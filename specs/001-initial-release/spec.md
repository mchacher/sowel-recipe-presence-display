# sowel-recipe-presence-display — initial release

## Context

Sowel v1.18.x ships a `display` equipment type (spec 120) and the
`sowel-energy-display` AMOLED firmware v1.3.0 honours
`cmd/brightness 0` as the explicit panel-off value (iter 035).
What's missing is the automation that closes the loop: detect zone
absence + drive the display off, so the AMOLED panel does not stay
lit (and slowly burn) when nobody is in the room.

This recipe is the first user of the `set_display_brightness` order
beyond manual UI control.

## Goal

When the user instantiates the recipe in a zone with a display:

- After **N minutes** of no motion in the zone, the display
  receives `set_display_brightness 0` → panel goes black.
- On the next motion detection in the zone, the display receives
  `set_display_brightness <wake_value>` → panel back on at the
  configured day brightness.
- A failsafe already exists firmware-side: tapping a black panel
  wakes it to 80 %.  The recipe re-sleeps the panel on the next
  absence cycle.

## Wire-up

The recipe is a standard Sowel recipe plugin (one binary, one
`RecipeDefinition` exported from `dist/index.js`).  Distributed via
GitHub releases, registered in Sowel's `plugins/registry.json` with
SHA256.  Installed via Sowel Admin → Plugins → Browse.  Same
mechanics as the existing recipe plugins (motion-light,
presence-thermostat, …).

## Slots

| Id                  | Type              | Required | Default | Notes                                                              |
| ------------------- | ----------------- | -------- | ------- | ------------------------------------------------------------------ |
| `zone`              | zone              | yes      | —       | The room whose motion drives the sleep.                            |
| `displays`          | equipment (list)  | yes      | —       | Constraint: `equipmentType == "display"`.  At least 1.             |
| `absence_threshold` | duration          | no       | 5 min   | No-motion delay before sleep.  Range 30 s..2 h.                    |
| `wake_brightness`   | number (5..100)   | no       | 80      | Brightness applied on motion-resumed and on recipe deactivation.   |

## Behaviour

State machine driven by zone motion + a single timer:

```
                   motion=true
              ┌──────────────────┐
              ▼                  │
       [awake] ──no motion──▶ [waiting] ──timer fires──▶ [sleeping]
              ▲                                                 │
              └─────────────── motion=true ─────────────────────┘
```

On every state transition the recipe dispatches
`set_display_brightness <pct>` to **each** display in the `displays`
slot:

| Transition         | Dispatched value     |
| ------------------ | -------------------- |
| awake → waiting    | (none — timer only)  |
| waiting → awake    | (none — already lit) |
| waiting → sleeping | `0` (panel off)      |
| sleeping → awake   | `wake_brightness`    |
| on deactivate      | `wake_brightness`    |

`wake_brightness` is canonical: the recipe always restores the same
configured value (not the last-known user setting).  Predictable
behaviour over organic memory.

Recipe never overrides ongoing manual brightness changes when the
state is `awake` (steady state) — only the two motion-driven
transitions dispatch.

## Validation at activation

The recipe activator (Sowel-side) calls `validate(slots, ctx)`
before `onActivate`.  Validation:

1. The zone has at least 1 motion sensor (`zoneAggregator
   .getByZoneId(zoneId).motionSensors > 0`).  Otherwise the recipe
   would never trigger — fail with a clear message so the user
   knows to bind a sensor first.
2. Every equipment in `displays` is of type `display`.  Sowel's slot
   constraint already enforces this at picker level but the
   activator double-checks.
3. `absence_threshold` is between 30 s and 2 h.
4. `wake_brightness` is between 5 and 100.

## Edge cases

- **Display offline** at sleep/wake time → `executeOrder` rejects;
  recipe logs a warn and moves on.  Next motion cycle retries.
- **Multiple displays in the zone** → all sleep / wake in lockstep.
  Dispatched as one fire-and-forget burst.
- **Motion sensor stuck active** (PIR fail) → recipe stays in
  `awake`.  No false sleep, no false wake.  The recipe does not
  attempt to detect sensor faults itself.
- **Recipe deactivated mid-sleep** → wake all displays to
  `wake_brightness` so a forgotten recipe instance cannot leave the
  panels dark indefinitely.
- **Two recipe instances on the same display** (user error) → each
  fires its own dispatch.  The last-wins.  Document but do not
  enforce uniqueness — overlap is the user's responsibility.

## Acceptance criteria

### Plugin

- [ ] `manifest.json` declares `type: "recipe"`, id `presence-display`,
      icon `Monitor`, repo `mchacher/sowel-recipe-presence-display`.
- [ ] `dist/index.js` exports a `RecipeDefinition` via the standard
      Sowel plugin shape (same as motion-light-dimmable).
- [ ] Slots advertised: `zone`, `displays`, `absence_threshold`,
      `wake_brightness`.

### Runtime

- [ ] On zone motion=false, after `absence_threshold` elapsed, each
      bound display equipment receives an order with category
      `set_display_brightness` and value 0.
- [ ] On zone motion=true while sleeping, each display receives an
      order with value `wake_brightness`.
- [ ] On motion=true before the timer fires (back from a quick
      absence), the timer is cancelled cleanly, no order dispatched.
- [ ] On recipe deactivation, all displays receive an order with
      value `wake_brightness`.
- [ ] Validation refuses activation when the zone has no motion
      sensors.

### Tests (native)

- [ ] Unit test covering the state machine via a fake context (mock
      `executeOrder`, `setTimeout`).  Scenarios listed in the test
      plan below.

## Out of scope

- Per-time-window scheduling (use Sowel modes for that).
- Dim instead of full off (a future iter could add a `sleep_pct`
  slot ; for v1.0 the off / wake binary is enough).
- Multi-zone aggregation (one recipe instance per zone is the
  intended pattern).
- Auto-tuning the absence threshold based on past patterns.

## Test plan

| Module          | Scenario                                          | Expected                                                |
| --------------- | ------------------------------------------------- | ------------------------------------------------------- |
| state machine   | Activation in steady awake (motion=true)          | No order dispatched, state = awake                      |
| state machine   | motion=true → motion=false                        | Timer armed for absence_threshold ms                    |
| state machine   | motion=false → motion=true before timer fires     | Timer cancelled, state = awake, no order                |
| state machine   | timer fires after absence_threshold               | Order set_display_brightness=0 on each display          |
| state machine   | motion=true while sleeping                        | Order set_display_brightness=wake_brightness            |
| state machine   | onDeactivate while sleeping                       | Wake order dispatched                                   |
| state machine   | onDeactivate while awake                          | No order (already lit)                                  |
| state machine   | Multiple displays in slot                         | Order dispatched to each                                |
| state machine   | display equipment offline                         | warn logged, recipe survives the failed dispatch        |
| validation      | Zone has no motion sensors                        | Activation refused with clear message                   |
| validation      | absence_threshold out of range                    | Activation refused                                      |
