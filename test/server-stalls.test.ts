// The engine serves every chat and run on one event loop. A slow Codex model catalog, a CLI slow to
// report its version, or a slow or hung git repository must not stall other requests, and requests
// that ask for the same slow thing at once share one subprocess.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { after, test } from 'node:test';

const root = join(import.meta.dirname, '..');
const temp = mkdtempSync(join(tmpdir(), 'duo-stalls-'));
const token = 'stalls';
const LOG = join(temp, 'calls.jsonl');
const DEBUG_MS = 2500;
const GIT_MS = 2500;
const posix = process.platform !== 'win32';

// A git that is slow to answer `status`, first on PATH for the engine (POSIX: a script is enough).
const fakeBin = join(temp, 'bin');
mkdirSync(fakeBin);
const realGit = posix ? execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim() : 'git';
if (posix) symlinkSync(join(root, 'test/fakes/git.mjs'), join(fakeBin, 'git'));
const repo = join(temp, 'repo');
mkdirSync(repo);
execFileSync(realGit, ['init', '-q', repo]);
writeFileSync(join(repo, 'a.txt'), 'a\n');
execFileSync(realGit, ['-C', repo, 'add', '-A']);
execFileSync(realGit, ['-C', repo, '-c', 'user.name=T', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'init']);
writeFileSync(join(repo, 'a.txt'), 'changed\n');

const child = spawn(process.execPath, [join(root, 'src/server/main.ts'), '--port', '0', '--token', token, '--parent-stdin'], {
  cwd: root,
  env: {
    ...process.env, DUO_DEPTH: '', DUO_PREBUILT: '1', DUO_HOME: join(temp, 'data'), DUO_CONFIG: join(temp, 'config.json'), CODEX_HOME: join(temp, 'codex'), CLAUDE_CONFIG_DIR: join(temp, 'claude'),
    DUO_CODEX_BIN: join(root, 'test/fakes/codex.mjs'), DUO_CLAUDE_BIN: join(root, 'test/fakes/claude.mjs'), FAKE_LOG: LOG,
    FAKE_CODEX_DEBUG_MS: String(DEBUG_MS), FAKE_CLAUDE_VERSION_MS: '1500',
    ...(posix ? { PATH: fakeBin + delimiter + process.env.PATH, FAKE_GIT_REAL: realGit, FAKE_GIT_STATUS_MS: String(GIT_MS) } : {}),
  },
  stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
});
let err = ''; child.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
const exited = new Promise<void>((resolve) => child.once('close', () => resolve()));
after(async () => {
  child.stdin.end();
  const timer = setTimeout(() => child.kill('SIGKILL'), 8000);
  await exited; clearTimeout(timer);
  rmSync(temp, { recursive: true, force: true });
});
const origin = await new Promise<string>((resolve, reject) => {
  let out = '';
  const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`server startup timed out: ${err}`)); }, 15000);
  child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited ${code}: ${err}`)); });
  child.stdout.on('data', (d) => {
    out += d;
    for (const line of out.split('\n')) if (line.startsWith('{')) {
      try { const ready = JSON.parse(line); if (ready.ready) { clearTimeout(timer); resolve(ready.url); } } catch { /* incomplete line */ }
    }
  });
});
const api = async (path: string, method = 'GET', body?: unknown) => {
  const res = await fetch(origin + path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  return { status: res.status, data: await res.json() as any };
};
const calls = (action: string) => (existsSync(LOG) ? readFileSync(LOG, 'utf8').split('\n').filter((l) => l.includes(`"action":"${action}"`)).length : 0);
const timed = async <T>(p: Promise<T>) => { const t0 = Date.now(); const v = await p; return { v, ms: Date.now() - t0 }; };

/** Start `slow`, then show a light request finishes while it is still running. */
async function staysResponsive(slow: Promise<unknown>, light: () => Promise<unknown>): Promise<void> {
  let done = false;
  const tracked = slow.then((v) => { done = true; return v; });
  await new Promise((r) => setTimeout(r, 200));
  const { ms } = await timed(light());
  assert.equal(done, false, 'the slow request must still be running, or the test proves nothing');
  assert.ok(ms < 1500, `a light request took ${ms} ms while the slow one ran`);
  await tracked;
}

test('a first launch with no model catalog loads it without stalling other requests, once for concurrent callers', async () => {
  const states = [api('/api/state'), api('/api/state'), api('/api/state')];
  await staysResponsive(Promise.all(states), () => api('/api/templates'));
  for (const s of await Promise.all(states)) {
    assert.equal(s.status, 200);
    assert.deepEqual(s.data.models.codex.map((m: any) => m.slug), ['gpt-6-sol']);
    assert.match(s.data.versions.claude, /2\.1\.999/);
  }
  assert.equal(calls('debug-models'), 1, 'three callers share one catalog fetch');
});

test('a stale model catalog is served at once and refreshed in the background, and the window is told', async () => {
  const cache = join(temp, 'data', 'cache', 'codex-models.json');
  writeFileSync(cache, JSON.stringify({ version: 'codex-cli 0.0.0-older', at: 0, models: [{ slug: 'stale-model', display: 'Stale', description: '', visibility: 'list', efforts: [] }] }));
  const before = calls('debug-models');
  const events = await fetch(`${origin}/api/events?token=${token}`, { signal: AbortSignal.timeout(20_000) });
  const reader = events.body!.getReader();
  const told = (async () => {
    let text = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return undefined;
      text += new TextDecoder().decode(value);
      for (const line of text.split('\n')) if (line.startsWith('data: ') && line.includes('"t":"models"')) return JSON.parse(line.slice(6));
    }
  })();
  const { v: s, ms } = await timed(api('/api/state'));
  assert.ok(ms < DEBUG_MS, `the state call waited ${ms} ms for a catalog it already had`);
  assert.deepEqual(s.data.models.codex.map((m: any) => m.slug), ['stale-model']);
  const event = await told;
  await reader.cancel();
  assert.deepEqual(event.codex.map((m: any) => m.slug), ['gpt-6-sol'], 'the window gets the fresh catalog');
  assert.equal(JSON.parse(readFileSync(cache, 'utf8')).version, 'codex-cli 0.0.0-fake');
  assert.equal(calls('debug-models'), before + 1);
});

test('a slow git status keeps the Changes panel from stalling chats and other requests', { skip: !posix && 'the fake git is a POSIX script' }, async () => {
  const before = calls('status');
  const gits = [api(`/api/git?cwd=${encodeURIComponent(repo)}`), api(`/api/git?cwd=${encodeURIComponent(repo)}`)];
  await staysResponsive(Promise.all(gits), async () => {
    const chat = await api('/api/chats', 'POST', { engine: 'claude', noProject: true, access: 'plan' });
    assert.equal(chat.status, 200);
    assert.equal((await api(`/api/chats/${chat.data.id}/send`, 'POST', { text: 'hello' })).status, 200);
    assert.equal((await api(`/api/chats/${chat.data.id}/stop`, 'POST')).status, 200);
  });
  for (const g of await Promise.all(gits)) {
    assert.equal(g.data.repo, true);
    assert.deepEqual(g.data.files, [{ status: 'M', path: 'a.txt' }]);
    assert.match(g.data.diff, /\+changed/);
  }
  assert.equal(calls('status'), before + 1, 'two windows asking at once share one git status');
});

test('a hung git is given up on after its timeout', { skip: !posix && 'the fake git is a POSIX script' }, async () => {
  const { gitAsync } = await import('../src/worktree.ts');
  const saved = { PATH: process.env.PATH, FAKE_GIT_STATUS_MS: process.env.FAKE_GIT_STATUS_MS, FAKE_GIT_REAL: process.env.FAKE_GIT_REAL };
  Object.assign(process.env, { PATH: fakeBin + delimiter + process.env.PATH, FAKE_GIT_STATUS_MS: 'hang', FAKE_GIT_REAL: realGit });
  try {
    const { ms } = await timed(assert.rejects(gitAsync(['-C', repo, 'status'], { timeout: 500 })));
    assert.ok(ms < 5000, `gave up after ${ms} ms`);
    // Output past a limit is dropped rather than failing the call.
    process.env.FAKE_GIT_STATUS_MS = '0';
    assert.equal((await gitAsync(['-C', repo, 'log', '--format=%s'], { limit: 2 })).slice(0, 2), 'in');
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});
