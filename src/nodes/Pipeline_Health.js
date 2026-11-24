// Pipeline Health
//
// Runs every 10 minutes in its own workflow (workflows/pipeline-health.json) and emails
// ALERT_EMAIL when the contact pipeline needs a person, before the forwarders notice:
// - forwarded mail still not processed LATE_MIN minutes after it arrived (queue stuck or model too slow)
// - a message that failed MAX_ATTEMPTS times and was given up on
// - the mailbox not readable
// - the local model (Ollama) not answering
// It sends one email when a problem appears and one when everything is clear again, and
// nothing while the state holds, so a long outage is not a flood of alerts.
//
// Input: the List Mailbox response ({ value: [messages] }, or an error item).
// Output: [] when nothing changed, else one item { to, subject, body } for Send Alert.

// Organization settings
const INTAKE_ADDRESS = 'contacts@yourcompany.com';
const SUBJECT_TAG = '[CRM]';
// Who gets the alerts. ALERT_EMAIL in the n8n environment overrides this placeholder.
let ALERT_EMAIL = 'you@yourcompany.com';
try { if (typeof $env !== 'undefined' && $env.ALERT_EMAIL) ALERT_EMAIL = $env.ALERT_EMAIL; } catch (e) {}
// The id of the imported Email-to-CRM workflow (from its URL in n8n). The ledger file is
// named after it, and this workflow has a different id of its own.
const MAIN_WORKFLOW_ID = '<main-workflow-id>';
const OLLAMA_URL = 'http://ollama:11434';

const fs = require('fs'), http = require('http');
const LEDGER = '/data/ingest_ledger_' + MAIN_WORKFLOW_ID + '.log';
const LATE_MIN = 45, MAX_ATTEMPTS = 4, LEASE_MIN = 90; // same limits as Claim New Mail
const TAG_RE = new RegExp('^' + SUBJECT_TAG.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' ');

const listed = $input.first().json;
const problems = [];
if (MAIN_WORKFLOW_ID.startsWith('<')) problems.push('MAIN_WORKFLOW_ID is not set in Pipeline Health, so the queue ledger cannot be read');
if (!Array.isArray(listed.value)) problems.push('Microsoft mailbox not reachable: ' + JSON.stringify(listed.error || listed).slice(0, 200));

const state = new Map();
for (const line of (fs.existsSync(LEDGER) ? fs.readFileSync(LEDGER, 'utf8') : '').split('\n')) {
  const [ts, ev, id] = line.split('\t');
  if (!id) continue;
  const s = state.get(id) || { done: false, claims: 0, last: '', lastClaim: 0 };
  if (ev === 'done') s.done = true;
  if (ev === 'claim') { s.claims++; s.lastClaim = Date.parse(ts) || 0; }
  s.last = ev;
  state.set(id, s);
}
const now = Date.now(), late = [], gaveUp = [];
for (const m of listed.value || []) {
  const from = (((m.from || {}).emailAddress || {}).address || '').toLowerCase();
  if (from === INTAKE_ADDRESS || (/^\/o=exchangelabs/.test(from) && TAG_RE.test(m.subject || ''))) continue; // same rule as Claim New Mail
  const s = state.get(m.id) || { done: false, claims: 0 };
  if (s.done) continue;
  const line = `${m.receivedDateTime.slice(0, 16).replace('T', ' ')}Z  ${from}  "${(m.subject || '').slice(0, 60)}"`;
  if (s.claims >= MAX_ATTEMPTS && (s.last === 'release' || now - s.lastClaim > LEASE_MIN * 60000)) gaveUp.push(line); // last try finished, or its lease ran out
  else if (now - Date.parse(m.receivedDateTime) > LATE_MIN * 60000) late.push(line + (s.claims ? `  (tried ${s.claims}x)` : '  (not started)'));
}
if (late.length) problems.push(`${late.length} forwarded email(s) not processed after ${LATE_MIN} min:\n  ` + late.join('\n  '));
if (gaveUp.length) problems.push(`${gaveUp.length} email(s) failed ${MAX_ATTEMPTS} times and were given up on:\n  ` + gaveUp.join('\n  '));

const ollamaUp = await new Promise(res => {
  const r = http.get(OLLAMA_URL + '/api/tags', { timeout: 15000 }, x => { x.resume(); res(x.statusCode === 200); });
  r.on('timeout', () => { r.destroy(); res(false); }); r.on('error', () => res(false));
});
if (!ollamaUp) problems.push('Local model (Ollama) not answering at ' + OLLAMA_URL);

// Alert on a change of state only; counts are masked so a growing backlog is not a new problem.
const sd = $getWorkflowStaticData('global');
const key = problems.map(p => p.split('\n')[0].replace(/^\d+ /, 'N ')).join('|');
if (key === (sd.lastKey || '')) return [];
sd.lastKey = key;
return [{ json: {
  to: ALERT_EMAIL,
  subject: problems.length ? '[CRM pipeline] Needs attention' : '[CRM pipeline] Back to normal',
  body: (problems.length ? problems.join('\n\n') : 'All checks pass again: queue moving, model answering.') +
    '\n\nLedger: ' + LEDGER + ' in the n8n container.',
} }];
