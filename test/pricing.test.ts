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
