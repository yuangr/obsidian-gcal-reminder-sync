const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const copy = value => JSON.parse(JSON.stringify(value));
function loadClient() {
    const timers = new Map(); let seq = 0, now = 100000;
    class Clock extends Date { static now() { return now; } }
    const api = { Plugin: class {}, PluginSettingTab: class {}, Setting: class {}, Modal: class {},
        MarkdownView: class {}, Notice: class { hide() {} }, requestUrl: async () => { throw Error('Network disabled in tests'); } };
    const context = vm.createContext({ require(name) { if (name !== 'obsidian') throw Error(name); return api; },
        module: { exports: {} }, crypto: crypto.webcrypto, Intl, Date: Clock,
        setTimeout(fn, ms) { const id = ++seq; timers.set(id, { fn, at: now + ms }); return id; },
        clearTimeout(id) { timers.delete(id); } });
    new vm.Script(fs.readFileSync(path.join(root, 'main.js'), 'utf8'), { filename: 'main.js' }).runInContext(context);
    return { Plugin: context.module.exports, ...context.module.exports._test, timers, api,
        async advance(ms) { now += ms; for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); } await new Promise(r => setImmediate(r)); } };
}
function memorySource(text, key = 'tasks.md') {
    return { text, key, async read() { return this.text; }, async transform(fn) { this.text = fn(this.text); } };
}
function parts(date, zone) {
    const fields = new Intl.DateTimeFormat('en-GB', { timeZone: zone, year: 'numeric', month: '2-digit',
        day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
    const values = Object.fromEntries(fields.map(p => [p.type, p.value]));
    return values.year + '-' + values.month + '-' + values.day + ' ' + values.hour + ':' + values.minute;
}
function backend() {
    const events = new Map(), calls = [], properties = { SYNC_SECRET: 'a'.repeat(40), CALENDAR_ID: 'test-calendar' };
    let revision = 0, injection = null;
    const reply = (code, body) => ({ getResponseCode: () => code, getContentText: () => body == null ? '' : JSON.stringify(body) });
    const fetch = (url, options) => {
        const method = options.method, suffix = url.split('/calendar/v3')[1];
        calls.push({ method, suffix, body: options.payload ? JSON.parse(options.payload) : null, headers: options.headers });
        if (injection) { const result = injection(url, options); if (result) return reply(result.status, result.body || { error: { message: 'Injected failure' } }); }
        if (suffix === '/calendars/test-calendar') return reply(200, { id: 'test-calendar', summary: 'Test reminders' });
        const base = '/calendars/test-calendar/events';
        if (!suffix.startsWith(base)) return reply(404, { error: { message: 'Unknown calendar' } });
        if (suffix.startsWith(base + '?')) {
            const uid = new URL('https://mock.invalid' + suffix).searchParams.get('iCalUID');
            return reply(200, { items: [...events.values()].filter(e => e.iCalUID === uid) });
        }
        const id = decodeURIComponent(suffix.slice(base.length + 1));
        const event = events.get(id);
        if (method === 'get') return event ? reply(200, event) : reply(404, { error: { message: 'Missing event' } });
        const body = options.payload ? JSON.parse(options.payload) : {};
        if (method === 'post') {
            if (events.has(body.id)) return reply(409, { error: { message: 'Duplicate ID' } });
            const created = { ...body, etag: String(++revision), status: 'confirmed' };
            events.set(body.id, copy(created)); return reply(200, created);
        }
        if (!event || event.status === 'cancelled') return reply(404, { error: { message: 'Missing event' } });
        if (options.headers['If-Match'] && options.headers['If-Match'] !== event.etag) return reply(412, { error: { message: 'Precondition failed' } });
        if (method === 'delete') { event.status = 'cancelled'; return reply(204, null); }
        if (method === 'patch') {
            const updated = { ...event, ...body, etag: String(++revision) };
            events.set(id, copy(updated)); return reply(200, updated);
        }
        return reply(400, { error: { message: 'Unsupported request' } });
    };
    let locked = false;
    const context = vm.createContext({ Intl, Date,
        ContentService: { MimeType: { JSON: 'json' }, createTextOutput(text) { return { text, setMimeType() { return this; } }; } },
        PropertiesService: { getScriptProperties: () => ({ getProperty: key => properties[key] }) },
        LockService: { getScriptLock: () => ({ tryLock: () => (locked = true), hasLock: () => locked, releaseLock: () => { locked = false; } }) },
        ScriptApp: { getOAuthToken: () => 'mock-token' }, UrlFetchApp: { fetch },
        Utilities: {
            DigestAlgorithm: { SHA_256: 'sha256' },
            computeDigest: (alg, value) => Array.from(crypto.createHash(alg).update(value).digest()),
            formatDate(date, zone, format) {
                const value = parts(date, zone);
                if (format === 'yyyy-MM-dd') return value.slice(0, 10);
                if (format === 'HH:mm') return value.slice(11);
                return value;
            },
            parseDate(value, zone) {
                const desired = Date.parse(value.replace(' ', 'T') + ':00Z');
                let guess = desired;
                for (let i = 0; i < 4; i++) {
                    const local = Date.parse(parts(new Date(guess), zone).replace(' ', 'T') + ':00Z');
                    guess += desired - local;
                }
                return new Date(guess);
            }
        }
    });
    new vm.Script(fs.readFileSync(path.join(root, 'google-apps-script/Code.gs'), 'utf8'), { filename: 'Code.gs' }).runInContext(context);
    function post(data, authenticated = true) {
        const payload = authenticated ? { protocol: 2, secret: properties.SYNC_SECRET, ...data } : data;
        return JSON.parse(context.doPost({ postData: { contents: JSON.stringify(payload) } }).text);
    }
    return { events, calls, properties, post,
        inject(fn) { injection = fn; },
        async send(payload) {
            const result = post(payload);
            if (result.status !== 'success') throw Object.assign(new Error(result.message), { code: result.code, retryable: result.retryable });
            return result;
        },
        seed(taskId, id = 'existing', extras = {}) {
            const event = { id, summary: 'Meeting', start: { dateTime: '2026-09-22T01:00:00.000Z' },
                end: { dateTime: '2026-09-22T01:30:00.000Z' }, reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 15 }] },
                extendedProperties: { private: { ogrsTaskId: taskId, ogrsCompleted: 'false' } },
                etag: String(++revision), status: 'confirmed', ...extras };
            events.set(id, copy(event)); return event;
        },
        active() { return [...events.values()].filter(e => e.status !== 'cancelled'); }
    };
}
function fixture(options = {}) {
    const client = loadClient(), server = backend(), source = memorySource(options.text || '- [ ] Meeting (@2026-09-22 09:00) !gcal');
    const settings = { ...copy(client.DEFAULT_SETTINGS), timeZone: 'Asia/Shanghai', ...options.settings };
    const notices = [], requests = []; let next = 0;
    const engine = new client.SyncEngine({ settings,
        newId: () => (++next).toString(16).padStart(32, '0'),
        send: async payload => { requests.push(copy(payload)); return options.send ? options.send(payload, server) : server.send(payload); },
        save: async () => {}, notify: (text, error) => notices.push({ text, error }) });
    return { ...client, server, source, settings, engine, notices, requests };
}
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
module.exports = { loadClient, memorySource, backend, fixture, deferred, copy };

