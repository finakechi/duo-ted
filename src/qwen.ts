/** Qwen Code one-shot adapter. The installed claw 7.6 custom one-shot runner does not
 * replay --resume or forward its raw stream; Duo needs both for safe collaboration. */
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BinSpec } from './bins.ts';
import type { QwenProfile } from './config.ts';
import { killTree, supervise, TREE_SPAWN } from './platform.ts';
import { parseQwenStream } from './tap.ts';

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
  configDir: string;
  id: string;
  onLine: (line: string) => void;
  onProcess?: (proc?: ChildProcessWithoutNullStreams) => void;
}

/** Fail closed if Qwen's Linux tool sandbox is unavailable. Neither plan mode nor
 * YOLO is a filesystem sandbox, and a read-only reviewer must be enforced by the host. */
function sandboxPolicy(o: QwenTurn): string {
  if (process.platform !== 'linux') throw new Error('Qwen review/write isolation currently requires Linux Bubblewrap');
  const check = spawnSync('/usr/bin/bwrap', ['--version'], { timeout: 5000, stdio: 'ignore' });
  if (check.status !== 0) throw new Error('Qwen isolation requires /usr/bin/bwrap; no unsandboxed fallback');
  const file = join(o.configDir, `qwen-policy-${o.id}.json`);
  writeFileSync(file, JSON.stringify({ tools: { executionSandbox: {
    backend: 'bwrap', filesystem: o.access === 'read' ? 'read-only' : 'workspace-write', network: 'closed',
  } } }), { mode: 0o600 });
  return file;
}

function profileEnvironment(profile?: QwenProfile): Record<string, string> {
  if (!profile) return {};
  const key = profile.keyEnv ? process.env[profile.keyEnv] : process.env.OPENAI_API_KEY;
  if (!key && profile.kind !== 'local') throw new Error(`Qwen profile ${profile.name}: set ${profile.keyEnv ?? 'OPENAI_API_KEY'} in the environment`);
  return {
    OPENAI_BASE_URL: profile.baseUrl,
    OPENAI_MODEL: profile.model,
    OPENAI_API_KEY: key || 'ollama',
  };
}

export async function executeQwen(o: QwenTurn): Promise<QwenResult> {
  const settings = sandboxPolicy(o);
  const profileEnv = profileEnvironment(o.profile);
  const args = [...o.bin.args, '--input-format', 'text', '--output-format', 'stream-json', '--include-partial-messages',
    '--safe-mode', // No user/project hooks, MCP servers, skills or extensions may bypass tool isolation.
    '--approval-mode', o.access === 'read' ? 'plan' : 'yolo', '--model', o.model,
    '--append-system-prompt', o.system,
    ...(o.schema ? ['--json-schema', JSON.stringify(o.schema)] : []),
    // Do not allow a reviewer to invoke shell/editing tools even in plan mode.
    ...(o.access === 'read' ? ['--exclude-tools', 'shell,run_shell_command,write,write_file,edit,agent'] : []),
    ...(o.resumeId ? ['--resume', o.resumeId] : []),
    ...(o.profile ? ['--auth-type', 'openai'] : []),
    '--max-wall-time', `${Math.ceil(o.timeoutSec)}s`,
  ];
  return new Promise<QwenResult>((resolve) => {
    let output = '';
    let sessionId: string | undefined = o.resumeId;
    let resultError: string | undefined;
    let sawResult = false;
    let stderr = '';
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    let proc: ChildProcessWithoutNullStreams;
    const done = (error?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      o.onProcess?.(undefined);
      resolve({ output, error: error ?? resultError, sessionId });
    };
    try {
      proc = spawn(o.bin.command, args, { cwd: o.cwd, windowsHide: true,
        env: { ...process.env, ...o.bin.env, ...profileEnv, QWEN_CODE_SYSTEM_SETTINGS_PATH: settings },
        stdio: ['pipe', 'pipe', 'pipe'], ...TREE_SPAWN });
    } catch (e) { done((e as Error).message); return; }
    // The fork's supervisor also ends CLI descendants if Duo exits or a child
    // keeps its output pipe open after the CLI itself has exited.
    void supervise(proc);
    o.onProcess?.(proc);
    // Prompt content is sent on stdin, not exposed in the process command line.
    proc.stdin.on('error', () => undefined);
    proc.stdin.end(o.message);
    const rl = createInterface({ input: proc.stdout, crlfDelay: Infinity });
    rl.on('line', (line) => {
      if (line.length > 4_000_000) { resultError = 'oversized Qwen stream event'; killTree(proc.pid); return; }
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
    proc.stderr.on('data', (b: Buffer) => { stderr = (stderr + b.toString()).slice(-2000); });
    proc.on('error', (e) => done(e.message));
    proc.on('close', (code, signal) => {
      rl.close();
      const reason = signal ? `Qwen terminated (${signal})` : code ? `Qwen exited ${code}` : undefined;
      // Stderr can include provider errors. Never retain a configured key.
      const secret = profileEnv.OPENAI_API_KEY;
      const diagnostic = (stderr.trim() || reason || '').replace(secret && secret !== 'ollama' ? new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g') : /\b(?!)\b/g, '[redacted]');
      done(reason ? `${resultError ?? reason}: ${diagnostic}`.slice(0, 2000)
        : !sawResult ? (resultError || diagnostic || 'Qwen returned no result event')
        : !output ? (resultError || diagnostic || 'Qwen returned an empty result') : undefined);
    });
    timer = setTimeout(() => { resultError = `Qwen timed out after ${o.timeoutSec}s`; killTree(proc.pid);
      const hard = setTimeout(() => { if (!settled) killTree(proc.pid, 'SIGKILL'); }, 1500); hard.unref();
    }, o.timeoutSec * 1000);
    timer.unref();
  });
}

/** Separate endpoint reachability from an actual coding-tool proof. A model list
 * response alone is never treated as evidence of agent capability. */
export async function probeQwenProfile(profile: QwenProfile, bin?: BinSpec): Promise<{
  reachable: boolean; modelListed?: boolean; toolUse: 'verified' | 'failed' | 'unverified'; detail: string;
}> {
  const key = profile.keyEnv ? process.env[profile.keyEnv] : process.env.OPENAI_API_KEY;
  if (!key && profile.kind === 'hosted') return { reachable: false, toolUse: 'unverified', detail: `Set ${profile.keyEnv ?? 'OPENAI_API_KEY'} first` };
  let modelListed: boolean | undefined;
  try {
    const url = new URL(profile.baseUrl.replace(/\/$/, '') + '/models');
    const reply = await fetch(url, { method: 'GET', headers: key ? { Authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(7000) });
    if (!reply.ok) return { reachable: false, toolUse: 'unverified', detail: `Endpoint returned HTTP ${reply.status}` };
    const data = await reply.json() as { data?: { id?: string }[] };
    if (Array.isArray(data.data)) modelListed = data.data.some((m) => m.id === profile.model);
  } catch (e) { return { reachable: false, toolUse: 'unverified', detail: `Cannot reach endpoint: ${(e as Error).name}` }; }
  if (!bin) return { reachable: true, modelListed, toolUse: 'unverified', detail: 'Endpoint reached; Qwen CLI unavailable for a tool-use test' };
  const workspace = mkdtempSync(join(tmpdir(), 'duo-qwen-probe-'));
  const marker = `DUO_TOOL_PROOF_${Math.random().toString(36).slice(2)}`;
  const events: string[] = [];
  try {
    writeFileSync(join(workspace, 'proof.txt'), marker + '\n');
    const result = await executeQwen({ bin, model: profile.model, profile, cwd: workspace,
      system: 'Use file-reading tools to inspect the requested file. Do not modify files.',
      message: 'Use your file-reading tool to read proof.txt, then reply with the exact file content.',
      access: 'read', configDir: workspace, id: 'probe', timeoutSec: 45,
      onLine: (line) => events.push(line) });
    const parsed = parseQwenStream(events.join('\n'));
    const read = parsed.tools.some((t) => /read/i.test(t.name));
    const passed = !result.error && !parsed.error && read && parsed.reply.includes(marker);
    return { reachable: true, modelListed, toolUse: passed ? 'verified' : 'failed',
      detail: passed ? 'Model read a file with an agent tool and returned its contents' : `Model/tool verification failed: ${(result.error || parsed.error || (!read ? 'no file-read tool call' : 'wrong file contents')).slice(0, 220)}` };
  } finally { rmSync(workspace, { recursive: true, force: true }); }
}
