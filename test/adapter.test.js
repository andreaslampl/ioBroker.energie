'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { install, until } = require('./fake');

install();

function freePort() {
    return new Promise(resolve => {
        const s = net.createServer();
        s.listen(0, '127.0.0.1', () => {
            const { port } = s.address();
            s.close(() => resolve(port));
        });
    });
}

const CONFIG = {
    pv: [{ name: 'Dach', state: 'modbus.0.holdingRegisters.40083_PV', scale: 10, signed: '16' }],
    gridState: 'shelly.0.em3.Total_Power',
    gridPositive: 'import',
    batteryState: 'modbus.0.holdingRegisters.40100_Batterie',
    batterySigned: '16',
    batteryPositive: 'charge',
    batterySoc: 'modbus.0.holdingRegisters.40102_SOC',
    batterySocScale: 0.1,
    consumers: [{ name: 'Wallbox', state: 'go-e.0.nrg.11', unit: 'kW', icon: 'car' }],
    surplusOn: 1000,
    surplusOff: 200,
    surplusDelay: 0,
};

async function start(t, config = {}, dataDir) {
    const port = await freePort();
    const adapter = require('../main.js')({ config: { port, ...CONFIG, ...config }, dataDir });
    // like a Modbus adapter without scaling and a Shelly 3EM
    adapter.add('modbus.0.holdingRegisters.40083_PV', '', 520); // * 10 = 5200 W
    adapter.add('shelly.0.em3.Total_Power', 'W', -1800); // export
    adapter.add('modbus.0.holdingRegisters.40100_Batterie', '', 1000); // charging 1000 W
    adapter.add('modbus.0.holdingRegisters.40102_SOC', '%', 765);
    adapter.add('go-e.0.nrg.11', 'kW', 1.1);
    adapter.emit('ready');
    await until(() => adapter.val('info.url'));
    t.after(() => new Promise(resolve => adapter.emit('unload', resolve)));
    const base = `http://127.0.0.1:${port}/`;
    return { adapter, base, port };
}

test('adapter: values from any adapter, Modbus factor/sign, states, page, values check, surplus', async t => {
    const { adapter, base } = await start(t);
    await until(() => adapter.val('power.pv') === 5200);
    assert.equal(adapter.val('power.grid'), -1800);
    assert.equal(adapter.val('power.export'), 1800);
    assert.equal(adapter.val('power.battery'), 1000);
    assert.equal(adapter.val('power.soc'), 77);
    assert.equal(adapter.val('power.house'), 5200 - 1800 - 1000);
    assert.equal(adapter.val('consumers.wallbox.power'), 1100);
    assert.equal(adapter.val('info.connection'), true);
    assert.equal(adapter.val('surplus.active'), true, 'delay 0: at once');
    assert.equal(adapter.objects['energie.0.consumers.wallbox.today'].common.unit, 'kWh');

    // Modbus 16 bit: discharging shows as 65036 -> -500
    adapter.change('modbus.0.holdingRegisters.40100_Batterie', 65036);
    await until(() => adapter.val('power.battery') === -500, 4000);
    assert.equal(adapter.val('power.house'), 5200 - 1800 + 500);

    // page and API
    const html = await (await fetch(base + 'flow')).text();
    assert.match(html, /render\.js/);
    const live = await (await fetch(base + 'api/live')).json();
    assert.equal(live.s.pv, 5200);
    assert.equal(live.today.date.length, 10);
    const check = await (await fetch(base + 'api/check')).json();
    const pvRow = check.inputs.find(i => i.label === 'Dach');
    assert.deepEqual([pvRow.raw, pvRow.value], [520, 5200]);
    assert.match(pvRow.setting, /Faktor 10 · Vorzeichen 16 Bit/);
    assert.match((await (await fetch(base + 'check')).text()), /Werte prüfen/);

    // live stream
    const ctrl = new AbortController();
    const res = await fetch(base + 'events', { signal: ctrl.signal });
    const reader = res.body.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    assert.match(first, /"pv":5200/);
    ctrl.abort();

    // SmartView asks for a day
    adapter.emit('message', { from: 'system.adapter.smartview.0', command: 'day', message: {}, callback: { id: 1 } });
    const answer = adapter.sent.find(s => s.command === 'day');
    assert.equal(answer.message.date, live.today.date);
    assert.ok(Array.isArray(answer.message.points));

    // own arrangement: only known symbols, saved and part of the live values
    const saved = await (await fetch(base + 'api/positions', { method: 'POST', body: JSON.stringify({ pos: { pv: { x: 70, y: 80 }, evil: { x: 1, y: 1 }, c_wallbox: { x: 'a', y: 2 } } }) })).json();
    assert.deepEqual(saved.pos, { pv: { x: 70, y: 80 } });
    assert.deepEqual((await (await fetch(base + 'api/live')).json()).view.pos, { pv: { x: 70, y: 80 } });

    // a missing data point
    adapter.change('go-e.0.nrg.11', null);
    await until(() => adapter.val('info.connection') === false, 4000);
    assert.equal((await (await fetch(base + 'api/live')).json()).s.missing[0], 'Wallbox');
});

test('adapter: access key, day values survive a restart, removed consumers disappear', async t => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'en-'));
    const date = new Date();
    const today = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    fs.writeFileSync(path.join(dataDir, 'energie.json'), JSON.stringify({ day: { date: today, e: { pv: 12500, house: 8000, import: 1000, export: 5500, charge: 0, discharge: 0 }, c: {} }, history: {} }));
    const { adapter, base } = await start(t, { accessKey: 'geheim', consumers: [] }, dataDir);
    await until(() => adapter.val('today.pv') !== undefined);
    assert.ok(adapter.val('today.pv') >= 12.5);
    assert.equal(adapter.val('today.autarky'), 88);
    assert.equal((await fetch(base + 'api/live')).status, 403);
    assert.equal((await fetch(base + 'flow')).status, 403);
    const ok = await fetch(base + 'flow?key=geheim');
    assert.equal(ok.status, 200);
    const cookie = ok.headers.get('set-cookie').split(';')[0];
    assert.equal((await fetch(base + 'api/live', { headers: { cookie } })).status, 200);
    assert.match(adapter.val('info.url'), /\/flow\?key=geheim$/);
    assert.equal(adapter.objects['energie.0.consumers.wallbox.power'], undefined);
});

test('adapter: wallbox surplus charging writes the current, mode from ioBroker', async t => {
    const { adapter } = await start(t, {
        consumers: [],
        wbPower: 'versicharge.0.power.total',
        wbCurrent: 'versicharge.0.control.current',
        wbPlugged: 'versicharge.0.status.plugged',
        wbPhases: '3',
        wbMax: 16,
        wbOnDelay: 0,
        wbOffDelay: 0,
    });
    adapter.add('versicharge.0.power.total', 'W', 0);
    adapter.change('versicharge.0.power.total', 0);
    await until(() => adapter.val('wallbox.mode') === 'pv');
    assert.equal(adapter.objects['energie.0.wallbox.mode'].common.states.fast, 'Schnell');
    // export 1800 W + battery 1000 W (car first, socMin 0) = 2800 W < 4140 W
    await until(() => /Wartet/.test(adapter.val('wallbox.status')));
    assert.equal(adapter.val('wallbox.available'), 2800);
    adapter.change('shelly.0.em3.Total_Power', -5000);
    await until(() => (adapter.writes || []).some(w => w.id === 'versicharge.0.control.current' && w.val === 8));
    assert.equal(adapter.states['versicharge.0.control.current'].ack, false);
    assert.equal(JSON.parse(adapter.val('live')).wallbox.mode, 'pv');
    adapter.command('wallbox.mode', 'Schnell');
    await until(() => adapter.writes.at(-1).val === 16);
    assert.equal(adapter.states['energie.0.wallbox.mode'].val, 'fast');
    assert.equal(adapter.states['energie.0.wallbox.mode'].ack, true);
    adapter.command('wallbox.mode', 'off');
    await until(() => adapter.writes.at(-1).val === 0);
    assert.ok(adapter.objects['energie.0.consumers.wallbox.power'], 'wallbox shown as consumer');
});

test('adapter: heat pump power above the threshold pauses the wallbox', async t => {
    const { adapter } = await start(t, {
        consumers: [],
        wbPower: 'versicharge.0.power.total',
        wbCurrent: 'versicharge.0.control.current',
        wbHp: 'modbus.0.wp_leistung',
        wbHpOn: 300,
        wbMode: 'fast',
    });
    adapter.add('versicharge.0.power.total', 'W', 0);
    adapter.add('modbus.0.wp_leistung', 'W', 100);
    adapter.change('modbus.0.wp_leistung', 100);
    await until(() => (adapter.writes || []).some(w => w.id === 'versicharge.0.control.current' && w.val === 16));
    adapter.change('modbus.0.wp_leistung', 2400);
    await until(() => adapter.val('wallbox.status') === 'Pause – Wärmepumpe läuft');
    await until(() => adapter.writes.at(-1).val === 0);
    assert.equal(JSON.parse(adapter.val('live')).wallbox.heatpump, true);
});

test('adapter: car charge level with factor (EU Data Act reports 212 for 21.2 %)', async t => {
    const { adapter } = await start(t, {
        consumers: [],
        wbPower: 'versicharge.0.power.total',
        wbCurrent: 'versicharge.0.control.current',
        wbCarSoc: 'vw-connect.0.VIN.statuseudata.value',
        wbCarSocScale: 0.1,
    });
    adapter.add('vw-connect.0.VIN.statuseudata.value', '', 212);
    adapter.change('vw-connect.0.VIN.statuseudata.value', 212);
    await until(() => adapter.val('wallbox.carSoc') === 21.2);
    adapter.change('vw-connect.0.VIN.statuseudata.value', 503);
    await until(() => adapter.val('wallbox.carSoc') === 50.3);
});

test('adapter: heat pump rule and import limit switchable via wallbox.hpPriority / wallbox.peakLimit', async t => {
    const { adapter } = await start(t, {
        consumers: [],
        wbPower: 'versicharge.0.power.total',
        wbCurrent: 'versicharge.0.control.current',
        wbHp: 'ochsner.0.status',
        wbHpKind: 'status',
        wbHpOff: '0',
        wbMode: 'fast',
        wbPeak: 12,
    });
    adapter.add('versicharge.0.power.total', 'W', 0);
    adapter.add('ochsner.0.status', '', 1);
    adapter.change('ochsner.0.status', 1);
    await until(() => adapter.val('wallbox.status') === 'Pause – Wärmepumpe läuft');
    assert.equal(adapter.val('wallbox.hpPriority'), true);
    assert.equal(adapter.val('wallbox.peakLimit'), 12);
    adapter.command('wallbox.hpPriority', false);
    await until(() => adapter.writes.at(-1).val === 16);
    assert.equal(adapter.states['energie.0.wallbox.hpPriority'].ack, true);
    adapter.command('wallbox.peakLimit', 2);
    await until(() => /Bezugsgrenze/.test(adapter.val('wallbox.status')));
    assert.equal(adapter.writes.at(-1).val, 0);
});

test('adapter: hot water switches the heat pump to Normal and back to Automatik', async t => {
    const { adapter } = await start(t, { hwUse: true, hwMode: 'ochsner-web2com.0.values.ww_mode', hwTemp: 'ochsner-web2com.0.values.ww_temp', hwValAuto: '1', hwValNormal: '4', hwStart: 45, hwTarget: 50, hwSurplusW: 1500, hwOnDelay: 0 });
    adapter.add('ochsner-web2com.0.values.ww_mode', '', 1);
    adapter.add('ochsner-web2com.0.values.ww_temp', '°C', 52);
    adapter.change('ochsner-web2com.0.values.ww_temp', 52);
    await until(() => adapter.val('hotwater.temp') === 52);
    assert.equal(adapter.val('hotwater.charging'), false);
    assert.ok(!(adapter.writes || []).some(w => w.id.endsWith('ww_mode')), 'nothing written at start');
    // export 1800 W >= 1500 W, below 55 - 3
    adapter.change('ochsner-web2com.0.values.ww_temp', 49);
    await until(() => (adapter.writes || []).some(w => w.id.endsWith('ww_mode') && w.val === 4));
    assert.equal(adapter.val('hotwater.reason'), 'Überschuss');
    adapter.change('ochsner-web2com.0.values.ww_mode', 4);
    adapter.change('ochsner-web2com.0.values.ww_temp', 55);
    await until(() => adapter.writes.at(-1).id.endsWith('ww_mode') && adapter.writes.at(-1).val === 1);
    assert.equal(adapter.writes.at(-1).ack, false);
    await until(() => adapter.val('hotwater.charging') === false);
    assert.ok(adapter.logs.some(l => /Warmwasser: fertig/.test(l)));
    // by hand, then control off -> Automatik again
    adapter.change('ochsner-web2com.0.values.ww_mode', 1);
    adapter.change('shelly.0.em3.Total_Power', 300);
    adapter.change('ochsner-web2com.0.values.ww_temp', 47);
    await until(() => /Automatik \(47/.test(adapter.val('hotwater.status')));
    adapter.command('hotwater.chargeNow', true);
    await until(() => adapter.writes.at(-1).val === 4 && adapter.val('hotwater.reason') === 'von Hand');
    adapter.change('ochsner-web2com.0.values.ww_mode', 4);
    adapter.command('hotwater.active', false);
    await until(() => adapter.writes.at(-1).val === 1);
    assert.equal(JSON.parse(adapter.val('live')).hotwater.status, 'Regelung aus');
});
