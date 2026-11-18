/**
 * End to end through claw-orchestrator and duo's spawn hook, with fake CLIs (test/fakes) standing in
 * for Codex and Claude Code: no network, no quota, any OS.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

// realpath: on macOS the temp folder is a symlink, and the CLIs report the resolved path.
const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'duo-engine-')));
const LOG = join(tmp, 'calls.jsonl');
Object.assign(process.env, {
  DUO_HOME: join(tmp, 'home'),
  DUO_CONFIG: join(tmp, 'config.json'),
  CODEX_HOME: join(tmp, 'codex-home'),
  CLAUDE_CONFIG_DIR: join(tmp, 'claude-home'),
  DUO_CODEX_BIN: join(import.meta.dirname, 'fakes', 'codex.mjs'),
  DUO_CLAUDE_BIN: join(import.meta.dirname, 'fakes', 'claude.mjs'),
  DUO_QWEN_BIN: join(import.meta.dirname, 'fakes', 'qwen.mjs'),
  FAKE_LOG: LOG,
});
delete process.env.DUO_DEPTH;

const { loadConfig } = await import('../src/config.ts');
const { RunContext } = await import('../src/protocols/common.ts');
const { ask } = await import('../src/protocols/ask.ts');
const { continueRun } = await import('../src/protocols/continue.ts');
const { debate } = await import('../src/protocols/debate.ts');
const { pair } = await import('../src/protocols/pair.ts');
const { review } = await import('../src/protocols/review.ts');
const { parseSeat } = await import('../src/seats.ts');
const { finishWorkspace } = await import('../src/worktree.ts');

const cfg = loadConfig();
const D = cfg.defaults;
const calls = () => (existsSync(LOG) ? readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

function ctxFor(protocol: string, specs: string[], o: { cwd?: string; rounds?: number; brief?: string } = {}) {
  const seats = specs.map((s, i) => parseSeat(s, String.fromCharCode(65 + i), D));
  return RunContext.create(cfg, { protocol, title: `${protocol} test`, brief: o.brief ?? 'What is 2+2?', cwd: o.cwd ?? tmp, seats, rounds: o.rounds ?? 2, minRounds: 1, anon: false, quiet: true, extra: {} });
}

after(() => rmSync(tmp, { recursive: true, force: true }));

test('ask: both CLIs answer; the Codex prompt goes through stdin with the seat flags after exec', async () => {
  rmSync(LOG, { force: true });
  const ctx = ctxFor('ask', ['codex:gpt-6-sol@high+verbosity=low', 'claude:sonnet@low']);
  await ask(ctx);
  const m = ctx.store.meta;
  assert.equal(m.status, 'completed');
  assert.equal(m.turns.length, 2);
  for (const t of m.turns) assert.ok(!t.error, `turn ${t.seat}: ${t.error}`);
  const cx = calls().find((c) => c.cli === 'codex' && c.args);
  assert.equal(cx.args[0], 'exec');
  assert.equal(cx.args[cx.args.length - 1], '-', 'the prompt is read from stdin');
  assert.match(cx.prompt, /What is 2\+2\?/);
  const flags = cx.args.slice(1, 12).join(' ');
  assert.match(flags, /model_verbosity="low"/);
  assert.match(flags, /skills\.include_instructions=false/);
  assert.ok(cx.args.includes('--ignore-rules'));
  const codexTurn = m.turns.find((t) => t.seat === 'A')!;
  assert.equal(codexTurn.usage.input, 1000);
  assert.ok((codexTurn.codexCredits ?? 0) > 0, 'priced from the rate card');
});

test('DeepSeek Codex seat answers alongside Claude with isolated provider config and no plan credits', async () => {
  rmSync(LOG, { force: true });
  const configuration = structuredClone(cfg);
  configuration.deepseek.enabled = true;
  process.env.DEEPSEEK_API_KEY = 'sensitive-test-key-do-not-log';
  try {
    const seats = ['codex:deepseek-flash@high+provider=deepseek', 'claude:sonnet@low'].map((spec, i) => parseSeat(spec, String.fromCharCode(65 + i), D));
    const ctx = RunContext.create(configuration, { protocol: 'ask', title: 'DeepSeek test', brief: 'Review a change', cwd: tmp, seats, rounds: 1, minRounds: 1, anon: false, quiet: true, extra: {} });
    await ask(ctx);
    assert.equal(ctx.store.meta.status, 'completed');
    const deepseek = ctx.store.meta.turns.find((t) => t.seat === 'A')!;
    assert.equal(deepseek.codexCredits, undefined);
    assert.match(deepseek.unpriced || '', /DeepSeek/);
    const codex = calls().find((c) => c.cli === 'codex')!;
    assert.match(codex.args.join(' '), /model_provider="duo_deepseek"/);
    assert.match(codex.args.join(' '), /wire_api="responses"/);
    assert.ok(codex.args.includes('--ignore-rules'));
    assert.doesNotMatch(readFileSync(LOG, 'utf8'), /sensitive-test-key-do-not-log/);
    assert.doesNotMatch(readFileSync(join(ctx.store.dir, 'run.json'), 'utf8'), /sensitive-test-key-do-not-log/);
    assert.equal(ctx.store.meta.seats.find((s) => s.id === 'A')?.engine, 'codex');
    assert.ok(ctx.store.meta.turns.some((t) => t.seat === 'B' && !t.error));
  } finally { delete process.env.DEEPSEEK_API_KEY; }
});

test('DeepSeek writer and Claude reviewer preserve Pair git isolation', async () => {
  const repo = join(tmp, 'deepseek-pair');
  execFileSync('git', ['init', '-q', repo]);
  writeFileSync(join(repo, 'README.md'), '# before\n');
  execFileSync('git', ['-C', repo, 'add', '-A']);
  execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init']);
  const configuration = structuredClone(cfg);
  configuration.deepseek.enabled = true;
  process.env.DEEPSEEK_API_KEY = 'fake-key';
  try {
    const seats = ['codex:deepseek-flash@high+provider=deepseek', 'claude:sonnet@low'].map((spec, i) => parseSeat(spec, String.fromCharCode(65 + i), D));
    const ctx = RunContext.create(configuration, { protocol: 'pair', title: 'DeepSeek Pair test', brief: 'Create a test change', cwd: repo, seats, rounds: 1, minRounds: 1, anon: false, quiet: true, extra: {} });
    await pair(ctx, { isolation: 'worktree', writerAccess: 'sandboxed' });
    const workspace = ctx.store.meta.workspace!;
    assert.ok(existsSync(join(workspace.cwd, 'duo-fake.txt')));
    assert.ok(!existsSync(join(repo, 'duo-fake.txt')));
    assert.ok(ctx.store.meta.turns.some((t) => t.seat === 'B'));
    assert.equal(finishWorkspace(workspace, 'discard', 'test').ok, true);
  } finally { delete process.env.DEEPSEEK_API_KEY; }
});

test('ask: a Qwen seat participates and emits recorded tool events and a resumable session', { skip: process.platform !== 'linux' || !existsSync('/usr/bin/bwrap') }, async () => {
  const ctx = ctxFor('ask', ['qwen:qwen3-coder-plus', 'codex:gpt-6-sol@low']);
  await ask(ctx);
  assert.equal(ctx.store.meta.status, 'completed', String(ctx.store.meta.outcome?.stop));
  const turn = ctx.store.meta.turns.find((t) => t.seat === 'A')!;
  assert.ok(!turn.error, turn.error);
  const tools = JSON.parse(readFileSync(join(ctx.store.dir, turn.dir, 'tools.json'), 'utf8'));
  assert.equal(tools[0]?.name, 'read_file');
  assert.ok(ctx.store.meta.seats.find((s) => s.id === 'A')?.qwenSessionId);
  const call = calls().find((c) => c.cli === 'qwen' && c.cwd === tmp);
  assert.ok(call);
  assert.equal(call.args.includes('--approval-mode'), true);
});

test('run intervention pauses at a turn boundary, queues instructions, then resumes without losing the run', { skip: process.platform !== 'linux' || !existsSync('/usr/bin/bwrap') }, async () => {
  rmSync(LOG, { force: true });
  const ctx = ctxFor('ask', ['qwen:qwen3-coder-plus']);
  assert.equal(ctx.pause(), true);
  const work = ask(ctx);
  for (let i = 0; i < 100; i++) {
    const control = JSON.parse(readFileSync(join(ctx.store.dir, 'control.json'), 'utf8'));
    if (control.state === 'paused') break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const paused = JSON.parse(readFileSync(join(ctx.store.dir, 'control.json'), 'utf8'));
  assert.equal(paused.state, 'paused');
  assert.equal(ctx.store.meta.turns.length, 0, 'no model turn executes before resume');
  ctx.instruct('A', 'Include the unique phrase: verified intervention');
  assert.equal(ctx.resume(), true);
  await work;
  assert.equal(ctx.store.meta.status, 'completed');
  assert.ok(calls().some((c) => c.cli === 'qwen' && c.prompt.includes('verified intervention')));
  const recorded = JSON.parse(readFileSync(join(ctx.store.dir, 'control.json'), 'utf8'));
  assert.equal(recorded.pending.length, 0);
  assert.equal(recorded.delivered.length, 1);
});

test('future assignment override changes provider at a safe boundary without losing completed context or reviewer restrictions', { skip: process.platform !== 'linux' || !existsSync('/usr/bin/bwrap') }, async () => {
  rmSync(LOG, { force: true });
  const ctx = ctxFor('ask', ['claude:sonnet@low']);
  const seat = ctx.opts.seats[0];
  const ss = await ctx.engines.openSeat(seat, 'participant', { system: 'Answer carefully', cwd: tmp });
  ctx.recordSeats([ss]);
  const first = await ctx.send(ss, 'First decision: preserve the source files.', { round: 1, kind: 'answer' });
  assert.ok(!first.error, first.error);
  ctx.override('A', 'codex:gpt-6-sol@low');
  ctx.override('A', 'qwen:qwen3-coder-plus'); // the later pending override wins
  const queued = JSON.parse(readFileSync(join(ctx.store.dir, 'control.json'), 'utf8'));
  assert.equal(queued.pendingOverrides.length, 1);
  const second = await ctx.send(ss, 'Continue the earlier work.', { round: 2, kind: 'answer' });
  assert.ok(!second.error, second.error);
  assert.equal(ss.seat.engine, 'qwen');
  assert.equal(ss.record.engine, 'qwen');
  assert.ok(ss.record.qwenSessionId);
  const qwen = calls().filter((call) => call.cli === 'qwen').at(-1);
  assert.match(qwen?.prompt || '', /completed_prior_agent_work/);
  assert.match(qwen?.prompt || '', /Round 1 \(answer\)/);
  const policy = JSON.parse(readFileSync(qwen.systemPolicy, 'utf8'));
  assert.equal(policy.tools.executionSandbox.filesystem, 'read-only');
  const recorded = JSON.parse(readFileSync(join(ctx.store.dir, 'control.json'), 'utf8'));
  assert.equal(recorded.pendingOverrides.length, 0);
  assert.deepEqual(recorded.appliedOverrides.map((o: any) => o.to), ['qwen:qwen3-coder-plus']);
  await ctx.finish('completed', { changed: true }, [ss]);
  assert.equal(ctx.store.meta.turns.length, 2);
  assert.equal(ctx.store.meta.seats.find((s) => s.id === 'A')?.engine, 'qwen');
});

test('overrides reject unknown seats and unconfigured Qwen profiles', async () => {
  const ctx = ctxFor('ask', ['claude:sonnet@low']);
  assert.throws(() => ctx.override('Z', 'qwen:qwen3-coder-plus'), /unknown or non-overridable/);
  assert.throws(() => ctx.override('A', 'qwen:qwen3-coder-plus+profile=missing'), /unknown Qwen profile/);
  assert.throws(() => ctx.override('A', 'codex:deepseek-flash+provider=deepseek'), /DeepSeek is disabled/);
  ctx.cancel();
  await ctx.fail(new Error('cancelled'), []);
});

test('Qwen continuation recovers pending instructions and a future assignment from the previous run', { skip: process.platform !== 'linux' || !existsSync('/usr/bin/bwrap') }, async () => {
  rmSync(LOG, { force: true });
  const original = ctxFor('ask', ['qwen:qwen3-coder-plus']);
  const ss = await original.engines.openSeat(original.opts.seats[0], 'participant', { system: 'Be precise', cwd: tmp });
  original.recordSeats([ss]);
  const turn = await original.send(ss, 'Remember our original decision.', { round: 1, kind: 'answer' });
  assert.ok(!turn.error, turn.error);
  original.instruct('A', 'Keep the previously established decisions.');
  original.override('A', 'claude:sonnet@low');
  await original.finish('completed', { preserved: true }, [ss]);
  let resumed: ReturnType<typeof ctxFor> | undefined;
  await continueRun(cfg, original.store.meta.id, 'Continue the original answer.', { rounds: 1, quiet: true, safe: false, onContext: (ctx) => { resumed = ctx; } });
  assert.ok(resumed);
  assert.equal(resumed.store.meta.status, 'completed');
  assert.equal(resumed.store.meta.continuedFrom, original.store.meta.id);
  const control = JSON.parse(readFileSync(join(resumed.store.dir, 'control.json'), 'utf8'));
  assert.equal(control.pending.length, 0);
  assert.equal(control.pendingOverrides.length, 0);
  assert.equal(control.appliedOverrides.at(-1).to, 'claude:sonnet@low');
  const c = calls().filter((call) => call.cli === 'claude' && call.prompt?.includes('Continue the original answer')).at(-1);
  assert.ok(c);
  assert.match(c.prompt, /Qwen answered/);
  assert.match(c.prompt, /Keep the previously established decisions/);
});

test('cancelling a paused run releases the boundary and retains a cancelled run record', { skip: process.platform !== 'linux' || !existsSync('/usr/bin/bwrap') }, async () => {
  const ctx = ctxFor('ask', ['qwen:qwen3-coder-plus']);
  ctx.pause();
  const work = ask(ctx);
  for (let i = 0; i < 100; i++) {
    if (JSON.parse(readFileSync(join(ctx.store.dir, 'control.json'), 'utf8')).state === 'paused') break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  ctx.cancel();
  await work;
  assert.equal(ctx.store.meta.status, 'cancelled');
  assert.equal(ctx.store.meta.turns.length, 0);
  assert.ok(existsSync(join(ctx.store.dir, 'control.json')));
});

test('pair: Qwen writer works in isolated worktree with an independent Claude reviewer', { skip: process.platform !== 'linux' || !existsSync('/usr/bin/bwrap') }, async () => {
  const repo = join(tmp, 'qwen-pair');
  execFileSync('git', ['init', '-q', repo]);
  writeFileSync(join(repo, 'README.md'), '# demo\n');
  execFileSync('git', ['-C', repo, 'add', '-A']);
  execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init']);
  process.env.FAKE_QWEN_WRITE = '1';
  try {
    const ctx = ctxFor('pair', ['qwen:qwen3-coder-plus', 'claude:sonnet@low'], { cwd: repo, rounds: 2, brief: 'Add a Qwen file.' });
    await pair(ctx, { isolation: 'worktree', writerAccess: 'sandboxed' });
    const ws = ctx.store.meta.workspace!;
    assert.ok(existsSync(join(ws.cwd, 'duo-qwen-fake.txt')));
    assert.ok(!existsSync(join(repo, 'duo-qwen-fake.txt')));
    assert.equal(ctx.store.meta.seats.find((s) => s.id === 'B')?.engine, 'claude');
    assert.ok(ctx.store.meta.turns.some((t) => t.seat === 'B'));
    const result = finishWorkspace(ws, 'discard', 'test');
    assert.ok(result.ok, result.message);
  } finally { delete process.env.FAKE_QWEN_WRITE; }
});

test('pair: a Qwen reviewer is read-only while a separate Codex writer owns the worktree', { skip: process.platform !== 'linux' || !existsSync('/usr/bin/bwrap') }, async () => {
  const repo = join(tmp, 'qwen-reviewer');
  execFileSync('git', ['init', '-q', repo]);
  writeFileSync(join(repo, 'README.md'), '# reviewer isolation\n');
  execFileSync('git', ['-C', repo, 'add', '-A']);
  execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init']);
  const ctx = ctxFor('pair', ['codex:gpt-6-sol@low', 'qwen:qwen3-coder-plus'], { cwd: repo, rounds: 1, brief: 'Review these changes.' });
  await pair(ctx, { isolation: 'worktree', writerAccess: 'sandboxed' });
  const reviewer = ctx.store.meta.turns.find((t) => t.seat === 'B');
  assert.ok(reviewer, 'independent Qwen review turn ran');
  const call = calls().filter((c) => c.cli === 'qwen').at(-1);
  assert.ok(call?.systemPolicy);
  const policy = JSON.parse(readFileSync(call.systemPolicy, 'utf8'));
  assert.equal(policy.tools.executionSandbox.filesystem, 'read-only');
  assert.ok(call?.args.includes('--exclude-tools'));
  assert.ok(call?.args.includes('--safe-mode'));
  const result = finishWorkspace(ctx.store.meta.workspace!, 'discard', 'test');
  assert.ok(result.ok, result.message);
});

test('review: Qwen performs independent Review without write permission', { skip: process.platform !== 'linux' || !existsSync('/usr/bin/bwrap') }, async () => {
  const repo = join(tmp, 'qwen-independent-review');
  execFileSync('git', ['init', '-q', repo]);
  writeFileSync(join(repo, 'README.md'), '# before\n');
  execFileSync('git', ['-C', repo, 'add', '-A']);
  execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init']);
  writeFileSync(join(repo, 'README.md'), '# after\n');
  const ctx = ctxFor('review', ['qwen:qwen3-coder-plus', 'codex:gpt-6-sol@low'], { cwd: repo, rounds: 1 });
  const report = await review(ctx, { kind: 'uncommitted' });
  assert.equal(ctx.store.meta.status, 'completed');
  assert.ok(ctx.store.meta.turns.some((t) => t.seat === 'A' && t.kind === 'review'));
  assert.match(report, /Review|review/i);
  const call = calls().filter((c) => c.cli === 'qwen' && c.cwd === repo).at(-1);
  assert.ok(call?.systemPolicy);
  const policy = JSON.parse(readFileSync(call.systemPolicy, 'utf8'));
  assert.equal(policy.tools.executionSandbox.filesystem, 'read-only');
  assert.equal(readFileSync(join(repo, 'README.md'), 'utf8'), '# after\n');
});

test('debate: each turn records only its own tool calls (no carry-over from the previous turn)', async () => {
  const ctx = ctxFor('debate', ['codex:gpt-6-sol@high', 'claude:sonnet@low'], { rounds: 2 });
  await debate(ctx);
  const m = ctx.store.meta;
  const codexTurns = m.turns.filter((t) => t.seat === 'A');
  assert.equal(codexTurns.length, 3, 'two discussion rounds and a final ledger review');
  for (const t of codexTurns) {
    const tools = JSON.parse(readFileSync(join(ctx.store.dir, t.dir, 'tools.json'), 'utf8'));
    assert.equal(tools.length, 1, `turn ${t.n} has exactly its own one command`);
  }
});

test('a Codex reconnect is a warning, not an error', async () => {
  process.env.FAKE_CODEX_MODE = 'reconnect';
  try {
    const ctx = ctxFor('ask', ['codex:gpt-6-sol@low']);
    await ask(ctx);
    const t = ctx.store.meta.turns[0];
    assert.equal(t.error, undefined);
    assert.match(t.warnings?.[0] ?? '', /Reconnecting/);
  } finally {
    delete process.env.FAKE_CODEX_MODE;
  }
});

test('a fatal seat error stops the run at once instead of letting the other seat burn quota', async () => {
  process.env.FAKE_CLAUDE_MODE = 'old';
  process.env.FAKE_CODEX_MODE = 'slow';
  try {
    const started = Date.now();
    const ctx = ctxFor('debate', ['codex:gpt-6-sol@high', 'claude:opus@high'], { rounds: 3 });
    await debate(ctx);
    const m = ctx.store.meta;
    assert.ok(Date.now() - started < 15_000, 'the slow Codex turn was stopped, not waited for');
    assert.equal(m.status, 'failed');
    assert.match(String(m.outcome?.stop), /or newer is required/);
    assert.match(String(m.outcome?.stop), /Update Claude Code/);
    assert.equal(m.turns.filter((t) => t.kind.endsWith('-retry')).length, 0, 'no pointless retry');
  } finally {
    delete process.env.FAKE_CLAUDE_MODE;
    delete process.env.FAKE_CODEX_MODE;
  }
});

test('a Claude process that died between turns is restarted on the same conversation', async () => {
  process.env.FAKE_CLAUDE_MODE = 'die-after-1';
  try {
    const ctx = ctxFor('debate', ['claude:sonnet@low', 'codex:gpt-6-sol@low'], { rounds: 2 });
    await debate(ctx);
    const m = ctx.store.meta;
    const claudeTurns = m.turns.filter((t) => t.seat === 'A');
    assert.equal(claudeTurns.length, 3, 'the recovered conversation also completes its ledger review');
    assert.ok(claudeTurns.every((t) => !t.error), JSON.stringify(claudeTurns.map((t) => t.error)));
    const resumed = calls().filter((c) => c.cli === 'claude' && c.args?.includes('--resume'));
    assert.ok(resumed.length >= 1, 'restarted with --resume');
  } finally {
    delete process.env.FAKE_CLAUDE_MODE;
  }
});

test('pair: the writer works in a worktree, the reviewer approves, and Apply brings the change home', async () => {
  const repo = join(tmp, 'repo');
  execFileSync('git', ['init', '-q', repo]);
  writeFileSync(join(repo, 'README.md'), '# demo\n');
  execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A']);
  execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init']);
  const ctx = ctxFor('pair', ['codex:gpt-6-sol@high', 'claude:opus@high'], { cwd: repo, rounds: 3, brief: 'Add a file that says hello.' });
  await pair(ctx, { isolation: 'worktree', writerAccess: 'sandboxed' });
  const m = ctx.store.meta;
  assert.equal(m.status, 'completed', String(m.outcome?.stop));
  assert.equal(m.outcome?.converged, true, String(m.outcome?.stop));
  const ws = m.workspace!;
  assert.equal(ws.mode, 'worktree');
  const same = (a: string, b: string) => realpathSync.native(a).toLowerCase() === realpathSync.native(b).toLowerCase();
  assert.ok(same(ws.cwd, ws.path), 'selecting the repository root keeps the writer at the worktree root');
  const writerCall = calls().find((c) => c.cli === 'codex' && c.cwd && existsSync(c.cwd) && same(c.cwd, ws.cwd));
  assert.ok(writerCall, `the writer ran in the worktree: ${JSON.stringify({ workspace: ws, calls: calls().slice(-2) })}`);
  assert.ok(existsSync(join(ws.path, 'duo-fake.txt')), `the writer wrote inside the worktree: ${JSON.stringify({ workspace: ws, args: writerCall.args })}`);
  assert.ok(!existsSync(join(repo, 'duo-fake.txt')), 'the user folder is untouched until Apply');
  const r = finishWorkspace(ws, 'apply', m.title);
  assert.ok(r.ok, r.message);
  assert.ok(existsSync(join(repo, 'duo-fake.txt')), 'applied to the user folder');
  assert.ok(!existsSync(ws.path), 'the worktree is gone');
});

test('continued ask and debate runs retain their template snapshot and model sessions', async () => {
  const { continueRun } = await import('../src/protocols/continue.ts');
  for (const protocol of ['ask', 'debate']) {
    const ctx = ctxFor(protocol, ['codex:gpt-6-sol@low', 'claude:sonnet@low']);
    if (protocol === 'ask') await ask(ctx); else await debate(ctx);
    let next: ReturnType<typeof RunContext.create> | undefined;
    await continueRun(cfg, ctx.store.meta.id, 'Focus on the unresolved constraint', { rounds: 2, quiet: true, safe: false, onContext: (c) => { next = c; } });
    assert.equal(next!.store.meta.status, 'completed');
    assert.deepEqual(next!.store.meta.options.template, ctx.store.meta.options.template);
    for (const seat of ctx.store.meta.seats.filter((s) => s.role === 'participant')) {
      const resumed = next!.store.meta.seats.find((s) => s.id === seat.id && s.role === 'participant')!;
      assert.equal(resumed.codexThreadId, seat.codexThreadId); assert.equal(resumed.claudeSessionId, seat.claudeSessionId);
    }
    assert.ok(next!.store.meta.turns[0].round > ctx.store.meta.turns[0].round);
  }
});
test('a copied pair template continues on the same workspace with the same definition', async () => {
  const { continueRun } = await import('../src/protocols/continue.ts');
  const { builtinTemplate } = await import('../src/templates/builtins.ts');
  const repo = join(tmp, 'continued-pair');
  execFileSync('git', ['init', '-q', repo]); writeFileSync(join(repo, 'README.md'), '# demo\n');
  execFileSync('git', ['-C', repo, 'add', '-A']);
  execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init']);
  const ctx = ctxFor('pair', ['codex:gpt-6-sol@low', 'claude:sonnet@low'], { cwd: repo, rounds: 1 });
  ctx.opts.extra.template = { ...builtinTemplate('pair'), id: 'pair-copy' };
  await pair(ctx, { isolation: 'worktree', writerAccess: 'sandboxed' });
  let next: ReturnType<typeof RunContext.create> | undefined;
  await continueRun(cfg, ctx.store.meta.id, 'Check the existing implementation again', { rounds: 1, quiet: true, safe: false, onContext: (c) => { next = c; } });
  assert.equal(next!.store.meta.status, 'completed');
  assert.deepEqual(next!.store.meta.options.template, ctx.store.meta.options.template);
  assert.equal(next!.store.meta.workspace!.path, ctx.store.meta.workspace!.path);
  assert.equal(next!.store.meta.turns[0].round, 2);
  const result = finishWorkspace(next!.store.meta.workspace!, 'discard', next!.store.meta.title); assert.ok(result.ok, result.message);
});
