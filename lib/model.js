'use strict';

/*
 * Energy model, independent of ioBroker:
 *   cleanConfig()  instance settings -> sources (PV, grid, battery, house, consumers)
 *   snapshot()     current values (W) -> powers of all nodes, house computed when not measured
 *   Day            energy of the day (Wh, trapezoid between ticks), autarky / self consumption
 *   History        5-minute averages per day (8 days) and daily summaries (400 days)
 *   Surplus        surplus signal with switch-on/-off thresholds and delay
 *   Charger        wallbox control: charging current from the surplus (modes off / pv / minpv / fast / manual)
 *
 * Signs inside the model: grid > 0 = import, battery > 0 = charging. Values in W.
 */

// symbols of www/render.js
const ICONS = ['sun', 'panel', 'roof', 'inverter', 'grid', 'pylon', 'meter', 'battery', 'house', 'factory', 'car', 'wallbox', 'heatpump', 'water', 'boiler', 'heat', 'ac', 'pool', 'pump', 'washer', 'kitchen', 'tv', 'server', 'light', 'plug', 'other'];
const UNITS = ['auto', 'W', 'kW'];

const str = (v, max = 200) => String(v === undefined || v === null ? '' : v).trim().slice(0, max);
const num = (v, def) => (v !== '' && v !== null && v !== undefined && Number.isFinite(Number(v)) ? Number(v) : def);
const unit = v => (UNITS.includes(v) ? v : 'auto');
// Modbus: raw register values often need a factor (0.1, 10 …) and a sign (65535 = -1)
const scale = v => (num(v, 1) === 0 ? 1 : num(v, 1));
const signed = v => (['16', '32'].includes(String(v)) ? String(v) : '');
/** unit/factor/sign settings of a data point from a config row with the given prefix */
const conv = (o, prefix = '') => ({
    unit: unit(o[`${prefix}unit`] ?? o[`${prefix}Unit`]),
    scale: scale(o[`${prefix}scale`] ?? o[`${prefix}Scale`]),
    signed: signed(o[`${prefix}signed`] ?? o[`${prefix}Signed`]),
    // "umgekehrt": negative values become positive and vice versa
    invert: Boolean(o[`${prefix}invert`] ?? o[`${prefix}Invert`]),
});
// where a consumer's line starts in the flow (display only): house, pv, grid, battery or another consumer
// ('consumer' + fromName, resolved to 'c_<id>' in linkConsumers())
const FROM = ['house', 'pv', 'grid', 'battery', 'consumer'];
const from = v => (FROM.includes(v) ? v : 'house');
const slug = s =>
    String(s)
        .toLowerCase()
        .replace(/ä/g, 'ae')
        .replace(/ö/g, 'oe')
        .replace(/ü/g, 'ue')
        .replace(/ß/g, 'ss')
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 30);

/** 'consumer' + fromName -> 'c_<id>' of that consumer (by name or id); unknown, itself or a loop -> house */
function linkConsumers(consumers) {
    const find = name => {
        const n = String(name || '').trim().toLowerCase();
        return n ? consumers.find(x => x.name.toLowerCase() === n || x.id === slug(n)) : null;
    };
    for (const x of consumers) {
        if (x.from === 'consumer') {
            const src = find(x.fromName);
            x.from = src && src !== x ? 'c_' + src.id : 'house';
        }
        delete x.fromName;
    }
    // a loop (A from B, B from A ...) would draw nonsense: those go back to the house
    for (const x of consumers) {
        const seen = new Set([x.id]);
        let cur = x;
        while (cur && cur.from.startsWith('c_')) {
            const next = consumers.find(y => 'c_' + y.id === cur.from);
            if (!next || seen.has(next.id)) {
                x.from = 'house';
                break;
            }
            seen.add(next.id);
            cur = next;
        }
    }
}

function cleanConfig(c = {}) {
    // main PV field + table of more inverters/strings (pvMore; 0.1.0 had only the table `pv`)
    const main = str(c.pvState) ? [{ name: 'PV', state: c.pvState, unit: c.pvUnit, scale: c.pvScale, signed: c.pvSigned, invert: c.pvInvert }] : [];
    const more = [...(Array.isArray(c.pvMore) ? c.pvMore : []), ...(Array.isArray(c.pv) ? c.pv : [])];
    const pv = [...main, ...more]
        .filter(p => p && str(p.state))
        .slice(0, 6)
        .map((p, i) => ({ name: str(p.name, 40) || `PV ${i + 1}`, state: str(p.state, 300), ...conv(p) }));
    const split = c.gridMode === 'split';
    const grid = {
        mode: split ? 'split' : 'single',
        state: split ? '' : str(c.gridState, 300),
        positive: c.gridPositive === 'export' ? 'export' : 'import',
        importState: split ? str(c.gridImport, 300) : '',
        exportState: split ? str(c.gridExport, 300) : '',
        ...conv(c, 'grid'),
    };
    const battery = str(c.batteryState)
        ? { state: str(c.batteryState, 300), positive: c.batteryPositive === 'discharge' ? 'discharge' : 'charge', soc: str(c.batterySoc, 300), socScale: scale(c.batterySocScale), ...conv(c, 'battery') }
        : null;
    const house = str(c.houseState) ? { state: str(c.houseState, 300), ...conv(c, 'house') } : null;
    const seen = new Set();
    const consumers = (Array.isArray(c.consumers) ? c.consumers : [])
        .filter(x => x && str(x.state))
        .slice(0, 8)
        .map((x, i) => {
            const name = str(x.name, 40) || `Verbraucher ${i + 1}`;
            let id = slug(name) || `c${i + 1}`;
            while (seen.has(id)) {
                id += '_';
            }
            seen.add(id);
            return { id, name, state: str(x.state, 300), ...conv(x), icon: ICONS.includes(x.icon) ? x.icon : 'plug', from: from(x.from), fromName: str(x.fromName, 40) };
        });
    const wallbox = cleanWallbox(c, consumers, seen);
    linkConsumers(consumers);
    const surplus = {
        on: Math.max(0, num(c.surplusOn, 1500)),
        off: Math.max(0, num(c.surplusOff, 300)),
        delay: Math.max(0, num(c.surplusDelay, 5)) * 60000,
        battery: Boolean(c.surplusBattery),
    };
    const icon = (v, def) => (ICONS.includes(v) ? v : def);
    const view = {
        shape: c.shape === 'square' ? 'square' : 'round',
        line: ['dash', 'solid'].includes(c.lineStyle) ? c.lineStyle : 'dots',
        // default on: the owner's touch PC has Windows animation effects off
        anim: ['auto', 'off'].includes(c.animation) ? c.animation : 'on',
        icons: { pv: icon(c.pvIcon, 'sun'), grid: icon(c.gridIcon, 'grid'), battery: icon(c.batteryIcon, 'battery'), house: icon(c.houseIcon, 'house') },
        // animation speed factor (1 = as before; still faster with more power)
        speed: Math.max(0.25, Math.min(4, num(c.animSpeed, 1) || 1)),
        // house outline by where its power comes from: green = PV/battery only, orange = import up to houseWarn W, red = more
        houseColor: Boolean(c.houseColor),
        houseWarn: Math.max(0, num(c.houseWarn, 1000)),
    };
    return { pv, grid, battery, house, consumers, surplus, view, wallbox };
}

const MODES = { off: 'Aus', pv: 'PV', minpv: 'Min+PV', fast: 'Schnell', manual: 'Manuell' };

/**
 * Wallbox (null when neither power nor current data point is set). Its power is shown as a consumer
 * (id 'wallbox', or the existing consumer with the same data point).
 */
function cleanWallbox(c, consumers, seen) {
    const power = str(c.wbPower, 300);
    const current = str(c.wbCurrent, 300);
    if (!power && !current) {
        return null;
    }
    const name = str(c.wbName, 40) || 'Wallbox';
    let consumer = power ? consumers.find(x => x.state === power) : null;
    if (power && !consumer && consumers.length < 9) {
        let id = 'wallbox';
        while (seen.has(id)) {
            id += '_';
        }
        seen.add(id);
        consumer = { id, name, state: power, ...conv(c, 'wb'), icon: ICONS.includes(c.wbIcon) ? c.wbIcon : 'car', from: from(c.wbFrom), fromName: str(c.wbFromName, 40) };
        consumers.push(consumer);
    }
    const min = Math.max(1, Math.min(32, num(c.wbMin, 6)));
    return {
        name,
        consumer: consumer ? consumer.id : null,
        current,
        enable: str(c.wbEnable, 300),
        plugged: str(c.wbPlugged, 300),
        phases: Number(c.wbPhases) === 1 ? 1 : 3,
        volt: Math.max(100, Math.min(260, num(c.wbVolt, 230))),
        min,
        max: Math.max(min, Math.min(80, num(c.wbMax, 16))),
        onDelay: Math.max(0, num(c.wbOnDelay, 60)) * 1000,
        offDelay: Math.max(0, num(c.wbOffDelay, 300)) * 1000,
        allowImport: Math.max(0, num(c.wbImport, 0)),
        // battery first until this charge level (%); 0 = car first
        socMin: Math.max(0, Math.min(100, num(c.wbSocMin, 0))),
        mode: MODES[c.wbMode] ? c.wbMode : 'pv',
        // wallbox before the inverter's meter: its power is not in grid / house values -> added in snapshot()
        outside: Boolean(c.wbOutside),
        // heat pump first (power-based grid tariff): pause or minimum current while it runs
        hp: str(c.wbHp, 300),
        hpOn: Math.max(0, num(c.wbHpOn, 200)),
        // auto: true/false or power; power: runs above hpOn W; status: off at the listed values (numbers or texts)
        hpKind: ['power', 'status'].includes(c.wbHpKind) ? c.wbHpKind : 'auto',
        hpOff: str(c.wbHpOff === undefined ? '0' : c.wbHpOff, 300)
            .split(/[;,]/)
            .map(x => x.trim().toLowerCase())
            .filter(Boolean),
        // heat pump first on/off (older settings: action 'none' = off); action while it runs: pause | min
        hpUse: c.wbHpUse === undefined || c.wbHpUse === null ? c.wbHpAction !== 'none' : Boolean(c.wbHpUse),
        // limit = the car keeps charging with what is left up to the import limit (the heat pump counts in the house)
        hpAction: ['min', 'limit'].includes(c.wbHpAction) ? c.wbHpAction : 'pause',
        // grid import incl. the car at most this (W), 0 = off
        peak: Math.max(0, num(c.wbPeak, 0)) * 1000,
        // import limit on/off (older settings without the checkbox: on, 0 kW = no limit anyway)
        peakUse: c.wbPeakUse === undefined || c.wbPeakUse === null ? true : Boolean(c.wbPeakUse),
        // kept free below the limit for the house (W): the car follows a rising house load with a delay
        peakReserve: Math.max(0, num(c.wbPeakReserve, 500)),
        // ready by: car charge level, capacity, target, time -> charge anyway (minimum current) when it gets tight
        carSoc: str(c.wbCarSoc, 300),
        // factor for the charge level, e.g. 0.1 when the car reports 212 for 21.2 % (EU Data Act)
        carSocScale: num(c.wbCarSocScale, 1) || 1,
        capacity: Math.max(1, Math.min(200, num(c.wbCapacity, 77))),
        target: Math.max(1, Math.min(100, num(c.wbTarget, 80))),
        ready: /^([01]?\d|2[0-3]):[0-5]\d$/.test(str(c.wbReady)) ? str(c.wbReady) : '',
        minWrite: 10000, // at most every 10 s a new current (the car needs time to follow)
    };
}

/** All data points to read: {id, label, unit, scale, signed}. */
function inputs(cfg) {
    const out = [];
    const add = (id, label, c) => id && !out.some(x => x.id === id) && out.push({ id, label, unit: c.unit, scale: c.scale, signed: c.signed, invert: Boolean(c.invert) });
    cfg.pv.forEach(p => add(p.state, p.name, p));
    add(cfg.grid.state, 'Netz', cfg.grid);
    add(cfg.grid.importState, 'Netzbezug', cfg.grid);
    add(cfg.grid.exportState, 'Einspeisung', cfg.grid);
    if (cfg.battery) {
        add(cfg.battery.state, 'Batterie', cfg.battery);
        add(cfg.battery.soc, 'Ladestand %', { unit: 'raw', scale: cfg.battery.socScale, signed: '', invert: false });
    }
    if (cfg.house) {
        add(cfg.house.state, 'Haus', cfg.house);
    }
    cfg.consumers.forEach(x => add(x.state, x.name, x));
    return out;
}

/**
 * Raw value of a data point -> W (or % for the charge level): sign of Modbus registers,
 * factor, unit (kW from the object or the setting). null when not a number.
 */
function convert(raw, input, objUnit) {
    let v = typeof raw === 'boolean' ? Number(raw) : Number(typeof raw === 'string' ? raw.replace(',', '.') : raw);
    if (raw === null || raw === undefined || raw === '' || !Number.isFinite(v)) {
        return null;
    }
    if (input.signed === '16' && v >= 32768 && v < 65536) {
        v -= 65536;
    } else if (input.signed === '32' && v >= 2147483648 && v < 4294967296) {
        v -= 4294967296;
    }
    return v * (input.scale || 1) * factor(input.unit, objUnit) * (input.invert ? -1 : 1);
}

/** Factor to W from the unit setting and the object's unit. */
function factor(setting, objUnit) {
    if (setting === 'raw') {
        return 1;
    }
    if (setting === 'kW') {
        return 1000;
    }
    if (setting === 'W') {
        return 1;
    }
    const u = String(objUnit || '').trim().toLowerCase();
    return u === 'kw' ? 1000 : u === 'mw' ? 1e6 : 1;
}

const r0 = v => Math.round(v);

/**
 * Powers now. `get(id)` returns the value in W (already scaled) or null when unknown.
 * House = measured, or PV + import - export + discharge - charge.
 */
function snapshot(cfg, get, ts = Date.now()) {
    const missing = [];
    const val = (id, name) => {
        const v = id ? get(id) : null;
        if (id && (v === null || v === undefined || !Number.isFinite(v))) {
            missing.push(name);
            return 0;
        }
        return v || 0;
    };
    const pvParts = cfg.pv.map(p => ({ name: p.name, w: r0(Math.max(0, val(p.state, p.name))) }));
    const pv = pvParts.reduce((s, p) => s + p.w, 0);
    let grid;
    if (cfg.grid.mode === 'split') {
        grid = Math.abs(val(cfg.grid.importState, 'Netzbezug')) - Math.abs(val(cfg.grid.exportState, 'Einspeisung'));
    } else {
        const g = val(cfg.grid.state, 'Netz');
        grid = cfg.grid.positive === 'export' ? -g : g;
    }
    const hasGrid = Boolean(cfg.grid.state || cfg.grid.importState || cfg.grid.exportState);
    let battery = null;
    let soc = null;
    if (cfg.battery) {
        const b = val(cfg.battery.state, 'Batterie');
        battery = cfg.battery.positive === 'discharge' ? -b : b;
        if (cfg.battery.soc) {
            const s = get(cfg.battery.soc);
            soc = Number.isFinite(s) ? Math.max(0, Math.min(100, Math.round(s))) : null;
        }
    }
    // wallbox before the inverter's meter: the meter does not see it -> add it to grid and house
    const w = cfg.wallbox;
    const outside = w && w.outside && w.consumer ? cfg.consumers.find(x => x.id === w.consumer) : null;
    const carOut = outside ? Math.max(0, Number(get(outside.state)) || 0) : 0;
    if (hasGrid) {
        grid += carOut;
    }
    const house = cfg.house ? Math.max(0, val(cfg.house.state, 'Haus')) + carOut : Math.max(0, pv + grid - (battery || 0));
    const consumers = cfg.consumers.map(x => ({ id: x.id, name: x.name, icon: x.icon, from: x.from || 'house', w: r0(Math.max(0, val(x.state, x.name))) }));
    const used = consumers.reduce((s, x) => s + x.w, 0);
    return {
        ts,
        pv: r0(pv),
        pvParts,
        grid: hasGrid ? r0(grid) : null,
        import: hasGrid ? r0(Math.max(0, grid)) : 0,
        export: hasGrid ? r0(Math.max(0, -grid)) : 0,
        battery: battery === null ? null : r0(battery),
        charge: r0(Math.max(0, battery || 0)),
        discharge: r0(Math.max(0, -(battery || 0))),
        soc,
        house: r0(house),
        consumers,
        rest: r0(Math.max(0, house - used)),
        missing,
    };
}

const ENERGY_KEYS = ['pv', 'import', 'export', 'charge', 'discharge', 'house'];

function dateKey(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Energy of one day in Wh. */
class Day {
    constructor(date, data) {
        this.date = date;
        this.e = Object.fromEntries(ENERGY_KEYS.map(k => [k, Number((data && data.e && data.e[k]) || 0)]));
        this.c = { ...((data && data.c) || {}) };
    }

    /** add the energy between two snapshots (gaps over 5 minutes are not counted) */
    add(prev, cur) {
        const dt = cur.ts - prev.ts;
        if (!(dt > 0) || dt > 300000) {
            return;
        }
        const h = dt / 3600000;
        for (const k of ENERGY_KEYS) {
            this.e[k] += ((prev[k] || 0) + (cur[k] || 0)) * 0.5 * h;
        }
        for (const x of cur.consumers) {
            const p = prev.consumers.find(y => y.id === x.id);
            this.c[x.id] = (this.c[x.id] || 0) + ((p ? p.w : x.w) + x.w) * 0.5 * h;
        }
    }

    /** kWh with 2 decimals, autarky and self consumption in %. */
    summary() {
        const k = v => Math.round(v / 10) / 100;
        const e = this.e;
        const pct = v => Math.max(0, Math.min(100, Math.round(v * 100)));
        return {
            date: this.date,
            pv: k(e.pv),
            import: k(e.import),
            export: k(e.export),
            charge: k(e.charge),
            discharge: k(e.discharge),
            house: k(e.house),
            autarky: e.house > 1 ? pct(1 - e.import / e.house) : null,
            selfUse: e.pv > 1 ? pct(1 - e.export / e.pv) : null,
            consumers: Object.fromEntries(Object.entries(this.c).map(([id, v]) => [id, k(v)])),
        };
    }

    toJSON() {
        return { date: this.date, e: this.e, c: this.c };
    }
}

const STEP = 5 * 60000;

/** 5-minute averages for the day chart; daily summaries for longer views. */
class History {
    constructor(data = {}) {
        this.points = data.points && typeof data.points === 'object' ? data.points : {}; // date -> [{t, pv, house, grid, battery, soc}]
        this.days = data.days && typeof data.days === 'object' ? data.days : {}; // date -> summary
        this.bucket = data.bucket || null;
    }

    add(s) {
        const start = Math.floor(s.ts / STEP) * STEP;
        if (this.bucket && this.bucket.t !== start) {
            this.flush();
        }
        if (!this.bucket) {
            this.bucket = { t: start, n: 0, pv: 0, house: 0, grid: 0, battery: 0, soc: null };
        }
        const b = this.bucket;
        b.n++;
        b.pv += s.pv;
        b.house += s.house;
        b.grid += s.grid || 0;
        b.battery += s.battery || 0;
        if (s.soc !== null) {
            b.soc = s.soc;
        }
    }

    flush() {
        const b = this.bucket;
        this.bucket = null;
        if (!b || !b.n) {
            return;
        }
        const date = dateKey(b.t);
        const p = { t: b.t, pv: r0(b.pv / b.n), house: r0(b.house / b.n), grid: r0(b.grid / b.n), battery: r0(b.battery / b.n) };
        if (b.soc !== null) {
            p.soc = b.soc;
        }
        (this.points[date] = this.points[date] || []).push(p);
        const dates = Object.keys(this.points).sort();
        for (const d of dates.slice(0, Math.max(0, dates.length - 8))) {
            delete this.points[d];
        }
    }

    setDay(summary) {
        this.days[summary.date] = summary;
        const dates = Object.keys(this.days).sort();
        for (const d of dates.slice(0, Math.max(0, dates.length - 400))) {
            delete this.days[d];
        }
    }

    day(date) {
        return { date, points: [...(this.points[date] || [])], summary: this.days[date] || null, dates: Object.keys(this.points).sort() };
    }

    toJSON() {
        return { points: this.points, days: this.days, bucket: this.bucket };
    }
}

/** Surplus = export (+ battery charging if wanted); on after `delay` above `on`, off after `delay` below `off`. */
class Surplus {
    constructor(cfg) {
        this.cfg = cfg;
        this.active = false;
        this.since = null;
    }

    update(s) {
        const w = s.export + (this.cfg.battery ? s.charge : 0);
        const want = this.active ? w >= this.cfg.off : w >= this.cfg.on;
        if (want === this.active) {
            this.since = null;
        } else if (this.since === null) {
            this.since = s.ts;
        }
        if (this.since !== null && s.ts - this.since >= this.cfg.delay) {
            this.active = want;
            this.since = null;
        }
        return { power: r0(w), active: this.active };
    }
}

/**
 * Does the heat pump run? `val` raw value of its data point, `obj` its common (unit, states).
 * null when unknown.
 */
function hpRunning(w, val, obj = {}) {
    if (val === null || val === undefined || val === '') {
        return null;
    }
    if (w.hpKind === 'status') {
        // e.g. Ochsner "Wärmeerzeuger Status" 0 = Standby: off at 0, or at the text "Standby"
        const text = obj.states && typeof obj.states === 'object' ? obj.states[String(val)] : undefined;
        const keys = [String(val).trim().toLowerCase(), text === undefined ? null : String(text).trim().toLowerCase()];
        return !w.hpOff.some(x => keys.includes(x));
    }
    if (typeof val === 'boolean') {
        return val;
    }
    if (w.hpKind === 'auto' && (val === 'true' || val === 'false')) {
        return val === 'true';
    }
    const n = convert(val, { unit: 'auto', scale: 1 }, obj.unit);
    return n === null ? null : n > w.hpOn;
}

const mmss = ms => {
    const t = Math.max(0, Math.ceil(ms / 1000));
    return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
};

/**
 * Wallbox control. update(s, {mode, plugged}) every tick -> {amps, status, available, ...}.
 * available = what the car could use: export + its own power, minus battery discharge, plus battery
 * charging when the car comes first (battery charge level >= socMin).
 * pv: start after onDelay with at least min A, stop after offDelay below min A (allowImport tolerated);
 * minpv: at least min A, more with surplus; fast: max A; off: 0 A; manual: nothing is written (amps null).
 */
class Charger {
    constructor(cfg) {
        this.cfg = cfg;
        this.on = false;
        this.since = null;
    }

    /**
     * opts: mode, plugged, heatpump (true = runs), carSoc (%), hpRule (heat pump first, overrides the setting),
     * peak (W, import limit, 0 = off, overrides the setting). The surplus logic gives the current, then the
     * heat pump and the import limit may lower it - unless the car would not be ready in time (then minimum current).
     */
    update(s, opts = {}) {
        const r = this.base(s, opts);
        const c = this.cfg;
        const hpRule = opts.hpRule === undefined || opts.hpRule === null ? c.hpUse : Boolean(opts.hpRule);
        const peak = opts.peak === undefined || opts.peak === null ? (c.peakUse ? c.peak : 0) : Math.max(0, Number(opts.peak) || 0);
        const urgent = this.urgent(opts.carSoc, s.ts, r.perAmp);
        const out = { ...r, urgent, heatpump: Boolean(opts.heatpump) };
        if (!r.amps) {
            return out;
        }
        const kw = w => `${(w / 1000).toFixed(1).replace('.', ',')} kW`;
        const late = `sonst bis ${c.ready} nicht ${c.target} %`;
        if (opts.heatpump && hpRule && c.hpAction !== 'limit') {
            if (urgent) {
                out.amps = c.min;
                out.status = `Wärmepumpe läuft – Auto mit ${c.min} A (${late})`;
            } else if (c.hpAction === 'pause') {
                out.amps = 0;
                out.status = 'Pause – Wärmepumpe läuft';
            } else {
                out.amps = c.min;
                out.status = `${c.min} A – Wärmepumpe läuft`;
            }
        }
        if (peak > 0 && s.grid !== null && out.amps > 0) {
            const car = c.consumer ? (s.consumers.find(x => x.id === c.consumer) || {}).w || 0 : 0;
            // import without the car; the car may use what is left up to the limit
            const maxA = Math.floor((peak - c.peakReserve - (s.grid - car)) / r.perAmp);
            if (maxA < out.amps) {
                if (maxA >= c.min) {
                    out.amps = maxA;
                    out.status = `${maxA} A – Bezugsgrenze ${kw(peak)}`;
                } else if (urgent) {
                    out.amps = c.min;
                    out.status = `${c.min} A über der Bezugsgrenze (${late})`;
                } else {
                    out.amps = 0;
                    out.status = `Pause – Bezugsgrenze ${kw(peak)} erreicht`;
                    this.peakAt = s.ts;
                }
            }
            // after a pause by the limit start again only after the start delay (no on/off with every kettle)
            const left = this.peakAt ? c.onDelay - (s.ts - this.peakAt) : 0;
            if (out.amps > 0 && left > 0 && !urgent) {
                out.amps = 0;
                out.status = `Bezugsgrenze – startet wieder in ${mmss(left)}`;
            }
        }
        return out;
    }

    /** true when the car (charge level `soc`) would not reach the target by the ready time with the minimum current */
    urgent(soc, ts, perAmp) {
        const c = this.cfg;
        const v = Number(soc);
        if (!c.ready || soc === null || soc === undefined || soc === '' || !Number.isFinite(v)) {
            return false;
        }
        const need = ((c.target - v) / 100) * c.capacity;
        if (need <= 0) {
            return false;
        }
        const hours = need / (((c.min * perAmp) / 1000) * 0.9); // ~90 % charging efficiency
        const [h, m] = c.ready.split(':').map(Number);
        const d = new Date(ts);
        d.setHours(h, m, 0, 0);
        if (d.getTime() <= ts) {
            d.setDate(d.getDate() + 1);
        }
        return ts + hours * 3600000 + 15 * 60000 >= d.getTime();
    }

    base(s, { mode = 'pv', plugged = null } = {}) {
        const c = this.cfg;
        const perAmp = c.volt * c.phases;
        const car = c.consumer ? (s.consumers.find(x => x.id === c.consumer) || {}).w || 0 : 0;
        let available = null;
        if (s.grid !== null) {
            available = -s.grid + car;
            if (s.battery !== null) {
                const carFirst = c.socMin === 0 || (s.soc !== null && s.soc >= c.socMin);
                available += carFirst ? s.battery : Math.min(0, s.battery);
            }
            available = Math.round(available);
        }
        const fit = w => Math.max(c.min, Math.min(c.max, Math.floor(w / perAmp)));
        const res = { mode, amps: 0, available, status: '', perAmp, startAt: c.min * perAmp };
        const reset = () => {
            this.on = false;
            this.since = null;
        };
        if (mode === 'manual') {
            reset();
            return { ...res, amps: null, status: 'Manuell – energie regelt nicht' };
        }
        if (mode === 'off') {
            reset();
            return { ...res, status: 'Aus' };
        }
        if (mode === 'fast') {
            reset();
            return { ...res, amps: c.max, status: `Schnellladen ${c.max} A` };
        }
        if (available === null) {
            reset();
            return { ...res, amps: mode === 'minpv' ? c.min : 0, status: 'Netz-Messwert fehlt' };
        }
        if (mode === 'minpv') {
            reset();
            const amps = fit(available);
            return { ...res, amps, status: amps > c.min ? `Min+PV ${amps} A` : `Min+PV ${amps} A (Mindeststrom)` };
        }
        // pv: only surplus
        if (plugged === false) {
            reset();
            return { ...res, status: 'Kein Auto angesteckt' };
        }
        const enough = available >= c.min * perAmp;
        const keep = available + c.allowImport >= c.min * perAmp;
        if (!this.on) {
            if (!enough) {
                this.since = null;
                return { ...res, status: `Wartet auf Überschuss (ab ${(res.startAt / 1000).toFixed(1).replace('.', ',')} kW)` };
            }
            this.since = this.since === null ? s.ts : this.since;
            const left = c.onDelay - (s.ts - this.since);
            if (left > 0) {
                return { ...res, status: `Startet in ${mmss(left)}` };
            }
            this.on = true;
            this.since = null;
        } else if (!keep) {
            this.since = this.since === null ? s.ts : this.since;
            const left = c.offDelay - (s.ts - this.since);
            if (left <= 0) {
                reset();
                return { ...res, status: 'Zu wenig Überschuss – pausiert' };
            }
            return { ...res, amps: c.min, status: `Zu wenig Überschuss – stoppt in ${mmss(left)}` };
        } else {
            this.since = null;
        }
        const amps = fit(available);
        return { ...res, amps, status: `PV-Laden ${amps} A` };
    }
}

module.exports = { MODES, Charger, hpRunning, ICONS, cleanConfig, inputs, convert, factor, snapshot, Day, History, Surplus, dateKey, slug };
