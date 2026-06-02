// ============================================================
// Presence-driven display sleep — Sowel recipe plugin
// ============================================================
//
// Watches motion in a zone and dispatches `set_display_brightness 0`
// to each bound display after `absence_threshold` of no motion.  On
// the next motion event, dispatches `set_display_brightness
// <wake_brightness>` to wake them up.
//
// Pairs with:
//   - Sowel spec 120 (display equipment + set_display_brightness order)
//   - sowel-energy-display iter 035 (firmware brightness=0 = panel off)
//   - sowel-plugin-displays v0.1.0+ (MQTT supervision)
//
// The recipe is plugin-distributed (spec 053+).  No Sowel core change
// required — it consumes the standard zone aggregator + executeOrder
// pipeline.

// ============================================================
// Minimal context typedefs (Sowel injects the real ones at runtime)
// ============================================================

interface RecipeContext {
  eventBus: {
    onType(type: string, handler: (event: Record<string, unknown>) => void): () => void;
  };
  equipmentManager: {
    getByIdWithDetails(id: string): {
      id: string;
      name: string;
      type: string;
      zoneId?: string;
      dataBindings: Array<{ alias: string; category?: string }>;
      orderBindings: Array<{ alias: string; category?: string }>;
    } | null;
    executeOrder(equipmentId: string, alias: string, value: unknown): Promise<void>;
  };
  zoneManager: {
    getById(id: string): { id: string; name: string } | null;
  };
  zoneAggregator: {
    getByZoneId(zoneId: string): { motion: boolean; motionSensors: number } | null;
  };
  log: (message: string, level?: "info" | "warn" | "error") => void;
  helpers: {
    parseDuration(value: unknown): number;
  };
}

interface RecipeSlotDef {
  id: string;
  name: string;
  description: string;
  type: "zone" | "equipment" | "number" | "duration" | "time" | "boolean" | "text";
  required: boolean;
  list?: boolean;
  defaultValue?: unknown;
  constraints?: {
    equipmentType?: string | string[];
    min?: number;
    max?: number;
  };
}

interface RecipeLangPack {
  name: string;
  description: string;
  slots?: Record<string, { name: string; description: string }>;
}

interface RecipeDefinition {
  id: string;
  name: string;
  description: string;
  slots: RecipeSlotDef[];
  i18n?: Record<string, RecipeLangPack>;
  validate(params: Record<string, unknown>, ctx: RecipeContext): void;
  createInstance(
    params: Record<string, unknown>,
    ctx: RecipeContext,
  ): { stop(): void };
}

// ============================================================
// Constants
// ============================================================

const BRIGHTNESS_ORDER_CATEGORY = "set_display_brightness";
const ABSENCE_MIN_MS = 30 * 1000;
const ABSENCE_MAX_MS = 2 * 60 * 60 * 1000;
const WAKE_MIN = 5;
const WAKE_MAX = 100;
const DEFAULT_ABSENCE = "5m";
const DEFAULT_WAKE = 80;

// ============================================================
// Pure helpers — exported for the unit test
// ============================================================

/**
 * Resolve the alias to use when dispatching the brightness order for
 * a given display equipment.  Sowel routes by alias, so the recipe
 * has to translate the canonical category into the user-bound alias.
 */
export function resolveBrightnessAlias(
  orderBindings: ReadonlyArray<{ alias: string; category?: string }>,
): string | null {
  for (const b of orderBindings) {
    if (b.category === BRIGHTNESS_ORDER_CATEGORY) return b.alias;
  }
  return null;
}

export type RecipeState = "awake" | "waiting" | "sleeping";

// ============================================================
// Slot definitions
// ============================================================

function slots(): RecipeSlotDef[] {
  return [
    {
      id: "zone",
      name: "Zone",
      description: "Zone whose motion drives the sleep / wake cycle",
      type: "zone",
      required: true,
    },
    {
      id: "displays",
      name: "Displays",
      description: "Displays to control (must be display equipments)",
      type: "equipment",
      required: true,
      list: true,
      constraints: { equipmentType: "display" },
    },
    {
      id: "absence_threshold",
      name: "Absence threshold",
      description: "Delay with no motion before turning displays off",
      type: "duration",
      required: false,
      defaultValue: DEFAULT_ABSENCE,
    },
    {
      id: "wake_brightness",
      name: "Wake brightness",
      description: "Brightness applied on motion-resumed and on recipe deactivation (5..100 %)",
      type: "number",
      required: false,
      defaultValue: DEFAULT_WAKE,
      constraints: { min: WAKE_MIN, max: WAKE_MAX },
    },
  ];
}

// ============================================================
// Recipe export — Sowel's RecipeLoader expects a `createRecipe`
// factory function that returns the RecipeDefinition (cf. how
// sowel-recipe-motion-light-dimmable et al. expose themselves).
// ============================================================

export function createRecipe(): RecipeDefinition {
  return recipe;
}

const recipe: RecipeDefinition = {
  id: "presence-display",
  name: "Presence-driven display sleep",
  description:
    "Turns Sowel-supervised displays off after a configurable absence in a zone, wakes them on the next motion event.",

  slots: slots(),

  i18n: {
    fr: {
      name: "Veille afficheur sur absence",
      description:
        "Éteint les afficheurs Sowel après une période d'absence dans une zone, les réveille au mouvement suivant.",
      slots: {
        zone: { name: "Zone", description: "Zone dont le mouvement pilote la veille / le réveil" },
        displays: {
          name: "Afficheurs",
          description: "Afficheurs à contrôler (équipements de type display uniquement)",
        },
        absence_threshold: {
          name: "Seuil d'absence",
          description: "Délai sans mouvement avant l'extinction des afficheurs",
        },
        wake_brightness: {
          name: "Luminosité de réveil",
          description: "Luminosité appliquée au mouvement repris et à la désactivation (5..100 %)",
        },
      },
    },
  },

  // ============================================================
  // Validation — runs once before createInstance, throws to refuse.
  // ============================================================
  validate(params: Record<string, unknown>, ctx: RecipeContext): void {
    const zoneId = typeof params.zone === "string" ? params.zone : null;
    if (!zoneId) throw new Error("Zone parameter is required");
    const zone = ctx.zoneManager.getById(zoneId);
    if (!zone) throw new Error(`Zone not found: ${zoneId}`);

    const zoneData = ctx.zoneAggregator.getByZoneId(zoneId);
    if (!zoneData || zoneData.motionSensors === 0) {
      throw new Error(
        `Zone "${zone.name}" has no motion sensor — the recipe would never trigger. Bind at least one motion sensor in this zone first.`,
      );
    }

    const displayIds = Array.isArray(params.displays)
      ? params.displays.filter((id): id is string => typeof id === "string")
      : [];
    if (displayIds.length === 0) {
      throw new Error("At least one display equipment must be selected");
    }
    for (const id of displayIds) {
      const eq = ctx.equipmentManager.getByIdWithDetails(id);
      if (!eq) throw new Error(`Display equipment not found: ${id}`);
      if (eq.type !== "display") {
        throw new Error(`Equipment "${eq.name}" is type "${eq.type}", expected "display"`);
      }
      if (!resolveBrightnessAlias(eq.orderBindings)) {
        throw new Error(
          `Display "${eq.name}" has no order of category "${BRIGHTNESS_ORDER_CATEGORY}" — cannot drive its brightness`,
        );
      }
    }

    const absenceRaw = params.absence_threshold ?? DEFAULT_ABSENCE;
    const absenceMs = ctx.helpers.parseDuration(absenceRaw);
    if (absenceMs < ABSENCE_MIN_MS || absenceMs > ABSENCE_MAX_MS) {
      throw new Error(
        `absence_threshold must be between ${ABSENCE_MIN_MS / 1000} s and ${ABSENCE_MAX_MS / 1000 / 60} min`,
      );
    }

    const wake = params.wake_brightness !== undefined ? Number(params.wake_brightness) : DEFAULT_WAKE;
    if (!Number.isFinite(wake) || wake < WAKE_MIN || wake > WAKE_MAX) {
      throw new Error(`wake_brightness must be between ${WAKE_MIN} and ${WAKE_MAX}`);
    }
  },

  // ============================================================
  // Instance lifecycle
  // ============================================================
  createInstance(params: Record<string, unknown>, ctx: RecipeContext) {
    const zoneId = String(params.zone);
    const displayIds = Array.isArray(params.displays)
      ? params.displays.filter((id): id is string => typeof id === "string")
      : [];
    const absenceMs = ctx.helpers.parseDuration(params.absence_threshold ?? DEFAULT_ABSENCE);
    const wakeBrightness =
      params.wake_brightness !== undefined ? Number(params.wake_brightness) : DEFAULT_WAKE;

    let state: RecipeState = "awake";
    let timer: ReturnType<typeof setTimeout> | null = null;

    const cancelTimer = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };

    const dispatch = (value: number, label: string) => {
      for (const displayId of displayIds) {
        const eq = ctx.equipmentManager.getByIdWithDetails(displayId);
        if (!eq) continue;
        const alias = resolveBrightnessAlias(eq.orderBindings);
        if (!alias) {
          ctx.log(
            `Display "${eq.name}" lost its brightness order binding — skipping`,
            "warn",
          );
          continue;
        }
        ctx.equipmentManager.executeOrder(displayId, alias, value).catch((err: unknown) => {
          ctx.log(
            `Failed to ${label} display "${eq.name}": ${err instanceof Error ? err.message : String(err)}`,
            "warn",
          );
        });
      }
    };

    const goSleep = () => {
      if (state === "sleeping") return;
      state = "sleeping";
      timer = null;
      ctx.log(`No motion for ${Math.round(absenceMs / 1000)} s — putting displays to sleep`);
      dispatch(0, "sleep");
    };

    const goAwake = () => {
      const wasSleeping = state === "sleeping";
      cancelTimer();
      state = "awake";
      if (wasSleeping) {
        ctx.log(`Motion resumed — waking displays at ${wakeBrightness}%`);
        dispatch(wakeBrightness, "wake");
      }
    };

    const goWaiting = () => {
      if (state !== "awake") return;
      state = "waiting";
      cancelTimer();
      timer = setTimeout(goSleep, absenceMs);
    };

    const onMotionChange = (motion: boolean) => {
      if (motion) {
        goAwake();
      } else if (state === "awake") {
        goWaiting();
      }
    };

    // Initial sync: derive state from current zone motion.
    const initial = ctx.zoneAggregator.getByZoneId(zoneId);
    if (initial && !initial.motion) {
      goWaiting();
    }

    // Subscribe to zone aggregation changes.
    const unsubZone = ctx.eventBus.onType("zone.data.changed", (event) => {
      if (event.zoneId !== zoneId) return;
      const aggregated = event.aggregatedData as { motion?: boolean } | undefined;
      if (!aggregated) return;
      onMotionChange(aggregated.motion === true);
    });

    return {
      stop() {
        unsubZone();
        cancelTimer();
        // Safety: if displays were asleep, wake them back to wake_brightness
        // so a deactivated recipe never leaves panels dark forever.
        if (state === "sleeping") {
          ctx.log("Recipe deactivated — waking displays back to wake_brightness");
          dispatch(wakeBrightness, "wake (deactivate)");
        }
        state = "awake";
      },
    };
  },
};
