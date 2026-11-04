import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
function family(pidFile: string, parent: 'wait' | 'exit'): BinSpec {
  const grandchild = `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`;
  // 'exit': the CLI exits at once (unref: Node would otherwise wait for its child) and leaves the
  // grandchild holding the pipes; 'wait': the CLI keeps running too.
  const code = `require('fs').writeFileSync(${JSON.stringify(pidFile + '.parent')}, String(process.pid)); const c = require('child_process').spawn(${JSON.stringify(node)}, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'inherit' }); console.log('started'); ${parent === 'wait' ? 'setInterval(() => {}, 1000)' : 'c.unref()'}`;
  return { command: node, args: ['-e', code], env: {}, display: 'family' };
}
function cleanupFamily(pidFile: string): void {
  for (const file of [pidFile + '.parent', pidFile]) {
    if (!existsSync(file)) continue;
    const pid = Number(readFileSync(file, 'utf8'));
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
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
      // End the outliving CLI and its child: they share the CLI's process group.
      const pgid = Number(spawnSync('ps', ['-o', 'pgid=', '-p', readFileSync(pidFile, 'utf8')], { encoding: 'utf8' }).stdout.trim());
      process.kill(-pgid, 'SIGKILL');
      await eventually(() => !alive(pidFile), 'the test cleaned up the outliving CLI');
    } else {
      await eventually(() => !alive(pidFile), 'the CLI tree outlived duo');
    }
  }
});
