const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

test('scorecard reads feedback from INQUIRY_HOME', () => {
  const inquiryHome = fs.mkdtempSync(path.join(os.tmpdir(), 'inquiry-scorecard-'));
  const feedback = [
    { run: 'one', reaction: 'escalate-worthy' },
    { run: 'one', reaction: 'escalate-noise' },
    { run: 'one', reaction: 'missed-escalation' },
    { run: 'one', reaction: 'acted' },
  ].map(JSON.stringify).join('\n');

  try {
    fs.writeFileSync(path.join(inquiryHome, 'feedback.jsonl'), feedback);
    const output = execFileSync(process.execPath, ['workflows/scorecard.js'], {
      cwd: path.resolve(__dirname, '..'),
      encoding: 'utf8',
      env: { ...process.env, INQUIRY_HOME: inquiryHome },
    });

    assert.match(output, /feedback events: 4/);
    assert.match(output, /50%\s+\(1 worthy \/ 2 interruptions, 1 were noise\)/);
    assert.match(output, /50%\s+\(1 thing you flagged it should've raised\)/);
  } finally {
    fs.rmSync(inquiryHome, { recursive: true, force: true });
  }
});
