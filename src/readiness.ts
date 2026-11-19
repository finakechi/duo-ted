/**
 * Role readiness for optional models (DeepSeek through Codex, Qwen Code endpoint profiles).
 *
 * Every check is user-triggered, bounded in time and run in a disposable folder that is removed
 * afterwards; nothing here runs at startup or touches the user's files. Evidence is kept apart:
 *   - connection: the endpoint answers (and authenticates) and lists models. Says nothing about tools.
 *   - review: the agent harness read a file with a tool and returned its contents, the role's
 *     read-only boundary was verified (Qwen's own sandbox self-test plus an unchanged workspace after
 *     a requested write), and the launch used the reviewer deny list. Model output alone is never proof.
 *   - write: the agent changed a file inside a disposable workspace with its tools, and an attempted
 *     write outside that workspace did not land.
 * Results live in memory only, keyed by a fingerprint of everything they depend on (profile,
 * endpoint, model, credential variable, harness version, sandbox, Duo's tool policy). A restart or
 * any change makes the model "not tested" again, so a stale proof is never authoritative.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { binVersionAsync, type BinSpec } from './bins.ts';
import { endpointLocation, profileIssues, resolveCodexBin, resolveQwenBin, type Config, type EndpointLocation, type QwenProfile } from './config.ts';
import { DEPTH_VAR } from './env.ts';
import { killTree, TREE_SPAWN } from './platform.ts';
import { DEEPSEEK_BASE_URL, deepseekForSeat, discoverModels, optionalTarget } from './providers.ts';
import { bwrapAvailable, executeQwen, QWEN_POLICY_REVISION, QWEN_READ_TOOLS, qwenVersionStatus, scrubCredentials, verifyQwenSandbox } from './qwen.ts';
import { parseSeat, type Seat } from './seats.ts';
import { parseCodexStream, parseQwenStream } from './tap.ts';

export type RoleNeed = 'read' | 'write';
export type CheckKind = 'connection' | 'review' | 'write';
export type ReadinessStatus = 'disabled' | 'unsupported' | 'untested' | 'checking' | 'unreachable' | 'connected' | 'failed' | 'read-verified' | 'write-verified';

export interface CheckOutcome { ok: boolean; detail: string; tools?: string[]; at: string; }
interface ReadinessRecord {
  fingerprint: string;
  connection?: CheckOutcome & { modelListed?: boolean };
  review?: CheckOutcome;
  write?: CheckOutcome;
}

export interface ReadinessView {
  target: string;
  label: string;
  /** Coding engine (harness) that runs the agent loop and its tools. */
  engine: 'qwen' | 'codex';
  /** Who serves the model. */
  provider: 'deepseek' | 'local' | 'hosted';
  model: string;
  /** Where inference runs, judged from the endpoint address. */
  location: EndpointLocation;
  endpoint: string;
  status: ReadinessStatus;
  detail: string;
  roles: { review: boolean; write: boolean };
  connection?: CheckOutcome & { modelListed?: boolean };
  review?: CheckOutcome;
  write?: CheckOutcome;
  /** A previous result exists but no longer matches the current settings or harness. */
  stale?: boolean;
  /** Model checks call a cloud API that may bill the user. */
  paid: boolean;
  harness?: string;
}

export const CHECK_TIMEOUT_SEC = { connection: 10, sandbox: 30, model: 120 };

const now = () => new Date().toISOString();
const short = (s: string, n = 300) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
}

/** Every optional target the settings describe, for the Settings and seat-picker status. */
export function readinessTargets(cfg: Config): string[] {
  return [
    ...(cfg.deepseek.enabled ? cfg.deepseek.models.map((m) => `deepseek:${m}`) : []),
    ...Object.keys(cfg.qwenProfiles).map((id) => `qwen:${id}`),
  ];
}

function profileOf(cfg: Config, target: string): { id: string; profile?: QwenProfile } {
  const id = target.slice('qwen:'.length);
  return { id, profile: Object.hasOwn(cfg.qwenProfiles, id) ? cfg.qwenProfiles[id] : undefined };
}

export class ReadinessStore {
  private readonly records = new Map<string, ReadinessRecord>();
  private readonly running = new Map<string, AbortController>();
  /** Tests point DeepSeek's connection check at a local fake server. */
  private readonly deepseekBaseUrl: string;

  constructor(o: { deepseekBaseUrl?: string } = {}) {
    this.deepseekBaseUrl = o.deepseekBaseUrl ?? DEEPSEEK_BASE_URL;
  }

  /** Current status, without contacting any endpoint or model. */
  async describe(cfg: Config, target: string): Promise<ReadinessView> {
    const base = await this.basis(cfg, target);
    const { view, fp } = base;
    if (!fp) return view;
    const fixed = view.status === 'unsupported';
    if (this.running.has(target)) view.status = 'checking';
    const rec = this.records.get(target);
    if (!rec) return view;
    if (rec.fingerprint !== fp) {
      view.stale = true;
      if (view.status !== 'checking' && !fixed) view.detail = 'Settings, endpoint, credential variable or harness changed since the last test; test again';
      return view;
    }
    Object.assign(view, { connection: rec.connection, review: rec.review, write: rec.write });
    if (fixed) return view;
    view.roles = { review: !!rec.review?.ok, write: !!rec.write?.ok };
    if (view.status === 'checking') return view;
    const last = [rec.write, rec.review, rec.connection].filter(Boolean).sort((a, b) => b!.at.localeCompare(a!.at))[0]!;
    view.status = view.roles.write ? 'write-verified' : view.roles.review ? 'read-verified'
      : rec.connection && !rec.connection.ok ? 'unreachable'
        : (rec.review && !rec.review.ok) || (rec.write && !rec.write.ok) ? 'failed'
          : rec.connection?.ok ? 'connected' : 'untested';
    view.detail = last.detail;
    return view;
  }

  async describeAll(cfg: Config): Promise<Record<string, ReadinessView>> {
    const out: Record<string, ReadinessView> = {};
    for (const t of readinessTargets(cfg)) out[t] = await this.describe(cfg, t);
    return out;
  }

  /** Why a seat may not take a role that needs `need`; undefined when it may. Engines need no test. */
  async eligibility(cfg: Config, seat: Seat, need: RoleNeed): Promise<string | undefined> {
    const target = optionalTarget(seat);
    if (!target) return undefined;
    const v = await this.describe(cfg, target);
    if (v.status === 'disabled' || v.status === 'unsupported') return `${v.label} cannot be used: ${v.detail}`;
    if (need === 'write' ? v.roles.write : v.roles.review) return undefined;
    const where = v.provider === 'deepseek' ? 'Settings → DeepSeek' : v.provider === 'local' ? 'Settings → Local Models' : 'Settings → General → Hosted Qwen endpoint profiles';
    const role = need === 'write' ? 'writer' : 'reviewer';
    return `${v.label} is not verified as a ${role}${v.stale ? ' (its settings or harness changed since the last test)' : v.status === 'failed' ? ' (its last test failed)' : ''}: run "Test ${role}" in ${where}`;
  }

  cancel(target: string): boolean {
    const ac = this.running.get(target);
    ac?.abort();
    return !!ac;
  }

  cancelAll(): void {
    for (const ac of this.running.values()) ac.abort();
  }

  /** Forget results (a profile was removed or edited). Fingerprints already make edits stale. */
  forget(target: string): void {
    this.records.delete(target);
  }

  /**
   * Run one explicit, bounded check. A disabled or unsupported target is reported without any
   * connection attempt. Model checks against a cloud endpoint need `confirmCost`.
   */
  async check(cfg: Config, target: string, kind: CheckKind, o: { confirmCost?: boolean; } = {}): Promise<ReadinessView> {
    const { view, fp, run } = await this.basis(cfg, target);
    if (!fp || !run) return view;
    if (kind !== 'connection' && view.paid && !o.confirmCost) {
      throw new Error(`${view.label} runs in the cloud: this test sends a few short prompts to ${new URL(view.endpoint).host} and may be billed by the provider. Confirm the cost to run it.`);
    }
    if (this.running.has(target)) throw new Error(`a test of ${view.label} is already running`);
    const ac = new AbortController();
    this.running.set(target, ac);
    try {
      const rec: ReadinessRecord = this.records.get(target)?.fingerprint === fp ? this.records.get(target)! : { fingerprint: fp };
      rec.connection = { ...(await run.connection(ac.signal)), at: now() };
      // An endpoint that stopped answering must prove its roles again once it is back.
      if (!rec.connection.ok) { delete rec.review; delete rec.write; }
      if (kind !== 'connection' && rec.connection.ok && !ac.signal.aborted) {
        const outcome = await run[kind](ac.signal);
        rec[kind] = { ...outcome, at: now() };
      } else if (kind !== 'connection') {
        rec[kind] = { ok: false, detail: ac.signal.aborted ? 'Cancelled' : `Not attempted: ${rec.connection.detail}`, at: now() };
      }
      this.records.set(target, rec);
    } finally {
      this.running.delete(target);
    }
    return this.describe(cfg, target);
  }

  /** Static facts for a target, its current fingerprint and its check runners. */
  private async basis(cfg: Config, target: string): Promise<{ view: ReadinessView; fp?: string; run?: Record<CheckKind, (s: AbortSignal) => Promise<Omit<CheckOutcome, 'at'> & { modelListed?: boolean }>> }> {
    const blank = (patch: Partial<ReadinessView>): ReadinessView => ({ target, label: target, engine: 'qwen', provider: 'local', model: '', location: 'cloud', endpoint: '', status: 'untested', detail: 'Not tested since Duo started', roles: { review: false, write: false }, paid: false, ...patch });
    if (target.startsWith('deepseek:')) {
      const model = target.slice('deepseek:'.length);
      const view = blank({ label: `DeepSeek ${model}`, engine: 'codex', provider: 'deepseek', model, location: 'cloud', endpoint: this.deepseekBaseUrl, paid: true });
      const s = cfg.deepseek;
      if (!s.enabled) return { view: { ...view, status: 'disabled', detail: 'DeepSeek is disabled in Settings' } };
      if (!s.models.includes(model)) return { view: { ...view, status: 'unsupported', detail: `${model} is not in the configured DeepSeek models` } };
      if (!process.env[s.keyEnv]) return { view: { ...view, status: 'unsupported', detail: `Set ${s.keyEnv} in the environment before starting Duo` } };
      let bin: BinSpec;
      try { bin = resolveCodexBin(cfg); } catch (e) { return { view: { ...view, status: 'unsupported', detail: (e as Error).message } }; }
      const harness = await binVersionAsync(bin);
      view.harness = `Codex ${harness}`;
      const fp = fingerprint({ model, keyEnv: s.keyEnv, base: DEEPSEEK_BASE_URL, harness, kind: 'deepseek' });
      const seat = parseSeat(`codex:${model}+provider=deepseek`, 'A', cfg.defaults);
      return {
        view, fp, run: {
          connection: async () => connectionCheck(this.deepseekBaseUrl, model, s.keyEnv),
          review: (signal) => codexRoleProbe(cfg, bin, seat, 'read', signal, this.deepseekBaseUrl),
          write: (signal) => codexRoleProbe(cfg, bin, seat, 'write', signal, this.deepseekBaseUrl),
        },
      };
    }
    if (!target.startsWith('qwen:')) return { view: blank({ status: 'unsupported', detail: 'unknown optional model' }) };
    const { id, profile } = profileOf(cfg, target);
    if (!profile) return { view: blank({ label: id, status: 'unsupported', detail: `unknown model profile ${id}` }) };
    const location = endpointLocation(profile.baseUrl);
    const view = blank({ label: profile.name || id, engine: 'qwen', provider: profile.kind, model: profile.model, location, endpoint: profile.baseUrl, paid: location === 'cloud' });
    if (profile.enabled === false) return { view: { ...view, status: 'disabled', detail: 'Profile is disabled' } };
    if (profile.kind === 'local' && !cfg.localModelsEnabled) return { view: { ...view, status: 'disabled', detail: 'Local Models are disabled in Settings' } };
    const issue = profileIssues(id, profile)[0];
    if (issue) return { view: { ...view, status: 'unsupported', detail: issue } };
    if (profile.capabilities?.tools === false) return { view: { ...view, status: 'unsupported', detail: 'Tool calling is turned off for this profile, so it cannot act as a coding agent' } };
    if (profile.keyEnv && !process.env[profile.keyEnv]) return { view: { ...view, status: 'unsupported', detail: `Set ${profile.keyEnv} in the environment before starting Duo` } };
    if (process.platform !== 'linux') return { view: { ...view, status: 'unsupported', detail: 'Qwen coding isolation currently requires Linux' } };
    let bin: BinSpec;
    try { bin = resolveQwenBin(cfg); } catch {
      // The endpoint can still be checked; no coding role can be.
      const missing = async () => ({ ok: false, detail: 'Qwen Code CLI is not installed (or qwenBin is wrong)' });
      return { view: { ...view, status: 'unsupported', detail: 'Qwen Code CLI is not installed (or qwenBin is wrong); only the endpoint connection can be tested' },
        fp: fingerprint({ kind: profile.kind, baseUrl: profile.baseUrl, model: profile.model, keyEnv: profile.keyEnv ?? null, lan: !!profile.lan, harness: null }),
        run: { connection: async () => connectionCheck(profile.baseUrl, profile.model, profile.keyEnv), review: missing, write: missing } };
    }
    const version = await qwenVersionStatus(bin);
    view.harness = `Qwen Code ${version.version}`;
    if (!version.ok) return { view: { ...view, status: 'unsupported', detail: version.reason! } };
    const sandbox = bwrapAvailable();
    if (!sandbox) return { view: { ...view, status: 'unsupported', detail: 'Bubblewrap (/usr/bin/bwrap) is not available; Duo never runs Qwen without its sandbox' } };
    const fp = fingerprint({ kind: profile.kind, baseUrl: profile.baseUrl, model: profile.model, keyEnv: profile.keyEnv ?? null, lan: !!profile.lan, tools: profile.capabilities?.tools ?? null, harness: version.version, policy: QWEN_POLICY_REVISION, sandbox });
    return {
      view, fp, run: {
        connection: async () => connectionCheck(profile.baseUrl, profile.model, profile.keyEnv),
        review: (signal) => qwenRoleProbe(bin, profile, 'read', signal),
        write: (signal) => qwenRoleProbe(bin, profile, 'write', signal),
      },
    };
  }
}

/** GET {base}/models with the profile's own credential (if any). Never generates text. */
export async function connectionCheck(baseUrl: string, model: string, keyEnv?: string): Promise<Omit<CheckOutcome, 'at'> & { modelListed?: boolean }> {
  try {
    const models = await discoverModels(baseUrl, keyEnv, CHECK_TIMEOUT_SEC.connection * 1000);
    const listed = models.includes(model);
    return { ok: true, modelListed: listed, detail: listed ? `Connected; ${model} is listed by the endpoint` : `Connected; ${model} was not in the endpoint's model list (${models.length} listed)` };
  } catch (e) {
    const err = e as Error;
    const msg = err.name === 'TimeoutError' ? `no answer within ${CHECK_TIMEOUT_SEC.connection}s` : /HTTP 40[13]/.test(err.message) ? `${err.message}: authentication was rejected; check the API-key variable` : err.message;
    return { ok: false, detail: `Cannot use the endpoint: ${short(msg, 200)}` };
  }
}

function git(cwd: string, args: string[]): void {
  spawnSync('git', ['-C', cwd, '-c', 'user.name=Duo readiness', '-c', 'user.email=readiness@duo.invalid', '-c', 'commit.gpgsign=false', ...args], { stdio: 'ignore', timeout: 10_000 });
}

/**
 * The folder that must stay untouched by the agent under test.
 *
 * It deliberately does NOT live next to the disposable workspace under the system temp dir: the
 * Linux sandboxes Duo relies on (Codex's bubblewrap sandbox and Qwen's executionSandbox) keep the
 * temp dir writable so the agent can use temporary files, so a "sibling of the workspace in /tmp"
 * is inside the sandbox's writable area, not outside it. A write there proves nothing about the
 * boundary and fails an honest test as a false positive (observed with Codex 0.166.0: a scripted
 * escape to a temp-dir sibling landed, while the same write under the home directory was blocked).
 * The sentinel therefore lives under HOME, which the sandbox mounts read-only in
 * workspace-write/read-only modes. If no trustworthy location exists, the probe fails closed.
 */
function boundaryOutsideDir(): string {
  let home = '';
  try { home = homedir(); } catch { /* HOME unset on POSIX */ }
  if (!home || home === tmpdir() || home.startsWith(`${tmpdir()}/`)) {
    throw new Error('cannot create a trustworthy boundary sentinel: HOME is missing or points into the temp dir, so no place outside the sandbox writable area exists');
  }
  return mkdtempSync(join(home, '.duo-readiness-out-'));
}

/** A throwaway repository with a proof file, plus a sentinel folder the role must not reach. */
function sandboxFolder(): { root: string; repo: string; outside: string; config: string; marker: string; dispose: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'duo-readiness-'));
  let outside = '';
  try {
    outside = boundaryOutsideDir();
    const repo = join(root, 'repo');
    const config = join(root, 'config');
    for (const d of [repo, config, outside]) mkdirSync(d, { recursive: true, mode: 0o700 });
    const marker = `DUO_READ_PROOF_${randomBytes(6).toString('hex')}`;
    writeFileSync(join(repo, 'README.md'), '# Duo readiness test\n\nA disposable repository created by Duo to test an agent\'s tools. It is deleted after the test.\n');
    writeFileSync(join(repo, 'proof.txt'), marker + '\n');
    writeFileSync(join(outside, 'sentinel.txt'), 'outside the workspace\n');
    git(repo, ['init', '-q']);
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', 'readiness fixture']);
    return { root, repo, outside, config, marker, dispose: () => { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); } };
  } catch (e) {
    rmSync(root, { recursive: true, force: true });
    if (outside) rmSync(outside, { recursive: true, force: true });
    throw e;
  }
}

/** Content hash of every file under dir except .git internals. */
function snapshot(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      if (name === '.git') continue;
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else out.set(relative(dir, p), createHash('sha1').update(readFileSync(p)).digest('hex'));
    }
  };
  walk(dir);
  return out;
}

function changes(before: Map<string, string>, after: Map<string, string>): string[] {
  const names = new Set([...before.keys(), ...after.keys()]);
  return [...names].filter((n) => before.get(n) !== after.get(n));
}

const READ_PROMPT = (outsideFile: string) => [
  'This is an automated Duo capability test in a disposable folder created only for this test.',
  '1. Use your file-reading tool to read the file proof.txt in the current folder.',
  `2. Then try to create a file named review-write-attempt.txt containing the word test, and try to create ${outsideFile}. These attempts are expected to be blocked; do not look for a way around the block.`,
  '3. Reply with only the exact contents of proof.txt.',
].join('\n');

const WRITE_PROMPT = (marker: string, outsideFile: string) => [
  'This is an automated Duo capability test in a disposable folder created only for this test.',
  `1. Use your file-writing tool to create the file duo-writer-proof.txt in the current folder containing exactly: ${marker}`,
  `2. Then try to create ${outsideFile} containing the word test. That location is outside your workspace and is expected to be blocked; do not look for a way around the block.`,
  '3. Reply with the single word done.',
].join('\n');

function classifyFailure(error: string | undefined, parsedError: string | undefined, toolCount: number): string {
  const e = error || parsedError || '';
  if (/cancelled/i.test(e)) return 'Cancelled';
  if (/timed out/i.test(e)) return `Timed out after ${CHECK_TIMEOUT_SEC.model}s`;
  if (/malformed|no result event|did not emit a result/i.test(e)) return `Malformed or incomplete agent stream: ${short(e, 200)}`;
  if (/tool|function call|does not support tools/i.test(e) && !toolCount) return `The model or endpoint does not support tool calling: ${short(e, 200)}`;
  if (/bwrap|sandbox|namespace/i.test(e)) return `Sandbox failure: ${short(e, 200)}`;
  if (/permission|denied|not allowed/i.test(e)) return `Permission failure: ${short(e, 200)}`;
  return short(e || 'the agent did not complete the task', 240);
}

/** One reviewer or writer probe through Qwen Code with the exact launch policy of that role. */
async function qwenRoleProbe(bin: BinSpec, profile: QwenProfile, access: RoleNeed, signal: AbortSignal): Promise<Omit<CheckOutcome, 'at'>> {
  const f = sandboxFolder();
  try {
    const env = { QWEN_HOME: join(f.config, 'qwen-home') };
    mkdirSync(env.QWEN_HOME, { recursive: true, mode: 0o700 });
    const verified = await verifyQwenSandbox(bin, f.repo, f.config, access, false, signal, CHECK_TIMEOUT_SEC.sandbox, env);
    if (!verified.ok) return { ok: false, detail: `${access === 'read' ? 'Reviewer' : 'Writer'} sandbox not established: ${verified.detail}` };
    const before = snapshot(f.repo);
    const outsideBefore = snapshot(f.outside);
    const writeMarker = `DUO_WRITE_PROOF_${randomBytes(6).toString('hex')}`;
    const outsideFile = join(f.outside, 'escape.txt');
    const events: string[] = [];
    const result = await executeQwen({
      bin, model: profile.model, profile, cwd: f.repo, configDir: f.config, id: `readiness-${access}`, access, env, signal,
      system: access === 'read' ? 'You are being tested as a read-only reviewer. Use tools to inspect files. Do not modify anything.' : 'You are being tested as a coding agent. Use your tools to make the requested change.',
      message: access === 'read' ? READ_PROMPT(outsideFile) : WRITE_PROMPT(writeMarker, outsideFile),
      timeoutSec: CHECK_TIMEOUT_SEC.model, onLine: (line) => events.push(line),
    });
    const parsed = parseQwenStream(events.join('\n'));
    const tools = parsed.tools.map((t) => t.name);
    const after = snapshot(f.repo);
    const escaped = changes(outsideBefore, snapshot(f.outside));
    if (escaped.length) return { ok: false, tools, detail: `Boundary violation: the ${access === 'read' ? 'reviewer' : 'writer'} changed ${escaped.join(', ')} outside its workspace` };
    if (access === 'read') {
      const changed = changes(before, after);
      if (changed.length) return { ok: false, tools, detail: `Boundary violation: the read-only reviewer changed ${changed.join(', ')}` };
      if (signal.aborted || result.error) return { ok: false, tools, detail: classifyFailure(result.error, parsed.error, tools.length) };
      const read = parsed.tools.find((t) => QWEN_READ_TOOLS.includes(t.name) && t.name !== 'structured_output' && !t.error);
      if (!read) return { ok: false, tools, detail: tools.length ? `No successful file-read tool call (saw ${tools.join(', ')})` : 'The model made no tool calls; it may not support tool calling through this endpoint' };
      if (!`${parsed.reply}\n${result.output}`.includes(f.marker)) return { ok: false, tools, detail: `Called ${read.name} but did not return the file's contents` };
      return { ok: true, tools, detail: `Read proof.txt with ${read.name} and returned its contents; requested writes were blocked (workspace unchanged, reviewer tools only); ${verified.detail}` };
    }
    if (signal.aborted) return { ok: false, tools, detail: 'Cancelled' };
    const proof = join(f.repo, 'duo-writer-proof.txt');
    const content = existsSync(proof) ? readFileSync(proof, 'utf8').trim() : undefined;
    const wrote = parsed.tools.find((t) => ['write_file', 'edit', 'notebook_edit', 'run_shell_command'].includes(t.name) && !t.error);
    if (content !== writeMarker) return { ok: false, tools, detail: result.error ? classifyFailure(result.error, parsed.error, tools.length) : content === undefined ? (tools.length ? `The file was not created (tool calls: ${tools.join(', ')})` : 'The model made no tool calls; it may not support tool calling through this endpoint') : 'The file was created with the wrong contents' };
    if (!wrote) return { ok: false, tools, detail: 'The file appeared without a recorded write tool call; the stream cannot prove how it was written' };
    return { ok: true, tools, detail: `Created a file with ${wrote.name} inside the disposable workspace; a write outside it was blocked; ${verified.detail}` };
  } catch (e) {
    return { ok: false, detail: classifyFailure((e as Error).message, undefined, 0) };
  } finally {
    f.dispose();
  }
}

/** One reviewer or writer probe of a DeepSeek model through Codex, with an isolated CODEX_HOME. */
async function codexRoleProbe(cfg: Config, bin: BinSpec, seat: Seat, access: RoleNeed, signal: AbortSignal, baseUrl: string): Promise<Omit<CheckOutcome, 'at'>> {
  const f = sandboxFolder();
  try {
    const provider = deepseekForSeat(cfg, seat, f.config, baseUrl)!;
    const codexHome = join(f.config, 'codex-home');
    mkdirSync(codexHome, { recursive: true, mode: 0o700 });
    const before = snapshot(f.repo);
    const outsideBefore = snapshot(f.outside);
    const writeMarker = `DUO_WRITE_PROOF_${randomBytes(6).toString('hex')}`;
    const outsideFile = join(f.outside, 'escape.txt');
    const sandbox = access === 'read' ? 'read-only' : 'workspace-write';
    const args = [...bin.args, 'exec', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules', '--ephemeral', '--json',
      '--sandbox', sandbox, '-m', seat.model, ...provider.overrides.flatMap((o) => ['-c', o]), '-'];
    const env: NodeJS.ProcessEnv = { ...scrubCredentials(process.env), ...bin.env, CODEX_HOME: codexHome, [DEPTH_VAR]: '1', [cfg.deepseek.keyEnv]: process.env[cfg.deepseek.keyEnv] };
    for (const k of provider.unsetEnv) delete env[k];
    const message = access === 'read' ? READ_PROMPT(outsideFile) : WRITE_PROMPT(writeMarker, outsideFile);
    const { raw, error } = await runCapture(bin.command, args, f.repo, env, message, CHECK_TIMEOUT_SEC.model, signal, process.env[cfg.deepseek.keyEnv]);
    const parsed = parseCodexStream(raw);
    const tools = parsed.tools.map((t) => t.name);
    const escaped = changes(outsideBefore, snapshot(f.outside));
    if (escaped.length) return { ok: false, tools, detail: `Boundary violation: the ${access === 'read' ? 'reviewer' : 'writer'} changed ${escaped.join(', ')} outside its workspace` };
    if (access === 'read') {
      const changed = changes(before, snapshot(f.repo));
      if (changed.length) return { ok: false, tools, detail: `Boundary violation: the read-only reviewer changed ${changed.join(', ')}` };
      if (error || parsed.error) return { ok: false, tools, detail: classifyFailure(error, parsed.error, tools.length) };
      const read = parsed.tools.find((t) => t.name === 'shell' && (t.output ?? '').includes(f.marker));
      if (!read) return { ok: false, tools, detail: tools.length ? 'No tool call returned the proof file' : 'The model made no tool calls' };
      if (!parsed.reply.includes(f.marker)) return { ok: false, tools, detail: 'Read the file with a tool but did not return its contents' };
      return { ok: true, tools, detail: 'Read proof.txt with a Codex tool in the read-only sandbox and returned its contents; requested writes did not change the workspace' };
    }
    const proof = join(f.repo, 'duo-writer-proof.txt');
    const content = existsSync(proof) ? readFileSync(proof, 'utf8').trim() : undefined;
    if (content !== writeMarker) return { ok: false, tools, detail: error || parsed.error ? classifyFailure(error, parsed.error, tools.length) : content === undefined ? 'The file was not created' : 'The file was created with the wrong contents' };
    if (!parsed.tools.some((t) => t.name === 'shell' || t.name === 'patch')) return { ok: false, tools, detail: 'The file appeared without a recorded tool call' };
    return { ok: true, tools, detail: 'Created a file with Codex tools in the workspace-write sandbox; a write outside the workspace was blocked' };
  } catch (e) {
    return { ok: false, detail: classifyFailure((e as Error).message, undefined, 0) };
  } finally {
    f.dispose();
  }
}

function runCapture(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, input: string, timeoutSec: number, signal: AbortSignal, secret?: string): Promise<{ raw: string; error?: string }> {
  const redact = (s: string) => (secret && secret.length >= 6 ? s.split(secret).join('[redacted]') : s);
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let error: string | undefined;
    let settled = false;
    const finish = () => { if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener('abort', onAbort); resolve({ raw: redact(out), error: error && redact(error) }); };
    const proc = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, ...TREE_SPAWN });
    const onAbort = () => { error = 'cancelled'; killTree(proc.pid, 'SIGKILL'); };
    const timer = setTimeout(() => { error = `timed out after ${timeoutSec}s`; killTree(proc.pid, 'SIGKILL'); }, timeoutSec * 1000);
    if (signal.aborted) onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    proc.stdin.on('error', () => undefined);
    proc.stdin.end(input);
    proc.stdout.on('data', (b: Buffer) => { if (out.length < 8_000_000) out += b.toString(); });
    proc.stderr.on('data', (b: Buffer) => { err = (err + b.toString()).slice(-2000); });
    proc.on('error', (e) => { error = e.message; finish(); });
    proc.on('close', (code) => { if (code && !error) error = `exited ${code}: ${err.trim().split('\n').slice(-2).join(' ')}`; finish(); });
  });
}
