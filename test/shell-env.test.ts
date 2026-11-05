import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const { loginShellEnv, parseEnv } = createRequire(import.meta.url)('../desktop/shell-env.cjs') as {
  loginShellEnv(o: { shell: string; node?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv; signal?: AbortSignal }): Promise<Record<string, string>>;
  parseEnv(text: string): Record<string, string>;
};

const tmp = mkdtempSync(join(tmpdir(), 'duo-shell-env-'));
after(() => rmSync(tmp, { recursive: true, force: true }));
const unix = process.platform !== 'win32';

function has(cmd: string): string | undefined {
  try {
    return execFileSync('sh', ['-c', `command -v ${cmd}`], { encoding: 'utf8' }).trim() || undefined;
  } catch {
    return undefined;
  }
}

/** A home whose bash startup files run `rc`; the launcher environment has only the system PATH. */
function bashHome(name: string, rc: string): NodeJS.ProcessEnv {
  const home = join(tmp, name);
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, '.bashrc'), rc);
  writeFileSync(join(home, '.bash_profile'), '. ~/.bashrc\n');
  return { HOME: home, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' };
}

test('parseEnv reads env -0 output, keeping newlines and = inside values', () => {
  assert.deepEqual(parseEnv('PATH=/a:/b\0MULTI=one\ntwo\0EQ=a=b\0'), { PATH: '/a:/b', MULTI: 'one\ntwo', EQ: 'a=b' });
  assert.deepEqual(parseEnv('{"PATH":"/x"}'), { PATH: '/x' });
  assert.throws(() => parseEnv('garbage'));
});

test('the login shell PATH arrives despite startup files that print', { skip: !unix }, async () => {
  const env = bashHome('noisy', 'echo "welcome back"\nprintf "no newline"\nexport PATH="/opt/fnm-like/bin:$PATH"\nexport DUO_TEST_VALUE="line one\nline two"\n');
  const got = await loginShellEnv({ shell: '/bin/bash', node: process.execPath, env });
  assert.match(got.PATH ?? '', /^\/opt\/fnm-like\/bin:/);
  assert.equal(got.DUO_TEST_VALUE, 'line one\nline two');
  assert.equal(got.ELECTRON_RUN_AS_NODE, undefined, 'the probe flag is not passed on');
});

test('a background job holding the output open does not hold up the launch', { skip: !unix }, async () => {
  const env = bashHome('daemon', 'sleep 20 &\nexport PATH="/opt/daemon/bin:$PATH"\n');
  const t0 = Date.now();
  const got = await loginShellEnv({ shell: '/bin/bash', node: process.execPath, env, timeoutMs: 8000 });
  assert.match(got.PATH ?? '', /\/opt\/daemon\/bin/);
  assert.ok(Date.now() - t0 < 4000, `took ${Date.now() - t0} ms`);
  try {
    execFileSync('pkill', ['-f', `sleep 20`]);
  } catch {
    /* already gone */
  }
});

test('startup files that never finish are ended at the timeout', { skip: !unix }, async () => {
  const env = bashHome('hung', 'exec sleep 37\n');
  const t0 = Date.now();
  const got = await loginShellEnv({ shell: '/bin/bash', node: process.execPath, env, timeoutMs: 700 });
  assert.deepEqual(got, {});
  assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0} ms`);
  // The shell (and the sleep it became) was ended, not left behind.
  await new Promise((r) => setTimeout(r, 200));
  assert.throws(() => execFileSync('pgrep', ['-f', '^sleep 37$']), 'no sleep left running');
});

test('an aborted probe ends the shell at once', { skip: !unix }, async () => {
  const env = bashHome('abort', 'sleep 38\n');
  const ac = new AbortController();
  const p = loginShellEnv({ shell: '/bin/bash', node: process.execPath, env, signal: ac.signal });
  setTimeout(() => ac.abort(), 200);
  const t0 = Date.now();
  assert.deepEqual(await p, {});
  assert.ok(Date.now() - t0 < 2000);
  await new Promise((r) => setTimeout(r, 200));
  assert.throws(() => execFileSync('pgrep', ['-f', '^sleep 38$']), 'no sleep left running');
});

test('without env -0 the Node fallback reads the environment', { skip: !unix }, async () => {
  const bin = join(tmp, 'old-env-bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'env'), '#!/bin/sh\necho "env: illegal option -- 0" >&2\nexit 1\n');
  chmodSync(join(bin, 'env'), 0o755);
  const env = bashHome('old-env', `export PATH="${bin}:$PATH"\n`);
  const got = await loginShellEnv({ shell: '/bin/bash', node: process.execPath, env });
  assert.match(got.PATH ?? '', new RegExp(`^${bin}:`));
});

test('a missing shell resolves to an empty environment', async () => {
  assert.deepEqual(await loginShellEnv({ shell: join(tmp, 'no-such-shell'), env: { PATH: '/usr/bin:/bin' } }), {});
});

test('fish: config.fish PATH (fnm, mise) and a greeting', { skip: !has('fish') && 'fish is not installed' }, async () => {
  const home = join(tmp, 'fish-home');
  const conf = join(home, '.config', 'fish');
  const shims = join(home, '.local', 'share', 'mise', 'shims');
  mkdirSync(conf, { recursive: true });
  mkdirSync(shims, { recursive: true });
  writeFileSync(join(conf, 'config.fish'), `function fish_greeting; echo "Welcome to fish"; end\nif status is-interactive\n  set -gx PATH /run/user/1000/fnm_multishells/123_456/bin $PATH\nend\nfish_add_path -g ${shims}\n`);
  const got = await loginShellEnv({ shell: has('fish')!, node: process.execPath, env: { HOME: home, XDG_CONFIG_HOME: join(home, '.config'), PATH: '/usr/bin:/bin' } });
  assert.match(got.PATH ?? '', /fnm_multishells\/123_456\/bin/);
  assert.match(got.PATH ?? '', /mise\/shims/);
});

test('zsh: .zshrc PATH', { skip: !has('zsh') && 'zsh is not installed' }, async () => {
  const home = join(tmp, 'zsh-home');
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, '.zshrc'), 'print "zsh says hi"\npath=(/opt/nvm-like/bin $path)\n');
  const got = await loginShellEnv({ shell: has('zsh')!, node: process.execPath, env: { HOME: home, ZDOTDIR: home, PATH: '/usr/bin:/bin' } });
  assert.match(got.PATH ?? '', /^\/opt\/nvm-like\/bin:/);
});
