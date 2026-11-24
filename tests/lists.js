// Checks for typed contact lists, staff-signature values, "Name, Title" lines, phone extensions and
// a name typed against its email. Each check runs the real Parse AI Response or Email Parser node from
// workflows/email-to-crm.json behind stub nodes. The model reply is an empty list, and OLLAMA_URL points
// at a closed port, so the company re-check fails fast and no model is called.
// node tests/lists.js -> prints "lists ok" or throws.
const assert = require('assert');
const path = require('path');
const { runWorkflow } = require('./lib/engine');

const built = require(path.join(__dirname, '..', 'workflows', 'email-to-crm.json'));
const ENV = { OLLAMA_URL: 'http://127.0.0.1:9' };
const FWD = 'pat@yourcompany.com';
const SIG = '\n\nPat Staffer\nManaging Director | Your Company\nOffice (555) 010-0100\npat@yourcompany.com\n100 Main Street\nAnytown, ST 00000\n';

async function chain(stubs, name) {
  const stub = ([n, json], i) => ({ name: n, type: 'n8n-nodes-base.code', typeVersion: 2, position: [100 * (i + 1), 0],
    parameters: { jsCode: 'return ' + JSON.stringify([{ json }]) + ';' } });
  const nodes = [{ name: 'Get a message1', type: 'n8n-nodes-base.microsoftOutlook', position: [0, 0], parameters: {} },
    ...stubs.map(stub), { ...built.nodes.find(n => n.name === name), position: [900, 0] }];
  const connections = {};
  for (let i = 0; i < nodes.length - 1; i++) connections[nodes[i].name] = { main: [[{ node: nodes[i + 1].name, type: 'main', index: 0 }]] };
  const ex = await runWorkflow({ nodes, connections }, { id: 'lists', email: {} }, { env: ENV, cacheDir: '/nonexistent' });
  assert.strictEqual(ex.error, null, ex.error);
  return ex.runData[name][0].outputs[0][0].json;
}

// Parse AI Response on a body with an empty model reply.
const parse = (body, fwd = FWD) => chain([
  ['Email Parser', { fullBody: body, originalSubject: 'contacts', forwarderEmail: fwd, email_id: 'm1' }],
  ['AI Contact Extractor', { message: { content: '[]' } }],
], 'Parse AI Response');
const list = async body => { const r = await parse(body + SIG); return { contacts: r.contacts, issues: r.listIssues || [] }; };
const pick = (r, email) => r.contacts.find(c => (c.email || '').toLowerCase() === email);
const digits = v => String(v || '').replace(/\D/g, '');

(async () => {
  // Mixed layouts in one email: numbered, bulleted, dashed and "Name <email>" entries.
  let r = await list("Hi, please add these:\n\n1. Pat O'Brien - pat@obrien.example - (305) 555-0101\n2) Mary-Kate Olsen\nmk@olsen.example\ncell 305.555.0102\n\n" +
    '• Sam Q. Public <sam@public.example> 305-555-0103\n- Lee Chang, lee@chang.example, +1 305 555 0104\nThanks!');
  assert.deepStrictEqual(r.contacts.map(c => c.email).sort(), ['lee@chang.example', 'mk@olsen.example', 'pat@obrien.example', 'sam@public.example']);
  assert.deepStrictEqual(r.issues, []);
  assert.strictEqual(pick(r, 'pat@obrien.example').lastName, "O'Brien");
  assert.strictEqual(digits(pick(r, 'pat@obrien.example').phone), '3055550101');
  assert.strictEqual(digits(pick(r, 'mk@olsen.example').mobile), '3055550102');
  assert.strictEqual(pick(r, 'mk@olsen.example').phone, '');
  assert.strictEqual(pick(r, 'sam@public.example').lastName, 'Public');
  assert.strictEqual(pick(r, 'lee@chang.example').firstName, 'Lee');
  assert.ok(r.contacts.every(c => c.extractionMethod === 'LIST_PARSE'));

  // "Last, First" with a company line and a title line.
  r = await list('Smith, John\njsmith@acme-leasing.example\nAcme Leasing LLC\nVP of Sales\n\nDoe, Jane\njane@doe.example');
  const j = pick(r, 'jsmith@acme-leasing.example');
  assert.deepStrictEqual([j.firstName, j.lastName, j.companyName, j.jobTitle], ['John', 'Smith', 'Acme Leasing LLC', 'VP of Sales']);

  // A person with no email is reported, never written.
  r = await list('Ann Lee\nann@lee.example\n\nBob Ray\n(212) 555-0199\n\nCy Day\ncy@day.example');
  assert.deepStrictEqual(r.contacts.map(c => c.email), ['ann@lee.example', 'cy@day.example']);
  assert.strictEqual(r.issues.length, 1);
  assert.match(r.issues[0].reason, /No email/);

  // Two emails in one block with no way to split them: reported, not guessed.
  r = await list('Ann Lee ann@lee.example Bob Ray bob@ray.example (212) 555-0199\n\nCy Day\ncy@day.example\n\nDi Fox\ndi@fox.example');
  assert.deepStrictEqual(r.contacts.map(c => c.email), ['cy@day.example', 'di@fox.example']);
  assert.strictEqual(r.issues.length, 1);
  assert.match(r.issues[0].reason, /Two or more email addresses/);

  // One line, several people separated by semicolons.
  r = await list('Ann Lee <ann@lee.example>; Bob Ray <bob@ray.example>');
  assert.deepStrictEqual(r.contacts.map(c => [c.firstName, c.email]), [['Ann', 'ann@lee.example'], ['Bob', 'bob@ray.example']]);

  // A compact list with no blank lines, email first.
  r = await list('ann@lee.example\nAnn Lee\n212-555-0101\nbob@ray.example\nBob Ray\n212-555-0102');
  assert.deepStrictEqual(r.contacts.map(c => [c.firstName, digits(c.phone)]), [['Ann', '2125550101'], ['Bob', '2125550102']]);

  // Your own numbers and a fax line are never a contact number.
  r = await list('Ann Lee\nann@lee.example\nfax 212-555-0109\n(555) 010-0100\n\nBob Ray\nbob@ray.example');
  assert.strictEqual(pick(r, 'ann@lee.example').phone, '');

  // Labels and an extension.
  r = await list('Ann Lee\nE: ann@lee.example\nP: 212.555.0101 ext 44\nM: 917.555.0102\n\nBob Ray\nbob@ray.example');
  assert.deepStrictEqual([pick(r, 'ann@lee.example').phone, pick(r, 'ann@lee.example').mobile], ['212.555.0101 x44', '917.555.0102']);

  // "Name, Title" lines under a company line.
  r = await list('Harbor Wealth\nRiley Chen, Portfolio Associate\nEmail: riley.chen@harborwealth.example\nPhone: 555-010-0126\n\n' +
    'Harbor Wealth\nMorgan Diaz, Registered Client Service Associate\nEmail: morgan.diaz@harborwealth.example\nPhone: 555-010-0127');
  assert.deepStrictEqual(r.contacts.map(c => [c.firstName, c.lastName, c.companyName, c.jobTitle]),
    [['Riley', 'Chen', 'Harbor Wealth', 'Portfolio Associate'], ['Morgan', 'Diaz', 'Harbor Wealth', 'Registered Client Service Associate']]);

  // Upper-case names; free text is kept out of the record and listed as not used.
  r = await list('ANN LEE\nann@lee.example\nmet at the trade show\n\nBOB RAY\nbob@ray.example');
  assert.deepStrictEqual([pick(r, 'ann@lee.example').firstName, pick(r, 'ann@lee.example').lastName, pick(r, 'ann@lee.example').companyName], ['Ann', 'Lee', '']);
  assert.match(pick(r, 'ann@lee.example').infoNotes.join(' '), /Not used: met at the trade show/);

  // Not a list: one person, a forwarded thread, a company line over bare emails, a thread on one line.
  // These go to the normal path, so no contact is marked LIST_PARSE.
  const notList = async body => (await parse(body + SIG)).contacts.every(c => c.extractionMethod !== 'LIST_PARSE');
  assert.ok(await notList('Ann Lee\nann@lee.example\n212-555-0101'));
  assert.ok(await notList('FYI see below\n\nFrom: Ann Lee <ann@lee.example>\nSent: Monday\nTo: Pat\nSubject: hi\n\nBob Ray bob@ray.example'));
  assert.ok(await notList('Harbor Wealth\nkelly.k@harborwealth.example\nsarah.t@harborwealth.example'));
  assert.ok(await notList('Ann Lee ann@lee.example 212-555-0101 From: Bob Ray <bob@ray.example> Sent: Monday Subject: hi cy@day.example'));

  // Over 100 people: the first 100 are written, the rest are listed as not added.
  const many = Array.from({ length: 102 }, (_, i) => `Person Number${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + Math.floor(i / 26))}\np${i}@many.example`).join('\n\n');
  r = await list(many);
  assert.strictEqual(r.contacts.length, 100);
  assert.strictEqual(r.issues.length, 2);
  assert.match(r.issues[0].reason, /Over 100 people/);

  // Staff signature values: a one-line forward puts the forwarder's signature right under the contact,
  // and the model copied its title and office city onto the contact. Neither may land there.
  const withAi = (body, ai) => chain([
    ['Email Parser', { fullBody: body, originalSubject: 'x', forwarderEmail: FWD }],
    ['AI Contact Extractor', { message: { content: JSON.stringify(ai) } }],
  ], 'Parse AI Response');
  const DANA = 'dana@reyesfreight.example';
  r = await withAi('Dana Reyes\n' + DANA + '\n\nPat Staffer\nManaging Director\n100 Main Street\nAnytown, ST 00000',
    [{ firstName: 'Dana', lastName: 'Reyes', email: DANA, jobTitle: 'Managing Director', city: 'Anytown', state: 'ST' }]);
  let d = pick(r, DANA);
  assert.deepStrictEqual([d.jobTitle, d.city, d.state], ['', '', '']);
  // The contact's own title stays even when it matches the forwarder's.
  r = await parse('FYI\n\nPat Staffer\nManaging Director\nFrom: Dana Reyes <dana@reyesfreight.example>\nSubject: hi\n\n' +
    'Dana Reyes\nManaging Director\nReyes Freight LLC\nNashville, TN 37201\ndana@reyesfreight.example');
  d = pick(r, DANA);
  assert.deepStrictEqual([d.jobTitle, d.city], ['Managing Director', 'Nashville']);

  // A "Name, Title" signature line is read as a name and a title; the street above "City, ST zip" is kept with the zip.
  r = await parse('Please add\n\nDana Reyes, Broker / President\nReyes Freight LLC\n200 Elm Avenue\nNashville, TN 37201\ndana@reyesfreight.example');
  d = pick(r, 'dana@reyesfreight.example');
  assert.deepStrictEqual([d.firstName, d.lastName, d.jobTitle, d.address, d.zip], ['Dana', 'Reyes', 'Broker / President', '200 Elm Avenue', '37201']);
  // Your own office address is never the contact's street.
  r = await parse('Please add\n\nDana Reyes\nReyes Freight LLC\n100 Main Street\nAnytown, ST 00000\ndana@reyesfreight.example');
  assert.strictEqual(pick(r, 'dana@reyesfreight.example').address, '');

  // A phone extension: "Ext. 130" is not split off as a fake mobile "130", and it is put back on the
  // phone even when the model left it off.
  for (const phone of ['555.010.0144 Ext. 130', '555.010.0144']) {
    d = pick(await withAi('Please add Dana Reyes ' + DANA + ' 555.010.0144 Ext. 130', [{ firstName: 'Dana', lastName: 'Reyes', email: DANA, phone }]), DANA);
    assert.deepStrictEqual([d.phone, d.mobile], ['555.010.0144 x130', '']);
  }

  // Email Parser: a name typed against its email gets its space back; "at Jane.Doe@..." is left alone.
  const body = async t => (await chain([['Map Outlook to Standard Format', { subject: 's', body: t, from: FWD }]], 'Email Parser')).fullBody;
  assert.strictEqual(await body('Adam Smithadam@acme.example'), 'Adam Smith adam@acme.example');
  assert.strictEqual(await body('John Smithjohn.smith@acme.example'), 'John Smith john.smith@acme.example');
  assert.strictEqual(await body('Colin Lind colin@lindfp.example'), 'Colin Lind colin@lindfp.example');
  assert.strictEqual(await body('at Jane.Doe@acme.example'), 'at Jane.Doe@acme.example');
  assert.strictEqual(await body('Email Pat@yourcompany.com'), 'Email Pat@yourcompany.com');

  console.log('lists ok');
})().catch(e => { console.error(e); process.exit(1); });
