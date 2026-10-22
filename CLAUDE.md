# ioBroker.energie

ioBroker adapter: energy flow (PV, grid, battery, house, consumers) from data points of any adapter,
day values, day chart, surplus signal. Owner wanted "like energiefluss but better and simpler", open for
all manufacturers (Modbus values need factor/sign), shown in SmartView and VIS-2.

## Layout

- `lib/model.js` – pure logic: `cleanConfig()` (PV table, grid single/split, battery, house, consumers
  table, surplus), `inputs()`, `convert()` (Modbus sign 16/32 bit, factor, unit auto = kW/MW from the object),
  `snapshot()` (grid > 0 import, battery > 0 charging, house computed = pv + grid - battery when not measured,
  `missing` names), `Day` (Wh by trapezoid between 2 s ticks, gaps > 5 min skipped; autarky, selfUse),
  `History` (5-min averages, 8 days; daily summaries, 400 days), `Surplus` (on/off thresholds + delay).
- `main.js` – subscribes the inputs, tick every 2 s -> states (written only on change), `live` JSON state,
  SSE push; energie.json in the instance data dir (saved every 5 min + unload; day restored if same date,
  else summarised into history); midnight -> yesterday.*. Messages `live` / `day {date}` (for SmartView).
- `lib/server.js` – `/flow` (+ `?view`, `?theme`, `?bg=transparent`), `/check` (raw value, setting, result),
  `/api/live`, `/api/day`, `/api/check`, `/events` (SSE); optional access key (cookie `en_key`).
- `www/render.js` – `EnergyView` (flow SVG built once then updated, dots = dashed stroke animation, speed
  by power; stats cards; day chart with touch/hover). Copied into ioBroker.smartview - keep in sync.
- `test/` – `node --test`; fake adapter-core in `test/fake.js`. Page checked with Playwright in the scratchpad.

## Status

- 0.1.0: built generic; owner's inverter/battery not known yet. Not yet tested on the owner's ioBroker.

## Conventions

- UI texts and README in German, code and comments in English.
- Bump `version` in both `package.json` and `io-package.json` and add a `news` entry.
- Install on the ioBroker host: `iobroker url https://github.com/andreaslampl/ioBroker.energie`.
- Run `npm test` before committing.
- Don't put the owner's IP addresses in the repository (use x.x.x.x / 192.168.1.x examples).
