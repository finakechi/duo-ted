/** Qwen Code one-shot adapter. The installed claw 7.6 custom one-shot runner does not
 * replay --resume or forward its raw stream; Duo needs both for safe collaboration.
 *
 * Isolation (verified against the published @qwen-code/qwen-code 0.28.0 bundle and its docs):
 *   - `tools.executionSandbox` in an operator (System) settings file confines shell, Read/Write/Edit
 *     and in-process agent tools with Bubblewrap; `--safe-mode` keeps that operator confinement while
 *     ignoring user/project hooks, MCP servers, extensions, skills and settings-sourced permission rules;
 *   - in safe mode the `--core-tools` allowlist is ignored and only `--exclude-tools` applies, so Duo
 *     passes a complete deny list computed from the verified release's own tool catalog;
 *   - host-side tools (web_fetch, web_search) run outside that sandbox, so they are always excluded;
 *   - an unverified Qwen Code release may ship tools Duo cannot name, so it is refused (fail closed).
 */
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { binVersion, binVersionAsync, type BinSpec } from './bins.ts';
import { profileIssues, type QwenProfile } from './config.ts';
import { killTree, supervise, TREE_SPAWN } from './platform.ts';

export interface QwenResult { output: string; error?: string; sessionId?: string; }
export interface QwenTurn {
  bin: BinSpec;
  model: string;
  cwd: string;
  system: string;
  schema?: object;
  message: string;
  timeoutSec: number;
  resumeId?: string;
  profile?: QwenProfile;
  access: 'read' | 'write';
  /** Writers only: let sandboxed commands use the network (Bubblewrap `network: open`). */
  network?: boolean;
  configDir: string;
  id: string;
  onLine: (line: string) => void;
  onProcess?: (proc?: ChildProcessWithoutNullStreams) => void;
  /** Ends the turn (kills the CLI) when aborted; an already-aborted signal starts nothing. */
  signal?: AbortSignal;
  /** Extra child environment (readiness probes isolate QWEN_HOME in their disposable folder). */
  env?: Record<string, string>;
}

/** Qwen Code release lines whose tool catalog and sandbox flags Duo has verified. */
export const QWEN_VERIFIED_SERIES = ['0.28'];
/** Bump when the tool policy below changes, so earlier readiness results no longer count. */
export const QWEN_POLICY_REVISION = 1;

/** Every built-in tool name (canonical, from TOOL_NAME_ALIASES) in Qwen Code 0.28.0. */
export const QWEN_TOOLS = [
  'advisor', 'agent', 'artifact', 'ask_user_question', 'autofix_pr', 'create_sub_session', 'cron_create', 'cron_delete',
  'cron_list', 'display_image', 'edit', 'enter_plan_mode', 'enter_worktree', 'exec', 'exit_plan_mode', 'exit_worktree',
  'get_goal', 'glob', 'grep_search', 'image_gen', 'list_agents', 'list_directory', 'loop_wakeup', 'lsp', 'manage_memory',
  'monitor', 'notebook_edit', 'omni_caption_audio', 'omni_caption_image', 'omni_clip_audio', 'omni_clip_image',
  'omni_clip_video', 'omni_convert_image', 'omni_downsample_audio', 'omni_downsample_image', 'omni_downscale_video',
  'omni_extract_audio', 'omni_extract_keyframes', 'omni_ocr_image', 'omni_recall_media_memory', 'omni_transcribe_audio',
  'omni_understand_video_segments', 'propose_goal', 'read_file', 'read_mcp_resource', 'record_artifact', 'record_source',
  'report_findings', 'request_shutdown', 'run_shell_command', 'save_memory', 'search_memory', 'send_message', 'skill',
  'structured_output', 'task_create', 'task_list', 'task_stop', 'task_update', 'team_create', 'team_delete',
  'team_plan_approval', 'todo_write', 'tool_call', 'tool_search', 'update_goal', 'web_fetch', 'web_search', 'workflow',
  'write_file', 'zoom_image',
];
/** A reviewer can only look: file reads and searches inside the read-only sandbox. */
export const QWEN_READ_TOOLS = ['read_file', 'glob', 'grep_search', 'list_directory', 'structured_output'];
/** A writer edits the workspace and runs sandboxed commands; nothing that runs on the host. */
export const QWEN_WRITE_TOOLS = [...QWEN_READ_TOOLS, 'write_file', 'edit', 'notebook_edit', 'run_shell_command', 'todo_write'];

export function qwenExcludedTools(access: 'read' | 'write'): string[] {
  const allowed = new Set(access === 'read' ? QWEN_READ_TOOLS : QWEN_WRITE_TOOLS);
  return QWEN_TOOLS.filter((t) => !allowed.has(t));
}

/** Refuse a Qwen Code release whose tool set and flags Duo has not verified. */
export function qwenSupport(version: string): { ok: boolean; series?: string; reason?: string } {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!m) return { ok: false, reason: `cannot read the Qwen Code version (${version.slice(0, 80) || 'unknown'})` };
  const series = `${Number(m[1])}.${Number(m[2])}`;
  if (!QWEN_VERIFIED_SERIES.includes(series)) return { ok: false, series, reason: `Qwen Code ${m[0]} is not verified by Duo (verified: ${QWEN_VERIFIED_SERIES.map((s) => `${s}.x`).join(', ')}). Its tool set may include tools Duo cannot restrict, so Qwen seats are refused; install a verified release` };
  return { ok: true, series };
}

export function assertQwenSupported(bin: BinSpec): string {
  const version = binVersion(bin);
  const support = qwenSupport(version);
  if (!support.ok) throw new Error(support.reason);
  return version;
}

export async function qwenVersionStatus(bin: BinSpec): Promise<{ version: string; ok: boolean; reason?: string }> {
  const version = await binVersionAsync(bin);
  const support = qwenSupport(version);
  return { version, ok: support.ok, reason: support.reason };
}

let bwrapSeen: { at: number; ok: boolean } | undefined;
/** Whether /usr/bin/bwrap runs (remembered for a minute; status views ask often). */
export function bwrapAvailable(): boolean {
  if (process.platform !== 'linux') return false;
  if (bwrapSeen && Date.now() - bwrapSeen.at < 60_000) return bwrapSeen.ok;
  const ok = spawnSync('/usr/bin/bwrap', ['--version'], { timeout: 5000, stdio: 'ignore' }).status === 0;
  bwrapSeen = { at: Date.now(), ok };
  return ok;
}

/** Fail closed if Qwen's Linux tool sandbox is unavailable. Neither plan mode nor
 * YOLO is a filesystem sandbox, and a read-only reviewer must be enforced by the host. */
export function writeSandboxPolicy(configDir: string, id: string, access: 'read' | 'write', network = false): string {
  if (process.platform !== 'linux') throw new Error('Qwen review/write isolation currently requires Linux Bubblewrap');
  if (!bwrapAvailable()) throw new Error('Qwen isolation requires /usr/bin/bwrap; no unsandboxed fallback');
  if (access === 'read' && network) throw new Error('a read-only Qwen seat never gets network access');
  const file = join(configDir, `qwen-policy-${id}.json`);
  writeFileSync(file, JSON.stringify({ tools: { executionSandbox: {
    backend: 'bwrap', filesystem: access === 'read' ? 'read-only' : 'workspace-write', network: network ? 'open' : 'closed',
  } } }), { mode: 0o600 });
  return file;
}

/** Environment names that hold credentials. A profile run passes only its own key (as OPENAI_API_KEY). */
const CREDENTIAL_ENV = /(^|_)(API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|ACCESS_KEY|PRIVATE_KEY|CREDENTIALS?|SESSION_KEY)$|^(OPENAI|ANTHROPIC|DEEPSEEK|DASHSCOPE|QWENCLOUD|QWEN|GEMINI|GOOGLE|AWS|AZURE|CODEX|CLAUDE|HF|HUGGINGFACE|GH|GITHUB|GITLAB|NPM|MISTRAL|GROQ|OPENROUTER|TOGETHER|FIREWORKS|XAI|COHERE)_/i;
const KEEP_ENV = new Set(['QWEN_CODE_SYSTEM_SETTINGS_PATH', 'QWEN_HOME']);

export function scrubCredentials(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (KEEP_ENV.has(k) || !CREDENTIAL_ENV.test(k)) out[k] = v;
  return out;
}

/**
 * The child environment for a Duo-managed endpoint profile. No implicit credential: a hosted
 * profile must name its variable, and an unauthenticated local server gets a placeholder. Other
 * credentials in Duo's environment are removed, so neither the CLI nor a sandboxed command the
 * model runs can read (and send) them.
 */
export function profileEnvironment(profile?: QwenProfile): { set: Record<string, string>; secret?: string } {
  if (!profile) return { set: {} };
  const issue = profileIssues(profile.name, profile)[0];
  if (issue) throw new Error(issue);
  const key = profile.keyEnv ? process.env[profile.keyEnv] : undefined;
  if (profile.keyEnv && !key) throw new Error(`Qwen profile ${profile.name}: set ${profile.keyEnv} in the environment before starting Duo`);
  return {
    set: { OPENAI_BASE_URL: profile.baseUrl, OPENAI_MODEL: profile.model, OPENAI_API_KEY: key || 'ollama' },
    secret: key,
  };
}

export function redactor(secret?: string): (text: string) => string {
  if (!secret || secret.length < 6) return (text) => text;
  return (text) => text.split(secret).join('[redacted]');
}

export function qwenArgs(o: Pick<QwenTurn, 'bin' | 'access' | 'model' | 'system' | 'schema' | 'resumeId' | 'profile' | 'timeoutSec'>): string[] {
  return [...o.bin.args, '--input-format', 'text', '--output-format', 'stream-json', '--include-partial-messages',
    '--safe-mode', // No user/project hooks, MCP servers, skills or extensions may bypass tool isolation.
    '--approval-mode', o.access === 'read' ? 'plan' : 'yolo', '--model', o.model,
    '--append-system-prompt', o.system,
    ...(o.schema ? ['--json-schema', JSON.stringify(o.schema)] : []),
    // Safe mode ignores --core-tools, so the role's boundary is a complete deny list.
    '--exclude-tools', qwenExcludedTools(o.access).join(','),
    ...(o.resumeId ? ['--resume', o.resumeId] : []),
    ...(o.profile ? ['--auth-type', 'openai'] : []),
    '--max-wall-time', `${Math.max(1, Math.ceil(o.timeoutSec))}s`,
  ];
}

const TRUST_DOWNGRADE = /Approval mode overridden to "default"/;
const TRUST_ERROR = 'Qwen Code ignored write access: folder trust is enabled in Qwen Code and this workspace is not trusted, so it downgraded the writer to approval mode "default". Trust the folder in Qwen Code (or turn off security.folderTrust), then retry';

export async function executeQwen(o: QwenTurn): Promise<QwenResult> {
  if (o.signal?.aborted) return { output: '', error: 'duo: run cancelled' };
  assertQwenSupported(o.bin);
  const settings = writeSandboxPolicy(o.configDir, o.id, o.access, o.access === 'write' && !!o.network);
  const profileEnv = profileEnvironment(o.profile);
  const redact = redactor(profileEnv.secret);
  const args = qwenArgs(o);
  const baseEnv = o.profile ? scrubCredentials(process.env) : process.env;
  return new Promise<QwenResult>((resolve) => {
    let output = '';
    let sessionId: string | undefined = o.resumeId;
    let resultError: string | undefined;
    let fixedError: string | undefined;
    let sawResult = false;
    let stderr = '';
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    let proc: ChildProcessWithoutNullStreams;
    const onAbort = () => { fixedError = 'duo: run cancelled'; killTree(proc?.pid); };
    const done = (error?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      o.signal?.removeEventListener('abort', onAbort);
      o.onProcess?.(undefined);
      resolve({ output, error: fixedError ?? error ?? (resultError && redact(resultError)), sessionId });
    };
    try {
      proc = spawn(o.bin.command, args, { cwd: o.cwd, windowsHide: true,
        env: { ...baseEnv, ...o.bin.env, ...o.env, ...profileEnv.set, QWEN_CODE_SYSTEM_SETTINGS_PATH: settings, QWEN_CODE_SUPPRESS_YOLO_WARNING: '1' },
        stdio: ['pipe', 'pipe', 'pipe'], ...TREE_SPAWN });
    } catch (e) { done(redact((e as Error).message)); return; }
    o.signal?.addEventListener('abort', onAbort, { once: true });
    // The fork's supervisor also ends CLI descendants if Duo exits or a child
    // keeps its output pipe open after the CLI itself has exited.
    void supervise(proc);
    o.onProcess?.(proc);
    // Prompt content is sent on stdin, not exposed in the process command line.
    proc.stdin.on('error', () => undefined);
    proc.stdin.end(o.message);
    const rl = createInterface({ input: proc.stdout, crlfDelay: Infinity });
    rl.on('line', (raw) => {
      if (raw.length > 4_000_000) { resultError = 'oversized Qwen stream event'; killTree(proc.pid); return; }
      // A sandboxed command can still print the endpoint key it was given; never record it.
      const line = redact(raw);
      o.onLine(line);
      try {
        const ev = JSON.parse(line);
        if (typeof ev.session_id === 'string') sessionId = ev.session_id;
        if (ev.type === 'result') {
          sawResult = true;
          if (typeof ev.result === 'string') output = ev.result;
          if (ev.is_error || (ev.subtype && ev.subtype !== 'success')) resultError = String(ev.result || ev.subtype || 'Qwen failed').slice(0, 2000);
        }
      } catch { /* parser records malformed JSON; exit zero without a result still fails */ }
    });
    proc.stderr.on('data', (b: Buffer) => {
      stderr = (stderr + b.toString()).slice(-4000);
      // With folder trust enabled, Qwen silently runs an untrusted folder in "default" mode, where a
      // headless writer's edits are auto-denied. Stop rather than report a writer that cannot write.
      if (o.access === 'write' && !fixedError && TRUST_DOWNGRADE.test(stderr)) {
        fixedError = TRUST_ERROR;
        killTree(proc.pid);
      }
    });
    proc.on('error', (e) => done(redact(e.message)));
    proc.on('close', (code, signal) => {
      rl.close();
      const reason = signal ? `Qwen terminated (${signal})` : code ? `Qwen exited ${code}` : undefined;
      // Stderr can include provider errors. Never retain a configured key.
      const diagnostic = redact(stderr.trim().slice(-2000) || reason || '');
      done(reason ? redact(`${resultError ?? reason}: ${diagnostic}`).slice(0, 2000)
        : !sawResult ? redact(resultError || diagnostic || 'Qwen returned no result event')
        : !output ? redact(resultError || diagnostic || 'Qwen returned an empty result') : undefined);
    });
    timer = setTimeout(() => { resultError = `Qwen timed out after ${o.timeoutSec}s`; killTree(proc.pid);
      const hard = setTimeout(() => { if (!settled) killTree(proc.pid, 'SIGKILL'); }, 1500); hard.unref();
    }, o.timeoutSec * 1000);
    timer.unref();
  });
}

/**
 * Qwen's own boundary self-test (`qwen sandbox --verify`) under the exact policy a seat would run
 * with. It checks admission, workspace write/deny behavior and the network namespace; it is not a
 * model call and costs nothing.
 */
export async function verifyQwenSandbox(bin: BinSpec, cwd: string, configDir: string, access: 'read' | 'write', network: boolean, signal?: AbortSignal, timeoutSec = 30, env: Record<string, string> = {}): Promise<{ ok: boolean; detail: string }> {
  const settings = writeSandboxPolicy(configDir, `verify-${access}`, access, network);
  return new Promise((resolve) => {
    let out = '';
    let finished = false;
    let proc: ReturnType<typeof spawn> | undefined;
    const finish = (ok: boolean, detail: string) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({ ok, detail: detail.slice(0, 400) });
    };
    const onAbort = () => { killTree(proc?.pid, 'SIGKILL'); finish(false, 'cancelled'); };
    const timer = setTimeout(() => { killTree(proc?.pid, 'SIGKILL'); finish(false, `sandbox verification timed out after ${timeoutSec}s`); }, timeoutSec * 1000);
    if (signal?.aborted) { finish(false, 'cancelled'); return; }
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      proc = spawn(bin.command, [...bin.args, 'sandbox', '--verify'], { cwd, windowsHide: true,
        env: { ...scrubCredentials(process.env), ...bin.env, ...env, QWEN_CODE_SYSTEM_SETTINGS_PATH: settings }, stdio: ['ignore', 'pipe', 'pipe'], ...TREE_SPAWN });
    } catch (e) { finish(false, (e as Error).message); return; }
    proc.stdout?.on('data', (b: Buffer) => { out = (out + b.toString()).slice(-4000); });
    proc.stderr?.on('data', (b: Buffer) => { out = (out + b.toString()).slice(-4000); });
    proc.on('error', (e) => finish(false, e.message));
    proc.on('close', (code) => finish(code === 0, code === 0
      ? `Qwen sandbox verification passed (${access === 'read' ? 'read-only' : 'workspace-write'}, network ${network ? 'open' : 'closed'})`
      : `Qwen sandbox verification failed (exit ${code}): ${out.trim().split('\n').slice(-3).join(' ')}`));
  });
}
