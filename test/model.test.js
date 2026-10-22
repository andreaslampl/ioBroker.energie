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
    const v = { pv1: 4000, pv2: -1000, grid: 1500, bat: -800, soc: 64.4, wb: 1100 };
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
