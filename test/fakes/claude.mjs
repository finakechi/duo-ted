#!/usr/bin/env node
// Stand-in for Claude Code's `-p --input-format stream-json --output-format stream-json` in tests.
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { instance, record, valueOf } from './common.mjs';

const args = process.argv.slice(2);
if (args[0] === '--version') {
  // FAKE_CLAUDE_VERSION_MS: a CLI slow to start (Node-based installs can take a while).
  await new Promise((r) => setTimeout(r, Number(process.env.FAKE_CLAUDE_VERSION_MS ?? 0)));
  console.log('2.1.999 (Claude Code)');
  process.exit(0);
}
if (args[0] === 'auth') {
  console.log(JSON.stringify({ loggedIn: true, authMethod: 'fake' }));
  process.exit(0);
}
if (args[0] === 'update') {
  record({ cli: 'claude', action: 'update' });
  await new Promise((r) => setTimeout(r, Number(process.env.FAKE_CLAUDE_UPDATE_MS ?? 0)));
  console.log('Fake Claude updated');
  process.exit(0);
}
const sid = valueOf(args, '--session-id') ?? valueOf(args, '--resume') ?? 'fake-session';
const schema = valueOf(args, '--json-schema');
const mode = process.env.FAKE_CLAUDE_MODE ?? '';
record({ cli: 'claude', args, cwd: process.cwd() });
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
out({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-fake' });

let turns = 0;
let cost = 0;
for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  const msg = JSON.parse(line);
  if (msg.type !== 'user') continue;
  turns++;
  const prompt = (msg.message?.content ?? []).map((c) => c.text ?? '').join('');
  record({ cli: 'claude', turn: turns, session: sid, prompt });
  if (mode === 'old') {
    out({ type: 'result', subtype: 'success', is_error: true, result: "API Error: 400 Claude Code 2.1.259 does not support this model; version 2.1.280 or newer is required. Run 'claude update', or update the Claude desktop app, then try again.", session_id: sid, user_message_uuids: [msg.uuid], usage: {}, total_cost_usd: 0 });
    continue;
  }
  const text = `claude answer ${turns}: ${prompt.length} chars`;
  out({ type: 'stream_event', event: { type: 'message_start', message: { id: `m${turns}` } } });
  out({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
  out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } });
  out({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } });
  out({ type: 'assistant', message: { id: `m${turns}`, content: [{ type: 'text', text }] }, session_id: sid });
  cost += 0.01;
  const outputSchema = schema ? JSON.parse(schema) : undefined;
  const structured = outputSchema?.properties?.templateJson && process.env.FAKE_TEMPLATE_FILE ? {
    templateJson: process.env.FAKE_TEMPLATE_INVALID_FIRST && !/draft failed validation/i.test(prompt) ? '{}' : readFileSync(process.env.FAKE_TEMPLATE_FILE, 'utf8'),
    explanation: 'A validated fake draft',
  } : schema ? instance(outputSchema, { answer: text }) : undefined;
  out({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.1, resetsAt: Math.floor(Date.now() / 1000) + 3600 } } } });
  // Like Claude Code: running totals for this process, plus (on current versions) this result's own
  // share. FAKE_CLAUDE_MODE=legacy-cost leaves the per-result share out, as older versions do;
  // unknown-price marks the model as one the CLI has no price for.
  const basis = mode === 'unknown-price' ? 'unknown' : 'list';
  const perTurn = { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 50, cacheCreationInputTokens: 0, costUSD: 0.01, costBasis: basis, canonicalModel: 'claude-fake' };
  const totals = { ...perTurn, inputTokens: 100 * turns, outputTokens: 20 * turns, cacheReadInputTokens: 50 * turns, costUSD: cost };
  out({
    type: 'result', subtype: 'success', is_error: false, result: structured ? JSON.stringify(structured) : text, structured_output: structured, session_id: sid, user_message_uuids: [msg.uuid],
    usage: { input_tokens: 100, cache_read_input_tokens: 50, cache_creation_input_tokens: 0, output_tokens: 20 }, total_cost_usd: cost,
    modelUsage: { 'claude-fake': totals },
    ...(mode === 'legacy-cost' ? {} : { model_usage_since_last_result: { 'claude-fake': perTurn } }),
  });
  // Simulate a CLI that goes away between turns (crash, update, laptop sleep).
  if (mode === 'die-after-1' && !args.includes('--resume')) process.exit(0);
}
