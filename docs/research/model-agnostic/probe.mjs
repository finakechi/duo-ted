#!/usr/bin/env node
/**
 * NON-PRODUCTION FEASIBILITY PROBE for docs/model-agnostic-feasibility.md.
 *
 * Runs claw-orchestrator's real SessionManager (the version pinned in package.json) and Duo's real
 * seat/template validators against FAKE CLIs. No network, no account, no model, no GPU.
 *
 * What it can show: how the pinned libraries pass prompts, schemas, permissions, provider URLs and
 * session ids to a CLI, and which Duo validators refuse non-Claude/Codex engines.
 * What it cannot show: whether any real CLI, provider or model behaves the same way.
 *
 *   node docs/research/model-agnostic/probe.mjs        (after `npm ci`; Linux/macOS: the fakes
 *                                                        are spawned via their #! line)
 */
import { chmodSync, mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const here = import.meta.dirname;
const tmp = mkdtempSync(join(tmpdir(), 'duo-probe-'));
const LOG = join(tmp, 'calls.jsonl');
for (const f of ['fake-opencode.mjs', 'fake-claude-env.mjs']) chmodSync(join(here, f), 0o755);
Object.assign(process.env, {
  HOME: tmp, USERPROFILE: tmp,
  DUO_HOME: join(tmp, 'duo'), DUO_CONFIG: join(tmp, 'config.json'),
  CLAWO_RUNS_DIR: join(tmp, 'claw-runs'), CLAWO_WF_DIR: join(tmp, 'claw-wf'), CLAWO_NO_EMBEDDED_SERVER: '1',
  OPENCODE_BIN: join(here, 'fake-opencode.mjs'),
  PROBE_LOG: LOG,
});
delete process.env.GATEWAY_URL;
delete process.env.ANTHROPIC_BASE_URL;

const results = [];
const check = (id, claim, ok, detail) => results.push({ id, claim, observed: ok ? 'CONFIRMED' : 'NOT CONFIRMED', detail });
const calls = () => (existsSync(LOG) ? readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

// ── P1/P2: Duo's own validators ─────────────────────────────────────────────────────────────
const { parseSeat } = await import('../../../src/seats.ts');
const { templateErrors } = await import('../../../src/templates/validate.ts');
const { builtinDefinition } = await import('../../../src/templates/definitions.ts');
const { classifyError } = await import('../../../src/errors.ts');
const defaults = { codexModel: 'gpt-6-sol', claudeModel: 'opus' };
for (const spec of ['opencode:qwen/qwen3.6-35b-a3b', 'deepseek:deepseek-flash', 'ollama:qwen3.6']) {
  let msg = '';
  try { parseSeat(spec, 'A', defaults); } catch (e) { msg = e.message; }
  check('P1', `Duo seat grammar refuses "${spec}"`, /unknown engine/.test(msg), msg);
}
const t = builtinDefinition('ask');
t.id = 'probe-ask';
delete t.library;
t.steps = { answers: { type: 'turn', role: 'participant', prompt: '{{brief}}', next: 'done' }, done: { type: 'finish', status: 'completed', reason: 'ok' } };
t.start = 'answers';
t.assignments = [{ role: 'participant', select: { engine: 'opencode' } }];
const errs = templateErrors(t);
check('P2', 'Template selector refuses engine "opencode"', errs.some((e) => /unknown engine/.test(e)), errs.join('; '));

// ── P3: claw's OpenCode engine, read-only, with a schema, an appended system prompt and a long prompt
const { SessionManager, nullLogger } = await import('@enderfga/claw-orchestrator');
const manager = new SessionManager({ claudeBin: join(here, 'fake-claude-env.mjs'), maxConcurrentSessions: 4, sessionTtlMinutes: 5 }, nullLogger);
const longPrompt = 'x'.repeat(200_000);
try {
  await manager.startSession({
    name: 'probe-oc', engine: 'opencode', cwd: tmp, model: 'ollama/qwen3.6:35b-a3b', effort: 'high',
    permissionMode: 'dontAsk', sandboxMode: 'read-only', skipPersistence: true,
    jsonSchema: JSON.stringify({ type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] }),
    appendSystemPrompt: '<probe_system>read-only reviewer</probe_system>',
  });
  // A debate-sized prompt first: claw puts the OpenCode message on argv (Linux caps one argument at 128 KiB).
  let bigError = '';
  try {
    const big = await manager.sendMessage('probe-oc', `first turn ${longPrompt}`, { timeout: 30_000 });
    bigError = big.error ?? '';
  } catch (e) { bigError = e.message; }
  check('P3-argv', 'A 200,000-character prompt to the OpenCode engine fails before the CLI runs', /E2BIG|too long/i.test(bigError), bigError || 'no error');
  rmSync(LOG, { force: true });
  await manager.stopSession('probe-oc').catch(() => undefined);
  await manager.startSession({
    name: 'probe-oc', engine: 'opencode', cwd: tmp, model: 'ollama/qwen3.6:35b-a3b', effort: 'high',
    permissionMode: 'dontAsk', sandboxMode: 'read-only', skipPersistence: true,
    jsonSchema: JSON.stringify({ type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] }),
    appendSystemPrompt: '<probe_system>read-only reviewer</probe_system>',
  });
  const r1 = await manager.sendMessage('probe-oc', `first turn ${'y'.repeat(20_000)}`, { timeout: 30_000 });
  const r2 = await manager.sendMessage('probe-oc', 'second turn', { timeout: 30_000 });
  const oc = calls().filter((c) => c.cli === 'opencode');
  check('P3a', 'OpenCode prompt travels on argv (not stdin)', oc[0]?.messageOnArgv === true, `first message length ${oc[0]?.messageLength}`);
  check('P3b', 'jsonSchema is not forwarded to OpenCode (no schema flag)', oc.every((c) => !c.hasSchemaFlag), JSON.stringify(oc[0]?.args));
  check('P3c', 'appendSystemPrompt is prepended to the first user message only', oc[0]?.messageStartsWithSystemText === true && oc[1]?.messageStartsWithSystemText === false, '');
  check('P3d', 'read-only maps to an injected agent denying edit/bash/task/webfetch', oc[0]?.agent === 'clawo-readonly' && oc[0]?.readOnlyAgentConfig?.agent?.['clawo-readonly']?.permission?.task === 'deny', JSON.stringify(oc[0]?.readOnlyAgentConfig));
  check('P3e', 'second send resumes the OpenCode session id', oc[0]?.session === null && /^ses_fake_\d+$/.test(oc[1]?.session ?? ''), `turn2 --session ${oc[1]?.session}`);
  check('P3f', 'model passes through only in provider/model form; effort becomes --variant', oc[0]?.model === 'ollama/qwen3.6:35b-a3b' && oc[0]?.variant === 'high', '');
  check('P3g', 'claw returns the reply text (structured output must be parsed by Duo)', /fake opencode reply/.test(r1.output ?? '') && !r2.error, `output=${JSON.stringify(r1.output)}`);
} catch (e) {
  check('P3', 'OpenCode engine probe ran', false, e.message);
}
await manager.stopSession('probe-oc').catch(() => undefined);

// ── P4: claw's Claude engine given a non-Claude model plus baseUrl ─────────────────────────
rmSync(LOG, { force: true });
try {
  await manager.startSession({ name: 'probe-cl-baseurl', engine: 'claude', cwd: tmp, model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com/anthropic', permissionMode: 'plan', skipPersistence: true, tools: ['Read'] });
  await manager.sendMessage('probe-cl-baseurl', 'hello', { timeout: 30_000 });
  const c = calls().find((x) => x.cli === 'claude');
  check('P4', 'claw rewrites a non-Claude model to --model opus and appends /real/<model> to baseUrl (proxy convention)', c?.model === 'opus' && /\/real\/deepseek-flash$/.test(c?.ANTHROPIC_BASE_URL ?? ''), JSON.stringify(c));
} catch (e) {
  check('P4', 'Claude baseUrl probe ran', false, e.message);
}
await manager.stopSession('probe-cl-baseurl').catch(() => undefined);

// ── P5: same model, provider URL supplied by the caller's process environment instead ──────
rmSync(LOG, { force: true });
process.env.ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic';
process.env.ANTHROPIC_AUTH_TOKEN = 'probe-not-a-real-key';
try {
  await manager.startSession({ name: 'probe-cl-env', engine: 'claude', cwd: tmp, model: 'deepseek-flash', permissionMode: 'plan', skipPersistence: true, tools: ['Read'] });
  await manager.sendMessage('probe-cl-env', 'hello', { timeout: 30_000 });
  const c = calls().find((x) => x.cli === 'claude');
  check('P5', 'Without baseUrl (and no OpenClaw gateway), model and env-provided ANTHROPIC_BASE_URL pass through unchanged', c?.model === 'deepseek-flash' && c?.ANTHROPIC_BASE_URL === 'https://api.deepseek.com/anthropic' && c?.hasAuthToken === true, JSON.stringify(c));
} catch (e) {
  check('P5', 'Claude env probe ran', false, e.message);
}
delete process.env.ANTHROPIC_BASE_URL;
delete process.env.ANTHROPIC_AUTH_TOKEN;
await manager.shutdown().catch(() => undefined);

// ── P6: Duo's error classes for errors a direct/local provider would plausibly produce ──────
for (const [msg, expect] of [
  ['connect ECONNREFUSED 127.0.0.1:11434', 'other'],
  ['fetch failed: getaddrinfo ENOTFOUND api.deepseek.com', 'other'],
  ['402 Insufficient Balance', 'other'],
  ['429 Too Many Requests', 'quota'],
  ["This model's maximum context length is 131072 tokens", 'other'],
  ['503 Service Unavailable', 'capacity'],
]) {
  const got = classifyError(msg);
  check('P6', `classifyError("${msg}") → ${expect}`, got === expect, `got ${got}`);
}

rmSync(tmp, { recursive: true, force: true });
for (const r of results) process.stdout.write(`${r.observed.padEnd(14)} ${r.id.padEnd(4)} ${r.claim}${r.detail ? `\n${' '.repeat(20)}${r.detail.slice(0, 300)}` : ''}\n`);
process.exit(0);
