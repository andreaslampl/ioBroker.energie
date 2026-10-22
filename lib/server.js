'use strict';

/*
 * Web page of the energy flow (own port, for VIS-2 as HTML widget / iframe and the browser):
 *   /, /flow               energy flow, today's values, day chart (?view=flow|stats|chart, ?theme=dark|light, ?bg=transparent)
 *   /check                 values check: raw value, unit, factor, result in W (for Modbus settings)
 *   /api/live              current powers + today
 *   /api/day?date=         5-minute values and summary of a day
 *   /api/check             what /check shows
 *   /api/positions         POST {pos} own arrangement of the symbols ("Anordnen" on /flow)
 *   /events                server-sent events: {s, today} on every update
 * Optional access key (?key= once, then a cookie).
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const WWW = path.join(__dirname, '..', 'www');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' };

class FlowServer {
    /** @param {object} a adapter side: live(), day(date), check() */
    constructor({ adapter, accessKey = '', log }) {
        this.a = adapter;
        this.accessKey = accessKey;
        this.log = log;
        this.clients = new Set();
        this.server = http.createServer((req, res) => {
            this._handle(req, res).catch(err => {
                if (!res.headersSent) {
                    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
                }
                res.end(JSON.stringify({ error: err.message }));
            });
        });
        // keep proxies and browsers from closing idle event streams
        this.ping = setInterval(() => this._send(':\n\n'), 25000);
    }

    listen(port, host = '0.0.0.0') {
        return new Promise((resolve, reject) => {
            this.server.once('error', reject);
            this.server.listen(port, host, () => {
                this.server.removeListener('error', reject);
                resolve(this.server.address());
            });
        });
    }

    close() {
        clearInterval(this.ping);
        for (const c of this.clients) {
            c.end();
        }
        this.server.closeAllConnections();
        return new Promise(resolve => this.server.close(() => resolve()));
    }

    /** new values for all open pages */
    push(data) {
        this._send(`data: ${JSON.stringify(data)}\n\n`);
    }

    _send(text) {
        for (const c of this.clients) {
            c.write(text);
        }
    }

    _allowed(req, url) {
        if (!this.accessKey) {
            return true;
        }
        const m = /(?:^|;\s*)en_key=([^;]+)/.exec(req.headers.cookie || '');
        return url.searchParams.get('key') === this.accessKey || (m && decodeURIComponent(m[1]) === this.accessKey);
    }

    _json(res, status, data) {
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(data));
    }

    async _handle(req, res) {
        const url = new URL(req.url, 'http://localhost');
        const p = url.pathname;
        if (this.accessKey && url.searchParams.get('key') === this.accessKey) {
            // SameSite=None would need https; the page is used on the same host (VIS) or directly
            res.setHeader('Set-Cookie', `en_key=${encodeURIComponent(this.accessKey)}; Path=/; Max-Age=315360000; SameSite=Lax; HttpOnly`);
        }
        const file = p === '/' || p === '/flow' ? 'flow.html' : p === '/check' ? 'check.html' : p.slice(1);
        const isPage = file.endsWith('.html');
        if ((p.startsWith('/api/') || p === '/events' || isPage) && !this._allowed(req, url)) {
            if (isPage) {
                res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
                return res.end('<p style="font-family:sans-serif">Zugriff verweigert – die Adresse braucht <b>?key=…</b> (Zugriffsschlüssel aus den Instanz-Einstellungen).</p>');
            }
            return this._json(res, 403, { error: 'Zugriff verweigert: Schlüssel fehlt (?key=...)' });
        }
        if (p === '/events') {
            res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
            res.write(`retry: 3000\ndata: ${JSON.stringify(this.a.live())}\n\n`);
            this.clients.add(res);
            req.on('close', () => this.clients.delete(res));
            return;
        }
        if (p === '/api/live') {
            return this._json(res, 200, this.a.live());
        }
        if (p === '/api/day') {
            const date = url.searchParams.get('date') || '';
            return this._json(res, 200, this.a.day(/^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null));
        }
        if (p === '/api/positions' && req.method === 'POST') {
            const chunks = [];
            for await (const c of req) {
                chunks.push(c);
                if (chunks.reduce((n, x) => n + x.length, 0) > 20000) {
                    throw new Error('Zu groß');
                }
            }
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
            return this._json(res, 200, { pos: this.a.setPositions(body.pos) });
        }
        if (p === '/api/check') {
            return this._json(res, 200, await this.a.check());
        }
        if (/^[\w.-]+$/.test(file) && MIME[path.extname(file)]) {
            const full = path.join(WWW, file);
            if (fs.existsSync(full)) {
                res.writeHead(200, { 'Content-Type': MIME[path.extname(file)], 'Cache-Control': 'no-cache' });
                fs.createReadStream(full).pipe(res);
                return;
            }
        }
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Nicht gefunden');
    }
}

module.exports = { FlowServer };
