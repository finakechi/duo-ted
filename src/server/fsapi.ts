/** Folder browsing and git state for the GUI's project picker and Changes panel. */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { IS_WIN } from '../platform.ts';
import { gitAsync } from '../worktree.ts';

/** Windows drive roots that exist (C:\, D:\, ...), for browsing above a drive. */
function drives(): string[] {
  const out: string[] = [];
  for (let c = 67; c <= 90; c++) {
    const d = `${String.fromCharCode(c)}:\\`;
    if (existsSync(d)) out.push(d);
  }
  return out;
}

export function listDirs(path?: string, showHidden = false) {
  if (IS_WIN && path === '::drives') {
    return { path: '', parent: undefined, home: homedir(), git: false, dirs: drives().map((d) => ({ name: d, path: d, git: false })) };
  }
  const p = resolve(path || homedir());
  if (!existsSync(p) || !statSync(p).isDirectory()) throw new Error(`not a folder: ${p}`);
  const dirs: { name: string; path: string; git: boolean }[] = [];
  for (const d of readdirSync(p, { withFileTypes: true })) {
    if (!(showHidden || !d.name.startsWith('.')) || d.name === 'node_modules' || d.name === '$RECYCLE.BIN' || d.name === 'System Volume Information') continue;
    let isDir = d.isDirectory();
    if (!isDir && d.isSymbolicLink()) {
      try {
        isDir = statSync(join(p, d.name)).isDirectory();
      } catch {
        isDir = false;
      }
    }
    if (isDir) dirs.push({ name: d.name, path: join(p, d.name), git: existsSync(join(p, d.name, '.git')) });
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  const up = dirname(p);
  return { path: p, parent: up !== p ? up : IS_WIN ? '::drives' : undefined, home: homedir(), git: existsSync(join(p, '.git')), dirs };
}

/** Each git call the Changes panel makes is bounded: a hung or very slow repository gives up. */
const GIT_TIMEOUT_MS = 30_000;

function git(cwd: string, args: string[], limit?: number): Promise<string> {
  return gitAsync(['-C', cwd, '--no-pager', ...args], { timeout: GIT_TIMEOUT_MS, limit });
}

type GitState = { repo: false } | { repo: true; branch: string; head: string; files: { status: string; path: string }[]; diff: string };

/** One refresh per folder at a time: windows and turns that ask at once share it. */
const inFlight = new Map<string, Promise<GitState>>();

export function gitState(cwd: string): Promise<GitState> {
  let p = inFlight.get(cwd);
  if (!p) {
    p = readGitState(cwd).finally(() => inFlight.delete(cwd));
    inFlight.set(cwd, p);
  }
  return p;
}

async function readGitState(cwd: string): Promise<GitState> {
  if (!cwd || !existsSync(cwd)) return { repo: false as const };
  try {
    await git(cwd, ['rev-parse', '--is-inside-work-tree']);
  } catch {
    return { repo: false as const };
  }
  const [branch, head, status] = await Promise.all([
    git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).then((s) => s.trim(), () => '(no commits)'),
    git(cwd, ['log', '-1', '--format=%h %s']).then((s) => s.trim(), () => ''),
    git(cwd, ['status', '--porcelain=v1', '-z'], 4 * 1024 * 1024),
  ]);
  const entries = status.split('\0');
  const files: { status: string; path: string }[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry) continue;
    const status = entry.slice(0, 2);
    files.push({ status: status.trim() || '?', path: entry.slice(3) });
    // In -z output, renames/copies have a second NUL-delimited source path, with no status.
    if (/[RC]/.test(status)) i++;
  }
  const limit = 400_000;
  // Only the first `limit` characters are shown; git's output past that is dropped, not a failure.
  let diff = '';
  try {
    diff = await git(cwd, ['diff', '--no-color', '--no-ext-diff', 'HEAD'], limit + 1);
  } catch {
    // No commits yet: show what is staged.
    diff = await git(cwd, ['diff', '--no-color', '--no-ext-diff', '--cached'], limit + 1);
  }
  return { repo: true as const, branch, head, files, diff: diff.length > limit ? diff.slice(0, limit) + '\n… (diff truncated)\n' : diff };
}
