const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');

test('one flat skill directory serves both runtimes', () => {
  const canonical = fs.readFileSync(path.join(root, 'SKILL.md'), 'utf8');
  const codexMetadata = fs.readFileSync(path.join(root, 'agents', 'openai.yaml'), 'utf8');

  assert.match(canonical, /^---\r?\nname: inquiry\r?\ndescription: .+/);
  assert.match(canonical, /reference\/runtime-claude\.md/);
  assert.match(canonical, /reference\/runtime-codex\.md/);
  assert.match(canonical, /reference\/run-state\.md/);
  assert.match(codexMetadata, /display_name: "Inquiry"/);
  assert.ok(fs.existsSync(path.join(root, 'workflows', 'round.js')));
  assert.ok(fs.existsSync(path.join(root, 'scripts', 'inquiry-state.js')));
  assert.ok(fs.existsSync(path.join(root, 'scripts', 'inquiry-conformance.js')));
  assert.ok(fs.existsSync(path.join(root, 'scripts', 'inquiry-live-smoke.js')));
  assert.ok(fs.existsSync(path.join(root, 'conformance', 'v1', 'contract.js')));
  assert.ok(fs.existsSync(path.join(root, 'conformance', 'v1', 'reducer.js')));
  assert.ok(fs.existsSync(path.join(root, 'conformance', 'adapters', 'claude.js')));
  assert.ok(fs.existsSync(path.join(root, 'conformance', 'adapters', 'codex.js')));
  assert.ok(!fs.existsSync(path.join(root, 'skills', 'inquiry', 'SKILL.md')));
});
