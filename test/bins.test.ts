import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { binVersion, runBinAsync, type BinSpec } from '../src/bins.ts';

const tmp = mkdtempSync(join(tmpdir(), 'duo-bins-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

function fakeCli(version: string): { bin: BinSpec; calls: () => number } {
  const script = join(tmp, 'cli.mjs');
  const log = join(tmp, 'calls.log');
  writeFileSync(script, `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(log)}, 'x');\nconsole.log(${JSON.stringify(version)});\n`);
  writeFileSync(log, '');
  return { bin: { command: process.execPath, args: [script], env: {}, display: script }, calls: () => readFileSync(log, 'utf8').length };
}

test('binVersion asks a CLI once and again only after the binary changes', () => {
  const { bin, calls } = fakeCli('1.0.0');
  assert.equal(binVersion(bin), '1.0.0');
  assert.equal(binVersion(bin), '1.0.0');
  assert.equal(calls(), 1, 'the second call reuses the remembered version');
  // An update rewrites the file.
  appendFileSync(bin.args[0], `console.log('2.0.0');\n`);
  assert.equal(binVersion(bin), '1.0.0\n2.0.0');
  assert.equal(calls(), 2);
});

test('binVersion does not remember a CLI that could not run', () => {
  const missing: BinSpec = { command: join(tmp, 'no-such-cli'), args: [], env: {}, display: 'missing' };
  assert.equal(binVersion(missing), 'unknown');
  assert.equal(binVersion(missing), 'unknown');
});

test('runBinAsync feeds stdin, collects output and enforces its timeout', async () => {
  const echo: BinSpec = { command: process.execPath, args: ['-e', 'process.stdin.pipe(process.stdout)'], env: {}, display: 'echo' };
  const r = await runBinAsync(echo, [], { input: 'hello' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, 'hello');
  const hang: BinSpec = { command: process.execPath, args: ['-e', 'setTimeout(() => {}, 60_000)'], env: {}, display: 'hang' };
  const t0 = Date.now();
  const slow = await runBinAsync(hang, [], { timeout: 300 });
  assert.ok(Date.now() - t0 < 5000);
  assert.match(slow.error?.message ?? '', /timed out/);
  const gone = await runBinAsync({ command: join(tmp, 'no-such-cli'), args: [], env: {}, display: 'missing' }, []);
  assert.equal(gone.status, null);
  assert.ok(gone.error);
});

// ── cancellation ────────────────────────────────────────────────────────────
// A CLI that starts a grandchild sharing its stdout/stderr, which then outlives it: the case that
// used to keep a timed-out call pending. The grandchild writes its pid so the test can see it go.
const node = process.execPath;
// These fake processes poll a private stop file. Their heartbeat and stopped marker
// let teardown distinguish a responsive fixture from a stale PID, without signalling it.
function fixtureLoop(pidFile: string, stopFile = pidFile + '.stop'): string {
  return `const fs = require('node:fs'); const beat = ${JSON.stringify(pidFile + '.beat')}; const stop = ${JSON.stringify(stopFile)}; const stopped = ${JSON.stringify(pidFile + '.stopped')}; fs.writeFileSync(beat, ''); const tick = () => { if (fs.existsSync(stop)) { fs.writeFileSync(stopped, ''); process.exit(0); } fs.writeFileSync(beat, ''); }; tick(); setInterval(tick, 100);`;
}
function family(pidFile: string, parent: 'wait' | 'exit'): BinSpec {
  const grandchild = `${fixtureLoop(pidFile)} require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`;
  // 'exit': the CLI exits at once (unref: Node would otherwise wait for its child) and leaves the
  // grandchild holding the pipes; 'wait': the CLI keeps running too.
  const code = `${parent === 'wait' ? fixtureLoop(pidFile + '.parent', pidFile + '.stop') : ''} require('node:fs').writeFileSync(${JSON.stringify(pidFile + '.parent')}, String(process.pid)); if (require('node:fs').existsSync(${JSON.stringify(pidFile + '.stop')})) process.exit(0); const c = require('child_process').spawn(${JSON.stringify(node)}, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'inherit' }); console.log('started'); ${parent === 'wait' ? '' : "c.unref()"}`;
  return { command: node, args: ['-e', code], env: {}, display: 'family' };
}
async function waitForFixture(pidFile: string, checks = 50): Promise<void> {
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
async function cleanupFamily(pidFile: string): Promise<void> {
  // PID files are observations only. Even a recycled PID cannot receive a signal here.
  writeFileSync(pidFile + '.stop', '');
  await Promise.all([waitForFixture(pidFile), waitForFixture(pidFile + '.parent')]);
}
const alive = (pidFile: string) => { try { process.kill(Number(readFileSync(pidFile, 'utf8')), 0); return true; } catch { return false; } };
async function eventually(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(check(), what);
}
const started = (pidFile: string) => eventually(() => existsSync(pidFile), 'the grandchild started');

test('a timeout ends the CLI and the grandchild holding its output, and the call settles', async (t) => {
  const pidFile = join(tmp, 'timeout.pid');
  t.after(() => cleanupFamily(pidFile));
  const pending = runBinAsync(family(pidFile, 'wait'), [], { timeout: 800 });
  await started(pidFile);
  const r = await pending;
  assert.match(r.error?.message ?? '', /timed out/);
  // taskkill /F exits a Node child with code 1 on Windows; POSIX signals yield null.
  if (process.platform === 'win32') assert.notEqual(r.status, 0, 'a forcibly ended CLI must not report success');
  else assert.equal(r.status, null);
  await eventually(() => !alive(pidFile), 'the grandchild was left running');
});

test('an abort ends the tree; aborting again or after it settled is harmless', async (t) => {
  const pidFile = join(tmp, 'abort.pid');
  t.after(() => cleanupFamily(pidFile));
  const ac = new AbortController();
  const pending = runBinAsync(family(pidFile, 'wait'), [], { signal: ac.signal, timeout: 60_000 });
  await started(pidFile);
  ac.abort();
  ac.abort();
  const r = await pending;
  assert.match(r.error?.message ?? '', /cancelled/);
  await eventually(() => !alive(pidFile), 'the grandchild survived the abort');
  ac.abort();
});

test('an already-aborted signal settles at once without leaving the CLI running', async (t) => {
  const pidFile = join(tmp, 'pre.pid');
  t.after(() => cleanupFamily(pidFile));
  const ac = new AbortController();
  ac.abort();
  const r = await runBinAsync(family(pidFile, 'wait'), [], { signal: ac.signal, timeout: 60_000 });
  assert.match(r.error?.message ?? '', /cancelled/);
  if (process.platform === 'win32') {
    assert.equal(r.status, null);
    assert.equal(existsSync(pidFile + '.parent'), false, 'a pre-cancelled CLI was spawned');
    assert.equal(existsSync(pidFile), false, 'a pre-cancelled CLI started its grandchild');
  }
  if (existsSync(pidFile)) await eventually(() => !alive(pidFile), 'a grandchild started before the kill survived');
});

test('a CLI that exits but leaves a process holding its output settles with its result', async (t) => {
  const pidFile = join(tmp, 'leftover.pid');
  t.after(() => cleanupFamily(pidFile));
  const r = await runBinAsync(family(pidFile, 'exit'), [], { timeout: 60_000 });
  assert.equal(r.status, 0);
  assert.equal(r.error, undefined);
  assert.match(r.stdout, /started/);
  await eventually(() => !alive(pidFile), 'the leftover process was not ended');
});

test('a CLI that cannot start settles with the error, whatever the reason', async () => {
  const missingCwd = await runBinAsync({ command: node, args: ['-e', ''], env: {}, display: 'node' }, [], { cwd: join(tmp, 'no-such-folder') });
  assert.equal(missingCwd.status, null);
  assert.ok(missingCwd.error);
  const ac = new AbortController();
  ac.abort();
  assert.ok((await runBinAsync({ command: join(tmp, 'no-such-cli'), args: [], env: {}, display: 'x' }, [], { signal: ac.signal })).error);
});

test('Ctrl-C to duo still ends the CLIs it started, and still ends duo', { skip: process.platform === 'win32' && 'checked through POSIX signals' }, async (t) => {
  const { spawn } = await import('node:child_process');
  const bins = join(import.meta.dirname, '..', 'src', 'bins.ts');
  const pidFile = join(tmp, 'sigint.pid');
  t.after(() => cleanupFamily(pidFile));
  const script = `const { runBinAsync } = await import(${JSON.stringify(pathToFileURL(bins).href)});
    void runBinAsync(${JSON.stringify(family(pidFile, 'wait'))}, []);
    setInterval(() => {}, 1000);`;
  const duo = spawn(node, ['--input-type=module', '-e', script], { stdio: 'ignore' });
  const exited = new Promise<NodeJS.Signals | null>((r) => duo.once('exit', (_c, s) => r(s)));
  await started(pidFile);
  duo.kill('SIGINT');
  assert.equal(await exited, 'SIGINT', 'with no handler of its own, duo still stops on Ctrl-C');
  await eventually(() => !alive(pidFile), 'the CLI tree survived Ctrl-C');
});

test('CLIs still running end when duo exits, except one marked to outlive it', { skip: process.platform === 'win32' && 'checked through POSIX process groups' }, async (t) => {
  const { spawnSync } = await import('node:child_process');
  const bins = join(import.meta.dirname, '..', 'src', 'bins.ts');
  for (const outlive of [false, true]) {
    const pidFile = join(tmp, `exit-${outlive}.pid`);
    t.after(() => cleanupFamily(pidFile));
    const fam = family(pidFile, 'wait');
    // A duo process that starts the CLI, waits for its grandchild, then exits without cleaning up.
    const script = `const { runBinAsync } = await import(${JSON.stringify(pathToFileURL(bins).href)});
      void runBinAsync(${JSON.stringify(fam)}, [], { outlive: ${outlive} });
      const fs = await import('node:fs');
      while (!fs.existsSync(${JSON.stringify(pidFile)})) await new Promise((r) => setTimeout(r, 50));
      process.exit(0);`;
    const r = spawnSync(node, ['--input-type=module', '-e', script], { timeout: 30_000, stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    if (outlive) {
      assert.equal(alive(pidFile), true, 'an outliving CLI keeps running after duo exits');
      // Ask the test-owned CLI and its descendant to stop; a saved PID/group may be reused.
      await cleanupFamily(pidFile);
      await eventually(() => !alive(pidFile), 'the test cleaned up the outliving CLI');
    } else {
      await eventually(() => !alive(pidFile), 'the CLI tree outlived duo');
    }
  }
});

// Exercise the same cleanup registered with t.after, including an assertion failure path.
test('fixture cleanup stops both live processes even after a failed assertion', async (t) => {
  const pidFile = join(tmp, 'failure.pid');
  t.after(() => cleanupFamily(pidFile));
  const pending = runBinAsync(family(pidFile, 'wait'), [], { timeout: 15_000 });
  try {
    await started(pidFile);
    assert.throws(() => assert.fail('simulated assertion failure'), /simulated assertion failure/);
  } finally {
    await cleanupFamily(pidFile);
  }
  const r = await pending;
  assert.equal(r.status, 0);
  assert.equal(existsSync(pidFile + '.stopped'), true, 'grandchild acknowledged shutdown');
  assert.equal(existsSync(pidFile + '.parent.stopped'), true, 'parent acknowledged shutdown');
  await eventually(() => !alive(pidFile) && !alive(pidFile + '.parent'), 'fixture remained alive');
});

test('cleanup ignores an exited fixture and a stale PID reused by another fake process', async () => {
  const { spawn } = await import('node:child_process');
  const exited = spawn(node, ['-e', ''], { stdio: 'ignore' });
  await new Promise<void>((resolve) => exited.once('exit', () => resolve()));
  const oldPidFile = join(tmp, 'already-exited.pid');
  writeFileSync(oldPidFile, String(exited.pid));
  await cleanupFamily(oldPidFile);

  const unrelatedStop = join(tmp, 'unrelated.stop');
  const unrelatedReady = join(tmp, 'unrelated.ready');
  const unrelated = spawn(node, ['-e', `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(unrelatedReady)}, ''); setInterval(() => { if (fs.existsSync(${JSON.stringify(unrelatedStop)})) process.exit(0); }, 50)`], { stdio: 'ignore' });
  const unrelatedExited = new Promise<void>((resolve) => unrelated.once('exit', () => resolve()));
  try {
    await eventually(() => existsSync(unrelatedReady), 'unrelated fake did not start');
    const staleFile = join(tmp, 'reused.pid');
    writeFileSync(staleFile, String(unrelated.pid)); // Simulate reuse, not an owned fixture.
    writeFileSync(staleFile + '.parent', String(unrelated.pid));
    await cleanupFamily(staleFile);
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(unrelated.exitCode, null, 'unrelated fake was terminated');
    assert.equal(unrelated.signalCode, null, 'unrelated fake received a signal');
  } finally {
    writeFileSync(unrelatedStop, '');
    await unrelatedExited;
  }
});

// Run a separate test process so an actual failed assertion does not fail this suite.
// The subprocess uses this file's real t.after cleanup, not a copy of the helper.
const binsCleanupProbe = process.env.DUO_BINS_CLEANUP_PROBE;
if (binsCleanupProbe) {
  test('probe: failed assertion triggers bins t.after', async (t) => {
    t.after(() => cleanupFamily(binsCleanupProbe));
    void runBinAsync(family(binsCleanupProbe, 'wait'), [], { timeout: 15_000 });
    await started(binsCleanupProbe);
    assert.fail('intentional bins assertion failure');
  });
}

test('t.after cleans the CLI family after a real failed assertion', async (t) => {
  const { spawnSync } = await import('node:child_process');
  const pidFile = join(tmp, 'actual-failure.pid');
  t.after(() => cleanupFamily(pidFile));
  const r = spawnSync(node, ['--test', '--test-name-pattern=^probe: failed assertion triggers bins t.after$', join(import.meta.dirname, 'bins.test.ts')], {
    encoding: 'utf8', timeout: 15_000, windowsHide: true,
    // A nested test runner must not inherit Node's test-worker marker.
    env: { ...process.env, NODE_TEST_CONTEXT: undefined, DUO_BINS_CLEANUP_PROBE: pidFile },
  });
  assert.ifError(r.error);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /intentional bins assertion failure/);
  assert.equal(existsSync(pidFile + '.stopped'), true, 'grandchild cleanup hook did not run');
  assert.equal(existsSync(pidFile + '.parent.stopped'), true, 'parent cleanup hook did not run');
  await eventually(() => !alive(pidFile) && !alive(pidFile + '.parent'), 'subprocess fixture survived');
});

test('a stale heartbeat cannot conceal a still-running fake CLI', async () => {
  const { spawn } = await import('node:child_process');
  const pidFile = join(tmp, 'unresponsive.pid');
  const release = pidFile + '.release';
  const script = `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); fs.writeFileSync(${JSON.stringify(pidFile + '.beat')}, ''); setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) process.exit(0); }, 50);`;
  const child = spawn(node, ['-e', script], { stdio: 'ignore' });
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  try {
    await eventually(() => existsSync(pidFile + '.beat'), 'fake CLI did not start');
    utimesSync(pidFile + '.beat', 1, 1);
    await assert.rejects(waitForFixture(pidFile, 2), /fixture did not stop/);
  } finally {
    writeFileSync(release, '');
    await exited;
  }
});
