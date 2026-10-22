'use strict';

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const utils = require('@iobroker/adapter-core');
const { cleanConfig, inputs, convert, snapshot, Day, History, Surplus, dateKey } = require('./lib/model');
const { FlowServer } = require('./lib/server');

const TICK_MS = 2000;
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
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    async onReady() {
        await this.setState('info.connection', false, true);
        this.cfg = cleanConfig(this.config);
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

        const port = Number(this.config.port) || 8101;
        const key = String(this.config.accessKey || '').trim();
        this.server = new FlowServer({
            accessKey: key,
            log: this.log,
            adapter: { live: () => this.live(), day: date => this.dayData(date), check: () => this.check() },
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
        return { s: this.last || null, today: this.day ? this.day.summary() : null, surplus: this.sur || null };
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
