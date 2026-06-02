# sowel-recipe-presence-display

Sowel recipe plugin: turns Sowel-supervised displays off after a
configurable absence in a zone, wakes them on the next motion event.

Pairs with:
- Sowel display equipment type (spec 120, v1.18.0+)
- `sowel-plugin-displays` MQTT supervision plugin (v0.1.0+)
- `sowel-energy-display` firmware v1.3.0+ (brightness=0 = panel off,
  wake-on-touch failsafe)

## What it does

For a configured zone + list of display equipments, the recipe
watches zone motion via the standard zone aggregator and runs a
3-state machine:

| State    | Enters from         | Action                                       |
| -------- | ------------------- | -------------------------------------------- |
| awake    | initial / wake      | (nothing — displays stay at user's setting)  |
| waiting  | awake on motion=off | start absence timer                          |
| sleeping | waiting on timeout  | dispatch `set_display_brightness 0`          |

On motion=on while sleeping → dispatch `set_display_brightness
<wake_brightness>` to each display. On recipe deactivation, the
displays are restored to `wake_brightness` so a forgotten recipe
cannot leave panels dark indefinitely.

Independent of this recipe, the firmware always wakes on tap when
the panel is at 0 % — failsafe in case the recipe stops dispatching
(broker outage, recipe disabled, etc.).

## Slots

| Id                  | Type             | Required | Default | Notes                              |
| ------------------- | ---------------- | -------- | ------- | ---------------------------------- |
| `zone`              | zone             | yes      | —       | Source of the motion signal        |
| `displays`          | equipment (list) | yes      | —       | Constraint: `type == "display"`    |
| `absence_threshold` | duration         | no       | `5m`    | 30 s..2 h                          |
| `wake_brightness`   | number           | no       | `80`    | 5..100 % (panel brightness on wake) |

## Installation

Once the registry entry lands on Sowel:

1. Sowel Admin → Plugins → Browse → "Presence-driven display sleep"
2. Install
3. Create a recipe instance from your zone's Scenarios / Recipes
   section, pick the zone + displays, leave defaults or tune.

## Development

```sh
npm ci
npm test       # native state-machine tests
npm run build  # tsc → dist/
```

The release workflow tags + builds + uploads a tarball when you
push a `v*` tag.
