import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRecipe, resolveBrightnessAlias, resolveWakeAlias } from "./index.js";

const recipe = createRecipe();

// ============================================================
// Fixtures + mock context
// ============================================================

const ZONE_ID = "zone-1";
const DISPLAY_ID = "display-1";

interface MockOrder {
  equipmentId: string;
  alias: string;
  value: unknown;
}

function makeCtx(opts: {
  motion?: boolean;
  motionSensors?: number;
  displayMissing?: boolean;
  brightnessAlias?: string | null;
  wakeAlias?: string | null;
} = {}) {
  const orders: MockOrder[] = [];
  const motion = opts.motion ?? true;
  const motionSensors = opts.motionSensors ?? 1;
  const displayMissing = opts.displayMissing ?? false;
  const brightnessAlias =
    opts.brightnessAlias === undefined ? "set_brightness" : opts.brightnessAlias;
  const wakeAlias = opts.wakeAlias === undefined ? "display_wake" : opts.wakeAlias;

  let zoneListener: ((event: Record<string, unknown>) => void) | null = null;

  const ctx = {
    eventBus: {
      onType: (type: string, handler: (event: Record<string, unknown>) => void) => {
        if (type === "zone.data.changed") zoneListener = handler;
        return () => {
          if (zoneListener === handler) zoneListener = null;
        };
      },
    },
    equipmentManager: {
      getByIdWithDetails: (id: string) => {
        if (id !== DISPLAY_ID || displayMissing) return null;
        const orderBindings: Array<{ alias: string; category: string }> = [];
        if (brightnessAlias) {
          orderBindings.push({ alias: brightnessAlias, category: "set_display_brightness" });
        }
        if (wakeAlias) {
          orderBindings.push({ alias: wakeAlias, category: "display_wake" });
        }
        return {
          id,
          name: "Test Display",
          type: "display",
          zoneId: ZONE_ID,
          dataBindings: [],
          orderBindings,
        };
      },
      executeOrder: vi.fn(
        async (equipmentId: string, alias: string, value: unknown): Promise<void> => {
          orders.push({ equipmentId, alias, value });
        },
      ),
    },
    zoneManager: {
      getById: (id: string) => (id === ZONE_ID ? { id: ZONE_ID, name: "Salon" } : null),
    },
    zoneAggregator: {
      getByZoneId: (id: string) =>
        id === ZONE_ID ? { motion, motionSensors } : null,
    },
    log: vi.fn(),
    helpers: {
      parseDuration: (value: unknown): number => {
        if (typeof value === "number") return value;
        const s = String(value);
        const m = s.match(/^(\d+)(s|m|h)?$/);
        if (!m) throw new Error(`Invalid duration: ${s}`);
        const n = Number(m[1]);
        const unit = m[2] ?? "s";
        if (unit === "s") return n * 1000;
        if (unit === "m") return n * 60_000;
        return n * 3_600_000;
      },
    },
  };

  return {
    ctx,
    orders,
    fireMotion(motion: boolean) {
      if (!zoneListener) throw new Error("No zone listener");
      zoneListener({ zoneId: ZONE_ID, aggregatedData: { motion } });
    },
  };
}

const VALID_PARAMS = {
  zone: ZONE_ID,
  displays: [DISPLAY_ID],
  absence_threshold: "30s",
};

// ============================================================
// Tests
// ============================================================

describe("resolveBrightnessAlias", () => {
  it("returns the alias of the set_display_brightness order", () => {
    const a = resolveBrightnessAlias([
      { alias: "lang", category: "set_language" },
      { alias: "bright", category: "set_display_brightness" },
    ]);
    expect(a).toBe("bright");
  });

  it("returns null when no matching order exists", () => {
    expect(resolveBrightnessAlias([{ alias: "lang", category: "set_language" }])).toBeNull();
    expect(resolveBrightnessAlias([])).toBeNull();
  });
});

describe("resolveWakeAlias", () => {
  it("returns the alias of the display_wake order", () => {
    const a = resolveWakeAlias([
      { alias: "bright", category: "set_display_brightness" },
      { alias: "wake", category: "display_wake" },
    ]);
    expect(a).toBe("wake");
  });

  it("returns null when no display_wake order exists", () => {
    expect(resolveWakeAlias([{ alias: "bright", category: "set_display_brightness" }])).toBeNull();
    expect(resolveWakeAlias([])).toBeNull();
  });
});

describe("validate", () => {
  it("accepts a valid configuration", () => {
    const { ctx } = makeCtx();
    expect(() => recipe.validate(VALID_PARAMS, ctx as never)).not.toThrow();
  });

  it("refuses a missing zone parameter", () => {
    const { ctx } = makeCtx();
    expect(() => recipe.validate({ ...VALID_PARAMS, zone: undefined }, ctx as never)).toThrow(
      /Zone parameter/,
    );
  });

  it("refuses a zone with no motion sensors", () => {
    const { ctx } = makeCtx({ motionSensors: 0 });
    expect(() => recipe.validate(VALID_PARAMS, ctx as never)).toThrow(/no motion sensor/);
  });

  it("refuses an empty displays list", () => {
    const { ctx } = makeCtx();
    expect(() => recipe.validate({ ...VALID_PARAMS, displays: [] }, ctx as never)).toThrow(
      /At least one display/,
    );
  });

  it("refuses a display without the set_display_brightness order", () => {
    const { ctx } = makeCtx({ brightnessAlias: null });
    expect(() => recipe.validate(VALID_PARAMS, ctx as never)).toThrow(
      /no order of category "set_display_brightness"/,
    );
  });

  it("refuses a display without the display_wake order (older firmware)", () => {
    const { ctx } = makeCtx({ wakeAlias: null });
    expect(() => recipe.validate(VALID_PARAMS, ctx as never)).toThrow(
      /no order of category "display_wake".*upgrade/i,
    );
  });

  it("refuses absence_threshold below 30 s", () => {
    const { ctx } = makeCtx();
    expect(() =>
      recipe.validate({ ...VALID_PARAMS, absence_threshold: "10s" }, ctx as never),
    ).toThrow(/between/);
  });

  it("absence_threshold above 2 h is also refused", () => {
    const { ctx } = makeCtx();
    expect(() =>
      recipe.validate({ ...VALID_PARAMS, absence_threshold: "3h" }, ctx as never),
    ).toThrow(/between/);
  });
});

describe("state machine — motion-driven", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // Helper: the initial wake dispatched at every instance start to sync the
  // panel with the recipe's "awake" default. Without this, a Sowel restart
  // mid-cycle (display physically at brightness=0) would leave the panel
  // dark on the next motion=true that hits a "waiting" state.
  const INITIAL_WAKE = { equipmentId: DISPLAY_ID, alias: "display_wake", value: null };

  it("dispatches an initial wake on activation (motion present)", () => {
    const { ctx, orders } = makeCtx({ motion: true });
    const instance = recipe.createInstance(VALID_PARAMS, ctx as never);
    expect(orders).toEqual([INITIAL_WAKE]);
    instance.stop();
  });

  it("dispatches an initial wake on activation even when zone is absent", () => {
    const { ctx, orders } = makeCtx({ motion: false });
    const instance = recipe.createInstance(VALID_PARAMS, ctx as never);
    expect(orders).toEqual([INITIAL_WAKE]);
    instance.stop();
  });

  it("motion=true → motion=false starts the absence timer (no extra order yet)", () => {
    const { ctx, orders, fireMotion } = makeCtx({ motion: true });
    const instance = recipe.createInstance(VALID_PARAMS, ctx as never);
    fireMotion(false);
    expect(orders).toEqual([INITIAL_WAKE]);
    instance.stop();
  });

  it("absence timer fires → set_display_brightness 0 on each display", () => {
    const { ctx, orders, fireMotion } = makeCtx({ motion: true });
    const instance = recipe.createInstance(VALID_PARAMS, ctx as never);
    fireMotion(false);
    vi.advanceTimersByTime(30000);
    expect(orders).toEqual([
      INITIAL_WAKE,
      { equipmentId: DISPLAY_ID, alias: "set_brightness", value: 0 },
    ]);
    instance.stop();
  });

  it("motion returns before timer fires → no extra order, timer cancelled", () => {
    const { ctx, orders, fireMotion } = makeCtx({ motion: true });
    const instance = recipe.createInstance(VALID_PARAMS, ctx as never);
    fireMotion(false);
    vi.advanceTimersByTime(15000);
    fireMotion(true);
    vi.advanceTimersByTime(60000);
    expect(orders).toEqual([INITIAL_WAKE]);
    instance.stop();
  });

  it("motion returns while sleeping → display_wake order dispatched", () => {
    const { ctx, orders, fireMotion } = makeCtx({ motion: true });
    const instance = recipe.createInstance(VALID_PARAMS, ctx as never);
    fireMotion(false);
    vi.advanceTimersByTime(30000); // sleep fires
    fireMotion(true);
    expect(orders).toEqual([
      INITIAL_WAKE,
      { equipmentId: DISPLAY_ID, alias: "set_brightness", value: 0 },
      { equipmentId: DISPLAY_ID, alias: "display_wake", value: null },
    ]);
    instance.stop();
  });

  it("activation when zone is already absent → timer armed at start", () => {
    const { ctx, orders, fireMotion } = makeCtx({ motion: false });
    const instance = recipe.createInstance(VALID_PARAMS, ctx as never);
    vi.advanceTimersByTime(30000);
    expect(orders).toEqual([
      INITIAL_WAKE,
      { equipmentId: DISPLAY_ID, alias: "set_brightness", value: 0 },
    ]);
    // Subsequent motion still wakes correctly
    fireMotion(true);
    expect(orders).toEqual([
      INITIAL_WAKE,
      { equipmentId: DISPLAY_ID, alias: "set_brightness", value: 0 },
      { equipmentId: DISPLAY_ID, alias: "display_wake", value: null },
    ]);
    instance.stop();
  });

  it("stop while sleeping → no extra order (firmware owns the wake)", () => {
    const { ctx, orders } = makeCtx({ motion: false });
    const instance = recipe.createInstance(VALID_PARAMS, ctx as never);
    vi.advanceTimersByTime(30000); // sleep fires
    instance.stop();
    expect(orders).toEqual([
      INITIAL_WAKE,
      { equipmentId: DISPLAY_ID, alias: "set_brightness", value: 0 },
    ]);
  });

  it("stop while awake → no extra order", () => {
    const { ctx, orders } = makeCtx({ motion: true });
    const instance = recipe.createInstance(VALID_PARAMS, ctx as never);
    instance.stop();
    expect(orders).toEqual([INITIAL_WAKE]);
  });

  it("multiple sleep / wake cycles dispatch every transition", () => {
    const { ctx, orders, fireMotion } = makeCtx({ motion: true });
    const instance = recipe.createInstance(VALID_PARAMS, ctx as never);
    fireMotion(false);
    vi.advanceTimersByTime(30000); // sleep 1
    fireMotion(true); // wake 1
    fireMotion(false);
    vi.advanceTimersByTime(30000); // sleep 2
    fireMotion(true); // wake 2
    const aliases = orders.map((o) => o.alias);
    expect(aliases).toEqual([
      "display_wake", // initial sync wake at instance start
      "set_brightness",
      "display_wake",
      "set_brightness",
      "display_wake",
    ]);
    const values = orders.map((o) => o.value);
    expect(values).toEqual([null, 0, null, 0, null]);
    instance.stop();
  });

  // Regression for the bug fixed in this release: on a Sowel restart while
  // the user is moving in the room, the recipe used to default state="awake"
  // and never re-wake the panel (which was at brightness=0 from a previous
  // sleep cycle). Motion=true arriving while state="waiting" silently passed
  // through goAwake without dispatching wake. The fix is the unconditional
  // initial wake on activation.
  it("regression: re-instantiation always re-syncs the panel with a wake", () => {
    // Simulate Sowel restart: a fresh createInstance call. The previous
    // session physically left the panel at brightness=0 (we can't observe
    // that directly in this test, but the contract is: the new instance
    // must dispatch a wake so the firmware re-applies user_pct).
    const { ctx, orders } = makeCtx({ motion: true });
    const instance = recipe.createInstance(VALID_PARAMS, ctx as never);
    expect(orders).toEqual([INITIAL_WAKE]);
    instance.stop();

    // Toggle off/on (a second createInstance after stop) must also re-sync.
    const second = recipe.createInstance(VALID_PARAMS, ctx as never);
    expect(orders).toEqual([INITIAL_WAKE, INITIAL_WAKE]);
    second.stop();
  });
});
