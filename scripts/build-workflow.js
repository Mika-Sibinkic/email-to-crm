#!/usr/bin/env node
// Renders the importable n8n workflows from their templates plus the Code-node sources.
// Input:  workflows/<name>.template.json (Code nodes hold "__SRC__:<file>") and src/nodes/*.js
// Output: workflows/<name>.json for every template (email-to-crm, pipeline-health)
//
// Usage:
//   node scripts/build-workflow.js           write every workflows/<name>.json
//   node scripts/build-workflow.js --check   exit 1 if a committed JSON differs from a fresh build
// src/nodes is the source of truth; edit the .js files, never the jsCode inside the built JSON.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const WF_DIR = path.join(ROOT, 'workflows');
const SRC = path.join(ROOT, 'src/nodes');

function render(template) {
  const wf = JSON.parse(fs.readFileSync(template, 'utf8'));
  for (const n of wf.nodes) {
    const code = n.parameters && n.parameters.jsCode;
    if (typeof code !== 'string' || !code.startsWith('__SRC__:')) continue;
    const file = path.join(SRC, code.slice('__SRC__:'.length).trim());
    // A missing source file must stop the build, not ship a node with a dangling reference.
    if (!fs.existsSync(file)) throw new Error(`${n.name}: ${path.relative(ROOT, file)} not found`);
    n.parameters.jsCode = fs.readFileSync(file, 'utf8');
  }
  return JSON.stringify(wf, null, 2) + '\n';
}

let stale = false;
for (const t of fs.readdirSync(WF_DIR).filter(f => f.endsWith('.template.json')).sort()) {
  const out = path.join(WF_DIR, t.replace('.template.json', '.json'));
  const built = render(path.join(WF_DIR, t));
  if (process.argv.includes('--check')) {
    const current = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '';
    if (current !== built) {
      console.error(`${path.relative(ROOT, out)} is out of sync with its template and src/nodes. Run: node scripts/build-workflow.js`);
      stale = true;
    } else console.log(`${path.relative(ROOT, out)} is in sync`);
  } else {
    fs.writeFileSync(out, built);
    console.log(`wrote ${path.relative(ROOT, out)}`);
  }
}
if (stale) process.exit(1);
