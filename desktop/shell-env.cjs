/**
 * The environment of the user's login shell, read once at launch. A desktop launcher starts apps
 * without the PATH that shell startup files build (nvm, fnm, mise, Homebrew, ~/.local/bin), so the
 * engine would not find node, claude or git without it.
 *
 * Plain Node (no Electron APIs), so it can be tested on its own.
 */
const { spawn } = require('node:child_process');

const MARK = '__DUO_ENV__';

/** A single-quoted word for sh, bash, zsh and fish alike. */
function quote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/** What the probe printed between its markers: `env -0` output, or JSON from the Node fallback. */
function parseEnv(text) {
  if (text.startsWith('{')) return JSON.parse(text);
  const env = {};
  for (const entry of text.split('\0')) {
    const i = entry.indexOf('=');
    if (i > 0) env[entry.slice(0, i)] = entry.slice(i + 1);
  }
  if (!env.PATH) throw new Error('no PATH in the login shell environment');
  return env;
}

/**
 * Run `$SHELL -ilc` and read its environment. `env -0` answers in a millisecond; where it is
 * missing (older BSD or busybox `env`), `node` (Electron as Node) prints it instead. Resolves as
 * soon as the environment has arrived, even if a startup file left a background job holding the
 * output open, and gives up after `timeoutMs`, ending the shell and anything it started (an
 * interactive shell ignores SIGTERM), or when `signal` aborts. Never rejects: on any failure it
 * resolves to {}.
 */
function loginShellEnv({ shell, node, timeoutMs = 10_000, env = process.env, signal } = {}) {
  return new Promise((resolve) => {
    let child;
    let out = '';
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      child?.stdout?.destroy();
      child?.unref();
      resolve(result);
    };
    const kill = () => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }
    };
    const stop = () => {
      if (child) kill();
      finish({});
    };
    const timer = setTimeout(stop, timeoutMs);
    if (signal?.aborted) return stop();
    signal?.addEventListener('abort', stop);
    const fallback = node ? ` || ${quote(node)} -p 'JSON.stringify(process.env)'` : '';
    const script = `printf '${MARK}'; command env -0 2>/dev/null${fallback}; printf '${MARK}'`;
    try {
      child = spawn(shell, ['-ilc', script], {
        env: { ...env, ELECTRON_RUN_AS_NODE: '1', DISABLE_AUTO_UPDATE: 'true' },
        stdio: ['ignore', 'pipe', 'ignore'],
        // Its own process group, so a timeout can end whatever the startup files started.
        detached: true,
      });
    } catch {
      finish({});
      return;
    }
    child.on('error', () => finish({}));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      out += d;
      const start = out.indexOf(MARK);
      const end = start >= 0 ? out.indexOf(MARK, start + MARK.length) : -1;
      if (end < 0) return;
      try {
        const parsed = parseEnv(out.slice(start + MARK.length, end));
        delete parsed.ELECTRON_RUN_AS_NODE;
        finish(parsed);
      } catch {
        finish({});
      }
    });
    child.on('close', () => finish({}));
  });
}

module.exports = { loginShellEnv, parseEnv, quote };
