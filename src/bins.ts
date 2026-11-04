/**
 * Finding the two CLIs on any OS. A BinSpec is what to actually execute: usually a native binary,
 * sometimes Node plus a script (npm installs on Windows only provide .cmd wrappers, which cannot be
 * spawned without a shell).
 */
import { execFileSync, spawn, spawnSync, type SpawnSyncOptions } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { PROJECT_ROOT } from './paths.ts';
import { IS_WIN, isExecutable, nodeRunner, supervise, TREE_SPAWN, which } from './platform.ts';

export interface BinSpec {
  command: string;
  /** Arguments that come before the CLI's own (the script, when command is Node). */
  args: string[];
  env: Record<string, string>;
  /** The path a person would recognize. */
  display: string;
}

export interface BinOverrides {
  codexBin?: string;
  claudeBin?: string;
}

const CODEX_TARGETS: Record<string, [string, string]> = {
  'linux-x64': ['@openai/codex-linux-x64', 'x86_64-unknown-linux-musl'],
  'linux-arm64': ['@openai/codex-linux-arm64', 'aarch64-unknown-linux-musl'],
  'darwin-x64': ['@openai/codex-darwin-x64', 'x86_64-apple-darwin'],
  'darwin-arm64': ['@openai/codex-darwin-arm64', 'aarch64-apple-darwin'],
  'win32-x64': ['@openai/codex-win32-x64', 'x86_64-pc-windows-msvc'],
  'win32-arm64': ['@openai/codex-win32-arm64', 'aarch64-pc-windows-msvc'],
};

function fromPath(p: string): BinSpec | undefined {
  if (!p || !existsSync(p)) return undefined;
  const lower = p.toLowerCase();
  if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) {
    const n = nodeRunner();
    return { command: n.command, args: [p], env: n.env, display: p };
  }
  if (IS_WIN && (lower.endsWith('.cmd') || lower.endsWith('.bat'))) return fromNpmWrapper(p);
  return isExecutable(p) ? { command: p, args: [], env: {}, display: p } : undefined;
}

/** npm's Windows wrappers (`claude.cmd`) call node on a script in the global node_modules next to them. */
function fromNpmWrapper(cmd: string): BinSpec | undefined {
  let text = '';
  try {
    text = readFileSync(cmd, 'utf8');
  } catch {
    return undefined;
  }
  const m = /"%dp0%\\([^"]+\.(?:js|mjs|cjs))"/i.exec(text) ?? /%~dp0\\([^"\s]+\.(?:js|mjs|cjs))/i.exec(text);
  if (!m) return undefined;
  const script = join(dirname(cmd), m[1]);
  if (!existsSync(script)) return undefined;
  const n = nodeRunner();
  return { command: n.command, args: [script], env: n.env, display: cmd };
}

/**
 * The Codex CLI pinned in duo's own dependencies comes first: which models the server offers depends
 * on the client version, so duo controls it. The platform package holds a native binary, run
 * directly (the npm launcher in front of it is a Node script).
 */
export function resolveCodex(o: BinOverrides = {}): BinSpec {
  for (const explicit of [process.env.DUO_CODEX_BIN, o.codexBin]) {
    if (!explicit) continue;
    const b = fromPath(explicit);
    if (b) return b;
    throw new Error(`codex binary not found or not executable: ${explicit}`);
  }
  const target = CODEX_TARGETS[`${process.platform}-${process.arch}`];
  if (target) {
    try {
      const require = createRequire(join(PROJECT_ROOT, 'package.json'));
      const pkgRoot = dirname(require.resolve(`${target[0]}/package.json`));
      const exe = join(pkgRoot, 'vendor', target[1], 'bin', IS_WIN ? 'codex.exe' : 'codex');
      if (existsSync(exe)) {
        let managedRoot = '';
        try {
          managedRoot = realpathSync(dirname(require.resolve('@openai/codex/package.json')));
        } catch {
          /* launcher package missing; the binary still works */
        }
        return { command: exe, args: [], env: managedRoot ? { CODEX_MANAGED_PACKAGE_ROOT: managedRoot, CODEX_MANAGED_BY_NPM: '1' } : {}, display: exe };
      }
    } catch {
      /* not installed for this platform; fall back to PATH */
    }
  }
  const onPath = which('codex');
  const b = onPath && fromPath(onPath);
  if (b) return b;
  throw new Error('no Codex CLI found: run `npm install` in the duo folder, or set codexBin in the config');
}

export function resolveClaude(o: BinOverrides = {}): BinSpec {
  for (const explicit of [process.env.DUO_CLAUDE_BIN, o.claudeBin]) {
    if (!explicit) continue;
    const b = fromPath(explicit);
    if (b) return b;
    throw new Error(`claude binary not found or not executable: ${explicit}`);
  }
  const h = homedir();
  const candidates = [
    which('claude'),
    join(h, '.local', 'bin', IS_WIN ? 'claude.exe' : 'claude'),
    join(h, '.claude', 'local', IS_WIN ? 'claude.exe' : 'claude'),
    ...(IS_WIN ? [join(process.env.APPDATA || '', 'npm', 'claude.cmd')] : ['/opt/homebrew/bin/claude', '/usr/local/bin/claude']),
  ];
  for (const c of candidates) {
    const b = c ? fromPath(c) : undefined;
    if (b) return b;
  }
  throw new Error('no Claude Code CLI found: install it (https://docs.claude.com/claude-code), or set claudeBin in the config');
}

/** Run a CLI synchronously (version checks, model catalog, login status). */
export function runBin(bin: BinSpec, args: string[], opts: SpawnSyncOptions = {}) {
  return spawnSync(bin.command, [...bin.args, ...args], { windowsHide: true, ...opts, env: { ...process.env, ...bin.env, ...(opts.env ?? {}) } });
}

/**
 * Run a CLI without blocking the event loop (the GUI engine streams every chat and run on it).
 * Resolves with the same fields `runBin` returns. A timeout or `signal` ends the CLI and everything
 * it started, and sets `error`; it settles soon after the CLI exits even if a process it left
 * behind still holds its output; it ends with duo unless `outlive` (an update that must finish).
 */
export async function runBinAsync(bin: BinSpec, args: string[], opts: { cwd?: string; input?: string; timeout?: number; env?: Record<string, string>; signal?: AbortSignal; outlive?: boolean } = {}): Promise<{ status: number | null; stdout: string; stderr: string; error?: Error }> {
  let stdout = '';
  let stderr = '';
  let p: ReturnType<typeof spawn>;
  try {
    p = spawn(bin.command, [...bin.args, ...args], { cwd: opts.cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...bin.env, ...(opts.env ?? {}) }, ...TREE_SPAWN });
  } catch (e) {
    return { status: null, stdout, stderr, error: e as Error };
  }
  // Keep the tail of very chatty output, like spawnSync's maxBuffer would.
  const cap = (s: string) => (s.length > 16 * 1024 * 1024 ? s.slice(-8 * 1024 * 1024) : s);
  p.stdout?.setEncoding('utf8').on('data', (d: string) => { stdout = cap(stdout + d); });
  p.stderr?.setEncoding('utf8').on('data', (d: string) => { stderr = cap(stderr + d); });
  p.stdin?.on('error', () => undefined);
  p.stdin?.end(opts.input ?? '');
  const r = await supervise(p, { timeoutMs: opts.timeout, signal: opts.signal, outlive: opts.outlive });
  const error = r.error ?? (r.timedOut ? new Error(`timed out after ${opts.timeout} ms`) : r.cancelled ? new Error('cancelled') : undefined);
  return { status: r.code, stdout, stderr, ...(error ? { error } : {}) };
}

/** What identifies an installed CLI: an update replaces the file (or retargets the symlink), changing these. */
function binStamp(bin: BinSpec): string | undefined {
  try {
    // Only files can be watched for changes; anything else is asked every time.
    return [bin.command, ...bin.args].map((p) => {
      const st = statSync(p);
      return `${p}:${st.ino}:${st.size}:${st.mtimeMs}`;
    }).join('|');
  } catch {
    return undefined;
  }
}

const versions = new Map<string, { stamp: string; version: string }>();

/** `<cli> --version`, remembered until the binary changes (the GUI asks for it on every state call and run). */
export function binVersion(bin: BinSpec): string {
  const key = [bin.command, ...bin.args].join('\0');
  const stamp = binStamp(bin);
  const known = versions.get(key);
  if (stamp && known?.stamp === stamp) return known.version;
  let version = 'unknown';
  try {
    version = execFileSync(bin.command, [...bin.args, '--version'], { encoding: 'utf8', timeout: 30_000, windowsHide: true, env: { ...process.env, ...bin.env }, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    /* not runnable right now; ask again next time */
  }
  if (stamp && version !== 'unknown') versions.set(key, { stamp, version });
  else versions.delete(key);
  return version;
}

const probing = new Map<string, Promise<string>>();

/**
 * binVersion for the GUI engine: the same remembered answer, but a probe that is needed runs
 * without blocking the event loop, at most one per binary at a time, and gives up after 30 s.
 */
export function binVersionAsync(bin: BinSpec): Promise<string> {
  const key = [bin.command, ...bin.args].join('\0');
  const stamp = binStamp(bin);
  const known = versions.get(key);
  if (stamp && known?.stamp === stamp) return Promise.resolve(known.version);
  let p = probing.get(key);
  if (!p) {
    p = runBinAsync(bin, ['--version'], { timeout: 30_000 })
      .then((r) => {
        const version = (r.status === 0 && !r.error && r.stdout.trim()) || 'unknown';
        if (stamp && version !== 'unknown') versions.set(key, { stamp, version });
        return version;
      })
      .finally(() => probing.delete(key));
    probing.set(key, p);
  }
  return p;
}
