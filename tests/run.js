#!/usr/bin/env node
// Runs the workflow's real node code on synthetic fixtures against the local Ollama model and
// scores the extracted contacts against each fixture's labels (tests/fixtures/<category>/<id>.json).
// Always exits 0: it measures, it does not gate.
//
// Usage:
//   node tests/run.js [--only id1,id2] [--category name] [--split train|holdout|all] [--no-cache]
//                     [--concurrency 4] [--json path] [--quiet]
//                     [--workflow path] [--src-dir dir[,dir2]]
// --workflow defaults to workflows/email-to-crm.json. Code nodes whose jsCode is "__SRC__:<file>"
// are loaded from --src-dir (default src/nodes; first dir that has the file wins).
//
// How this differs from a real n8n run (approximations):
// - Execution order is n8n v1: run from the node after "Get a message1" (the fixture email is its
//   output), children go to the front of the stack sorted top-to-bottom then left-to-right, an
//   empty output schedules nothing, and a node with several parents runs once per incoming batch.
//   Multi-input nodes (Merge) are not supported and stop the run with an error.
// - Data between nodes is JSON round-tripped (like n8n's task runner), so undefined fields drop.
// - Code runs in this process, not a fresh vm context: an undeclared assignment in node code would
//   leak a global across fixtures (none do today; check globalThis if results look order-dependent).
// - $('Node') reads the node's last run, on the output that leads to the current node.
//   Unexecuted nodes throw, as in n8n. .item has no paired-item tracking: it is the item at the
//   same index, else the first. $now, $today and luxon DateTime are not provided (no node uses them).
// - Expressions `={{ ... }}` are evaluated as plain JavaScript (no n8n extension functions such
//   as .isEmpty() or .toDateTime()). An expression containing "}}" is not supported.
// - IF v2 supports boolean operators plus exists/notExists. Strict type validation throws on a
//   non-boolean left value (null/undefined count as false); loose mode converts "true"/"1"/"yes".
//   Other operator types throw so the gap is visible.
// - HTTP Request: Ollama (port 11434) goes to http://localhost:11434 with stream:false and is
//   cached by sha256 of the request body in tests/.cache/. Zoho token/upsert/fetch, Graph
//   attachments and web pages are canned (fixture.web[url], else 404). Error items are
//   { error: { message, name, status } } when the node continues on error. No retries.
// - Code-node require() is limited to crypto, path, url, util, buffer, fs, http, https, dns,
//   child_process. http/https/dns are offline mocks routed the same way as HTTP nodes; fs writes
//   outside /tmp land in a per-fixture temp dir; execSync refuses wget/curl (no OCR model download).
// - Outlook send and Excel append are captured, not sent. The mail queue in front ("Every Minute",
//   "List Mailbox", "Claim New Mail"), "Get a message1" and nodes without a parent never run;
//   tests/queue.js covers the queue nodes on their own.
// - $getWorkflowStaticData returns one object per fixture that starts empty, so every fixture
//   begins with no cached Zoho token and goes through Refresh Zoho Token. $workflow.id is "test",
//   so Mark Processed writes its ledger into the fixture's temp dir.
// - Result contacts are read from "Format for CSV" (the same contacts Prepare Upsert reads via
//   Save to CSV), whether or not Zoho is skipped. Contacts flagged skipZohoUpsert are scored too.

const fs = require('fs');
const path = require('path');
const { loadWorkflow, runWorkflow } = require('./lib/engine');

const ROOT = path.resolve(__dirname, '..');
const PHONE_FIELDS = new Set(['phone', 'mobile']);
const FIELD_GETTERS = {
  company: c => c.companyName || c.company || '',
  title: c => c.jobTitle || c.title || '',
};

function parseArgs(argv) {
  const a = { split: 'all', concurrency: 4, cache: true, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i], v = () => argv[++i];
    if (k === '--only') a.only = v().split(',').map(s => s.trim()).filter(Boolean);
    else if (k === '--category') a.category = v();
    else if (k === '--split') a.split = v();
    else if (k === '--no-cache') a.cache = false;
    else if (k === '--concurrency') a.concurrency = Math.max(1, parseInt(v(), 10) || 1);
    else if (k === '--json') a.json = v();
    else if (k === '--quiet') a.quiet = true;
    else if (k === '--workflow') a.workflow = v();
    else if (k === '--src-dir') a.srcDirs = v().split(',').map(s => path.resolve(s));
    else { console.error('unknown argument: ' + k); process.exit(0); }
  }
  a.workflow = path.resolve(a.workflow || path.join(ROOT, 'workflows/email-to-crm.json'));
  a.srcDirs = a.srcDirs || [path.join(ROOT, 'src/nodes')];
  return a;
}

function loadFixtures(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...loadFixtures(p));
    else if (e.name.endsWith('.json')) {
      const fx = JSON.parse(fs.readFileSync(p, 'utf8'));
      fx.category = fx.category || path.basename(dir);
      fx.split = fx.split || 'train';
      fx._file = path.relative(ROOT, p);
      out.push(fx);
    }
  }
  return out.sort((x, y) => String(x.id).localeCompare(String(y.id)));
}

const norm = v => String(v ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
const phoneNorm = v => { const d = String(v ?? '').replace(/\D/g, ''); return d.length === 11 && d[0] === '1' ? d.slice(1) : d; };
const fieldValue = (c, k) => (FIELD_GETTERS[k] ? FIELD_GETTERS[k](c) : c[k]);

function extractResult(ex) {
  const runs = name => ex.runData[name] || [];
  const last = name => { const r = runs(name); return r.length ? (r[r.length - 1].outputs[0] || []) : []; };
  let skipReason = '';
  for (const name of ex.order) {
    for (const r of runs(name)) for (const out of r.outputs) for (const it of out || []) {
      if (!skipReason && it.json && it.json.skip === true) skipReason = String(it.json.skipReason || 'SKIPPED');
    }
    if (skipReason) break;
  }
  const contacts = last('Format for CSV').filter(i => !i.json.skip).flatMap(i => i.json.contacts || []);
  return { error: ex.error, skipReason, contacts, confirmation: ex.sent[0] || null, sent: ex.sent, nodes: ex.order, logs: ex.logs };
}

function score(fx, res) {
  const exp = fx.expected || {};
  const reasons = [], diffs = [];
  const s = { fieldsChecked: 0, fieldsOk: 0, missed: 0, extra: 0 };
  if (res.error) reasons.push('error: ' + res.error);

  const wantSkip = exp.skip || false;
  s.skipOk = wantSkip ? !!res.skipReason && norm(res.skipReason).startsWith(norm(wantSkip)) : !res.skipReason;
  if (!s.skipOk) reasons.push(`skip: want ${wantSkip || 'none'}, got ${res.skipReason || 'none'}`);

  if (Array.isArray(exp.contacts)) {
    const pool = res.contacts.map(c => ({ c, used: false }));
    for (const e of exp.contacts) {
      const key = norm(e.email);
      const hit = pool.find(p => !p.used && norm(p.c.email) === key);
      if (!hit) { s.missed++; reasons.push('missing ' + (e.email || '(no email)')); diffs.push({ email: e.email, missing: true }); continue; }
      hit.used = true;
      for (const [k, want] of Object.entries(e)) {
        if (k === 'email') continue;
        const got = fieldValue(hit.c, k);
        const ok = PHONE_FIELDS.has(k) ? phoneNorm(got) === phoneNorm(want) : norm(got) === norm(want);
        s.fieldsChecked++;
        if (ok) s.fieldsOk++;
        else { diffs.push({ email: e.email, field: k, expected: want, actual: got ?? '' }); reasons.push(`${e.email}.${k}: want "${want}" got "${got ?? ''}"`); }
      }
    }
    for (const p of pool.filter(p => !p.used)) {
      s.extra++;
      reasons.push('extra ' + (p.c.email || `(no email: ${p.c.firstName || ''} ${p.c.lastName || ''})`));
      diffs.push({ email: p.c.email || '', extra: true, firstName: p.c.firstName || '', lastName: p.c.lastName || '' });
    }
  }
  return { pass: reasons.length === 0, reasons, diffs, ...s };
}

async function pool(list, n, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, list.length) }, async () => {
    while (next < list.length) { const i = next++; await fn(list[i], i); }
  }));
}

function summarize(rows) {
  const groups = new Map();
  const add = (label, r) => {
    if (!groups.has(label)) groups.set(label, { n: 0, pass: 0, fc: 0, fo: 0, missed: 0, extra: 0, skipOk: 0 });
    const g = groups.get(label);
    g.n++; g.pass += r.score.pass ? 1 : 0; g.fc += r.score.fieldsChecked; g.fo += r.score.fieldsOk;
    g.missed += r.score.missed; g.extra += r.score.extra; g.skipOk += r.score.skipOk ? 1 : 0;
  };
  for (const r of rows) { add('all', r); add('category ' + r.category, r); add('split ' + r.split, r); }
  const pct = (a, b) => (b ? (100 * a / b).toFixed(1) + '%' : '-');
  const lines = [['', 'fixtures passed', 'field accuracy', 'missed', 'extra', 'skip-reason acc']];
  for (const [label, g] of groups) {
    lines.push([label, `${g.pass}/${g.n} (${pct(g.pass, g.n)})`, `${g.fo}/${g.fc} (${pct(g.fo, g.fc)})`, String(g.missed), String(g.extra), pct(g.skipOk, g.n)]);
  }
  const widths = lines[0].map((_, i) => Math.max(...lines.map(l => l[i].length)));
  return lines.map(l => l.map((c, i) => c.padEnd(widths[i])).join('  ')).join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const env = JSON.parse(fs.readFileSync(path.join(__dirname, 'env.json'), 'utf8'));
  let wf;
  try { wf = loadWorkflow(args.workflow, args.srcDirs); }
  catch (e) { console.error('cannot load workflow: ' + e.message); return; }

  let fixtures = loadFixtures(path.join(__dirname, 'fixtures'));
  if (args.only) fixtures = fixtures.filter(f => args.only.includes(f.id));
  if (args.category) fixtures = fixtures.filter(f => f.category === args.category);
  if (args.split !== 'all') fixtures = fixtures.filter(f => f.split === args.split);
  if (!fixtures.length) { console.log('no fixtures selected'); return; }

  try { await fetch('http://localhost:11434/api/tags', { signal: AbortSignal.timeout(3000) }); }
  catch (e) { console.error('warning: Ollama is not reachable at http://localhost:11434; uncached AI calls will fail'); }

  const stats = { ollamaCalls: 0, cacheHits: 0 };
  const opts = { env, cacheDir: path.join(__dirname, '.cache'), noCache: !args.cache, stats };
  const rows = [];
  const t0 = Date.now();
  await pool(fixtures, args.concurrency, async fx => {
    const started = Date.now();
    const ex = await runWorkflow(wf, fx, opts);
    const result = extractResult(ex);
    const row = { id: fx.id, category: fx.category, split: fx.split, file: fx._file, ms: Date.now() - started, score: score(fx, result), result };
    rows.push(row);
    if (!args.quiet) {
      const why = row.score.reasons.join('; ');
      console.log(`${row.score.pass ? 'PASS' : 'FAIL'} ${fx.id} (${(row.ms / 1000).toFixed(1)}s)${why ? '  ' + (why.length > 160 ? why.slice(0, 157) + '...' : why) : ''}`);
    }
  });
  rows.sort((a, b) => String(a.id).localeCompare(String(b.id)));

  console.log('\n' + summarize(rows));
  console.log(`\n${rows.length} fixtures in ${((Date.now() - t0) / 1000).toFixed(1)}s; model calls ${stats.ollamaCalls}, cache hits ${stats.cacheHits}`);
  if (args.json) {
    fs.writeFileSync(path.resolve(args.json), JSON.stringify({ workflow: path.relative(ROOT, args.workflow), when: new Date().toISOString(), fixtures: rows }, null, 2));
    console.log('wrote ' + args.json);
  }
}

main().catch(e => console.error(e.stack || e.message)).finally(() => { process.exitCode = 0; });
