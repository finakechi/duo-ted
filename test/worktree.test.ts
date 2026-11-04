import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { after, test } from 'node:test';

const tmp = mkdtempSync(join(tmpdir(), 'duo-worktree-'));
process.env.DUO_HOME = join(tmp, 'home');
const { prepareWorkspace, discardWorkspace, runCheck } = await import('../src/worktree.ts');
const repo = join(tmp, 'repo');
mkdirSync(join(repo, 'src'), { recursive: true });
writeFileSync(join(repo, 'src', 'example.txt'), 'example\n');
execFileSync('git', ['init', '-q', repo]);
execFileSync('git', ['-C', repo, 'add', '-A']);
execFileSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'init']);
after(() => rmSync(tmp, { recursive: true, force: true }));

test('a selected subfolder stays at the same relative path inside its worktree', () => {
  const ws = prepareWorkspace(join(repo, 'src'), 'nested', 'nested folder', 'worktree');
  try {
    assert.equal(relative(ws.path, ws.cwd), 'src');
    assert.equal(realpathSync.native(ws.repo!), realpathSync.native(repo));
  } finally {
    discardWorkspace(ws);
  }
});

test('a directory alias resolves into the worktree instead of escaping to the original folder', () => {
  const alias = join(tmp, 'alias');
  // Junctions need no elevated symlink permission on Windows.
  symlinkSync(realpathSync.native(repo), alias, process.platform === 'win32' ? 'junction' : 'dir');
  const ws = prepareWorkspace(join(alias, 'src'), 'alias', 'aliased folder', 'worktree');
  try {
    assert.equal(relative(ws.path, ws.cwd), 'src');
    assert.notEqual(realpathSync.native(ws.cwd), realpathSync.native(join(repo, 'src')));
  } finally {
    discardWorkspace(ws);
  }
});

// A check whose shell starts a child (`npm test` starts node, which starts workers). The child
// writes its pid, so the test can see whether it outlived the check.
const node = JSON.stringify(process.execPath);
function nested(pidFile: string, tail = ''): string {
  const child = `const fs = require('node:fs'); const beat = ${JSON.stringify(pidFile + '.beat')}; const stop = ${JSON.stringify(pidFile + '.stop')}; fs.writeFileSync(beat, ''); fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => { if (fs.existsSync(stop)) { fs.writeFileSync(${JSON.stringify(pidFile + '.stopped')}, ''); process.exit(0); } fs.writeFileSync(beat, ''); }, 100);`;
  return `${node} -e ${JSON.stringify(child)}${tail}`;
}
function alive(pidFile: string): boolean {
  try {
    process.kill(Number(readFileSync(pidFile, 'utf8')), 0);
    return true;
  } catch {
    return false;
  }
}
async function cleanupChild(pidFile: string, checks = 50): Promise<void> {
  // The fake child observes this file itself. The PID may be stale or reused.
  writeFileSync(pidFile + '.stop', '');
  const beat = pidFile + '.beat';
  for (let i = 0; i < checks; i++) {
    if (existsSync(pidFile + '.stopped') || !existsSync(beat)) return;
    if (existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, 'utf8'));
      assert.ok(Number.isSafeInteger(pid) && pid > 0, `invalid fixture PID: ${pidFile}`);
      try {
        // Signal 0 only checks for absence; it never establishes ownership or kills a PID.
        process.kill(pid, 0);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ESRCH') return;
        throw e;
      }
    }
    // A stale heartbeat is NOT proof of exit: a hung fixture may still be alive.
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.fail(`fixture did not stop: ${pidFile}`);
}
async function gone(pidFile: string): Promise<boolean> {
  for (let i = 0; i < 50 && alive(pidFile); i++) await new Promise((r) => setTimeout(r, 100));
  return !alive(pidFile);
}

test('a check that times out ends with everything it started', async (t) => {
  const pidFile = join(tmp, 'timeout.pid');
  t.after(() => cleanupChild(pidFile));
  const t0 = Date.now();
  const r = await runCheck(nested(pidFile, ' && echo after'), tmp, 1500);
  assert.ok(Date.now() - t0 < 10_000, `the timed-out check returned after ${Date.now() - t0} ms`);
  assert.equal(r.timedOut, true);
  assert.notEqual(r.exitCode, 0);
  assert.ok(await gone(pidFile), 'the check\'s child process was left running');
});

test('cancelling the run stops a running check at once', async (t) => {
  const pidFile = join(tmp, 'cancel.pid');
  t.after(() => cleanupChild(pidFile));
  const ac = new AbortController();
  const t0 = Date.now();
  const pending = runCheck(nested(pidFile, ' && echo after'), tmp, 60_000, ac.signal);
  for (let i = 0; i < 50 && !existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 100));
  ac.abort();
  const r = await pending;
  assert.ok(Date.now() - t0 < 15_000);
  assert.equal(r.cancelled, true);
  assert.ok(await gone(pidFile), 'the check\'s child process survived the cancel');
});

test('a background process left by a passing check does not hold the run open', { skip: process.platform === 'win32' }, async (t) => {
  const pidFile = join(tmp, 'background.pid');
  t.after(() => cleanupChild(pidFile));
  const t0 = Date.now();
  const r = await runCheck(`${nested(pidFile)} & echo started`, tmp, 60_000);
  assert.ok(Date.now() - t0 < 15_000, `the check returned after ${Date.now() - t0} ms`);
  assert.equal(r.exitCode, 0);
  assert.match(r.output, /started/);
  assert.ok(await gone(pidFile));
});

test('a plain check still reports its exit code and output', async () => {
  const ok = await runCheck(`${node} -e "console.log('fine')"`, tmp);
  assert.equal(ok.exitCode, 0);
  assert.match(ok.output, /fine/);
  const bad = await runCheck(`${node} -e "process.exit(3)"`, tmp);
  assert.equal(bad.exitCode, 3);
  assert.equal(bad.timedOut, false);
});

test('a check whose run is already cancelled ends at once and leaves nothing running', async (t) => {
  const pidFile = join(tmp, 'precancel.pid');
  t.after(() => cleanupChild(pidFile));
  const ac = new AbortController();
  ac.abort();
  const r = await runCheck(nested(pidFile, ' && echo after'), tmp, 60_000, ac.signal);
  assert.equal(r.cancelled, true);
  assert.notEqual(r.exitCode, 0);
  if (process.platform === 'win32') {
    assert.equal(r.exitCode, null);
    assert.equal(existsSync(pidFile), false, 'a pre-cancelled check started a child');
  }
  if (existsSync(pidFile)) assert.ok(await gone(pidFile), 'a child started before the kill survived');
});

test('a check that cannot start reports why instead of hanging', async () => {
  const r = await runCheck(`${node} -e "1"`, join(tmp, 'no-such-folder'), 60_000);
  assert.equal(r.exitCode, null);
  assert.ok(r.output.trim(), 'the reason is in the output');
  assert.equal(r.timedOut, false);
});

test('repeated cancellation and a timeout racing it settle once', async (t) => {
  const pidFile = join(tmp, 'race.pid');
  t.after(() => cleanupChild(pidFile));
  const ac = new AbortController();
  const pending = runCheck(nested(pidFile, ' && echo after'), tmp, 1500, ac.signal);
  for (let i = 0; i < 50 && !existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 100));
  ac.abort();
  ac.abort();
  const r = await pending;
  assert.equal(r.cancelled, true);
  ac.abort();
  assert.ok(await gone(pidFile));
  // Wait past the timeout: nothing fires after the check settled.
  await new Promise((r) => setTimeout(r, 1700));
});

test('fixture cleanup ends a live check child after an assertion failure', async (t) => {
  const pidFile = join(tmp, 'failure.pid');
  t.after(() => cleanupChild(pidFile));
  const pending = runCheck(nested(pidFile), tmp, 15_000);
  try {
    for (let i = 0; i < 50 && !existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(existsSync(pidFile), 'fixture never started');
    assert.throws(() => assert.fail('simulated assertion failure'), /simulated assertion failure/);
  } finally {
    await cleanupChild(pidFile);
  }
  await pending;
  assert.equal(existsSync(pidFile + '.stopped'), true, 'child did not acknowledge shutdown');
  assert.ok(await gone(pidFile), 'fixture survived cleanup');
});

test('cleanup of stale or reused check PID cannot stop an unrelated fake', async () => {
  const { spawn } = await import('node:child_process');
  const exited = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise<void>((resolve) => exited.once('exit', () => resolve()));
  const oldPidFile = join(tmp, 'already-exited.pid');
  writeFileSync(oldPidFile, String(exited.pid));
  await cleanupChild(oldPidFile);

  const unrelatedStop = join(tmp, 'unrelated.stop');
  const unrelatedReady = join(tmp, 'unrelated.ready');
  const unrelated = spawn(process.execPath, ['-e', `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(unrelatedReady)}, ''); setInterval(() => { if (fs.existsSync(${JSON.stringify(unrelatedStop)})) process.exit(0); }, 50)`], { stdio: 'ignore' });
  const unrelatedExited = new Promise<void>((resolve) => unrelated.once('exit', () => resolve()));
  try {
    for (let i = 0; i < 50 && !existsSync(unrelatedReady); i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(existsSync(unrelatedReady), 'unrelated fake did not start');
    const staleFile = join(tmp, 'reused.pid');
    writeFileSync(staleFile, String(unrelated.pid));
    await cleanupChild(staleFile);
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(unrelated.exitCode, null, 'unrelated fake was terminated');
    assert.equal(unrelated.signalCode, null, 'unrelated fake received a signal');
  } finally {
    writeFileSync(unrelatedStop, '');
    await unrelatedExited;
  }
});

// Run a separate test process so an actual failed assertion does not fail this suite.
const worktreeCleanupProbe = process.env.DUO_WORKTREE_CLEANUP_PROBE;
if (worktreeCleanupProbe) {
  test('probe: failed assertion triggers worktree t.after', async (t) => {
    t.after(() => cleanupChild(worktreeCleanupProbe));
    void runCheck(nested(worktreeCleanupProbe), tmp, 15_000);
    for (let i = 0; i < 50 && !existsSync(worktreeCleanupProbe); i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(existsSync(worktreeCleanupProbe), 'fixture never started');
    assert.fail('intentional worktree assertion failure');
  });
}

test('t.after cleans a check child after a real failed assertion', async (t) => {
  const { spawnSync } = await import('node:child_process');
  const pidFile = join(tmp, 'actual-failure.pid');
  t.after(() => cleanupChild(pidFile));
  const r = spawnSync(process.execPath, ['--test', '--test-name-pattern=^probe: failed assertion triggers worktree t.after$', join(import.meta.dirname, 'worktree.test.ts')], {
    encoding: 'utf8', timeout: 15_000, windowsHide: true,
    // A nested test runner must not inherit Node's test-worker marker.
    env: { ...process.env, NODE_TEST_CONTEXT: undefined, DUO_WORKTREE_CLEANUP_PROBE: pidFile },
  });
  assert.ifError(r.error);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /intentional worktree assertion failure/);
  assert.equal(existsSync(pidFile + '.stopped'), true, 'cleanup hook did not run');
  assert.ok(await gone(pidFile), 'subprocess fixture survived');
});

test('a stale heartbeat cannot conceal a still-running fake check child', async () => {
  const { spawn } = await import('node:child_process');
  const pidFile = join(tmp, 'unresponsive.pid');
  const release = pidFile + '.release';
  const script = `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); fs.writeFileSync(${JSON.stringify(pidFile + '.beat')}, ''); setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) process.exit(0); }, 50);`;
  const child = spawn(process.execPath, ['-e', script], { stdio: 'ignore' });
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  try {
    for (let i = 0; i < 50 && !existsSync(pidFile + '.beat'); i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(existsSync(pidFile + '.beat'), 'fake check child did not start');
    utimesSync(pidFile + '.beat', 1, 1);
    await assert.rejects(cleanupChild(pidFile, 2), /fixture did not stop/);
  } finally {
    writeFileSync(release, '');
    await exited;
  }
});
