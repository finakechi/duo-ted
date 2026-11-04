/**
 * Operating-system specifics in one place: where duo keeps its files, how to find an executable,
 * how to run a Node script, and how to show a folder. Everything else stays platform-neutral.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

export const IS_WIN = process.platform === 'win32';
export const IS_MAC = process.platform === 'darwin';

const home = homedir();

/** Per-user application data: XDG on Linux, Application Support on macOS, LocalAppData on Windows. */
export function dataHome(): string {
  if (IS_WIN) return process.env.LOCALAPPDATA || join(home, 'AppData', 'Local');
  if (IS_MAC) return join(home, 'Library', 'Application Support');
  return process.env.XDG_DATA_HOME || join(home, '.local', 'share');
}

/** Per-user configuration: XDG on Linux; on macOS and Windows it sits next to the data. */
export function configHome(): string {
  if (IS_WIN) return process.env.APPDATA || join(home, 'AppData', 'Roaming');
  if (IS_MAC) return join(home, 'Library', 'Application Support');
  return process.env.XDG_CONFIG_HOME || join(home, '.config');
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

export function isExecutable(p: string): boolean {
  if (!isFile(p)) return false;
  if (IS_WIN) return true;
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** PATH lookup that honours PATHEXT on Windows (claude.exe, codex.cmd, ...). */
export function which(name: string): string | undefined {
  const exts = IS_WIN ? ['', ...(process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').map((e) => e.toLowerCase())] : [''];
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = join(dir, name + ext);
      if (isExecutable(p)) return p;
    }
  }
  return undefined;
}

/**
 * How to run a Node script with the runtime duo itself runs on. Inside the desktop app that is
 * Electron's bundled Node, which acts as plain Node only with ELECTRON_RUN_AS_NODE set.
 */
export function nodeRunner(): { command: string; env: Record<string, string> } {
  return { command: process.execPath, env: process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {} };
}

// ── child process trees ─────────────────────────────────────────────────

/**
 * Spawn options that make a child and everything it starts one unit duo can end together: on
 * POSIX its own process group (a CLI or `npm test` starts children of its own). Windows has no
 * process groups; taskkill /T walks the tree instead, and detaching there would open a console.
 */
export const TREE_SPAWN = { detached: !IS_WIN } as const;

/** End a child spawned with TREE_SPAWN and everything it started. Never throws. */
export function killTree(pid: number | undefined, signal: NodeJS.Signals = 'SIGTERM'): void {
  if (!pid) return;
  try {
    if (IS_WIN) execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 10_000 });
    else process.kill(-pid, signal);
  } catch {
    /* already gone */
  }
}

const exitTrees = new Set<number>();
let exitHooked = false;

/** End this tree if duo itself exits first (a second Ctrl-C, app shutdown); returns "forget it". */
function endTreeWithDuo(pid: number | undefined): () => void {
  if (!pid) return () => undefined;
  exitTrees.add(pid);
  if (!exitHooked) {
    exitHooked = true;
    const endAll = () => {
      for (const p of exitTrees) killTree(p, 'SIGKILL');
    };
    process.on('exit', endAll);
    // A tree has its own process group, so a terminal's Ctrl-C no longer reaches it, and Node runs
    // no 'exit' handlers when a signal ends it. End the trees on the signal too; where nothing else
    // handles that signal, keep its usual effect by raising it again.
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
      if (IS_WIN && sig !== 'SIGINT') continue;
      const onSignal = () => {
        endAll();
        if (process.listenerCount(sig) === 1) {
          process.removeListener(sig, onSignal);
          process.kill(process.pid, sig);
        }
      };
      process.on(sig, onSignal);
    }
  }
  return () => exitTrees.delete(pid);
}

export interface Supervised {
  code: number | null;
  timedOut: boolean;
  cancelled: boolean;
  /** The process could not be started. */
  error?: Error;
}

/**
 * Wait for a child spawned with TREE_SPAWN, bounded:
 *   - a timeout or an abort ends the whole tree (TERM, then KILL after a grace period), and an
 *     already-aborted signal ends it at once;
 *   - it settles soon after the child exits even when something the child started still holds the
 *     output pipes (that leftover is ended too), so a background process cannot hold duo waiting;
 *   - it settles at once when the process cannot be started;
 *   - the tree ends with duo if duo exits first, unless `outlive` (an updater that must finish).
 * Timers, listeners and the output streams are released when it settles.
 */
export function supervise(p: ChildProcess, o: { timeoutMs?: number; signal?: AbortSignal; graceMs?: number; outlive?: boolean } = {}): Promise<Supervised> {
  return new Promise((resolve) => {
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    let error: Error | undefined;
    let hardKill: ReturnType<typeof setTimeout> | undefined;
    let drain: ReturnType<typeof setTimeout> | undefined;
    const forget = o.outlive ? () => undefined : endTreeWithDuo(p.pid);
    const stop = () => {
      if (settled) return;
      killTree(p.pid, 'SIGTERM');
      hardKill ??= setTimeout(() => killTree(p.pid, 'SIGKILL'), o.graceMs ?? 5000);
    };
    const timer = o.timeoutMs ? setTimeout(() => { timedOut = true; stop(); }, o.timeoutMs) : undefined;
    const onAbort = () => { cancelled = true; stop(); };
    const done = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(hardKill);
      clearTimeout(drain);
      o.signal?.removeEventListener('abort', onAbort);
      forget();
      p.stdout?.destroy();
      p.stderr?.destroy();
      resolve({ code, timedOut, cancelled, ...(error ? { error } : {}) });
    };
    p.on('error', (e) => {
      error = e;
      done(null);
    });
    p.on('close', (code) => done(code));
    p.on('exit', (code) => {
      drain ??= setTimeout(() => {
        killTree(p.pid, 'SIGKILL');
        done(code);
      }, 2000);
    });
    if (o.signal?.aborted) onAbort();
    else o.signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Show a folder in the system file manager. */
export function openFolder(path: string): void {
  if (!existsSync(path)) throw new Error(`no such folder: ${path}`);
  const [cmd, args] = IS_WIN ? ['explorer.exe', [path]] : IS_MAC ? ['open', [path]] : ['xdg-open', [path]];
  spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

/** "~/src/app" for display; the full path elsewhere. */
export function tildify(p: string): string {
  return p === home ? '~' : p.startsWith(home + (IS_WIN ? '\\' : '/')) ? '~' + p.slice(home.length) : p;
}

export function expandHome(p: string): string {
  return p === '~' ? home : p.startsWith('~/') || p.startsWith('~\\') ? join(home, p.slice(2)) : p;
}
