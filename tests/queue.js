// Checks for the mail queue, the Zoho token cache, the confirmation's retry path and
// Pipeline Health (no model calls). The fixture harness starts after "Get a message1",
// so the queue nodes never run there; this file runs them against a temp ledger.
// node tests/queue.js -> prints "queue ok" or throws.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runWorkflow } = require('./lib/engine');

const SRC = path.join(__dirname, '..', 'src', 'nodes');
const built = require(path.join(__dirname, '..', 'workflows', 'email-to-crm.json'));
const AsyncFn = Object.getPrototypeOf(async function () {}).constructor;
const src = f => fs.readFileSync(path.join(SRC, f), 'utf8');

// Queue nodes run directly, with /data mapped to a temp dir that lives for the whole file.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'email-to-crm-queue-'));
const map = p => (p.startsWith('/data/') ? path.join(tmp, p.slice(6)) : p);
const fsShim = { ...fs, readFileSync: (p, ...a) => fs.readFileSync(map(p), ...a), appendFileSync: (p, ...a) => fs.appendFileSync(map(p), ...a),
  existsSync: p => fs.existsSync(map(p)), writeFileSync: (p, ...a) => fs.writeFileSync(map(p), ...a) };
let ollamaUp = true;
const httpShim = { get: (u, o, cb) => { const r = { on: (ev, f) => { if (ev === 'error' && !ollamaUp) setImmediate(f); return r; }, destroy() {} };
  if (ollamaUp) setImmediate(() => cb({ statusCode: 200, resume() {} })); return r; } };
const req = m => (m === 'fs' ? fsShim : m === 'http' ? httpShim : require(m));
const WF = 'queuetest', LEDGER = '/data/ingest_ledger_' + WF + '.log';
const direct = (code, input, store = {}, env = {}) => new AsyncFn('$input', '$workflow', 'require', '$getWorkflowStaticData', '$env', code)(
  { all: () => input, first: () => input[0] }, { id: WF }, req, () => store, env);
const msg = (id, from = 'pat@yourcompany.com', at = '2026-01-05T10:00:00Z', subject = 'FW: intro') =>
  ({ id, receivedDateTime: at, subject, from: { emailAddress: { address: from } } });
const claimSrc = src('Claim_New_Mail.js');
const claim = async (msgs, code = claimSrc) => (await direct(code, [{ json: { value: msgs } }])).map(i => i.json.id);
const mark = items => direct(src('Mark_Processed.js'), items.map(json => ({ json })));
const ledger = () => fs.readFileSync(map(LEDGER), 'utf8');
// Moves a message's claim/release lines far into the past, as if its lease or retry delay ran out.
const age = id => fs.writeFileSync(map(LEDGER), ledger().replace(new RegExp('^\\S+(\\t(?:claim|release)\\t' + id + ')$', 'gm'), '2000-01-01T00:00:00.000Z$1'));

// Sub-workflow: Get a message1 -> stubs in order -> the named real nodes with their real connections.
async function chain(stubs, reals, staticData = {}) {
  const stub = ([name, json], i) => ({ name, type: 'n8n-nodes-base.code', typeVersion: 2, position: [100 * (i + 1), 0],
    parameters: { jsCode: 'return ' + JSON.stringify([].concat(json).map(j => ({ json: j }))) + ';' } });
  const nodes = [{ name: 'Get a message1', type: 'n8n-nodes-base.microsoftOutlook', position: [0, 0], parameters: {} }, ...stubs.map(stub),
    ...reals.map(n => built.nodes.find(x => x.name === n))];
  const connections = {};
  for (let i = 0; i <= stubs.length; i++) connections[nodes[i].name] = { main: [[{ node: nodes[i + 1].name, type: 'main', index: 0 }]] };
  for (const n of reals) {
    const main = (built.connections[n] || { main: [] }).main.map(l => (l || []).filter(c => reals.includes(c.node)));
    if (main.length) connections[n] = { main };
  }
  const ex = await runWorkflow({ nodes, connections }, { id: 'queue', email: {} }, { env: { UNDO_SECRET: 'test-undo-secret' }, cacheDir: '/nonexistent', staticData });
  assert.strictEqual(ex.error, null, ex.error);
  const out = name => (ex.runData[name] ? ex.runData[name][0].outputs[0].map(i => i.json) : []);
  return { ex, out };
}

(async () => {
  // Claim New Mail: a first run with no ADOPT_BEFORE marks the whole mailbox done.
  assert.deepStrictEqual(await claim([msg('h1'), msg('h2')], claimSrc.replace('$workflow.id', "'fresh'")), []);
  // A first run with ADOPT_BEFORE adopts older mail and claims newer mail.
  const adopt = claimSrc.replace("const ADOPT_BEFORE = '';", "const ADOPT_BEFORE = '2026-01-05T11:00:00Z';");
  assert.deepStrictEqual(await claim([msg('old1'), msg('new1', 'pat@yourcompany.com', '2026-01-05T11:30:00Z')], adopt), ['new1']);
  // One batch at a time: nothing is claimed while new1 is running; done messages never come back.
  assert.deepStrictEqual(await claim([msg('old1'), msg('new1'), msg('new2')]), []);
  // The workflow's own confirmations are marked done even while a batch is running.
  assert.deepStrictEqual(await claim([msg('self', 'Contacts@YourCompany.com')]), []);
  assert.match(ledger(), /\tdone\tself\n/);
  assert.deepStrictEqual(await claim([msg('self2', '/O=EXCHANGELABS/OU=EXCHANGE ADMINISTRATIVE GROUP/CN=RECIPIENTS/CN=X', undefined, '[CRM] Added 1 contact: Dana Whitlock')]), []);
  assert.match(ledger(), /\tdone\tself2\n/);
  // A legacy sender without the subject tag is not ours, so it is not marked done.
  await claim([msg('self3', '/O=EXCHANGELABS/OU=EXCHANGE ADMINISTRATIVE GROUP/CN=RECIPIENTS/CN=X', undefined, 'Re: intro')]);
  assert.doesNotMatch(ledger(), /\tdone\tself3\n/);
  // Graph down: nothing claimed, nothing marked.
  assert.deepStrictEqual(await direct(claimSrc, [{ json: { error: { message: '502' } } }]), []);
  // Batch finishes, next batch goes.
  await mark([{ emailId: 'new1' }]);
  assert.deepStrictEqual(await claim([msg('new1'), msg('new2')]), ['new2']);
  // Zoho refused new2: released, retried only after the back-off, as attempt 2; new mail is not blocked.
  await mark([{ emailId: 'new2', retry: true }]);
  assert.deepStrictEqual(await claim([msg('new2'), msg('new3')]), ['new3']);
  await mark([{ emailId: 'new3' }]);
  age('new2');
  assert.deepStrictEqual((await direct(claimSrc, [{ json: { value: [msg('new2')] } }])).map(i => [i.json.id, i.json.attempt]), [['new2', 2]]);
  // Crash: claimed, never done or released. Blocks new claims until the lease runs out, then is handed out again.
  assert.deepStrictEqual(await claim([msg('new2'), msg('new4')]), []);
  age('new2');
  assert.deepStrictEqual(await claim([msg('new2'), msg('new4')]), ['new2', 'new4']);
  age('new2'); age('new4'); await claim([msg('new2')]); age('new2');
  assert.deepStrictEqual(await claim([msg('new2')]), [], 'stops after 4 attempts');
  // Mark Processed: done, release, and the Skip Self-Sent? shape (email_id).
  const summary = await mark([{ emailId: 'a1' }, { emailId: 'r1', retry: true }, { email_id: 's1' }]);
  assert.deepStrictEqual(summary[0].json, { done: 2, released: 1 });
  assert.match(ledger(), /\tdone\ta1\n/); assert.match(ledger(), /\tdone\ts1\n/); assert.match(ledger(), /\trelease\tr1\n/);
  assert.doesNotMatch(ledger(), /\tdone\tr1/);
  // Three per run, the rest on later runs.
  await mark([{ emailId: 'new4' }]);
  const many = Array.from({ length: 25 }, (_, i) => msg('m' + i, 'jordan@acme.example', '2026-01-05T12:00:00Z'));
  for (let k = 0; k < 9; k++) {
    const got = await claim(many);
    assert.strictEqual(got.length, k < 8 ? 3 : 1);
    await mark(got.map(emailId => ({ emailId })));
  }
  assert.strictEqual((await claim(many)).length, 0);

  // Zoho Token Gate: refresh when there is no token or it is 50+ minutes old.
  const store = {};
  const gate = async () => (await direct(src('Zoho_Token_Gate.js'), [{ json: {} }], store))[0].json;
  assert.deepStrictEqual(await gate(), { needRefresh: true });
  Object.assign(store, { zohoToken: 'T', zohoTokenAt: Date.now() - 10 * 60000 });
  assert.deepStrictEqual(await gate(), { access_token: 'T', cachedToken: true });
  store.zohoTokenAt = Date.now() - 51 * 60000;
  assert.deepStrictEqual(await gate(), { needRefresh: true });

  // Prepare Upsert token cache: a fresh login is saved; a failed refresh reuses a token under 50 minutes old.
  const csv = { contacts: [{ firstName: 'Dana', lastName: 'Whitlock', email: 'dwhitlock@harborline.example', type: 'Broker' }] };
  const upsert = async (token, sd) => (await chain([['Save to CSV', csv], ['Refresh Zoho Token', token]], ['Prepare Upsert'], sd)).out('Prepare Upsert')[0];
  const sd = {};
  assert.strictEqual((await upsert({ access_token: 'T1' }, sd)).accessToken, 'T1');
  assert.strictEqual(sd.zohoToken, 'T1');
  const reused = await upsert({ error: { message: '400 too many requests' } }, sd);
  assert.strictEqual(reused.accessToken, 'T1'); assert.ok(!reused.zohoFailed);
  sd.zohoTokenAt = Date.now() - 51 * 60000;
  assert.strictEqual((await upsert({ error: {} }, sd)).zohoFailed, true);
  assert.strictEqual((await upsert({ error: {} }, {})).zohoFailed, true);
  // A token handed in by the gate is reused, never re-stamped (it would outlive its 60 minutes).
  const sd2 = { zohoToken: 'OLD', zohoTokenAt: 1000 };
  assert.strictEqual((await upsert({ access_token: 'OLD', cachedToken: true }, sd2)).accessToken, 'OLD');
  assert.strictEqual(sd2.zohoTokenAt, 1000);

  // Prepare Confirmation Email -> Has Confirmation? / Mark Processed.
  const confirm = (email, upsertJson, sd3 = {}) => chain([['Format for CSV', email], ['Upsert Contact', upsertJson]],
    ['Prepare Confirmation Email', 'Has Confirmation?', 'Send Confirmation', 'Mark Processed'], sd3);
  const base = { email_id: 'msg-1', forwarderEmail: 'pat@yourcompany.com', originalSubject: 'FW: intro', contacts: [] };
  const ok = id => ({ data: [{ code: 'SUCCESS', action: 'insert', message: 'record added', details: { id } }] });
  // Zoho refused: no email to the forwarder, the message is released for retry, and the token clock is cleared.
  const sd3 = { zohoToken: 'T', zohoTokenAt: Date.now() };
  let r = await confirm({ ...base, contacts: [{ firstName: 'Dana', lastName: 'Whitlock', email: 'dwhitlock@harborline.example' }] },
    { error: { message: 'Request failed with status code 401' } }, sd3);
  const pc = r.out('Prepare Confirmation Email');
  assert.ok(pc.length && pc.every(o => o.skipEmail && o.retry && !o.emailBody && o.emailId === 'msg-1'), JSON.stringify(pc));
  assert.strictEqual(r.ex.sent.length, 0);
  assert.strictEqual(sd3.zohoTokenAt, 0);
  assert.deepStrictEqual(r.out('Mark Processed')[0], { done: 0, released: 1 });
  // Success: one confirmation, the message is done.
  r = await confirm({ ...base, contacts: [{ firstName: 'Dana', lastName: 'Whitlock', email: 'dwhitlock@harborline.example' }] }, ok('z1'));
  assert.strictEqual(r.ex.sent.length, 1);
  assert.strictEqual(r.ex.sent[0].subject, '[CRM] Added 1 contact: Dana Whitlock');
  assert.deepStrictEqual(r.out('Mark Processed')[0], { done: 1, released: 0 });
  // A malformed email is shown as skipped, not retried as a Zoho failure.
  r = await confirm({ ...base, contacts: [{ firstName: 'Dana', lastName: 'Whitlock', email: 'dwhitlock@harborline' }] }, { error: { message: 'no body' } });
  const skipped = r.out('Prepare Confirmation Email')[0];
  assert.ok(!skipped.retry, JSON.stringify(skipped).slice(0, 200));
  assert.match(skipped.emailSubject, /^\[CRM\] Skipped 1 contact: Dana Whitlock$/);
  assert.match(skipped.emailBody, /No email address found/);
  // Several contacts: an undo link per contact, and list entries that were not added are listed.
  r = await confirm({ ...base, listIssues: [{ raw: 'Jordan Reyes / (555) 010-0177', reason: 'No email address for this person' }],
    contacts: [{ firstName: 'Dana', lastName: 'Whitlock', email: 'dwhitlock@harborline.example' }, { firstName: 'Will', lastName: 'Archer', email: 'will@acme.example' }] },
    { data: [...ok('z1').data, ...ok('z2').data] });
  const body = r.ex.sent[0].body;
  assert.strictEqual(body.match(/Undo just this contact: /g).length, 2);
  assert.match(body, /━━━ Not added, please check \(1\) ━━━\n1\. Jordan Reyes \/ \(555\) 010-0177\n   → No email address for this person\n/);
  assert.match(body, /Undo this update \(expires in 24hrs\): /);

  // Pipeline Health: one alert when a problem appears, one when it clears, nothing in between.
  const ago = min => new Date(Date.now() - min * 60000).toISOString();
  const hmsg = (id, min, from = 'pat@yourcompany.com') => ({ id, receivedDateTime: ago(min), subject: 'Customer add to CRM', from: { emailAddress: { address: from } } });
  const healthSrc = src('Pipeline_Health.js');
  const hstore = {};
  const health = (value, code = healthSrc.replace("'<main-workflow-id>'", "'" + WF + "'"), env = {}) =>
    direct(code, [{ json: value === null ? { error: '502' } : { value } }], hstore, env).then(o => o.map(i => i.json));
  fs.writeFileSync(map(LEDGER), `${ago(5)}\tdone\th-a\n`);
  assert.deepStrictEqual(await health([hmsg('h-a', 60), hmsg('h-b', 10), hmsg('h-c', 90, 'contacts@yourcompany.com')]), [], 'healthy: no mail');
  let out = await health([hmsg('h-a', 60), hmsg('h-b', 50)]);
  assert.strictEqual(out[0].subject, '[CRM pipeline] Needs attention');
  assert.strictEqual(out[0].to, 'you@yourcompany.com');
  assert.match(out[0].body, /1 forwarded email\(s\) not processed/);
  assert.deepStrictEqual(await health([hmsg('h-a', 61), hmsg('h-b', 51)]), [], 'same problem: no repeat');
  fs.appendFileSync(map(LEDGER), `${ago(1)}\tdone\th-b\n`);
  out = await health([hmsg('h-a', 62), hmsg('h-b', 52)], undefined, { ALERT_EMAIL: 'ops@yourcompany.com' });
  assert.strictEqual(out[0].subject, '[CRM pipeline] Back to normal');
  assert.strictEqual(out[0].to, 'ops@yourcompany.com');
  fs.appendFileSync(map(LEDGER), ['claim', 'claim', 'claim', 'claim'].map(e => `${ago(1)}\t${e}\th-d`).join('\n') + '\n');
  assert.deepStrictEqual(await health([hmsg('h-d', 20)]), [], 'fourth try still in its lease: not given up yet');
  fs.appendFileSync(map(LEDGER), `${ago(1)}\trelease\th-d\n`);
  out = await health([hmsg('h-d', 20)]); assert.match(out[0].body, /given up on/);
  ollamaUp = false; out = await health([hmsg('h-d', 21)]); assert.match(out[0].body, /Ollama/);
  ollamaUp = true; out = await health(null); assert.match(out[0].body, /mailbox not reachable/);
  // An unset workflow id is reported, not silently read as an empty ledger.
  out = await health([], healthSrc); assert.match(out[0].body, /MAIN_WORKFLOW_ID is not set/);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('queue ok');
})().catch(e => { fs.rmSync(tmp, { recursive: true, force: true }); console.error(e); process.exit(1); });
