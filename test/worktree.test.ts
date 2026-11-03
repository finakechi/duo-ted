import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
  const child = `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 60000)`;
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
async function gone(pidFile: string): Promise<boolean> {
  for (let i = 0; i < 50 && alive(pidFile); i++) await new Promise((r) => setTimeout(r, 100));
  return !alive(pidFile);
}

test('a check that times out ends with everything it started', async () => {
  const pidFile = join(tmp, 'timeout.pid');
  const t0 = Date.now();
  const r = await runCheck(nested(pidFile, ' && echo after'), tmp, 1500);
  assert.ok(Date.now() - t0 < 10_000, `the timed-out check returned after ${Date.now() - t0} ms`);
  assert.equal(r.timedOut, true);
  assert.notEqual(r.exitCode, 0);
  assert.ok(await gone(pidFile), 'the check\'s child process was left running');
});

test('cancelling the run stops a running check at once', async () => {
  const pidFile = join(tmp, 'cancel.pid');
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

test('a background process left by a passing check does not hold the run open', { skip: process.platform === 'win32' }, async () => {
  const pidFile = join(tmp, 'background.pid');
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
