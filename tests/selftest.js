// Offline check of the engine's n8n semantics on a tiny synthetic workflow (no model calls).
// node tests/selftest.js -> prints "selftest ok" or throws.
const assert = require('assert');
const { runWorkflow } = require('./lib/engine');

const code = (name, jsCode, position) => ({ name, type: 'n8n-nodes-base.code', typeVersion: 2, position, parameters: { jsCode } });
const ifNode = (name, left, position, typeValidation = 'strict') => ({
  name, type: 'n8n-nodes-base.if', typeVersion: 2, position,
  parameters: { conditions: { options: { typeValidation }, combinator: 'and',
    conditions: [{ leftValue: left, rightValue: true, operator: { type: 'boolean', operation: 'equals' } }] } },
});
const link = (...targets) => ({ main: targets.map(t => (t ? [{ node: t, type: 'main', index: 0 }] : [])) });

const wf = {
  nodes: [
    { name: 'Get a message1', type: 'n8n-nodes-base.microsoftOutlook', position: [0, 0], parameters: {} },
    code('Split', 'return [{flag:true,n:1},{flag:false,n:2},{n:3}];', [100, 0]),
    ifNode('Flag?', '={{ $json.flag }}', [200, 0]),
    code('Yes', 'return $input.all().map(i => ({...i.json, branch:"yes"}));', [300, -100]),
    code('No', 'return $input.all().map(i => ({...i.json, branch:"no"}));', [300, 100]),
    code('Join', 'return [{ seen: $input.all().map(i => i.json.n), split: $("Split").all().length }];', [400, 0]),
    ifNode('Never?', '={{ false }}', [500, 0]),
    code('Unreached', 'return [{}];', [600, 0]),
    code('Peek', 'try { $("Unreached").all(); return [{ ok: false }]; } catch (e) { return [{ threw: e.message }]; }', [600, 100]),
  ],
  connections: {
    'Get a message1': link('Split'),
    Split: link('Flag?'),
    'Flag?': link('Yes', 'No'),
    Yes: link('Join'),
    No: link('Join'),
    Join: link('Never?'),
    'Never?': link('Unreached', 'Peek'),
  },
};

(async () => {
  const ex = await runWorkflow(wf, { id: 'selftest', email: {} }, { env: {}, cacheDir: '/nonexistent' });
  assert.strictEqual(ex.error, null, ex.error);
  // Yes is higher on the canvas, so its branch (including Join) runs before No.
  assert.deepStrictEqual(ex.order, ['Get a message1', 'Split', 'Flag?', 'Yes', 'Join', 'Never?', 'Peek', 'No', 'Join', 'Never?', 'Peek']);
  // A node with two parents runs once per incoming batch; missing boolean counts as false.
  assert.deepStrictEqual(ex.runData.Join.map(r => r.outputs[0][0].json.seen), [[1], [2, 3]]);
  assert.strictEqual(ex.runData.Join[0].outputs[0][0].json.split, 3);
  // Empty IF output schedules nothing; referencing an unexecuted node throws.
  assert.ok(!ex.runData.Unreached);
  assert.match(ex.runData.Peek[0].outputs[0][0].json.threw, /unexecuted/);

  // Strict type validation rejects a non-boolean left value; loose converts "true".
  const typed = left => ({ ...wf, nodes: wf.nodes.map(n => (n.name === 'Split' ? code('Split', `return [{flag:${left}}];`, n.position) : n)) });
  const strict = await runWorkflow(typed('"true"'), { id: 'selftest', email: {} }, { env: {}, cacheDir: '/nonexistent' });
  assert.match(strict.error, /^Flag\?: Wrong type/);
  const looseWf = typed('"true"');
  looseWf.nodes = looseWf.nodes.map(n => (n.name === 'Flag?' ? ifNode('Flag?', '={{ $json.flag }}', n.position, 'loose') : n));
  const loose = await runWorkflow(looseWf, { id: 'selftest', email: {} }, { env: {}, cacheDir: '/nonexistent' });
  assert.strictEqual(loose.error, null);
  assert.strictEqual(loose.runData.Yes.length, 1);
  console.log('selftest ok');
})().catch(e => { console.error(e); process.exitCode = 1; });
