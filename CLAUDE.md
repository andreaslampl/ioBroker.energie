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
- 0.1.1 field: owner found no place to enter the PV value (the PV table only shows a + button) -> own field
  `pvState` (+ pvUnit/pvScale/pvSigned/pvInvert), table renamed `pvMore`; old `pv` table still read.
  jsonConfig validated against ioBroker/json-config schemas/jsonConfig.json (ajv).
- 0.2.0: owner asked for animated lines and round/square/own symbols. Lines were animated already, but the
  CSS stopped them under prefers-reduced-motion (likely Windows animation effects off on the touch PC) ->
  `view` {shape, line dots|dash|solid, anim on (default)|auto|off, icons} in cfg + `live.view`;
  `flow.update(s, view)`; square = rect with rx, SOC ring via pathLength=100. More icons (model `ICONS` = render).
- 0.2.1: owner wanted to flip the sign on every data point -> `invert` is part of `conv()` and applied in
  `convert()` (not in snapshot); checkboxes gridInvert/batteryInvert/houseInvert added.
- 0.2.2 field: consumer dots ran towards the house (consumer paths were drawn house->consumer but animated
  'reverse'); owner then ticked "umgekehrt" and got 0 W (negative consumption is clamped). Now every path
  runs node->house, direction normal = towards the house.
- 0.2.3 field: long consumer names were cut off at the edges -> `labelLines()` (two lines over 13 chars),
  consumers spread 120 px apart up to 280, viewBox widened by the estimated label width (6.4 px/char).
- 0.3.0: owner wanted to move the symbols freely -> `view.pos` {key: {x, y}} from positions.json (data dir,
  `cleanPositions()`), POST /api/positions; render.js `flow.edit(on, cb)` drags nodes (5 px raster, viewBox
  frozen while dragging), viewBox computed from all node positions; /flow "Anordnen" bar (not with ?view or
  bg=transparent). SmartView shows the arrangement via `live.view`.

- 0.4.0: owner's wallbox (Siemens VersiCharge 3, 3-phase, VW ID.4) allows only one Modbus client, so far evcc.
  Owner wanted an own wallbox adapter (ioBroker.versicharge) + surplus charging here + SmartView tile.
  Config `wb*` -> `cfg.wallbox` (its power becomes consumer `wallbox`, or the consumer with the same data point);
  model `Charger` (modes off/pv/minpv/fast/manual; available = -grid + car power + battery (only min(0, battery)
  below `wbSocMin`); pv: onDelay/offDelay, `wbImport` tolerated); main `controlWallbox()` writes `wbCurrent`
  (ack false) on change, at most every 10 s (pause/start at once), again after 30 s if the wallbox shows another
  value; `wallbox.mode` (keys or German texts), `live.wallbox`. Not yet tested on the real system.

- 0.5.0: owner's grid tariff will charge by power peaks; the wallbox is before the inverter's meter (so the car does
  not drain the house battery) and was missing from house consumption. `wbOutside` -> snapshot adds the wallbox
  consumer's power to grid (and to a measured house; a computed house includes it via grid). Charger `update()` =
  `base()` (surplus logic as before) then limits: heat pump (`wbHp` bool or power > `wbHpOn` W, kW by object unit;
  `wbHpAction` pause|min|none), import limit `wbPeak` kW incl. car (amps = (peak - (grid - car)) / perAmp; below
  min -> pause, restart only after onDelay via `peakAt`), `urgent()` (car SOC `wbCarSoc`, `wbCapacity`, `wbTarget`,
  `wbReady` HH:MM; minimum-current time at 90 % efficiency + 15 min >= time left) overrides both with min current.
  `wallbox.urgent` state, `live.wallbox.heatpump/urgent`. Not yet tested on the real system.
- 0.5.1: owner's heat pump is the Ochsner (ioBroker.ochsner-web2com), "Wärmeerzeuger Status" 0 = Standby -> `wbHpKind`
  auto|power|status + `wbHpOff` (numbers or texts, matched against the value and its common.states text);
  model `hpRunning(w, val, common)`. Must stay generic (Dimplex and others).
- Car SOC for "ready by": the VersiCharge (AC) has no SOC register. VW retired the classic VW ID login (2026-06-01);
  Tibber not available to the owner (Austria). Owner set up the EU Data Act portal request; vw-connect connects again
  (SOC was expected under vw-connect.0.<VIN>.statuseudata.battery_state_report.soc, every 15 min while the car is active).
  First owner dataset: battery_state_report only had charge_rate_unit; candidates `statuseudata.value` = 212 ("battery
  level HV battery") and `energy_contents.current_energy_content.physical_value` = 274; app showed 50 % ~2 h later
  while charging -> not decided yet. 0.5.2: `wbCarSocScale` factor, result in state `wallbox.carSoc`.

## Conventions

- UI texts and README in German, code and comments in English.
- Bump `version` in both `package.json` and `io-package.json` and add a `news` entry.
- Install on the ioBroker host: `iobroker url https://github.com/andreaslampl/ioBroker.energie`.
- Run `npm test` before committing.
- Don't put the owner's IP addresses in the repository (use x.x.x.x / 192.168.1.x examples).
