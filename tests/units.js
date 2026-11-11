// Node-level checks for rules a whole-email fixture cannot pin down (no model calls).
// Each check runs one real Code node from workflows/email-to-crm.json behind stub nodes.
// node tests/units.js -> prints "units ok" or throws.
const assert = require('assert');
const path = require('path');
const { runWorkflow } = require('./lib/engine');

const built = require(path.join(__dirname, '..', 'workflows', 'email-to-crm.json'));
const real = name => ({ ...built.nodes.find(n => n.name === name), position: [900, 0] });
const stub = (name, json, x) => ({ name, type: 'n8n-nodes-base.code', typeVersion: 2, position: [x, 0],
  parameters: { jsCode: 'return ' + JSON.stringify([].concat(json).map(j => ({ json: j }))) + ';' } });

// Get a message1 -> stubs in order -> the real node; returns the real node's first output json.
async function runNode(name, stubs) {
  const nodes = [{ name: 'Get a message1', type: 'n8n-nodes-base.microsoftOutlook', position: [0, 0], parameters: {} },
    ...stubs.map(([n, j], i) => stub(n, j, 100 * (i + 1))), real(name)];
  const connections = {};
  for (let i = 0; i < nodes.length - 1; i++) connections[nodes[i].name] = { main: [[{ node: nodes[i + 1].name, type: 'main', index: 0 }]] };
  const ex = await runWorkflow({ nodes, connections }, { id: 'units', email: {} }, { env: {}, cacheDir: '/nonexistent' });
  assert.strictEqual(ex.error, null, ex.error);
  return ex.runData[name][0].outputs[0].map(i => i.json);
}

const sanity = async c => (await runNode('Final Sanity Clean', [['Merge', { contacts: [{ firstName: 'Pat', lastName: 'Example', email: 'pat@acme.example', ...c }] }]]))[0].contacts[0];

(async () => {
  // Calling codes: a US number on a foreign contact stays as written; 00 becomes +; trunk 0 is required.
  assert.strictEqual((await sanity({ phone: '(915) 555-0100', country: 'Mexico' })).phone, '(915) 555-0100');
  assert.strictEqual((await sanity({ phone: '(212) 555-0100', country: 'United Kingdom' })).phone, '(212) 555-0100');
  assert.strictEqual((await sanity({ phone: '1-212-555-0100', country: 'Germany' })).phone, '1-212-555-0100');
  assert.strictEqual((await sanity({ phone: '0034 915 550 142', country: 'Spain' })).phone, '+34 915 550 142');
  assert.strictEqual((await sanity({ phone: '020 7946 0000', country: 'United Kingdom' })).phone, '+44 20 7946 0000');
  // City: an upper-case region code is dropped, a short mixed-case city is kept.
  assert.strictEqual((await sanity({ city: 'Miraflores, Lima', country: 'Peru' })).city, 'Lima');
  assert.strictEqual((await sanity({ city: 'Downtown, Reno' })).city, 'Reno');
  assert.strictEqual((await sanity({ city: 'Austin, TX' })).city, 'Austin');

  // Note rules in Validate Contact Type.
  const two = [{ firstName: 'Will', lastName: 'Archer', email: 'will@acme.example', type: 'Broker' },
               { firstName: 'Jordan', lastName: 'Reyes', email: 'jordan@acme.example', type: 'Broker' }];
  const validate = async extra => (await runNode('Validate Contact Type', [['Prior', { contacts: two, fullBody: '', ...extra }]]))[0].contacts.map(c => c.firstName);
  assert.deepStrictEqual(await validate({ forwarderInstruction: 'Pls add to CRM, he will send the signed LOI Monday' }), ['Will', 'Jordan']);
  assert.deepStrictEqual(await validate({ forwarderInstruction: 'Please add Jordan to the CRM' }), ['Jordan']);
  // An exclusion on its own note line (rawForwarderInstruction) is honored.
  assert.deepStrictEqual(await validate({ forwarderInstruction: 'Add to CRM', rawForwarderInstruction: 'Will is already in there' }), ['Jordan']);

  // Parse PDF Contacts: each number on a shared card line takes its own label.
  const card = 'Jane Card\nm 555.010.0166 / o 555.010.0120\njane@acme.example';
  const reply = { message: { content: JSON.stringify({ contacts: [{ firstName: 'Jane', lastName: 'Card', email: 'jane@acme.example', phone: '555.010.0166', mobile: '555.010.0120' }] }) } };
  const pdf = async text => (await runNode('Parse PDF Contacts', [['Parse AI Response', { contacts: [], fullBody: '' }], ['Extract Attachment Text', { pdfText: text }], ['AI Extract from PDF', reply]]))[0].contacts[0];
  const swapped = await pdf(card);
  assert.deepStrictEqual([swapped.phone, swapped.mobile], ['555.010.0120', '555.010.0166']);
  // Two numbers labelled for the same slot: keep the model's values.
  const clash = await pdf('Jane Card\nm 555.010.0166 / m 555.010.0120\njane@acme.example');
  assert.deepStrictEqual([clash.phone, clash.mobile], ['555.010.0166', '555.010.0120']);

  // Obfuscated addresses: a bracketed (at) may use a real dot; an all-caps line is prose.
  const mapped = async text => (await runNode('Map Outlook to Standard Format', [['Message', { id: 'u1', subject: 'Intro',
    from: { emailAddress: { address: 'pat@yourcompany.com' } }, body: { contentType: 'text', content: text } }]]))[0].body;
  assert.match(await mapped('Please add Jane, write to jane (at) acme.example any time this week.'), /jane@acme\.example/);
  assert.match(await mapped('Reach Jane at jane AT acme DOT example for the details on the program.'), /jane@acme\.example/);
  assert.match(await mapped('Thanks for stopping by.\nMEET US AT BOOTH DOT COM NEXT YEAR'), /MEET US AT BOOTH DOT COM/);

  console.log('units ok');
})().catch(e => { console.error(e); process.exitCode = 1; });
