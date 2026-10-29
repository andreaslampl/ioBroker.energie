'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { cleanConfig, inputs, convert, snapshot, Day, History, Surplus } = require('../lib/model');

test('convert: units, Modbus factor and sign', () => {
    assert.equal(convert(1.5, { unit: 'auto', scale: 1 }, 'kW'), 1500);
    assert.equal(convert('2,5', { unit: 'kW', scale: 1 }, ''), 2500);
    assert.equal(convert(12345, { unit: 'auto', scale: 0.1 }, ''), 1234.5);
    assert.equal(convert(65436, { unit: 'auto', scale: 1, signed: '16' }, ''), -100);
    assert.equal(convert(4294967196, { unit: 'auto', scale: 1, signed: '32' }, 'W'), -100);
    assert.equal(convert(100, { unit: 'auto', scale: 1, signed: '16' }, ''), 100);
    assert.equal(convert(null, { unit: 'auto', scale: 1 }, ''), null);
    assert.equal(convert('abc', { unit: 'auto', scale: 1 }, ''), null);
    assert.equal(convert(true, { unit: 'W', scale: 1 }, ''), 1);
});

test('snapshot: signs, computed house, consumers, missing values', () => {
    const cfg = cleanConfig({
        pvState: 'pv1',
        pvMore: [{ name: 'Garage', state: 'pv2', invert: true }],
        gridState: 'grid',
        gridPositive: 'export',
        batteryState: 'bat',
        batteryPositive: 'discharge',
        batterySoc: 'soc',
        consumers: [{ name: 'Wallbox', state: 'wb', icon: 'car' }, { name: 'Wärmepumpe', state: 'wp', icon: 'heatpump' }],
    });
    assert.deepEqual(inputs(cfg).map(i => i.id), ['pv1', 'pv2', 'grid', 'bat', 'soc', 'wb', 'wp']);
    // get() delivers converted values (sign, factor, "umgekehrt" are applied in convert())
    const v = { pv1: 4000, pv2: 1000, grid: 1500, bat: -800, soc: 64.4, wb: 1100 };
    const s = snapshot(cfg, id => (id in v ? v[id] : null), 1000);
    // export 1500 (positive = export), battery charging 800 (positive = discharge)
    assert.deepEqual([s.pv, s.grid, s.import, s.export, s.battery, s.charge, s.soc], [5000, -1500, 0, 1500, 800, 800, 64]);
    assert.equal(s.house, 5000 - 1500 - 800);
    assert.deepEqual(s.consumers.map(c => [c.id, c.w]), [['wallbox', 1100], ['waermepumpe', 0]]);
    assert.equal(s.rest, 2700 - 1100);
    assert.deepEqual(s.missing, ['Wärmepumpe']);
    // split grid, measured house, no battery
    const c2 = cleanConfig({ pv: [{ state: 'pv' }], gridMode: 'split', gridImport: 'imp', gridExport: 'exp', houseState: 'h' });
    const s2 = snapshot(c2, id => ({ pv: 0, imp: 900, exp: 0, h: 950 })[id]);
    assert.deepEqual([s2.grid, s2.house, s2.battery], [900, 950, null]);
});

test('day: energy, autarky, self consumption; history; surplus', () => {
    const day = new Day('2026-06-01');
    const s = (ts, o) => ({ ts, pv: 0, import: 0, export: 0, charge: 0, discharge: 0, house: 0, consumers: [{ id: 'wb', w: 0 }], ...o });
    // one hour: PV 3 kW, house 2 kW, export 1 kW; then one hour import 1 kW
    const hour = (start, o) => {
        for (let i = 0; i < 60; i++) {
            day.add(s(start + i * 60000, o), s(start + (i + 1) * 60000, o));
        }
    };
    hour(0, { pv: 3000, house: 2000, export: 1000 });
    hour(3600000, { house: 1000, import: 1000, consumers: [{ id: 'wb', w: 1000 }] });
    const t = day.summary();
    assert.deepEqual([t.pv, t.house, t.export, t.import], [3, 3, 1, 1]);
    assert.equal(t.autarky, 67);
    assert.equal(t.selfUse, 67);
    assert.equal(t.consumers.wb, 1);
    // gaps (adapter stopped) are not counted
    day.add(s(7200000, { pv: 5000 }), s(7200000 + 3600000, { pv: 5000 }));
    assert.equal(day.summary().pv, 3);

    const h = new History();
    const base = new Date(2026, 5, 1, 10, 0, 0).getTime();
    for (let i = 0; i < 12; i++) {
        h.add({ ts: base + i * 60000, pv: 1000 * (i < 5 ? 1 : 2), house: 500, grid: 0, battery: null, soc: 50 });
    }
    assert.equal(h.day('2026-06-01').points.length, 2);
    assert.deepEqual(h.day('2026-06-01').points.map(p => p.pv), [1000, 2000]);

    const sur = new Surplus({ on: 1500, off: 300, delay: 60000, battery: true });
    const at = (ts, exp, charge = 0) => sur.update({ ts, export: exp, charge });
    assert.equal(at(0, 2000).active, false);
    assert.equal(at(30000, 1000, 600).active, false);
    assert.equal(at(60000, 1600).active, true, 'above 1500 for a minute (battery counts)');
    assert.equal(at(90000, 500).active, true, 'still above the switch-off value');
    assert.equal(at(100000, 100).active, true);
    assert.equal(at(159000, 100).active, true);
    assert.equal(at(160000, 100).active, false, 'below 300 for a minute');
});

test('"umgekehrt" on every data point: negative becomes positive', () => {
    const cfg = cleanConfig({ pvState: 'pv', pvInvert: true, gridState: 'g', gridInvert: true, batteryState: 'b', batteryInvert: true, houseState: 'h', houseInvert: true, consumers: [{ name: 'WP', state: 'wp', invert: true }] });
    const raw = { pv: -3000, g: 500, b: 700, h: -2000, wp: -800 };
    const ins = Object.fromEntries(inputs(cfg).map(i => [i.id, i]));
    const s = snapshot(cfg, id => convert(raw[id], ins[id], 'W'));
    assert.deepEqual([s.pv, s.grid, s.battery, s.house, s.consumers[0].w], [3000, -500, -700, 2000, 800]);
});

test('Charger: pv starts after the delay, follows the surplus, stops after the delay; battery priority', () => {
    const { Charger } = require('../lib/model');
    const cfg = cleanConfig({ gridState: 'grid', batteryState: 'bat', batterySoc: 'soc', wbPower: 'wb.power', wbCurrent: 'wb.current', wbPhases: 3, wbMax: 16, wbOnDelay: 60, wbOffDelay: 300, wbSocMin: 80 });
    assert.equal(cfg.consumers.at(-1).id, 'wallbox');
    assert.equal(cfg.consumers.at(-1).icon, 'car');
    const w = cfg.wallbox;
    assert.equal(w.min * w.volt * w.phases, 4140);
    const ch = new Charger(w);
    // grid > 0 import; battery > 0 charging
    const snap = (ts, grid, car, battery = 0, soc = 90) => ({ ts, grid, battery, soc, consumers: [{ id: 'wallbox', w: car }] });
    let r = ch.update(snap(0, -3000, 0), { mode: 'pv', plugged: true });
    assert.equal(r.amps, 0);
    assert.match(r.status, /Wartet auf Überschuss \(ab 4,1 kW\)/);
    r = ch.update(snap(1000, -5000, 0));
    assert.equal(r.amps, 0);
    assert.match(r.status, /Startet in 1:00/);
    r = ch.update(snap(61000, -5000, 0));
    assert.equal(r.amps, 7, '5000 W / 690 W per A');
    // car draws 7 A = 4830 W, export drops: available stays
    r = ch.update(snap(70000, -170, 4830));
    assert.equal(r.amps, 7);
    // more sun
    r = ch.update(snap(80000, -2000, 4830));
    assert.equal(r.amps, 9);
    // cloud: below the minimum -> min A until the off delay
    r = ch.update(snap(90000, 1500, 4830));
    assert.equal(r.amps, 6);
    assert.match(r.status, /stoppt in 5:00/);
    r = ch.update(snap(390000, 1500, 4830));
    assert.equal(r.amps, 0);
    assert.match(r.status, /pausiert/);
    // battery charging counts for the car above socMin, not below
    r = ch.update(snap(400000, 0, 0, 5000, 90), { mode: 'minpv' });
    assert.equal(r.amps, 7);
    r = ch.update(snap(401000, 0, 0, 5000, 50), { mode: 'minpv' });
    assert.equal(r.amps, 6);
    assert.equal(r.available, 0);
    // battery discharging never feeds the car
    r = ch.update(snap(402000, 0, 4140, -2000, 90), { mode: 'minpv' });
    assert.equal(r.available, 2140);
    assert.equal(ch.update(snap(0, 0, 0), { mode: 'fast' }).amps, 16);
    assert.equal(ch.update(snap(0, 0, 0), { mode: 'off' }).amps, 0);
    assert.equal(ch.update(snap(0, 0, 0), { mode: 'manual' }).amps, null);
    assert.equal(ch.update({ ...snap(0, 0, 0), grid: null }, { mode: 'pv' }).status, 'Netz-Messwert fehlt');
    assert.match(ch.update(snap(0, -9000, 0), { mode: 'pv', plugged: false }).status, /Kein Auto/);
    // an existing consumer with the same data point becomes the wallbox
    const c2 = cleanConfig({ consumers: [{ name: 'Auto', state: 'wb.power' }], wbPower: 'wb.power', wbCurrent: 'x' });
    assert.equal(c2.consumers.length, 1);
    assert.equal(c2.wallbox.consumer, 'auto');
    assert.equal(cleanConfig({}).wallbox, null);
});

test('Charger: heat pump first, import limit, ready by; wallbox outside the meter', () => {
    const { Charger } = require('../lib/model');
    const base = { gridState: 'grid', wbPower: 'wb.power', wbCurrent: 'wb.current', wbPhases: 3, wbMax: 16, wbOnDelay: 60 };
    // wallbox before the inverter's meter: grid and house get the car's power
    const cfgOut = cleanConfig({ ...base, pvState: 'pv', wbOutside: true });
    const vals = { pv: 2000, grid: -500, 'wb.power': 4140 };
    const s = snapshot(cfgOut, id => vals[id] ?? null, 0);
    assert.equal(s.grid, 3640, 'meter shows 500 W export, the car draws 4140 W -> 3640 W import');
    assert.equal(s.house, 5640, 'PV 2000 W + import 3640 W');

    const snap = (ts, grid, car) => ({ ts, grid, battery: null, soc: null, consumers: [{ id: 'wallbox', w: car }] });
    // heat pump: pause (default) / minimum current
    let ch = new Charger(cleanConfig({ ...base, wbHp: 'hp' }).wallbox);
    let r = ch.update(snap(0, 0, 0), { mode: 'fast', heatpump: true });
    assert.equal(r.amps, 0);
    assert.equal(r.status, 'Pause – Wärmepumpe läuft');
    assert.equal(ch.update(snap(0, 0, 0), { mode: 'fast', heatpump: false }).amps, 16);
    ch = new Charger(cleanConfig({ ...base, wbHp: 'hp', wbHpAction: 'min' }).wallbox);
    assert.equal(ch.update(snap(0, 0, 0), { mode: 'fast', heatpump: true }).amps, 6);

    // ready by 07:00, 80 %: at 20 % 46 kWh are missing, ~12 h at 6 A -> urgent at 21:00, not at 12:00
    const at = h => new Date(2026, 9, 23, h, 0, 0).getTime();
    ch = new Charger(cleanConfig({ ...base, wbHp: 'hp', wbCarSoc: 'soc', wbTarget: 80, wbCapacity: 77, wbReady: '07:00' }).wallbox);
    r = ch.update(snap(at(12), 0, 0), { mode: 'fast', heatpump: true, carSoc: 20 });
    assert.equal(r.urgent, false);
    assert.equal(r.amps, 0);
    r = ch.update(snap(at(21), 0, 0), { mode: 'fast', heatpump: true, carSoc: 20 });
    assert.equal(r.urgent, true);
    assert.equal(r.amps, 6);
    assert.match(r.status, /Wärmepumpe läuft – Auto mit 6 A \(sonst bis 07:00 nicht 80 %\)/);
    assert.equal(ch.update(snap(at(21), 0, 0), { mode: 'fast', heatpump: true, carSoc: 85 }).urgent, false, 'already full enough');
    assert.equal(ch.update(snap(at(21), 0, 0), { mode: 'fast', heatpump: true, carSoc: null }).urgent, false, 'no charge level known');

    // import limit 8 kW incl. car: house draws 3 kW -> 5 kW left = 7 A; house 5 kW -> 3 kW < 6 A -> pause, restart after the delay
    ch = new Charger(cleanConfig({ ...base, wbPeak: 8, wbPeakReserve: 0 }).wallbox);
    r = ch.update(snap(0, 3000 + 11040, 11040), { mode: 'fast' });
    assert.equal(r.amps, 7);
    assert.match(r.status, /7 A – Bezugsgrenze 8,0 kW/);
    r = ch.update(snap(1000, 5000 + 4830, 4830), { mode: 'fast' });
    assert.equal(r.amps, 0);
    assert.match(r.status, /Pause – Bezugsgrenze 8,0 kW erreicht/);
    r = ch.update(snap(2000, 1000, 0), { mode: 'fast' });
    assert.equal(r.amps, 0);
    assert.match(r.status, /startet wieder in 0:59/);
    assert.equal(ch.update(snap(62000, 1000, 0), { mode: 'fast' }).amps, 10);
});

test('hpRunning: on/off, power, status with off values (Ochsner, Dimplex texts)', () => {
    const { hpRunning } = require('../lib/model');
    const w = o => cleanConfig({ wbCurrent: 'x', ...o }).wallbox;
    assert.equal(hpRunning(w({}), true), true);
    assert.equal(hpRunning(w({}), false), false);
    assert.equal(hpRunning(w({}), 'true'), true);
    assert.equal(hpRunning(w({ wbHpOn: 300 }), 120, { unit: 'W' }), false);
    assert.equal(hpRunning(w({ wbHpOn: 300 }), 2.1, { unit: 'kW' }), true);
    assert.equal(hpRunning(w({}), null), null);
    // Ochsner "Wärmeerzeuger Status": 0 = Standby, 3 = extern gesperrt, 8 = Störung
    const states = { 0: 'Standby', 1: 'Heizbetrieb', 3: 'Extern gesperrt', 8: 'Störung' };
    const och = w({ wbHpKind: 'status', wbHpOff: '0; 3; 8' });
    assert.equal(hpRunning(och, 0, { states }), false);
    assert.equal(hpRunning(och, 1, { states }), true);
    assert.equal(hpRunning(och, 8, { states }), false);
    assert.equal(hpRunning(och, '1', { states }), true);
    // by text, also for a text data point
    const txt = w({ wbHpKind: 'status', wbHpOff: 'Standby, Störung' });
    assert.equal(hpRunning(txt, 0, { states }), false);
    assert.equal(hpRunning(txt, 1, { states }), true);
    assert.equal(hpRunning(txt, 'standby'), false);
    assert.equal(hpRunning(txt, 'Heizen'), true);
    // default off value 0
    assert.deepEqual(w({ wbHpKind: 'status' }).hpOff, ['0']);
});

test('view: consumer line source, animation speed, house color settings', () => {
    const cfg = cleanConfig({
        gridState: 'grid',
        consumers: [{ name: 'Pool', state: 'pool', from: 'pv' }, { name: 'Sauna', state: 'sauna', from: 'evil' }],
        wbPower: 'wb', wbCurrent: 'x', wbFrom: 'grid',
        animSpeed: 1.5, houseColor: true, houseWarn: 800,
    });
    assert.deepEqual(cfg.consumers.map(c => c.from), ['pv', 'house', 'grid']);
    assert.equal(cfg.view.speed, 1.5);
    assert.equal(cfg.view.houseColor, true);
    assert.equal(cfg.view.houseWarn, 800);
    assert.equal(cleanConfig({ animSpeed: 99 }).view.speed, 4);
    assert.equal(cleanConfig({}).view.speed, 1);
    const s = snapshot(cfg, () => 100, 0);
    assert.deepEqual(s.consumers.map(c => c.from), ['pv', 'house', 'grid']);
});

test('Charger: import limit keeps a reserve (default 500 W)', () => {
    const { Charger } = require('../lib/model');
    const ch = new Charger(cleanConfig({ gridState: 'grid', wbPower: 'wb', wbCurrent: 'x', wbMax: 16, wbPeak: 12 }).wallbox);
    // house + heat pump 4 kW, car 11 kW: 12 - 0.5 - 4 = 7.5 kW -> 10 A (6.9 kW)
    const r = ch.update({ ts: 0, grid: 4000 + 11040, battery: null, soc: null, consumers: [{ id: 'wallbox', w: 11040 }] }, { mode: 'fast' });
    assert.equal(r.amps, 10);
});

test('consumer line from another consumer (by name); a loop is broken, unknown names and itself go to the house', () => {
    const cfg = cleanConfig({
        consumers: [
            { name: 'Unterzähler Garage', state: 'g', from: 'house' },
            { name: 'Pumpe', state: 'p', from: 'consumer', fromName: 'unterzähler garage' },
            { name: 'A', state: 'a', from: 'consumer', fromName: 'B' },
            { name: 'B', state: 'b', from: 'consumer', fromName: 'A' },
            { name: 'C', state: 'c', from: 'consumer', fromName: 'gibt es nicht' },
            { name: 'D', state: 'd', from: 'consumer', fromName: 'D' },
        ],
        wbPower: 'wb', wbCurrent: 'x', wbFrom: 'consumer', wbFromName: 'Unterzähler Garage',
    });
    // loop A <-> B: A goes back to the house, then B may come from A
    assert.deepEqual(cfg.consumers.map(x => x.from), ['house', 'c_unterzaehler_garage', 'house', 'c_a', 'house', 'house', 'c_unterzaehler_garage']);
    assert.equal(cfg.consumers[1].fromName, undefined);
});

test('Charger: heat pump rule and import limit can be switched off (settings and while running)', () => {
    const { Charger } = require('../lib/model');
    const base = { gridState: 'grid', wbPower: 'wb', wbCurrent: 'x', wbMax: 16, wbHp: 'hp' };
    const snap = (grid, car) => ({ ts: 0, grid, battery: null, soc: null, consumers: [{ id: 'wallbox', w: car }] });
    // older settings: action 'none' = off
    assert.equal(cleanConfig({ ...base, wbHpAction: 'none' }).wallbox.hpUse, false);
    assert.equal(cleanConfig({ ...base }).wallbox.hpUse, true);
    let ch = new Charger(cleanConfig({ ...base, wbHpUse: false }).wallbox);
    assert.equal(ch.update(snap(0, 0), { mode: 'fast', heatpump: true }).amps, 16, 'rule off in the settings');
    ch = new Charger(cleanConfig({ ...base, wbHpUse: true }).wallbox);
    assert.equal(ch.update(snap(0, 0), { mode: 'fast', heatpump: true }).amps, 0);
    assert.equal(ch.update(snap(0, 0), { mode: 'fast', heatpump: true, hpRule: false }).amps, 16, 'switched off while running');
    // import limit: checkbox off = no limit; while running: peak in W
    ch = new Charger(cleanConfig({ ...base, wbPeak: 8, wbPeakUse: false, wbPeakReserve: 0 }).wallbox);
    assert.equal(ch.update(snap(3000 + 11040, 11040), { mode: 'fast' }).amps, 16);
    assert.equal(ch.update(snap(3000 + 11040, 11040), { mode: 'fast', peak: 8000 }).amps, 7);
    ch = new Charger(cleanConfig({ ...base, wbPeak: 8, wbPeakReserve: 0 }).wallbox);
    assert.equal(ch.update(snap(3000 + 11040, 11040), { mode: 'fast' }).amps, 7);
    assert.equal(ch.update(snap(3000 + 11040, 11040), { mode: 'fast', peak: 0 }).amps, 16, 'limit 0 = off');
});

test('Charger: heat pump runs, action "rest up to the limit" - the car follows the import limit', () => {
    const { Charger } = require('../lib/model');
    const ch = new Charger(cleanConfig({ gridState: 'grid', wbPower: 'wb', wbCurrent: 'x', wbMax: 16, wbHp: 'hp', wbHpAction: 'limit', wbPeak: 12 }).wallbox);
    // house + heat pump 4 kW, car 11 kW -> 12 - 0.5 - 4 = 7.5 kW -> 10 A instead of a pause
    const r = ch.update({ ts: 0, grid: 4000 + 11040, battery: null, soc: null, consumers: [{ id: 'wallbox', w: 11040 }] }, { mode: 'fast', heatpump: true });
    assert.equal(r.amps, 10);
    assert.match(r.status, /Bezugsgrenze 12,0 kW/);
});

test('Charger: "rest up to the limit" without an active limit gives the minimum current, not unlimited', () => {
    const { Charger } = require('../lib/model');
    const ch = new Charger(cleanConfig({ gridState: 'grid', wbPower: 'wb', wbCurrent: 'x', wbMax: 16, wbHp: 'hp', wbHpAction: 'limit', wbPeak: 12, wbPeakUse: false }).wallbox);
    const r = ch.update({ ts: 0, grid: 4000, battery: null, soc: null, consumers: [{ id: 'wallbox', w: 0 }] }, { mode: 'fast', heatpump: true });
    assert.equal(r.amps, 6);
    assert.match(r.status, /keine Bezugsgrenze eingestellt/);
    // limit switched off while running (peakLimit 0)
    const ch2 = new Charger(cleanConfig({ gridState: 'grid', wbPower: 'wb', wbCurrent: 'x', wbMax: 16, wbHp: 'hp', wbHpAction: 'limit', wbPeak: 12 }).wallbox);
    assert.equal(ch2.update({ ts: 0, grid: 4000, battery: null, soc: null, consumers: [{ id: 'wallbox', w: 0 }] }, { mode: 'fast', heatpump: true, peak: 0 }).amps, 6);
});

test('HotWater: too cold, surplus with delay and own maximum, surplus gone, at the latest, by hand, timeout', () => {
    const { HotWater } = require('../lib/model');
    const cfg = cleanConfig({ hwUse: true, hwMode: 'o.0.ww.mode', hwTemp: 'o.0.ww.temp', hwStart: 45, hwTarget: 50, hwSurplusW: 2000, hwOnDelay: 5, hwSurplusMax: 55, hwOffDelay: 10, hwLatest: '15:00' }).hotwater;
    assert.equal(cleanConfig({ hwUse: true, hwMode: 'x' }).hotwater, null, 'needs the temperature');
    const day = new Date(2026, 9, 29, 10, 0).getTime();
    const s = (min, exp = 0, imp = 0) => ({ ts: day + min * 60000, export: exp, import: imp, charge: 0, discharge: 0 });
    const hw = new HotWater(cfg);
    // too cold -> charge up to 50, then back
    assert.equal(hw.update(s(0), { temp: 44 }).started, 'cold');
    assert.match(hw.update(s(1), { temp: 47 }).status, /lädt \(zu kalt\) bis 50/);
    assert.equal(hw.update(s(30), { temp: 50 }).finished, 'cold');
    // surplus: only after 5 min, up to 55
    assert.match(hw.update(s(60, 2500), { temp: 49 }).status, /startet in 5 min/);
    assert.equal(hw.update(s(64, 2500), { temp: 49 }).charge, false);
    assert.equal(hw.update(s(65, 2500), { temp: 49 }).started, 'surplus');
    assert.equal(hw.update(s(80, 0, 300), { temp: 52 }).charge, true, '300 W import is tolerated');
    assert.equal(hw.update(s(90, 0, 1500), { temp: 52 }).charge, true, 'surplus gone, waits 10 min');
    assert.equal(hw.update(s(100, 0, 1500), { temp: 52 }).lost, true);
    // above 55 - 3 no surplus charge
    assert.match(hw.update(s(120, 5000), { temp: 53 }).status, /Automatik/);
    // a new surplus charge reaches 55
    hw.update(s(130, 5000), { temp: 50 });
    assert.equal(hw.update(s(135, 5000), { temp: 50 }).started, 'surplus');
    assert.equal(hw.update(s(150, 0), { temp: 55 }).finished, 'surplus');
    // at the latest: a charge already finished today -> nothing
    assert.equal(hw.update(s(310), { temp: 46 }).charge, false);
    const fresh = new HotWater(cfg);
    assert.equal(fresh.update(s(299), { temp: 46 }).charge, false, 'before 15:00');
    assert.equal(fresh.update(s(300), { temp: 46 }).started, 'latest');
    assert.equal(fresh.update(s(300 + 180), { temp: 48 }).timeout, true, 'stops after 180 min');
    // by hand, switched off
    assert.equal(fresh.update(s(500), { temp: 49, manual: true }).charge, true);
    assert.equal(fresh.update(s(501), { temp: 49, active: false }).stopped, true);
    assert.equal(fresh.update(s(502), { temp: 30, active: false }).charge, false, 'off = nothing');
    // a running charge survives a restart
    const again = new HotWater(cfg, fresh.saved());
    assert.equal(again.charging, false);
    hw.update(s(600), { temp: 40 });
    assert.deepEqual(new HotWater(cfg, hw.saved()).reason, 'cold');
});
