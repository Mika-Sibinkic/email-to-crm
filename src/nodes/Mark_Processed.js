// Mark Processed
//
// Writes the ledger mark that takes a message out of the queue (see Claim New Mail).
// "done" for a message whose confirmation was built, or that Skip Self-Sent? discarded.
// "release" when retry is true: Zoho refused the upsert, and Claim New Mail hands the
// message out again after its retry delay.
//
// Input: Prepare Confirmation Email items ({ emailId, retry }) or Skip Self-Sent? items ({ email_id }).
// Output: one summary item { done, released }.
const fs = require('fs');
const LEDGER = '/data/ingest_ledger_' + $workflow.id + '.log';
const ev = new Map(); // id -> done | release
for (const it of $input.all()) {
  const j = it.json, id = j.emailId || j.email_id || '';
  if (id) ev.set(id, j.retry ? 'release' : 'done');
}
const stamp = new Date().toISOString();
if (ev.size) fs.appendFileSync(LEDGER, [...ev].map(([id, e]) => stamp + '\t' + e + '\t' + id).join('\n') + '\n');
return [{ json: { done: [...ev.values()].filter(e => e === 'done').length, released: [...ev.values()].filter(e => e === 'release').length } }];
