/**
 * Where a pair-mode writer works, and how its result gets back to the user.
 *
 *   worktree  a git worktree on a new branch (duo/<slug>-<id>) in duo's data folder, created from
 *             HEAD. The user's checkout is untouched until they choose Apply (the writer's diff is
 *             applied to their working tree), Keep branch, or Discard.
 *   in-place  the writer edits the folder itself. A shadow git repository outside the folder
 *             snapshots it first, so duo can still show exactly what the writer changed (works for
 *             folders that are not git repositories, and ignores any uncommitted work already
 *             there).
 */
import { execFile, execFileSync, spawn, type ExecFileSyncOptions } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { WORKTREES_DIR } from './paths.ts';
import { supervise, TREE_SPAWN } from './platform.ts';

export interface Workspace {
  mode: 'worktree' | 'in-place';
  /** Where the writer works (inside the worktree, the same subfolder the user picked). */
  cwd: string;
  /** Worktree mode: the worktree root and the user's repository root. */
  path: string;
  repo?: string;
  branch?: string;
  /** The commit diffs are taken against. */
  base: string;
  /** In-place mode: the shadow repository. */
  gitDir?: string;
  state: 'active' | 'applied' | 'kept' | 'discarded' | 'moved';
  /** state "moved": the continued run that took the workspace over. */
  movedTo?: string;
  /** What happened when the user applied, kept or discarded it. */
  outcome?: string;
}

export interface WorkspaceDiff {
  files: { status: string; path: string }[];
  stat: string;
  diff: string;
  truncated: boolean;
}

const ID = ['-c', 'user.name=duo', '-c', 'user.email=duo@localhost', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false'];

function git(args: string[], opts: ExecFileSyncOptions & { input?: string } = {}): string {
  // Bounded by default: a hung repository must not hang the engine forever. Callers that copy a
  // whole folder (add -A) pass their own limit.
  return String(execFileSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, timeout: 300_000, killSignal: 'SIGKILL', ...opts }));
}

function tryGit(args: string[]): string | undefined {
  try {
    return git(args).trim();
  } catch {
    return undefined;
  }
}

/**
 * git without blocking the event loop: the GUI engine streams every chat and run on it, and a
 * large repository can keep `status`, `diff` or `add -A` busy for seconds. A timeout ends git; with
 * `limit`, output past that many characters is dropped instead of failing the call.
 */
export function gitAsync(args: string[], o: { timeout?: number; limit?: number; input?: string } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const maxBuffer = o.limit !== undefined ? o.limit + 64 * 1024 : 256 * 1024 * 1024;
    const p = execFile('git', args, { encoding: 'utf8', maxBuffer, timeout: o.timeout ?? 120_000, killSignal: 'SIGKILL', windowsHide: true }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout);
      const code = (err as NodeJS.ErrnoException).code;
      if (o.limit !== undefined && (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || code === 'ENOBUFS')) return resolve(stdout);
      reject(Object.assign(err, { stdout, stderr }));
    });
    p.stdin?.on('error', () => undefined);
    p.stdin?.end(o.input ?? '');
  });
}

async function tryGitAsync(args: string[], limit?: number): Promise<string | undefined> {
  try {
    return (await gitAsync(args, { timeout: 30_000, limit })).trim();
  } catch {
    return undefined;
  }
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32).replace(/-+$/, '') || 'task';
}

/** What the folder allows: a worktree needs a git repository with at least one commit. */
export function workspaceOptions(cwd: string): { git: boolean; head: boolean; dirty: boolean; root?: string } {
  const root = tryGit(['-C', cwd, 'rev-parse', '--show-toplevel']);
  if (!root) return { git: false, head: false, dirty: false };
  const head = !!tryGit(['-C', cwd, 'rev-parse', '--verify', '-q', 'HEAD']);
  const dirty = !!tryGit(['-C', cwd, 'status', '--porcelain']);
  return { git: true, head, dirty, root };
}

/** workspaceOptions for the GUI engine, without blocking it. */
export async function workspaceOptionsAsync(cwd: string): Promise<{ git: boolean; head: boolean; dirty: boolean; root?: string }> {
  const root = await tryGitAsync(['-C', cwd, 'rev-parse', '--show-toplevel']);
  if (!root) return { git: false, head: false, dirty: false };
  // Only whether there is any change matters, so a huge status listing is cut short.
  const [head, dirty] = await Promise.all([tryGitAsync(['-C', cwd, 'rev-parse', '--verify', '-q', 'HEAD']), tryGitAsync(['-C', cwd, 'status', '--porcelain'], 1)]);
  return { git: true, head: !!head, dirty: !!dirty, root };
}

const SHADOW_EXCLUDES = [
  'node_modules/', '.venv/', 'venv/', '__pycache__/', '*.pyc', 'dist/', 'build/', 'target/', '.next/', '.cache/',
  '.DS_Store', 'Thumbs.db', '.idea/', '.vscode/', '*.log',
];

export function prepareWorkspace(cwd: string, runId: string, title: string, mode: 'worktree' | 'in-place'): Workspace {
  mkdirSync(WORKTREES_DIR, { recursive: true });
  if (mode === 'worktree') {
    const o = workspaceOptions(cwd);
    if (!o.git || !o.root) throw new Error(`${cwd} is not a git repository; use in-place mode, or run \`git init\` and commit first`);
    if (!o.head) throw new Error(`${o.root} has no commits yet; commit once, or use in-place mode`);
    // Git expands Windows 8.3 names (RUNNER~1), while Node's JS realpath can keep
    // them. Resolve both paths natively before computing the selected subfolder:
    // a false ../.. path would otherwise send the writer outside its worktree.
    const repo = realpathSync.native(o.root);
    const sub = relative(repo, realpathSync.native(cwd));
    if (sub === '..' || sub.startsWith(`..${sep}`) || isAbsolute(sub)) {
      throw new Error(`${cwd} resolves outside its git repository ${repo}`);
    }
    const base = git(['-C', repo, 'rev-parse', 'HEAD']).trim();
    const branch = `duo/${slug(title)}-${Date.now().toString(36).slice(-5)}`;
    const path = join(WORKTREES_DIR, runId);
    git(['-C', repo, 'worktree', 'add', '-b', branch, path, base]);
    return { mode, cwd: sub ? join(path, sub) : path, path, repo, branch, base, state: 'active' };
  }
  // In place: snapshot the folder into a shadow repository that lives in duo's data folder.
  const gitDir = join(WORKTREES_DIR, `${runId}.git`);
  git(['init', '--quiet', '--bare', gitDir]);
  writeFileSync(join(gitDir, 'info', 'exclude'), SHADOW_EXCLUDES.join('\n') + '\n');
  const shadow = ['--git-dir', gitDir, '--work-tree', cwd];
  git([...shadow, 'config', 'core.bare', 'false']);
  git([...shadow, ...ID, 'add', '-A'], { timeout: 120_000 });
  git([...shadow, ...ID, 'commit', '--quiet', '--allow-empty', '-m', 'duo: baseline before the writer started'], { timeout: 120_000 });
  const base = git([...shadow, 'rev-parse', 'HEAD']).trim();
  return { mode, cwd, path: cwd, base, gitDir, state: 'active' };
}

function gitArgs(ws: Workspace): string[] {
  return ws.mode === 'worktree' ? ['-C', ws.path] : ['--git-dir', ws.gitDir!, '--work-tree', ws.path];
}

/** Everything the writer changed since the start, new files included. */
export async function workspaceDiff(ws: Workspace, maxChars = 120_000): Promise<WorkspaceDiff> {
  const g = gitArgs(ws);
  await gitAsync([...g, ...ID, 'add', '-A'], { timeout: 120_000 });
  const [names, stat, full] = await Promise.all([
    gitAsync([...g, 'diff', '--cached', '--name-status', ws.base], { timeout: 60_000 }),
    gitAsync([...g, 'diff', '--cached', '--stat', ws.base], { timeout: 60_000 }),
    // Only maxChars of the diff are kept, so git's output beyond that is never held in memory.
    gitAsync([...g, 'diff', '--cached', '--no-color', '--no-ext-diff', ws.base], { timeout: 60_000, limit: maxChars + 1 }),
  ]);
  const files = names
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [status, ...rest] = l.split('\t');
      return { status: status.trim(), path: rest[rest.length - 1] };
    });
  let diff = full;
  const truncated = diff.length > maxChars;
  if (truncated) diff = diff.slice(0, maxChars) + `\n\n[diff truncated at ${maxChars} characters; read the files directly]\n`;
  return { files, stat: stat.trim(), diff, truncated };
}

/**
 * Worktree mode: bring the writer's changes into the user's working tree. A plain apply first; if
 * the user changed the same lines meanwhile, a 3-way apply that leaves conflict markers to resolve.
 */
export function applyWorkspace(ws: Workspace): { ok: boolean; message: string } {
  if (ws.mode !== 'worktree' || !ws.repo) return { ok: true, message: 'the changes are already in the folder (in-place run)' };
  if (ws.state !== 'active') return { ok: false, message: `this workspace was already ${ws.state}` };
  const g = gitArgs(ws);
  git([...g, ...ID, 'add', '-A']);
  const patch = git([...g, 'diff', '--cached', '--binary', '--no-color', ws.base]);
  if (!patch.trim()) return { ok: true, message: 'the writer changed nothing' };
  try {
    git(['-C', ws.repo, 'apply', '--whitespace=nowarn'], { input: patch });
    return { ok: true, message: `applied to ${ws.repo}` };
  } catch {
    try {
      git(['-C', ws.repo, 'apply', '--3way', '--whitespace=nowarn'], { input: patch });
      return { ok: true, message: `applied to ${ws.repo} with a 3-way merge; check for conflict markers` };
    } catch (e) {
      return { ok: false, message: `could not apply cleanly: ${String((e as { stderr?: string }).stderr ?? (e as Error).message).trim().slice(0, 600)}` };
    }
  }
}

/** Commit the writer's work on its branch and remove the worktree folder; the branch stays. */
export function keepBranch(ws: Workspace, message: string): { ok: boolean; message: string } {
  if (ws.mode !== 'worktree' || !ws.repo || !ws.branch) return { ok: false, message: 'only worktree runs have a branch' };
  const g = gitArgs(ws);
  git([...g, ...ID, 'add', '-A']);
  if (tryGit([...g, 'diff', '--cached', '--quiet']) === undefined) git([...g, ...ID, 'commit', '--quiet', '-m', message]);
  removeWorktree(ws);
  return { ok: true, message: `kept on branch ${ws.branch}` };
}

export function removeWorktree(ws: Workspace): void {
  if (ws.mode === 'worktree' && ws.repo) {
    tryGit(['-C', ws.repo, 'worktree', 'remove', '--force', ws.path]);
    if (existsSync(ws.path)) rmSync(ws.path, { recursive: true, force: true });
    tryGit(['-C', ws.repo, 'worktree', 'prune']);
  }
  if (ws.gitDir) rmSync(ws.gitDir, { recursive: true, force: true });
}

/** Drop the writer's work: the worktree and its branch, or (in place) only duo's snapshot. */
export function discardWorkspace(ws: Workspace): { ok: boolean; message: string } {
  removeWorktree(ws);
  if (ws.mode === 'worktree' && ws.repo && ws.branch) tryGit(['-C', ws.repo, 'branch', '-D', ws.branch]);
  return { ok: true, message: ws.mode === 'worktree' ? `removed the worktree and branch ${ws.branch}` : 'removed duo\'s snapshot; the changes stay in the folder' };
}

/**
 * Run the user's check command in the workspace (their command, their shell). A timeout or the
 * run's cancellation ends the whole process tree (`npm test` starts node, which starts workers); a
 * background process the check leaves behind cannot hold the run open; checks still running end
 * with duo. See supervise() in platform.ts.
 */
export async function runCheck(command: string, cwd: string, timeoutMs = 15 * 60_000, signal?: AbortSignal): Promise<{ command: string; exitCode: number | null; output: string; durationMs: number; timedOut: boolean; cancelled?: boolean }> {
  const started = Date.now();
  let out = '';
  const finish = (exitCode: number | null, timedOut: boolean, cancelled: boolean) => {
    const tail = out.length > 12_000 ? '\u2026\n' + out.slice(-12_000) : out;
    return { command, exitCode, output: tail, durationMs: Date.now() - started, timedOut, ...(cancelled ? { cancelled } : {}) };
  };
  let p: ReturnType<typeof spawn>;
  try {
    p = spawn(command, { cwd, shell: true, windowsHide: true, env: process.env, ...TREE_SPAWN });
  } catch (e) {
    out = (e as Error).message;
    return finish(null, false, false);
  }
  const add = (d: Buffer) => {
    out += d.toString('utf8');
    if (out.length > 400_000) out = out.slice(-200_000);
  };
  p.stdout?.on('data', add);
  p.stderr?.on('data', add);
  const r = await supervise(p, { timeoutMs, signal });
  if (r.error) out += '\n' + r.error.message;
  return finish(r.code, r.timedOut, r.cancelled);
}

/** In place: put the folder back the way the snapshot found it (files the writer added are deleted). */
export function revertInPlace(ws: Workspace): { ok: boolean; message: string } {
  if (ws.mode !== 'in-place' || !ws.gitDir) return { ok: false, message: 'only in-place runs can be reverted' };
  const g = gitArgs(ws);
  git([...g, ...ID, 'add', '-A']);
  const added = git([...g, 'diff', '--cached', '--name-only', '--diff-filter=A', ws.base]).split('\n').filter(Boolean);
  git([...g, 'checkout', ws.base, '--', '.']);
  for (const f of added) rmSync(join(ws.path, f), { force: true });
  return { ok: true, message: `restored ${ws.path} to the snapshot taken before the writer started` };
}

/**
 * Finish a pair run's workspace. apply: worktree changes go into the user's folder (in place they
 * already are); keep: commit on the duo/ branch; discard: drop the worktree and branch, or (in
 * place) revert the folder to the snapshot.
 */
export function finishWorkspace(ws: Workspace, action: 'apply' | 'keep' | 'discard', title: string): { ok: boolean; message: string; state?: Workspace['state'] } {
  if (ws.state === 'moved') return { ok: false, message: `this workspace moved to the continued run ${ws.movedTo}; finish it there` };
  if (ws.state !== 'active') return { ok: false, message: `this workspace was already ${ws.state}${ws.outcome ? `: ${ws.outcome}` : ''}` };
  if (action === 'apply') {
    const r = applyWorkspace(ws);
    if (r.ok) removeWorktree(ws);
    if (r.ok && ws.mode === 'worktree' && ws.repo && ws.branch) tryGit(['-C', ws.repo, 'branch', '-D', ws.branch]);
    return { ...r, state: r.ok ? 'applied' : undefined };
  }
  if (action === 'keep') {
    const r = ws.mode === 'worktree' ? keepBranch(ws, `duo: ${title}`) : (removeWorktree(ws), { ok: true, message: 'kept the changes in the folder' });
    return { ...r, state: r.ok ? 'kept' : undefined };
  }
  const r = ws.mode === 'worktree' ? discardWorkspace(ws) : revertInPlace(ws);
  if (r.ok && ws.mode === 'in-place') removeWorktree(ws);
  return { ...r, state: r.ok ? 'discarded' : undefined };
}
