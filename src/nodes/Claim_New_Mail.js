// Claim New Mail
//
// The queue in front of the pipeline. List Mailbox returns every message from the last
// 10 days once a minute, and this node passes on the ones the ledger has no "done" mark
// for. A polling trigger that advances its clock on a failed poll loses the mail that
// arrived during an outage; re-reading the mailbox against a ledger does not.
//
// Mark Processed writes "done" once a message's confirmation is built, or "release" when
// Zoho refused it; a released message is tried again after RETRY_MIN. A message whose run
// crashed (reboot, power cut) stays claimed and is handed out again after LEASE_MIN.
// After MAX_ATTEMPTS claims it is left alone and Pipeline Health reports it.
//
// One batch runs at a time. Overlapping runs processed the same mail twice and slowed
// the local model, so nothing new is claimed while a batch is running.
//
// Input: the List Mailbox response ({ value: [messages] }, or an error item).
// Output: one item { id, attempt } per claimed message, at most PER_RUN.
// Ledger: /data/ingest_ledger_<workflow id>.log, one line per event: <ISO time>\t<claim|done|release>\t<message id>

// Organization settings
const INTAKE_ADDRESS = 'contacts@yourcompany.com';
const SUBJECT_TAG = '[CRM]';

const fs = require('fs');
const LEDGER = '/data/ingest_ledger_' + $workflow.id + '.log';
// The lease must outlast a batch: three long emails can take half an hour on a loaded local model.
const LEASE_MIN = 90, RETRY_MIN = 10, MAX_ATTEMPTS = 4, PER_RUN = 3;
// First run only (no ledger yet): mail received before this ISO time is marked done without
// processing, for example mail an earlier trigger already handled. Left empty, the first
// run marks everything in the mailbox done, so switching the queue on never reprocesses history.
const ADOPT_BEFORE = '';
const TAG_RE = new RegExp('^' + SUBJECT_TAG.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' ');

const firstRun = !fs.existsSync(LEDGER);
const state = new Map(); // id -> { done, claims, lastClaim, released, releasedAt }
if (!firstRun) {
  for (const line of fs.readFileSync(LEDGER, 'utf8').split('\n')) {
    const [ts, ev, id] = line.split('\t');
    if (!id) continue;
    const s = state.get(id) || { done: false, claims: 0, lastClaim: 0, released: false, releasedAt: 0 };
    if (ev === 'done') s.done = true;
    if (ev === 'claim') { s.claims++; s.lastClaim = Date.parse(ts) || 0; s.released = false; }
    if (ev === 'release') { s.released = true; s.releasedAt = Date.parse(ts) || 0; }
    state.set(id, s);
  }
}

const listed = $input.first().json;
if (!Array.isArray(listed.value)) return []; // Graph unreachable: try again next minute

const now = Date.now(), stamp = new Date().toISOString(), lines = [], out = [];
const batchRunning = [...state.values()].some(s => !s.done && !s.released && s.claims < MAX_ATTEMPTS + 1 && now - s.lastClaim < LEASE_MIN * 60000);
for (const m of listed.value) {
  const s = state.get(m.id) || { done: false, claims: 0, lastClaim: 0, released: false };
  if (s.done) continue;
  const from = ((m.from || {}).emailAddress || {}).address || '';
  // The workflow's own confirmations can show the Exchange legacy address (/O=EXCHANGELABS/...) instead of the intake address.
  const ours = from.toLowerCase() === INTAKE_ADDRESS || (/^\/o=exchangelabs/i.test(from) && TAG_RE.test(m.subject || ''));
  if (ours || (firstRun && (!ADOPT_BEFORE || m.receivedDateTime < ADOPT_BEFORE))) { lines.push(stamp + '\tdone\t' + m.id); continue; }
  if (batchRunning || out.length >= PER_RUN) continue;               // a batch is running, or this one is full
  if (s.claims >= MAX_ATTEMPTS) continue;                         // given up; Pipeline Health reports it
  if (s.released ? now - s.releasedAt < RETRY_MIN * 60000 : s.claims && now - s.lastClaim < LEASE_MIN * 60000) continue; // retry delay, or a crashed run's lease
  lines.push(stamp + '\tclaim\t' + m.id);
  out.push({ json: { id: m.id, attempt: s.claims + 1 } });
}
if (lines.length) fs.appendFileSync(LEDGER, lines.join('\n') + '\n');
return out;
