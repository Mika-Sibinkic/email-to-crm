// Executes an n8n workflow JSON in-process with n8n v1 execution order.
// The approximations of n8n behavior are listed at the top of tests/run.js.

const fs = require('fs');
const path = require('path');
const { Mocks } = require('./mocks');

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const START_NODE = 'Get a message1';
const MAX_NODE_RUNS = 500;
const CONTEXT_NAMES = ['$input', '$', '$json', '$node', '$items', '$env', 'require', 'console',
  'items', '$execution', '$workflow', '$runIndex', '$itemIndex'];

// n8n hands nodes serialized copies (task runner); a JSON round trip gives the same isolation.
const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

function loadWorkflow(file, srcDirs) {
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const n of wf.nodes) {
    const code = n.parameters && n.parameters.jsCode;
    if (typeof code !== 'string' || !code.startsWith('__SRC__:')) continue;
    const name = code.slice('__SRC__:'.length).trim();
    const dir = srcDirs.find(d => fs.existsSync(path.join(d, name)));
    if (!dir) throw new Error(`${n.name}: ${name} not found in ${srcDirs.join(', ')}`);
    n.parameters.jsCode = fs.readFileSync(path.join(dir, name), 'utf8');
  }
  return wf;
}

class Execution {
  constructor(wf, fixture, opts) {
    this.wf = wf;
    this.byName = Object.fromEntries(wf.nodes.map(n => [n.name, n]));
    this.conns = wf.connections || {};
    this.env = opts.env || {};
    this.mocks = new Mocks(fixture, opts);
    this.require = this.mocks.require();
    this.runData = {};      // node name -> [ { outputs: [[items], [items]] } ]
    this.order = [];        // node names in the order they ran
    this.sent = [];         // Outlook sends
    this.appended = [];     // Excel rows
    this.logs = [];
    this.error = null;
    this.reach = {};
  }

  async run(emailJson) {
    if (!this.byName[START_NODE]) throw new Error(`workflow has no "${START_NODE}" node`);
    const seed = [[{ json: emailJson }]];
    this.record(START_NODE, seed);
    const stack = this.children(START_NODE, seed);
    let runs = 0;
    while (stack.length) {
      if (++runs > MAX_NODE_RUNS) { this.error = `more than ${MAX_NODE_RUNS} node runs (loop?)`; break; }
      const { node: name, items } = stack.shift();
      const node = this.byName[name];
      if (!node) { this.error = `connection to missing node "${name}"`; break; }
      let outputs;
      try {
        outputs = await this.execNode(node, clone(items));
      } catch (e) {
        if (continues(node)) outputs = [[{ json: { error: e.message } }]];
        else { this.error = `${name}: ${e.message}`; this.record(name, [], e.message); break; }
      }
      this.record(name, outputs);
      stack.unshift(...this.children(name, outputs));
    }
    return this;
  }

  record(name, outputs, error) {
    (this.runData[name] ||= []).push({ outputs, error });
    this.order.push(name);
  }

  // v1 order: children of the node that just ran go to the FRONT of the stack (depth first),
  // top-to-bottom then left-to-right by canvas position. Empty outputs schedule nothing.
  children(name, outputs) {
    const add = [];
    (this.conns[name]?.main || []).forEach((list, oi) => {
      for (const c of list || []) {
        if (c.index > 0) throw new Error(`"${c.node}" uses input ${c.index}; multi-input nodes are not supported`);
        if (outputs[oi] && outputs[oi].length) {
          add.push({ node: c.node, items: outputs[oi], pos: this.byName[c.node]?.position || [0, 0] });
        }
      }
    });
    return add.sort((a, b) => a.pos[1] - b.pos[1] || a.pos[0] - b.pos[0]);
  }

  async execNode(node, items) {
    const type = node.type.replace(/^n8n-nodes-base\./, '');
    if (node.disabled) return [items];
    switch (type) {
      case 'code': return this.code(node, items);
      case 'if': return [...this.ifNode(node, items)];
      case 'httpRequest': return this.http(node, items);
      case 'noOp': return [items];
      case 'microsoftOutlook': return this.outlook(node, items);
      case 'microsoftExcel':
        this.appended.push(...items.map(i => i.json));
        return [items];
      default: throw new Error(`node type ${node.type} is not supported by the harness`);
    }
  }

  // ---- expression context -------------------------------------------------------------

  // Output index of `from` that leads to `to` (n8n's getNodeConnectionIndexes); 0 if none.
  sourceIndex(from, to) {
    const key = from + '\u0000' + to;
    if (key in this.reach) return this.reach[key];
    const reaches = start => {
      const seen = new Set(), queue = [start];
      while (queue.length) {
        const n = queue.shift();
        if (n === to) return true;
        if (seen.has(n)) continue;
        seen.add(n);
        for (const list of this.conns[n]?.main || []) for (const c of list || []) queue.push(c.node);
      }
      return false;
    };
    const outs = this.conns[from]?.main || [];
    let idx = outs.findIndex(list => (list || []).some(c => reaches(c.node)));
    return (this.reach[key] = idx < 0 ? 0 : idx);
  }

  context(node, items, itemIndex) {
    const self = this;
    const $ = name => {
      if (!self.byName[name]) throw new Error(`Referenced node doesn't exist: "${name}"`);
      const runs = self.runData[name];
      if (!runs) throw new Error(`Referenced node is unexecuted: "${name}"`);
      const pick = (branch, run) => {
        const r = runs[run === undefined || run < 0 ? runs.length - 1 : run];
        if (!r) throw new Error(`"${name}" has no run ${run}`);
        const out = r.outputs[branch === undefined ? self.sourceIndex(name, node.name) : branch];
        return clone(out || []);
      };
      return {
        all: (b, r) => pick(b, r),
        first: (b, r) => pick(b, r)[0],
        last: (b, r) => pick(b, r).slice(-1)[0],
        get item() { const a = pick(); return a[itemIndex] || a[0]; },
        isExecuted: true,
        params: node.parameters,
      };
    };
    const item = items[itemIndex];
    const consoleShim = {};
    for (const k of ['log', 'info', 'warn', 'error', 'debug']) {
      consoleShim[k] = (...a) => { if (self.logs.length < 300) self.logs.push(`[${node.name}] ` + a.map(String).join(' ').slice(0, 500)); };
    }
    return {
      $input: { all: () => items, first: () => items[0], last: () => items.slice(-1)[0], item },
      $,
      $json: item && item.json,
      $node: new Proxy({}, { get: (_, n) => ({ json: $(String(n)).first()?.json }) }),
      $items: n => (n === undefined ? items : $(n).all()),
      $env: self.env,
      require: self.require,
      console: consoleShim,
      items,
      $execution: { id: 'test', mode: 'manual', resumeUrl: '' },
      $workflow: { id: self.wf.id || 'test', name: self.wf.name || '', active: false },
      $runIndex: (self.runData[node.name] || []).length,
      $itemIndex: itemIndex,
    };
  }

  // `={{ expr }}` returns the raw value; mixed text and {{ }} segments return a string.
  param(value, node, items, i) {
    if (typeof value !== 'string' || !value.startsWith('=')) return value;
    const src = value.slice(1);
    const ctx = this.context(node, items, i);
    const evalExpr = expr => new Function(...CONTEXT_NAMES, `return (${expr});`)(...CONTEXT_NAMES.map(k => ctx[k]));
    const whole = src.match(/^\s*\{\{([\s\S]*?)\}\}\s*$/);
    if (whole && !whole[1].includes('{{')) return evalExpr(whole[1]);
    return src.replace(/\{\{([\s\S]*?)\}\}/g, (_, e) => {
      const r = evalExpr(e);
      return r == null ? '' : typeof r === 'object' ? JSON.stringify(r) : String(r);
    });
  }

  // ---- node types -----------------------------------------------------------------------

  async code(node, items) {
    const code = node.parameters.jsCode || '';
    // Inner arrow keeps node code in its own scope, so `const items = ...` is legal as in n8n.
    node._fn ||= new AsyncFunction(...CONTEXT_NAMES, `return (async () => {\n${code}\n})();`);
    const call = i => { const c = this.context(node, items, i); return node._fn(...CONTEXT_NAMES.map(k => c[k])); };
    const wrap = r => (r && typeof r === 'object' && 'json' in r ? { json: r.json, ...(r.binary ? { binary: r.binary } : {}) } : { json: r });
    if (node.parameters.mode === 'runOnceForEachItem') {
      const out = [];
      for (let i = 0; i < items.length; i++) {
        const r = await call(i);
        if (r != null) out.push(wrap(r));
      }
      return [out];
    }
    const r = await call(0);
    if (r == null) return [[]];
    return [(Array.isArray(r) ? r : [r]).map(wrap)];
  }

  // IF v2: each item goes to output 0 (true) or 1 (false).
  ifNode(node, items) {
    const c = node.parameters.conditions || {};
    const opts = c.options || {};
    const strict = opts.typeValidation === 'strict' && !node.parameters.looseTypeValidation && !node.parameters.options?.looseTypeValidation;
    const t = [], f = [];
    items.forEach((it, i) => {
      let pass;
      try {
        const results = (c.conditions || []).map((cond, ci) =>
          testCondition(this.param(cond.leftValue, node, items, i), this.param(cond.rightValue, node, items, i), cond.operator || {}, strict, ci, i));
        pass = c.combinator === 'or' ? results.some(Boolean) : results.every(Boolean);
      } catch (e) {
        if (!continues(node)) throw e;
        pass = false;
      }
      (pass ? t : f).push(it);
    });
    return [t, f];
  }

  async http(node, items) {
    const p = node.parameters;
    const out = [];
    for (let i = 0; i < items.length; i++) {
      try {
        const url = this.param(p.url, node, items, i);
        if (!url) throw new Error('Invalid URL: ""');
        const method = String(p.method || 'GET').toUpperCase();
        let body;
        if (p.sendBody && p.specifyBody === 'json') {
          body = this.param(p.jsonBody, node, items, i);
          if (body === undefined) throw new Error('JSON parameter needs to be valid JSON');
          if (typeof body !== 'string') body = JSON.stringify(body);
        } else if (p.sendBody && p.bodyParameters) {
          body = JSON.stringify(Object.fromEntries((p.bodyParameters.parameters || []).map(b => [b.name, this.param(b.value, node, items, i)])));
        }
        const r = await this.mocks.route(url, method, body, p.options && p.options.timeout);
        if (r.status >= 400) {
          throw Object.assign(new Error(`Request failed with status code ${r.status}`), { status: r.status });
        }
        const format = p.options?.response?.response?.responseFormat;
        if (format === 'text') { out.push({ json: { data: r.body } }); continue; }
        let parsed;
        try { parsed = r.body ? JSON.parse(r.body) : {}; } catch (e) { parsed = { data: r.body }; }
        for (const j of Array.isArray(parsed) ? parsed : [parsed]) out.push({ json: j });
      } catch (e) {
        if (!continues(node)) throw e;
        out.push({ json: { error: { message: e.message, name: 'AxiosError', status: e.status || 0 } } });
      }
    }
    return [out];
  }

  outlook(node, items) {
    const p = node.parameters;
    if (p.operation && p.operation !== 'send') throw new Error(`Outlook operation "${p.operation}" is not supported mid-workflow`);
    const out = items.map((it, i) => {
      this.sent.push({
        to: this.param(p.toRecipients, node, items, i),
        subject: this.param(p.subject, node, items, i),
        body: this.param(p.bodyContent, node, items, i),
      });
      return { json: { success: true } };
    });
    return [out];
  }
}

function continues(node) {
  return node.onError === 'continueRegularOutput' || node.continueOnFail === true;
}

// Mirrors n8n's filter-parameter checks for the operators the workflow uses.
function testCondition(left, right, op, strict, ci, ii) {
  const exists = left !== undefined && left !== null && !(typeof left === 'number' && Number.isNaN(left));
  if (op.operation === 'exists') return exists;
  if (op.operation === 'notExists') return !exists;
  if (op.type !== 'boolean') throw new Error(`IF operator ${op.type}.${op.operation} is not supported by the harness`);
  if (exists && typeof left !== 'boolean') {
    if (strict) throw new Error(`Wrong type: '${String(left).slice(0, 40)}' is a ${typeof left} but was expecting a boolean [condition ${ci}, item ${ii}]`);
    const s = String(left).toLowerCase();
    if (['true', '1', 'yes'].includes(s)) left = true;
    else if (['false', '0', 'no'].includes(s)) left = false;
  }
  const l = left ?? false, r = right ?? false;
  switch (op.operation) {
    case 'true': return l === true;
    case 'false': return l === false;
    case 'equals': return l === r;
    case 'notEquals': return l !== r;
    default: throw new Error(`IF operator boolean.${op.operation} is not supported by the harness`);
  }
}

async function runWorkflow(wf, fixture, opts) {
  const ex = new Execution(wf, fixture, opts);
  try { await ex.run(fixture.email); } catch (e) { ex.error = ex.error || e.message; }
  finally { fs.rmSync(ex.mocks.tmpRoot, { recursive: true, force: true }); }
  return ex;
}

module.exports = { loadWorkflow, runWorkflow, Execution };
