#!/usr/bin/env node
// Renders the importable n8n workflow from the template plus the Code-node sources.
// Input:  workflows/email-to-crm.template.json (Code nodes hold "__SRC__:<file>") and src/nodes/*.js
// Output: workflows/email-to-crm.json
//
// Usage:
//   node scripts/build-workflow.js           write workflows/email-to-crm.json
//   node scripts/build-workflow.js --check   exit 1 if the committed JSON differs from a fresh build
// src/nodes is the source of truth; edit the .js files, never the jsCode inside the built JSON.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TEMPLATE = path.join(ROOT, 'workflows/email-to-crm.template.json');
const OUT = path.join(ROOT, 'workflows/email-to-crm.json');
const SRC = path.join(ROOT, 'src/nodes');

function render() {
  const wf = JSON.parse(fs.readFileSync(TEMPLATE, 'utf8'));
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

const built = render();
if (process.argv.includes('--check')) {
  const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  if (current !== built) {
    console.error(`${path.relative(ROOT, OUT)} is out of sync with the template and src/nodes. Run: node scripts/build-workflow.js`);
    process.exit(1);
  }
  console.log(`${path.relative(ROOT, OUT)} is in sync`);
} else {
  fs.writeFileSync(OUT, built);
  console.log(`wrote ${path.relative(ROOT, OUT)}`);
}
