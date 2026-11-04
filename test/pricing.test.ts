/**
 * Pricing: the Codex credit registry, Claude's per-turn API-equivalent cost, and how a turn
 * without a price is recorded, totalled and reported. Fake CLIs and stubs only: no model calls.
 */
import assert from 'node:assert/strict';
import { readFileSync, realpathSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'duo-pricing-')));
Object.assign(process.env, {
  DUO_HOME: join(tmp, 'home'), DUO_CONFIG: join(tmp, 'config.json'), CODEX_HOME: join(tmp, 'codex-home'), CLAUDE_CONFIG_DIR: join(tmp, 'claude-home'),
  DUO_CODEX_BIN: join(import.meta.dirname, 'fakes', 'codex.mjs'), DUO_CLAUDE_BIN: join(import.meta.dirname, 'fakes', 'claude.mjs'),
});
delete process.env.DUO_DEPTH;
const { CODEX_RATES, canonicalCodexModel, codexCredits, codexPrice, codexRate, knownCodexRates } = await import('../src/pricing.ts');
const { claudeTurnCost, parseClaudeStream } = await import('../src/tap.ts');
const { costText, usageSection } = await import('../src/render.ts');
after(() => rmSync(tmp, { recursive: true, force: true }));

const M = 1_000_000;

// The published Standard credit rates (input / cached input / output per 1M tokens). Changing one
// should be a deliberate edit to both the registry and this list.
const PUBLISHED: Record<string, [number, number, number]> = {
  'gpt-6-astra': [250, 25, 1250],
  'gpt-6.1-sol': [50, 2.5, 250],
  'gpt-6.1-terra': [25, 1.25, 125],
  'gpt-6-sol': [50, 5, 250],
  'gpt-6-luna': [2.5, 0.25, 12.5],
  'gpt-5.6-sol': [100, 10, 500],
  'gpt-5.6-terra': [50, 5, 300],
  'gpt-5.6-luna': [5, 0.5, 30],
  'gpt-5.5': [125, 12.5, 750],
};

test('every Codex model in the registry has its published rate and a source', () => {
  assert.deepEqual(Object.keys(CODEX_RATES).sort(), Object.keys(PUBLISHED).sort());
  for (const [model, [input, cached, output]] of Object.entries(PUBLISHED)) {
    const r = codexRate(model);
    assert.deepEqual(r && [r.input, r.cached, r.output], [input, cached, output], model);
    assert.ok(r!.source.length > 10, `${model} names where its rate comes from`);
    // 1M of each kind of token costs exactly the published figures.
    assert.equal(codexCredits(model, { input: 2 * M, cached: M, output: M, reasoning: 0 }), input + cached + output, model);
  }
  assert.deepEqual(knownCodexRates()['gpt-6.1-terra'], [25, 1.25, 125]);
});

test('GPT-6.1 Sol and Terra use their own rates, not GPT-5.x ones', () => {
  const u = { input: M, cached: 0, output: M, reasoning: 0 };
  assert.equal(codexCredits('gpt-6.1-sol', u), 300);
  assert.equal(codexCredits('gpt-6.1-terra', u), 150, 'Terra used to have no price at all');
  for (const old of ['gpt-5.5', 'gpt-5.6-sol', 'gpt-5.6-terra']) {
    assert.notEqual(codexCredits('gpt-6.1-sol', u), codexCredits(old, u));
    assert.notEqual(codexCredits('gpt-6.1-terra', u), codexCredits(old, u));
  }
});

test('model ids resolve through case, an openai/ prefix and a dated snapshot, and nothing looser', () => {
  assert.equal(canonicalCodexModel(' OpenAI/GPT-6.1-Sol '), 'gpt-6.1-sol');
  assert.equal(codexRate('GPT-6.1-Terra')?.input, 25);
  assert.equal(codexRate('openai/gpt-6-luna')?.output, 12.5);
  assert.equal(codexRate('gpt-6.1-sol-2026-09-30')?.cached, 2.5);
  assert.equal(codexRate('gpt-6.1-sol-mini'), undefined, 'a variant is a different model');
  assert.equal(codexRate('gpt-6.1'), undefined);
});

test('newer, unknown or variant models are unpriced instead of borrowing an older rate', () => {
  const u = { input: M, cached: 0, output: M, reasoning: 0 };
  // Each of these used to resolve to a neighbour's rate (or to nothing) without saying so.
  for (const model of ['gpt-6.2-sol', 'gpt-6.2-luna', 'gpt-6-sol-mini', 'gpt-5.7-terra', 'gpt-7-sol', 'gpt-5.5-pro', 'o9-mini', '']) {
    assert.equal(codexRate(model), undefined, model);
    const p = codexPrice(model, u);
    assert.equal(p.credits, undefined, model);
    assert.match(p.unpriced!, /no published Codex credit rate/, model);
  }
});

test('credits count fresh input, cached input and output at their own rates', () => {
  // gpt-6-sol: 50 / 5 / 250. Codex reports input including the cached part.
  assert.equal(codexCredits('gpt-6-sol', { input: 1_000_000, cached: 400_000, output: 50_000, reasoning: 10_000 }), (600_000 * 50 + 400_000 * 5 + 50_000 * 250) / M);
  assert.equal(codexCredits('gpt-6-sol', { input: 0, cached: 0, output: 0, reasoning: 0 }), 0);
  // A cached count above input (rounding in a report) never makes fresh input negative.
  assert.equal(codexCredits('gpt-6-sol', { input: 100, cached: 200, output: 0, reasoning: 0 }), (200 * 5) / M);
});

test('service tiers: Fast doubles, Ultrafast is 6x, an unknown tier is unpriced', () => {
  const u = { input: M, cached: 0, output: 0, reasoning: 0 };
  assert.equal(codexCredits('gpt-6.1-sol', u), 50);
  for (const tier of ['', 'default', 'standard', 'auto']) assert.equal(codexCredits('gpt-6.1-sol', u, tier), 50, tier);
  for (const tier of ['fast', 'priority', 'Fast']) assert.equal(codexCredits('gpt-6.1-sol', u, tier), 100, tier);
  assert.equal(codexCredits('gpt-6.1-sol', u, 'ultrafast'), 300, 'used to be charged at the Standard rate');
  assert.match(codexPrice('gpt-6.1-sol', u, 'flex').unpriced!, /unknown Codex service tier "flex"/);
});

// ── Claude: the CLI prices its own calls; duo takes each turn's share ────────

const result = (o: Record<string, unknown>) => ({ type: 'result', subtype: 'success', is_error: false, result: 'ok', usage: { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 5 }, ...o });

test('a Claude turn costs what the CLI states for that result, subagents and cache writes included', () => {
  const ev = result({
    total_cost_usd: 9.99, // a running total; not this turn's cost
    model_usage_since_last_result: {
      'claude-opus-5-5': { inputTokens: 1000, outputTokens: 200, cacheReadInputTokens: 5000, cacheCreationInputTokens: 300, thinkingTokens: 50, costUSD: 0.02, costBasis: 'list', canonicalModel: 'claude-opus-5-5' },
      'claude-haiku-5-5': { inputTokens: 400, outputTokens: 100, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.001, costBasis: 'list' },
    },
  });
  const c = claudeTurnCost(ev);
  assert.equal(c.unpriced, undefined);
  assert.ok(Math.abs(c.usd! - 0.021) < 1e-12);
  assert.deepEqual(c.usage, { input: 1000 + 5000 + 300 + 400, cached: 5000, output: 300, reasoning: 50 });
  assert.deepEqual(claudeTurnCost(result({ model_usage_since_last_result: {} })), { usd: 0, usage: { input: 0, cached: 0, output: 0, reasoning: 0 } });
});

test('a Claude model the CLI has no price for is unpriced, not shown at its default model\'s rate', () => {
  const delta = { 'claude-sonnet-9': { inputTokens: 10, outputTokens: 5, costUSD: 0.5, costBasis: 'unknown', canonicalModel: 'claude-sonnet-9' } };
  const c = claudeTurnCost(result({ total_cost_usd: 0.5, model_usage_since_last_result: delta }));
  assert.equal(c.usd, undefined);
  assert.match(c.unpriced!, /no price for claude-sonnet-9/);
  // Older CLIs without the per-result field: costBasis on the running totals is still the latest request's.
  assert.match(claudeTurnCost(result({ total_cost_usd: 0.5, modelUsage: delta })).unpriced!, /claude-sonnet-9/);
  assert.deepEqual(claudeTurnCost(result({ total_cost_usd: 0.5, modelUsage: { m: { costUSD: 0.5, costBasis: 'list' } } })), {});
});

test('a captured real Claude stream still parses to its CLI-reported cost', () => {
  const raw = readFileSync(join(import.meta.dirname, 'fixtures', 'claude-stream.jsonl'), 'utf8');
  const t = parseClaudeStream(raw);
  assert.equal(t.costUsd, 0.0412356);
  assert.deepEqual(t.turn, {}, 'this older capture has no per-result field, so the running total is used');
  assert.deepEqual(t.usage, { input: 18 + 13564 + 13046, cached: 13046, output: 2557, reasoning: 0 });
});

// Two CLI processes: the second (after the model switch) starts its running total again, and its
// first turn costs more than everything before it. Returns each turn's recorded cost.
async function chatCostsAcrossModelSwitch(legacy: boolean): Promise<number[]> {
  const { ChatManager } = await import('../src/server/chats.ts');
  const { PermissionBroker } = await import('../src/server/permissions.ts');
  const { loadConfig } = await import('../src/config.ts');
  const bus = { emit: () => undefined, add: () => undefined } as any;
  const bin = { command: process.execPath, args: [], env: {}, display: 'node' };
  const cm = new ChatManager(bus, loadConfig(), { codex: bin, claude: bin }, new PermissionBroker(bus), { url: 'http://127.0.0.1:1', token: 't' }, 'mcp.ts');
  const manager = (cm as any).manager;
  await manager.shutdown();
  const chat = cm.create({ engine: 'claude', cwd: tmp });
  const costs = [0.01, 0.01, 0.05, 0.01];
  const totals = [0.01, 0.02, 0.05, 0.06];
  let i = 0;
  Object.assign(manager, {
    startSession: async () => ({}), hasSession: () => true, stopSession: async () => undefined, shutdown: async () => undefined,
    sendMessage: async () => {
      (cm as any).onLine(chat.id, JSON.stringify({ type: 'assistant', message: { id: `m${i}`, content: [{ type: 'text', text: 'answer' }] } }));
      const delta = { 'claude-opus-5-5': { inputTokens: 10, outputTokens: 5, costUSD: costs[i], costBasis: 'list' } };
      (cm as any).onLine(chat.id, JSON.stringify(result({ total_cost_usd: totals[i++], ...(legacy ? {} : { model_usage_since_last_result: delta }) })));
      return {};
    },
  });
  const run = async (text: string) => {
    const turn = cm.send(chat.id, text);
    while (turn.status === 'running') await new Promise((r) => setTimeout(r, 5));
    return turn;
  };
  await run('one');
  await run('two');
  cm.update(chat.id, { spec: 'claude:sonnet' });
  for (const text of ['three', 'four']) await run(text);
  await cm.close();
  return cm.get(chat.id).turns.map((t) => Math.round(t.usd! * 1000) / 1000);
}

test('chat turns keep the right Claude cost after a model switch restarts the CLI', async () => {
  assert.deepEqual(await chatCostsAcrossModelSwitch(false), [0.01, 0.01, 0.05, 0.01]);
  // Older CLIs state only running totals; differencing them misprices the restarted process's
  // first turn (0.03 instead of 0.05). This is the fallback, and why the per-result field wins.
  assert.deepEqual(await chatCostsAcrossModelSwitch(true), [0.01, 0.01, 0.03, 0.01]);
});

test('a run with an unpriced Codex model and an unpriced Claude model says so in records, totals and report', async () => {
  const { loadConfig } = await import('../src/config.ts');
  const { RunContext } = await import('../src/protocols/common.ts');
  const { ask } = await import('../src/protocols/ask.ts');
  const { parseSeat } = await import('../src/seats.ts');
  const { RunStore } = await import('../src/store.ts');
  const cfg = loadConfig();
  process.env.FAKE_CLAUDE_MODE = 'unknown-price';
  try {
    const seats = ['codex:gpt-6.2-sol', 'claude:sonnet', 'codex:gpt-6.1-terra'].map((s, i) => parseSeat(s, String.fromCharCode(65 + i), cfg.defaults));
    const ctx = RunContext.create(cfg, { protocol: 'ask', title: 'pricing', brief: 'What is 2+2?', cwd: tmp, seats, rounds: 1, minRounds: 1, anon: false, quiet: true, extra: {} });
    await ask(ctx);
    const meta = RunStore.open(ctx.store.meta.id).meta; // as persisted
    const bySeat = Object.fromEntries(meta.turns.map((t) => [t.seat, t]));
    assert.equal(bySeat.A.codexCredits, undefined);
    assert.match(bySeat.A.unpriced!, /gpt-6\.2-sol/);
    assert.equal(bySeat.B.usd, undefined);
    assert.match(bySeat.B.unpriced!, /no price for claude-fake/);
    // The fake Codex reports 1000 input (400 cached) and 50 output tokens.
    assert.equal(bySeat.C.codexCredits, (600 * 25 + 400 * 1.25 + 50 * 125) / M);
    assert.equal(bySeat.C.unpriced, undefined);
    assert.equal(meta.totals!.unpricedTurns, 2);
    assert.equal(meta.totals!.codexCredits, Math.round(bySeat.C.codexCredits! * 1000) / 1000);
    assert.equal(meta.totals!.usd, 0, 'a guessed Claude cost is not counted');
    assert.equal(costText(bySeat.A), 'no price');
    const report = usageSection(meta);
    assert.match(report, /without a price/);
    assert.match(report, /no published Codex credit rate for gpt-6\.2-sol/);
    assert.match(report, /API-equivalent estimates, not subscription charges/);
  } finally {
    delete process.env.FAKE_CLAUDE_MODE;
  }
});

test('the fake Claude CLI without per-result usage still prices turns from its running total', async () => {
  const { loadConfig } = await import('../src/config.ts');
  const { RunContext } = await import('../src/protocols/common.ts');
  const { ask } = await import('../src/protocols/ask.ts');
  const { parseSeat } = await import('../src/seats.ts');
  const cfg = loadConfig();
  process.env.FAKE_CLAUDE_MODE = 'legacy-cost';
  try {
    const ctx = RunContext.create(cfg, { protocol: 'ask', title: 'legacy', brief: 'Hi', cwd: tmp, seats: [parseSeat('claude:sonnet', 'A', cfg.defaults)], rounds: 1, minRounds: 1, anon: false, quiet: true, extra: {} });
    await ask(ctx);
    assert.equal(ctx.store.meta.turns[0].usd, 0.01);
    assert.equal(ctx.store.meta.turns[0].unpriced, undefined);
  } finally {
    delete process.env.FAKE_CLAUDE_MODE;
  }
});

// ── Accounting across turns, processes and runs ─────────────────────────────

/** Run with extra environment set for the fake CLIs, and restore it afterwards. */
async function withEnv<T>(env: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
}

async function runDebate(specs: string[], rounds = 2) {
  const { loadConfig } = await import('../src/config.ts');
  const { RunContext } = await import('../src/protocols/common.ts');
  const { debate } = await import('../src/protocols/debate.ts');
  const { parseSeat } = await import('../src/seats.ts');
  const cfg = loadConfig();
  const seats = specs.map((s, i) => parseSeat(s, String.fromCharCode(65 + i), cfg.defaults));
  const ctx = RunContext.create(cfg, { protocol: 'debate', title: 'accounting', brief: 'Which is larger, 2 or 3?', cwd: tmp, seats, rounds, minRounds: rounds, anon: false, quiet: true, extra: {} });
  await debate(ctx);
  return ctx;
}

// The fake Codex turn: 1000 input (400 cached), 50 output, 10 reasoning.
const FAKE_TURN = { input: 1000, cached: 400, output: 50, reasoning: 10 };
const credits = (model: string, mult = 1) => ((600 * CODEX_RATES[model].input + 400 * CODEX_RATES[model].cached + 50 * CODEX_RATES[model].output) / M) * mult;
const close = (a: number | undefined, b: number) => assert.ok(a !== undefined && Math.abs(a - b) < 1e-9, `${a} ≠ ${b}`);

test('Codex running totals become per-turn usage and credits over several turns, at each tier', async () => {
  const ctx = await withEnv({ FAKE_CODEX_USAGE: 'cumulative' }, () => runDebate(['codex:gpt-6.1-sol+fast', 'codex:gpt-6.1-terra+tier=ultrafast']));
  const turns = ctx.store.meta.turns;
  for (const seat of ['A', 'B']) assert.ok(turns.filter((t) => t.seat === seat).length >= 3, `seat ${seat} took several turns`);
  for (const t of turns) {
    assert.deepEqual(t.usage, FAKE_TURN, `${t.seat} ${t.kind}: each turn reports its own share of the thread's total`);
    close(t.codexCredits, t.seat === 'A' ? credits('gpt-6.1-sol', 2) : credits('gpt-6.1-terra', 6));
  }
  close(ctx.store.meta.totals!.codexCredits, Math.round(turns.reduce((a, t) => a + t.codexCredits!, 0) * 1000) / 1000);
});

test('a continued run carries the Codex running total, so its first turn is not billed for the earlier ones', async () => {
  const { continueRun } = await import('../src/protocols/continue.ts');
  const { loadConfig } = await import('../src/config.ts');
  await withEnv({ FAKE_CODEX_USAGE: 'cumulative' }, async () => {
    const first = await runDebate(['codex:gpt-6-sol', 'claude:sonnet'], 1);
    let next: any;
    await continueRun(loadConfig(), first.store.meta.id, 'Once more', { rounds: 1, quiet: true, safe: false, onContext: (c) => { next = c; } });
    const codexTurns = next.store.meta.turns.filter((t: any) => t.seat === 'A');
    assert.ok(codexTurns.length >= 1);
    for (const t of codexTurns) {
      assert.deepEqual(t.usage, FAKE_TURN);
      close(t.codexCredits, credits('gpt-6-sol'));
    }
  });
});

test('a Claude CLI that dies between turns is restarted without mispricing the next turn', async () => {
  const ctx = await withEnv({ FAKE_CLAUDE_MODE: 'die-after-1' }, () => runDebate(['codex:gpt-6-sol', 'claude:sonnet']));
  const claude = ctx.store.meta.turns.filter((t) => t.seat === 'B');
  assert.ok(claude.length >= 2);
  // Each restarted process starts its running total again; the per-result figure stays right.
  for (const t of claude) {
    assert.equal(t.usd, 0.01, t.kind);
    assert.deepEqual(t.usage, { input: 150, cached: 50, output: 20, reasoning: 0 });
  }
});

/** A chat whose CLI is replaced by events the test writes; returns the chat manager and a turn runner. */
async function scriptedChat(engine: 'claude' | 'codex', spec: string, events: (turn: number) => Record<string, unknown>[]) {
  const { ChatManager } = await import('../src/server/chats.ts');
  const { PermissionBroker } = await import('../src/server/permissions.ts');
  const { loadConfig } = await import('../src/config.ts');
  const bus = { emit: () => undefined, add: () => undefined } as any;
  const bin = { command: process.execPath, args: [], env: {}, display: 'node' };
  const cm = new ChatManager(bus, loadConfig(), { codex: bin, claude: bin }, new PermissionBroker(bus), { url: 'http://127.0.0.1:1', token: 't' }, 'mcp.ts');
  const manager = (cm as any).manager;
  await manager.shutdown();
  const chat = cm.create({ engine, cwd: tmp, spec, access: engine === 'codex' ? 'read-only' : 'plan' });
  let n = 0;
  Object.assign(manager, {
    startSession: async () => ({}), hasSession: () => true, stopSession: async () => undefined, shutdown: async () => undefined,
    sendMessage: async () => {
      n++;
      for (const e of events(n)) (cm as any).onLine(chat.id, JSON.stringify(e));
      return {};
    },
  });
  const send = async (text: string) => {
    const turn = cm.send(chat.id, text);
    while (turn.status === 'running') await new Promise((r) => setTimeout(r, 5));
    return turn;
  };
  return { cm, chat, send };
}

test('Codex chats price each turn\'s share of the thread total at that turn\'s model and tier', async () => {
  const codexTurn = (n: number) => [
    { type: 'thread.started', thread_id: 'thread-1' },
    { type: 'item.completed', item: { id: `m${n}`, type: 'agent_message', text: `answer ${n}` } },
    { type: 'turn.completed', usage: { input_tokens: 1000 * n, cached_input_tokens: 400 * n, output_tokens: 50 * n, reasoning_output_tokens: 10 * n } },
  ];
  const { cm, chat, send } = await scriptedChat('codex', 'codex:gpt-6-sol', codexTurn);
  await send('one');
  await send('two');
  cm.update(chat.id, { spec: 'codex:gpt-6.1-sol+fast' }); // same thread, another model and tier
  await send('three');
  cm.update(chat.id, { spec: 'codex:gpt-7-sol' }); // a model with no published rate
  await send('four');
  const turns = cm.get(chat.id).turns;
  for (const t of turns) assert.deepEqual(t.usage, FAKE_TURN);
  close(turns[0].credits, credits('gpt-6-sol'));
  close(turns[1].credits, credits('gpt-6-sol'));
  close(turns[2].credits, credits('gpt-6.1-sol', 2));
  assert.equal(turns[3].credits, undefined);
  assert.match(turns[3].unpriced!, /gpt-7-sol/);
  await cm.close();
});

test('a Claude chat turn the CLI could not price is saved as unpriced, not at the guessed rate', async () => {
  const { cm, chat, send } = await scriptedChat('claude', 'claude:fable', () => [
    { type: 'assistant', message: { id: 'm', content: [{ type: 'text', text: 'answer' }] } },
    result({ total_cost_usd: 0.4, model_usage_since_last_result: { 'claude-fable-9': { inputTokens: 10, outputTokens: 5, costUSD: 0.4, costBasis: 'unknown' } } }),
  ]);
  const turn = await send('hello');
  assert.equal(turn.status, 'done');
  assert.equal(turn.usd, undefined);
  assert.match(turn.unpriced!, /no price for claude-fable-9/);
  const saved = JSON.parse(readFileSync(join(tmp, 'home', 'gui', 'chats', `${chat.id}.json`), 'utf8'));
  assert.equal(saved.turns[0].usd, undefined);
  assert.match(saved.turns[0].unpriced, /claude-fable-9/);
  await cm.close();
});

test('a turn with no tokens costs zero when the model has a rate, and nothing (not "no price") when it does not', () => {
  const none = { input: 0, cached: 0, output: 0, reasoning: 0 };
  assert.deepEqual(codexPrice('gpt-6-sol', none), { credits: 0 });
  assert.equal(costText({ codexCredits: 0 }), '0.00 cr', 'free is shown as zero, not hidden');
  assert.equal(costText({ codexCredits: undefined, usd: undefined }), '');
  assert.equal(costText({ unpriced: 'no published Codex credit rate for x' }), 'no price');
  assert.equal(costText({ usd: 0 }), '~$0.000');
});

test('claw-orchestrator\'s own price-table warning is dropped; other warnings still print', async () => {
  const { codexRoute, dropCodexRoute } = await import('../src/hooks.ts');
  dropCodexRoute(codexRoute('quiet-test', { bin: { command: 'x', args: [], env: {}, display: 'x' }, overrides: [], ignoreRules: false })); // installs the hook
  const seen: unknown[][] = [];
  const original = console.warn;
  // The filter wraps whatever console.warn was when it was installed; observe through stderr instead.
  const write = process.stderr.write.bind(process.stderr);
  (process.stderr as any).write = (chunk: unknown, ...rest: unknown[]) => { seen.push([String(chunk)]); return true; };
  try {
    console.warn('[models] Unknown model "gpt-6.1-sol" — falling back to gpt-5.5 pricing');
    console.warn('[models] Partial pricing override for unregistered model "x"');
    console.warn('something else');
  } finally {
    (process.stderr as any).write = write;
    console.warn = original;
  }
  const out = seen.map((s) => s[0]).join('');
  assert.doesNotMatch(out, /falling back to gpt-5\.5 pricing/);
  assert.match(out, /Partial pricing override/);
  assert.match(out, /something else/);
});
