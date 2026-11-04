// The engine streams every chat and run on one event loop. A slow CLI behind a maintenance endpoint
// (quota refresh, live sign-in check, `claude update`) must not freeze the other API calls.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const root = join(import.meta.dirname, '..');
const temp = mkdtempSync(join(tmpdir(), 'duo-responsive-'));
const token = 'responsive';
const SLOW_MS = 4000;
const child = spawn(process.execPath, [join(root, 'src/server/main.ts'), '--port', '0', '--token', token, '--parent-stdin'], {
  cwd: root,
  env: {
    ...process.env, DUO_DEPTH: '', DUO_PREBUILT: '1', DUO_HOME: join(temp, 'data'), DUO_CONFIG: join(temp, 'config.json'), CODEX_HOME: join(temp, 'codex'), CLAUDE_CONFIG_DIR: join(temp, 'claude'),
    DUO_CODEX_BIN: join(root, 'test/fakes/codex.mjs'), DUO_CLAUDE_BIN: join(root, 'test/fakes/claude.mjs'), FAKE_CODEX_MODE: 'slow', FAKE_CODEX_SLOW_MS: String(SLOW_MS),
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
const api = (path: string, method = 'GET') => fetch(origin + path, { method, headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });

async function stillAnswers(slow: Promise<Response>): Promise<void> {
  await new Promise((r) => setTimeout(r, 300)); // let the slow CLI start
  const t0 = Date.now();
  assert.equal((await api('/api/templates')).status, 200);
  const waited = Date.now() - t0;
  assert.ok(waited < SLOW_MS / 2, `the engine stopped answering for ${waited} ms while a slow CLI ran`);
  assert.equal((await slow).status, 200);
}

test('a quota refresh does not block other API calls while the CLIs answer', async () => {
  await stillAnswers(api('/api/quota?refresh=1'));
});

test('a live sign-in check does not block other API calls', async () => {
  const slow = api('/api/doctor?live=1');
  await stillAnswers(slow);
});

test('the state call reuses CLI versions instead of starting both CLIs every time', async () => {
  await api('/api/state');
  const t0 = Date.now();
  for (let i = 0; i < 5; i++) assert.equal((await api('/api/state')).status, 200);
  const each = (Date.now() - t0) / 5;
  assert.ok(each < 60, `/api/state took ${each.toFixed(0)} ms per call`);
});
