// Offline stand-ins for everything the workflow reaches outside n8n: the HTTP Request
// nodes, and the Node modules Code nodes require (http, https, dns, fs, child_process).
// One Mocks instance per fixture, so fixture.web / attachments / Zoho ids never leak between runs.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { Readable } = require('stream');

const OLLAMA_URL = 'http://localhost:11434';

class Mocks {
  constructor(fixture, opts) {
    this.fixture = fixture;
    this.cacheDir = opts.cacheDir;
    this.noCache = !!opts.noCache;
    this.stats = opts.stats || { ollamaCalls: 0, cacheHits: 0 };
    this.zohoSeq = 0;
    this.zohoRecords = {};
    this.tmpRoot = path.join(os.tmpdir(), 'email-to-crm-tests', `${fixture.id || 'fixture'}-${process.pid}`);
    fs.rmSync(this.tmpRoot, { recursive: true, force: true });
    fs.mkdirSync(this.tmpRoot, { recursive: true });
  }

  // Every outbound request (HTTP node or Code-node http/https) ends here.
  // Returns { status, headers, body } with body as a string.
  async route(url, method, body, timeoutMs) {
    let u;
    try { u = new URL(url); } catch (e) { throw new Error('Invalid URL: ' + url); }
    if (u.port === '11434') return this.ollama(u.pathname, body, timeoutMs);
    if (/(^|\.)accounts\.zoho\./.test(u.hostname) && u.pathname.includes('/oauth/')) {
      return json(200, { access_token: 'test-token', expires_in: 3600, api_domain: 'https://www.zohoapis.com', token_type: 'Bearer' });
    }
    if (/zohoapis\./.test(u.hostname) && /\/Contacts\/upsert$/.test(u.pathname)) return this.zohoUpsert(body);
    const fetchMatch = /zohoapis\./.test(u.hostname) && u.pathname.match(/\/Contacts\/([^/]+)$/);
    if (fetchMatch && method === 'GET') return this.zohoFetch(decodeURIComponent(fetchMatch[1]));
    if (u.hostname === 'graph.microsoft.com' && /\/attachments\/?$/.test(u.pathname)) {
      return json(200, { value: this.fixture.attachments || [] });
    }
    const web = this.fixture.web || {};
    const alt = url.endsWith('/') ? url.slice(0, -1) : url + '/';
    const html = web[url] ?? web[alt];
    if (typeof html === 'string') return { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: html };
    return { status: 404, headers: { 'content-type': 'text/html' }, body: '<html><body>404 Not Found</body></html>' };
  }

  async ollama(pathname, body, timeoutMs) {
    let reqBody = typeof body === 'string' ? body : JSON.stringify(body);
    try { const o = JSON.parse(reqBody); o.stream = false; reqBody = JSON.stringify(o); } catch (e) { /* send as-is */ }
    const key = crypto.createHash('sha256').update(reqBody).digest('hex');
    const file = path.join(this.cacheDir, key + '.json');
    if (!this.noCache && fs.existsSync(file)) {
      this.stats.cacheHits++;
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
    this.stats.ollamaCalls++;
    const r = await fetch(OLLAMA_URL + pathname, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: reqBody,
      signal: AbortSignal.timeout(timeoutMs || 900000),
    });
    const res = { status: r.status, headers: { 'content-type': r.headers.get('content-type') || 'application/json' }, body: await r.text() };
    if (r.ok) {
      fs.mkdirSync(this.cacheDir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(res));
    }
    return res;
  }

  zohoUpsert(body) {
    let parsed = body;
    if (typeof body === 'string') { try { parsed = JSON.parse(body); } catch (e) { parsed = null; } }
    if (!parsed || !Array.isArray(parsed.data)) {
      return json(400, { code: 'INVALID_DATA', message: 'invalid data', status: 'error' });
    }
    const now = new Date().toISOString();
    const user = { name: 'Test User', id: 'user-1' };
    return json(200, {
      data: parsed.data.map(rec => {
        const id = 'zoho-' + (++this.zohoSeq);
        this.zohoRecords[id] = rec;
        return {
          code: 'SUCCESS', duplicate_field: null, action: 'insert', message: 'record added', status: 'success',
          details: { Modified_Time: now, Modified_By: user, Created_Time: now, id, Created_By: user },
        };
      }),
    });
  }

  zohoFetch(id) {
    const rec = this.zohoRecords[id];
    if (!rec) return { status: 204, headers: {}, body: '' };
    // Zoho returns lookup fields as objects on read.
    const out = { id, ...rec };
    if (typeof rec.Account_Name === 'string') out.Account_Name = { name: rec.Account_Name, id: 'acct-' + id };
    return json(200, { data: [out] });
  }

  // require() handed to Code nodes. Mirrors n8n's NODE_FUNCTION_ALLOW_BUILTIN allowlist.
  require() {
    const mods = {
      crypto, path, url: require('url'), util: require('util'), buffer: require('buffer'),
      fs: this.fsShim(), http: this.httpShim('http:'), https: this.httpShim('https:'),
      dns: dnsShim(), child_process: childProcessShim(),
    };
    return name => {
      const key = String(name).replace(/^node:/, '');
      if (!(key in mods)) throw new Error(`Cannot find module '${name}' (not in the harness allowlist)`);
      return mods[key];
    };
  }

  // Absolute paths outside /tmp (e.g. /data/extracted_contacts.csv) are rewritten into a
  // per-fixture temp dir. /tmp is left alone so shell tools (pdftotext) see what fs wrote.
  fsShim() {
    const root = this.tmpRoot;
    const remap = p => {
      if (typeof p !== 'string' || p.startsWith('/tmp/') || p.startsWith(os.tmpdir())) return p;
      const target = path.join(root, path.resolve('/', p));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      return target;
    };
    const wrap = obj => new Proxy(obj, {
      get(t, k) {
        const v = t[k];
        if (k === 'promises') return wrap(t.promises);
        if (typeof v !== 'function') return v;
        return (p, ...rest) => v.call(t, remap(p), ...rest);
      },
    });
    return wrap(fs);
  }

  // Minimal http/https: request()/get() with the callback + 'data'/'end' events the nodes use.
  httpShim(protocol) {
    const mocks = this;
    function request(a, b, c) {
      let opts = {};
      if (typeof a === 'string' || a instanceof URL) {
        const u = new URL(a);
        opts = { protocol: u.protocol, hostname: u.hostname, port: u.port, path: u.pathname + u.search };
        if (b && typeof b === 'object') opts = { ...opts, ...b };
      } else opts = { ...a };
      const cb = typeof b === 'function' ? b : c;
      const req = new EventEmitter();
      const chunks = [];
      req.destroyed = false;
      req.write = d => { if (d != null) chunks.push(Buffer.from(d)); return true; };
      req.setTimeout = () => req;
      req.setHeader = () => {};
      req.destroy = () => { req.destroyed = true; return req; };
      req.abort = req.destroy;
      req.end = d => {
        req.write(d);
        setImmediate(async () => {
          const host = opts.hostname || String(opts.host || '').split(':')[0];
          const port = opts.port ? ':' + opts.port : '';
          const url = (opts.protocol || protocol) + '//' + host + port + (opts.path || '/');
          let r;
          try { r = await mocks.route(url, (opts.method || 'GET').toUpperCase(), Buffer.concat(chunks).toString('utf8'), opts.timeout); }
          catch (e) { if (!req.destroyed) req.emit('error', e); return; }
          if (req.destroyed) return;
          const res = Readable.from(r.body ? [Buffer.from(r.body)] : [], { objectMode: false });
          res.statusCode = r.status;
          res.headers = { ...(r.headers || {}), 'content-length': String(Buffer.byteLength(r.body || '')) };
          if (cb) cb(res);
          req.emit('response', res);
        });
        return req;
      };
      return req;
    }
    return { request, get: (a, b, c) => request(a, b, c).end(), Agent: class Agent {}, STATUS_CODES: require('http').STATUS_CODES };
  }
}

function json(status, obj) {
  return { status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) };
}

function dnsShim() {
  const fail = name => Object.assign(new Error(`queryMx ENOTFOUND ${name} (offline test)`), { code: 'ENOTFOUND' });
  const promises = new Proxy({}, { get: (_, k) => async name => { throw fail(name); } });
  return new Proxy({ promises }, {
    get: (t, k) => k === 'promises' ? promises : (name, ...rest) => { const cb = rest.pop(); if (typeof cb === 'function') setImmediate(() => cb(fail(name))); },
  });
}

function childProcessShim() {
  const cp = require('child_process');
  const blocked = () => { throw new Error('child_process: only execSync is available in tests'); };
  return {
    ...cp, exec: blocked, execFile: blocked, spawn: blocked, fork: blocked,
    execSync(cmd, opts) {
      if (/\b(wget|curl)\b/.test(String(cmd))) throw new Error('network tools are disabled in tests');
      return cp.execSync(cmd, opts);
    },
  };
}

module.exports = { Mocks };
