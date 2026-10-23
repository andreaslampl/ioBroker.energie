'use strict';

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const utils = require('@iobroker/adapter-core');
const { cleanConfig, inputs, convert, snapshot, Day, History, Surplus, Charger, MODES, dateKey } = require('./lib/model');
const { FlowServer } = require('./lib/server');

const TICK_MS = 2000;

/** {key: {x, y}} for pv, grid, battery, house, c_<consumer id>; numbers within the drawing */
function cleanPositions(pos) {
    const out = {};
    for (const [k, v] of Object.entries(pos && typeof pos === 'object' ? pos : {})) {
        if (/^(pv|grid|battery|house|c_[\w]{1,40})$/.test(k) && v && Number.isFinite(v.x) && Number.isFinite(v.y)) {
            out[k] = { x: Math.max(-300, Math.min(700, Math.round(v.x))), y: Math.max(-300, Math.min(700, Math.round(v.y))) };
        }
    }
    return out;
}
const SAVE_MS = 5 * 60000;

function localAddress() {
    for (const list of Object.values(os.networkInterfaces())) {
        for (const a of list || []) {
            if (a.family === 'IPv4' && !a.internal) {
                return a.address;
            }
        }
    }
    return '127.0.0.1';
}

const kwh = (en, de) => ({ type: 'number', role: 'value.energy', unit: 'kWh', read: true, write: false, name: { en, de } });
const watt = (en, de) => ({ type: 'number', role: 'value.power', unit: 'W', read: true, write: false, name: { en, de } });
const pct = (en, de) => ({ type: 'number', role: 'value', unit: '%', read: true, write: false, name: { en, de } });

/** today.* / yesterday.* */
const DAY_STATES = {
    pv: kwh('PV generated', 'PV erzeugt'),
    house: kwh('Consumed', 'Verbraucht'),
    import: kwh('Grid import', 'Netzbezug'),
    export: kwh('Grid export', 'Eingespeist'),
    charge: kwh('Battery charged', 'Batterie geladen'),
    discharge: kwh('Battery discharged', 'Batterie entladen'),
    autarky: pct('Autarky', 'Autarkie'),
    selfUse: pct('Self consumption', 'Eigenverbrauch'),
};

class Energie extends utils.Adapter {
    constructor(options) {
        super({ ...options, name: 'energie' });
        this.raw = new Map(); // state id -> raw value
        this.meta = new Map(); // state id -> {unit, exists}
        this.written = new Map(); // own state -> last value written
        this.wb = { mode: 'pv', current: null, plugged: null, sent: undefined, sentAt: 0, res: null, hp: null, carSoc: null, urgent: false };
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    async onReady() {
        await this.setState('info.connection', false, true);
        this.cfg = cleanConfig(this.config);
        this.dir0 = this.dataDir || utils.getAbsoluteInstanceDataDir(this);
        this.cfg.view.pos = this.loadPositions();
        this.inputs = inputs(this.cfg);
        this.dir = this.dataDir || utils.getAbsoluteInstanceDataDir(this);
        fs.mkdirSync(this.dir, { recursive: true });
        this.file = path.join(this.dir, 'energie.json');
        this.load();
        this.surplus = new Surplus(this.cfg.surplus);

        await this.createObjects();
        for (const input of this.inputs) {
            const obj = await this.getForeignObjectAsync(input.id).catch(() => null);
            this.meta.set(input.id, { unit: (obj && obj.common && obj.common.unit) || '', exists: Boolean(obj) });
            if (!obj) {
                this.log.warn(`Data point ${input.id} (${input.label}) does not exist`);
            }
            await this.subscribeForeignStatesAsync(input.id);
            const st = await this.getForeignStateAsync(input.id).catch(() => null);
            this.raw.set(input.id, st ? st.val : null);
        }
        if (!this.inputs.length) {
            this.log.warn('No data points configured yet - open the instance settings');
        }
        if (this.cfg.wallbox) {
            await this.startWallbox();
        }

        const port = Number(this.config.port) || 8101;
        const key = String(this.config.accessKey || '').trim();
        this.server = new FlowServer({
            accessKey: key,
            log: this.log,
            adapter: { live: () => this.live(), day: date => this.dayData(date), check: () => this.check(), setPositions: pos => this.setPositions(pos) },
        });
        try {
            await this.server.listen(port);
        } catch (err) {
            this.log.error(`Cannot open port ${port}: ${err.message}. Choose another port in the settings.`);
        }
        const host = String(this.config.publicHost || '').trim() || localAddress();
        const q = key ? `?key=${encodeURIComponent(key)}` : '';
        await this.setState('info.url', `http://${host}:${port}/flow${q}`, true);
        this.log.info(`Energy flow: http://${host}:${port}/flow - values check: http://${host}:${port}/check (${this.inputs.length} data point(s))`);

        await this.tick();
        this.timer = setInterval(() => this.tick().catch(err => this.log.warn(`Update: ${err.message}`)), TICK_MS);
        this.saveTimer = setInterval(() => this.save(), SAVE_MS);
    }

    // ---------------- wallbox (surplus charging) ----------------

    async startWallbox() {
        const w = this.cfg.wallbox;
        this.charger = new Charger(w);
        const st = await this.getStateAsync('wallbox.mode');
        this.wb.mode = st && MODES[st.val] ? st.val : w.mode;
        await this.setState('wallbox.mode', this.wb.mode, true);
        this.subscribeStates('wallbox.mode');
        for (const [key, id] of [
            ['current', w.current],
            ['plugged', w.plugged],
            ['hp', w.hp],
            ['carSoc', w.carSoc],
        ]) {
            if (id) {
                if (key === 'hp') {
                    const obj = await this.getForeignObjectAsync(id).catch(() => null);
                    this.wb.hpUnit = (obj && obj.common && obj.common.unit) || '';
                }
                await this.subscribeForeignStatesAsync(id);
                const s = await this.getForeignStateAsync(id).catch(() => null);
                this.wbValue(key, s ? s.val : null);
            }
        }
        if (!w.current) {
            this.log.warn('Wallbox: no data point for the charging current - the wallbox is only shown, not controlled');
        }
        this.log.info(`Wallbox ${w.name}: mode ${MODES[this.wb.mode]}, ${w.phases}-phase, ${w.min}-${w.max} A, starts from ${((w.min * w.volt * w.phases) / 1000).toFixed(1)} kW surplus`);
    }

    wbValue(key, val) {
        if (key === 'hp') {
            // heat pump runs: true, or a power above the threshold (W, kW from the object's unit)
            const n = typeof val === 'boolean' ? null : convert(val, { unit: 'auto', scale: 1 }, this.wb.hpUnit);
            this.wb.hp = val === null || val === undefined ? null : typeof val === 'boolean' ? val : n !== null && n > this.cfg.wallbox.hpOn;
        } else if (key === 'carSoc') {
            const n = Number(val);
            this.wb.carSoc = val === null || val === undefined || val === '' || !Number.isFinite(n) ? null : n;
        } else if (key === 'plugged') {
            this.wb.plugged = val === null || val === undefined ? null : val === true || val === 1 || val === 'true';
        } else {
            const n = Number(val);
            this.wb.current = val === null || val === undefined || !Number.isFinite(n) ? null : n;
        }
    }

    /** mode from ioBroker / SmartView: key (pv) or text (PV, Schnell) */
    async setMode(val) {
        const v = String(val ?? '').trim().toLowerCase();
        const mode = Object.keys(MODES).find(k => k === v || MODES[k].toLowerCase() === v);
        if (!mode) {
            this.log.warn(`Wallbox: unknown mode "${val}" (${Object.keys(MODES).join(', ')})`);
            await this.setState('wallbox.mode', this.wb.mode, true);
            return;
        }
        if (mode !== this.wb.mode) {
            this.log.info(`Wallbox: mode ${MODES[mode]}`);
        }
        this.wb.mode = mode;
        this.wb.sentAt = 0; // a new mode may write at once
        await this.setState('wallbox.mode', mode, true);
        await this.tick();
    }

    async controlWallbox(s) {
        const w = this.cfg.wallbox;
        const res = this.charger.update(s, { mode: this.wb.mode, plugged: this.wb.plugged, heatpump: this.wb.hp, carSoc: this.wb.carSoc });
        if (res.urgent !== this.wb.urgent) {
            this.wb.urgent = res.urgent;
            if (res.urgent) {
                this.log.info(`Wallbox: car at ${this.wb.carSoc} % would not reach ${w.target} % by ${w.ready} - charging with at least ${w.min} A despite heat pump / import limit`);
            }
        }
        await this.put('wallbox.urgent', res.urgent);
        this.wb.res = res;
        await this.put('wallbox.status', res.status);
        await this.put('wallbox.available', res.available);
        await this.put('wallbox.target', res.amps);
        if (res.amps === null || !w.current) {
            this.wb.sent = undefined;
            return;
        }
        const since = s.ts - this.wb.sentAt;
        const changed = res.amps !== this.wb.sent;
        // pausing/starting at once, other changes at most every 10 s; repeat when the wallbox shows something else
        const due = since >= w.minWrite || res.amps === 0 || !this.wb.sent;
        const drift = this.wb.current !== null && Math.abs(this.wb.current - res.amps) >= 0.5 && since >= 30000;
        if ((changed && due) || drift) {
            this.wb.sent = res.amps;
            this.wb.sentAt = s.ts;
            this.log.debug(`Wallbox: ${res.amps} A (${res.status}, available ${res.available} W)`);
            await this.setForeignStateAsync(w.current, res.amps, false);
            if (w.enable) {
                await this.setForeignStateAsync(w.enable, res.amps > 0, false);
            }
        }
    }

    // ---------------- own arrangement of the symbols (positions.json) ----------------

    loadPositions() {
        try {
            return cleanPositions(JSON.parse(fs.readFileSync(path.join(this.dir0, 'positions.json'), 'utf8')));
        } catch {
            return {};
        }
    }

    setPositions(pos) {
        const clean = cleanPositions(pos);
        fs.mkdirSync(this.dir0, { recursive: true });
        fs.writeFileSync(path.join(this.dir0, 'positions.json'), JSON.stringify(clean));
        this.cfg.view.pos = clean;
        this.log.info(`Arrangement saved (${Object.keys(clean).length} symbol(s) moved)`);
        this.tick().catch(() => {});
        return clean;
    }

    // ---------------- persistence ----------------

    load() {
        let data = {};
        try {
            data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        } catch {
            // first start
        }
        this.history = new History(data.history);
        const today = dateKey(Date.now());
        const day = data.day && data.day.date ? new Day(data.day.date, data.day) : null;
        if (day && day.date === today) {
            this.day = day;
        } else {
            if (day) {
                // the adapter was stopped over midnight
                this.history.setDay(day.summary());
            }
            this.day = new Day(today);
        }
    }

    save() {
        try {
            fs.writeFileSync(`${this.file}.tmp`, JSON.stringify({ day: this.day, history: this.history }));
            fs.renameSync(`${this.file}.tmp`, this.file);
        } catch (err) {
            this.log.warn(`Cannot save ${this.file}: ${err.message}`);
        }
    }

    // ---------------- objects ----------------

    async createObjects() {
        const channel = async (id, de, en) => this.extendObject(id, { type: 'channel', common: { name: { en, de } }, native: {} });
        const state = async (id, common) => this.extendObject(id, { type: 'state', common, native: {} });
        await channel('power', 'Leistung jetzt', 'Power now');
        await state('power.pv', watt('PV power', 'PV-Leistung'));
        await state('power.grid', watt('Grid (+ import / - export)', 'Netz (+ Bezug / - Einspeisung)'));
        await state('power.import', watt('Grid import', 'Netzbezug'));
        await state('power.export', watt('Grid export', 'Einspeisung'));
        await state('power.house', watt('House consumption', 'Hausverbrauch'));
        if (this.cfg.battery) {
            await state('power.battery', watt('Battery (+ charging / - discharging)', 'Batterie (+ laden / - entladen)'));
            await state('power.soc', { ...pct('Battery charge level', 'Batterie-Ladestand'), role: 'value.battery' });
        }
        for (const [folder, de, en] of [
            ['today', 'Heute', 'Today'],
            ['yesterday', 'Gestern', 'Yesterday'],
        ]) {
            await channel(folder, de, en);
            for (const [k, common] of Object.entries(DAY_STATES)) {
                await state(`${folder}.${k}`, common);
            }
        }
        await channel('surplus', 'Überschuss', 'Surplus');
        await state('surplus.power', watt('Surplus power', 'Überschuss-Leistung'));
        await state('surplus.active', {
            type: 'boolean',
            role: 'indicator',
            read: true,
            write: false,
            name: { en: 'Surplus available (thresholds and delay from the settings)', de: 'Überschuss vorhanden (Schwellen und Verzögerung aus den Einstellungen)' },
        });
        if (this.cfg.wallbox) {
            await channel('wallbox', this.cfg.wallbox.name, this.cfg.wallbox.name);
            await state('wallbox.mode', {
                type: 'string',
                role: 'level.mode',
                read: true,
                write: true,
                states: MODES,
                name: { en: 'Charging mode', de: 'Lademodus' },
            });
            await state('wallbox.status', { type: 'string', role: 'text', read: true, write: false, name: { en: 'Charging control', de: 'Laderegelung' } });
            await state('wallbox.target', { type: 'number', role: 'value.current', unit: 'A', read: true, write: false, name: { en: 'Charging current set', de: 'Vorgegebener Ladestrom' } });
            await state('wallbox.available', watt('Power available for the car', 'Leistung fürs Auto verfügbar'));
            await state('wallbox.urgent', {
                type: 'boolean',
                role: 'indicator',
                read: true,
                write: false,
                name: { en: 'Car would not be ready in time - charges despite heat pump / limit', de: 'Auto würde nicht rechtzeitig voll – lädt trotz Wärmepumpe / Grenze' },
            });
        }
        await state('live', { type: 'string', role: 'json', read: true, write: false, name: { en: 'Live values (JSON, for SmartView)', de: 'Live-Werte (JSON, für SmartView)' } });
        // consumers: own folder per consumer; old ones are removed
        const ids = new Set(this.cfg.consumers.map(c => c.id));
        const objs = await this.getAdapterObjectsAsync();
        for (const id of Object.keys(objs)) {
            const m = new RegExp(`^${this.namespace.replace('.', '\\.')}\\.consumers\\.([^.]+)`).exec(id);
            if (m && !ids.has(m[1])) {
                await this.delObjectAsync(id).catch(() => {});
            }
        }
        if (this.cfg.consumers.length) {
            await channel('consumers', 'Verbraucher', 'Consumers');
        }
        for (const c of this.cfg.consumers) {
            await channel(`consumers.${c.id}`, c.name, c.name);
            await state(`consumers.${c.id}.power`, watt(`${c.name} power`, `${c.name} Leistung`));
            await state(`consumers.${c.id}.today`, kwh(`${c.name} today`, `${c.name} heute`));
        }
    }

    async put(id, val) {
        if (this.written.get(id) === val) {
            return;
        }
        this.written.set(id, val);
        await this.setState(id, val, true);
    }

    // ---------------- values ----------------

    value(id) {
        const input = this.inputs.find(i => i.id === id);
        const meta = this.meta.get(id) || {};
        return input ? convert(this.raw.get(id), input, meta.unit) : null;
    }

    onStateChange(id, state) {
        if (this.meta.has(id)) {
            this.raw.set(id, state ? state.val : null);
        }
        const w = this.cfg && this.cfg.wallbox;
        if (!w) {
            return;
        }
        if (id === `${this.namespace}.wallbox.mode` && state && !state.ack) {
            this.setMode(state.val).catch(err => this.log.warn(`Wallbox: ${err.message}`));
        }
        if (id === w.current) {
            this.wbValue('current', state ? state.val : null);
        }
        if (id === w.plugged) {
            this.wbValue('plugged', state ? state.val : null);
        }
        if (id === w.hp) {
            this.wbValue('hp', state ? state.val : null);
        }
        if (id === w.carSoc) {
            this.wbValue('carSoc', state ? state.val : null);
        }
    }

    async tick() {
        const s = snapshot(this.cfg, id => this.value(id));
        if (dateKey(s.ts) !== this.day.date) {
            await this.newDay(s.ts);
        } else if (this.prev) {
            this.day.add(this.prev, s);
        }
        this.prev = s;
        this.history.add(s);
        this.sur = this.surplus.update(s);
        this.last = s;

        await this.put('power.pv', s.pv);
        await this.put('power.grid', s.grid === null ? null : s.grid);
        await this.put('power.import', s.import);
        await this.put('power.export', s.export);
        await this.put('power.house', s.house);
        if (this.cfg.battery) {
            await this.put('power.battery', s.battery);
            await this.put('power.soc', s.soc);
        }
        const t = this.day.summary();
        for (const k of Object.keys(DAY_STATES)) {
            await this.put(`today.${k}`, t[k]);
        }
        for (const c of s.consumers) {
            await this.put(`consumers.${c.id}.power`, c.w);
            await this.put(`consumers.${c.id}.today`, t.consumers[c.id] || 0);
        }
        await this.put('surplus.power', this.sur.power);
        await this.put('surplus.active', this.sur.active);
        if (this.charger) {
            await this.controlWallbox(s);
        }
        await this.put('info.connection', this.inputs.length > 0 && s.missing.length === 0);
        const live = this.live();
        await this.put('live', JSON.stringify(live));
        if (this.server) {
            this.server.push(live);
        }
    }

    async newDay(ts) {
        const summary = this.day.summary();
        this.history.flush();
        this.history.setDay(summary);
        for (const k of Object.keys(DAY_STATES)) {
            await this.put(`yesterday.${k}`, summary[k]);
        }
        this.day = new Day(dateKey(ts));
        this.prev = null;
        this.save();
        this.log.info(`Day ${summary.date}: PV ${summary.pv} kWh, consumed ${summary.house} kWh, import ${summary.import} kWh, export ${summary.export} kWh, autarky ${summary.autarky ?? '-'} %`);
    }

    live() {
        const w = this.cfg.wallbox;
        const r = this.wb.res;
        const wallbox = w
            ? { name: w.name, consumer: w.consumer, heatpump: this.wb.hp, urgent: Boolean(r && r.urgent), mode: this.wb.mode, modes: MODES, status: r ? r.status : '', amps: r ? r.amps : null, available: r ? r.available : null, plugged: this.wb.plugged, current: this.wb.current }
            : null;
        return { s: this.last || null, today: this.day ? this.day.summary() : null, surplus: this.sur || null, view: this.cfg.view, wallbox };
    }

    /** chart data of a day (today when no date) */
    dayData(date) {
        const today = this.day.date;
        const d = this.history.day(date || today);
        if (d.date === today) {
            d.summary = this.day.summary();
            if (!d.dates.includes(today)) {
                d.dates.push(today);
            }
        }
        return d;
    }

    async check() {
        const desc = i => {
            if (i.unit === 'raw') {
                return i.scale !== 1 ? `Faktor ${String(i.scale).replace('.', ',')}` : '–';
            }
            const meta = this.meta.get(i.id) || {};
            const parts = [i.unit === 'auto' ? `Einheit automatisch (${/^kw$/i.test(meta.unit) ? 'kW' : 'W'}${meta.unit ? ' vom Objekt' : ''})` : `Einheit ${i.unit}`];
            if (i.scale !== 1) {
                parts.push(`Faktor ${String(i.scale).replace('.', ',')}`);
            }
            if (i.signed) {
                parts.push(`Vorzeichen ${i.signed} Bit`);
            }
            if (i.invert) {
                parts.push('umgekehrt');
            }
            return parts.join(' · ');
        };
        return {
            inputs: this.inputs.map(i => {
                const meta = this.meta.get(i.id) || {};
                const raw = this.raw.get(i.id);
                return { id: i.id, label: i.label, exists: meta.exists !== false, objUnit: meta.unit || '', raw: raw === undefined ? null : raw, unit: i.unit, setting: desc(i), value: this.value(i.id) };
            }),
            s: this.last || snapshot(this.cfg, id => this.value(id)),
            houseMeasured: Boolean(this.cfg.house),
            surplus: this.sur || { power: 0, active: false },
        };
    }

    /** SmartView asks: live {} -> live values, day {date} -> chart data */
    onMessage(obj) {
        if (!obj || !obj.command || !obj.callback) {
            return;
        }
        let res;
        if (obj.command === 'live') {
            res = this.live();
        } else if (obj.command === 'day') {
            const date = obj.message && obj.message.date;
            res = this.dayData(/^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) ? date : null);
        } else {
            res = { error: `unknown command ${obj.command}` };
        }
        this.sendTo(obj.from, obj.command, res, obj.callback);
    }

    async onUnload(callback) {
        try {
            clearInterval(this.timer);
            clearInterval(this.saveTimer);
            if (this.day) {
                this.save();
            }
            if (this.server) {
                await this.server.close();
            }
            await this.setState('info.connection', false, true);
        } finally {
            callback();
        }
    }
}

if (require.main !== module) {
    module.exports = options => new Energie(options);
} else {
    new Energie();
}
