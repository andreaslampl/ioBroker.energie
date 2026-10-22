'use strict';

/*
 * Energy model, independent of ioBroker:
 *   cleanConfig()  instance settings -> sources (PV, grid, battery, house, consumers)
 *   snapshot()     current values (W) -> powers of all nodes, house computed when not measured
 *   Day            energy of the day (Wh, trapezoid between ticks), autarky / self consumption
 *   History        5-minute averages per day (8 days) and daily summaries (400 days)
 *   Surplus        surplus signal with switch-on/-off thresholds and delay
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
            return { id, name, state: str(x.state, 300), ...conv(x), icon: ICONS.includes(x.icon) ? x.icon : 'plug' };
        });
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
    };
    return { pv, grid, battery, house, consumers, surplus, view };
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
    const house = cfg.house ? Math.max(0, val(cfg.house.state, 'Haus')) : Math.max(0, pv + grid - (battery || 0));
    const consumers = cfg.consumers.map(x => ({ id: x.id, name: x.name, icon: x.icon, w: r0(Math.max(0, val(x.state, x.name))) }));
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

module.exports = { ICONS, cleanConfig, inputs, convert, factor, snapshot, Day, History, Surplus, dateKey, slug };
