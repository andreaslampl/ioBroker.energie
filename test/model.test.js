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
    ch = new Charger(cleanConfig({ ...base, wbPeak: 8 }).wallbox);
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
