'use strict';

/* Test helpers: a fake ioBroker adapter-core (objects and states in memory). */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');

class FakeAdapter extends EventEmitter {
    constructor(options) {
        super();
        this.namespace = `${options.name}.0`;
        this.config = options.config || {};
        this.dataDir = options.dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'en-'));
        this.states = {}; // full id -> {val, ack}
        this.objects = {};
        this.subs = new Set();
        this.sent = [];
        this.logs = [];
        const log = level => m => this.logs.push(`${level}: ${m}`);
        this.log = { debug() {}, info: log('info'), warn: log('warn'), error: log('error') };
    }
    _id(id) {
        return id.startsWith(`${this.namespace}.`) ? id : `${this.namespace}.${id}`;
    }
    async setState(id, val, ack) {
        this.states[this._id(id)] = { val, ack: Boolean(ack) };
    }
    async getStateAsync(id) {
        return this.states[this._id(id)] || null;
    }
    subscribeStates() {}
    async setForeignStateAsync(id, val, ack) {
        this.states[id] = { val, ack: Boolean(ack) };
        (this.writes = this.writes || []).push({ id, val, ack: Boolean(ack) });
    }
    /** a user / SmartView writes an own state (ack false) */
    command(id, val) {
        const full = this._id(id);
        this.states[full] = { val, ack: false };
        this.emit('stateChange', full, this.states[full]);
    }
    async extendObject(id, obj) {
        const full = this._id(id);
        const old = this.objects[full] || {};
        this.objects[full] = { ...old, ...obj, common: { ...(old.common || {}), ...(obj.common || {}) } };
    }
    async getAdapterObjectsAsync() {
        return Object.fromEntries(Object.entries(this.objects).filter(([id]) => id.startsWith(`${this.namespace}.`)));
    }
    async delObjectAsync(id) {
        delete this.objects[this._id(id)];
    }
    async getForeignObjectAsync(id) {
        return this.objects[id] ? { _id: id, ...this.objects[id] } : null;
    }
    async getForeignStateAsync(id) {
        return this.states[id] || null;
    }
    async subscribeForeignStatesAsync(id) {
        this.subs.add(id);
    }
    sendTo(to, command, message, callback) {
        this.sent.push({ to, command, message, callback });
    }
    /** a data point of another adapter */
    add(id, unit, val) {
        this.objects[id] = { type: 'state', common: { name: id, type: 'number', unit } };
        if (val !== undefined) {
            this.states[id] = { val, ack: true };
        }
    }
    change(id, val) {
        this.states[id] = { val, ack: true };
        if (this.subs.has(id)) {
            this.emit('stateChange', id, this.states[id]);
        }
    }
    val(id) {
        const st = this.states[this._id(id)];
        return st ? st.val : undefined;
    }
}

function install() {
    const orig = Module._load;
    Module._load = function (request, ...rest) {
        if (request === '@iobroker/adapter-core') {
            return { Adapter: FakeAdapter, getAbsoluteInstanceDataDir: () => fs.mkdtempSync(path.join(os.tmpdir(), 'en-')) };
        }
        return orig.call(this, request, ...rest);
    };
}

async function until(fn, ms = 5000) {
    const end = Date.now() + ms;
    while (!(await fn())) {
        if (Date.now() > end) {
            throw new Error('timeout');
        }
        await new Promise(r => setTimeout(r, 20));
    }
}

module.exports = { FakeAdapter, install, until };
