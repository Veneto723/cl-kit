const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const script = path.join(root, 'scripts', 'inquiry-state.js');

function run(...args) {
  return JSON.parse(execFileSync(process.execPath, [script, ...args], {
    cwd: root,
    encoding: 'utf8',
  }));
}

test('state utility enforces one writer and records normalized round state', () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inquiry-state-'));

  try {
    const initialized = run('init', runDir);
    assert.equal(initialized.state.roundsCompleted, 0);
    assert.equal(initialized.lock, null);

    const acquired = run('acquire', runDir, 'controller-a', '120');
    assert.equal(acquired.lock.owner, 'controller-a');
    assert.equal(acquired.state.status, 'active');

    const conflict = spawnSync(process.execPath, [script, 'acquire', runDir, 'controller-b', '120'], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.notEqual(conflict.status, 0);
    assert.match(conflict.stderr, /already owned/);

    const dry = run('record', runDir, 'controller-a', 'true', 'true', 'false', '1');
    assert.equal(dry.state.roundsCompleted, 1);
    assert.equal(dry.state.roundAttempts, 1);
    assert.equal(dry.state.cleanDryStreak, 1);
    assert.equal(dry.state.escalationsTotal, 1);

    const failed = run('record', runDir, 'controller-a', 'false', 'false', 'true', '0');
    assert.equal(failed.state.roundsCompleted, 1);
    assert.equal(failed.state.roundAttempts, 2);
    assert.equal(failed.state.cleanDryStreak, 1);

    const released = run('release', runDir, 'controller-a', 'paused');
    assert.equal(released.state.status, 'paused');
    assert.equal(released.state.activeOwner, null);
    assert.equal(released.lock, null);

    const next = run('acquire', runDir, 'controller-b', '120');
    assert.equal(next.lock.owner, 'controller-b');

    const lockFile = path.join(runDir, 'RUNNING.lock');
    const expired = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    expired.expiresAt = new Date(0).toISOString();
    fs.writeFileSync(lockFile, `${JSON.stringify(expired, null, 2)}\n`);
    const takeover = run('acquire', runDir, 'controller-c', '120');
    assert.equal(takeover.lock.owner, 'controller-c');
    assert.deepEqual(
      fs.readdirSync(runDir).filter((name) => name.includes('.stale.')),
      [],
    );
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
  }
});
