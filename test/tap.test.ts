import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { extractJson, looksLikeContextTruncation, parseClaudeStream, parseCodexStream, parseQwenStream } from '../src/tap.ts';

const fx = (f: string) => readFileSync(join(import.meta.dirname, 'fixtures', f), 'utf8');

test('codex exec --json stream (real capture)', () => {
  const t = parseCodexStream(fx('codex-stream.jsonl'));
  assert.match(t.threadId ?? '', /^[0-9a-f-]{36}$/);
  assert.ok(t.usage && t.usage.input > 0 && t.usageIsCumulative);
  assert.ok(t.tools.length > 0 && t.tools.every((x) => x.name === 'shell'));
  const parsed = extractJson(t.reply) as { answer: string };
  assert.equal(typeof parsed.answer, 'string');
});

test('claude stream-json slice (real capture)', () => {
  const t = parseClaudeStream(fx('claude-stream.jsonl'));
  assert.match(t.sessionId ?? '', /^[0-9a-f-]{36}$/);
  assert.ok(t.rateLimits, 'rate_limit_event captured');
  assert.ok(t.usage && t.usage.input > 0 && !t.usageIsCumulative);
  assert.equal(typeof (t.structured as { answer?: string })?.answer, 'string');
  assert.ok(t.tools.length > 0 && t.tools.every((x) => x.output !== undefined), 'tool results attached');
});

test('qwen truncation signature: continuation retries, boundary totals and no tool calls', () => {
  const events = (evs: Record<string, unknown>[]) => evs.map((e) => JSON.stringify(e)).join('\n');
  const truncated = parseQwenStream(events([
    { type: 'system', subtype: 'init', model: 'qwen3.5:9b' },
    { type: 'system', subtype: 'retry', data: { reason: 'retry', discardedToolCalls: 0, preserveText: true } },
    { type: 'system', subtype: 'retry', data: { reason: 'retry', discardedToolCalls: 0, preserveText: true } },
    { type: 'system', subtype: 'retry', data: { reason: 'retry', discardedToolCalls: 0, preserveText: true } },
    { type: 'result', subtype: 'success', is_error: false, result: '', usage: { input_tokens: 16242, output_tokens: 142, total_tokens: 16384 } },
  ]));
  assert.equal(truncated.retries, 3);
  assert.equal(truncated.totalTokens, 16384);
  assert.equal(truncated.tools.length, 0);
  assert.equal(looksLikeContextTruncation(truncated), true);
  // One retry whose usage lands on a 4K boundary is enough; without a stated total it is not.
  const one = parseQwenStream(events([
    { type: 'system', subtype: 'retry', data: { reason: 'retry', discardedToolCalls: 0, preserveText: true } },
    { type: 'result', subtype: 'success', is_error: false, result: '', usage: { total_tokens: 8192 } },
  ]));
  assert.equal(looksLikeContextTruncation(one), true);
  const noTotal = parseQwenStream(events([
    { type: 'system', subtype: 'retry', data: { reason: 'retry', discardedToolCalls: 0, preserveText: true } },
    { type: 'result', subtype: 'success', is_error: false, result: '' },
  ]));
  assert.equal(looksLikeContextTruncation(noTotal), false);
  // A tool call, an error or a real reply clears the signature.
  const withTool = parseQwenStream(events([
    { type: 'system', subtype: 'retry', data: { reason: 'retry', discardedToolCalls: 0, preserveText: true } },
    { type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'x' } },
    { type: 'result', subtype: 'success', is_error: false, result: 'ok', usage: { total_tokens: 8192 } },
  ]));
  assert.equal(looksLikeContextTruncation(withTool), false);
  const errored = parseQwenStream(events([
    { type: 'system', subtype: 'retry', data: { reason: 'retry', discardedToolCalls: 0, preserveText: true } },
    { type: 'result', subtype: 'error_max_turns', is_error: true, result: 'failed', usage: { total_tokens: 8192 } },
  ]));
  assert.equal(looksLikeContextTruncation(errored), false);
});

test('extractJson tolerates fences and prose', () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('Here:\n```json\n{"a":2}\n```'), { a: 2 });
  assert.deepEqual(extractJson('note {"a":3} end'), { a: 3 });
  assert.throws(() => extractJson('no json'));
});
