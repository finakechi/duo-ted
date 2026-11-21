#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { instance, record, valueOf } from './common.mjs';

import { existsSync, readFileSync } from 'node:fs';

// --fake-version=X (a BinSpec argument) stands in for another installed release.
const all = process.argv.slice(2);
const version = (all.find((a) => a.startsWith('--fake-version=')) ?? '--fake-version=0.28.0').split('=')[1];
const args = all.filter((a) => !a.startsWith('--fake-version='));
if (args[0] === '--version') { console.log(version); process.exit(0); }
if (args[0] === 'sandbox') {
  record({ cli: 'qwen', action: 'sandbox', args, systemPolicy: process.env.QWEN_CODE_SYSTEM_SETTINGS_PATH, qwenHome: process.env.QWEN_HOME });
  if (process.env.FAKE_QWEN_SANDBOX === 'fail') { console.error('bwrap: setting up uid map: Permission denied'); process.exit(1); }
  console.log('Tool boundary: bwrap (full)'); process.exit(0);
}
let prompt = '';
for await (const line of createInterface({ input: process.stdin })) prompt += line + '\n';
const mode = process.env.FAKE_QWEN_MODE || '';
const session = valueOf(args, '--resume') || '00000000-0000-4000-8000-000000000001';
const schema = valueOf(args, '--json-schema');
record({ cli: 'qwen', args, prompt, cwd: process.cwd(), session, endpoint: process.env.OPENAI_BASE_URL || undefined,
  // Never print or record API keys; tests only inspect whether the key exists.
  hasKey: Boolean(process.env.OPENAI_API_KEY), usesPlaceholderKey: process.env.OPENAI_API_KEY === 'ollama', systemPolicy: process.env.QWEN_CODE_SYSTEM_SETTINGS_PATH || undefined,
  // Names only: which other credentials leaked into the child environment.
  credentialNames: Object.keys(process.env).filter((k) => /(API_?KEY|TOKEN|SECRET)$/.test(k) && k !== 'OPENAI_API_KEY'), qwenHome: process.env.QWEN_HOME });
if (mode === 'trust-downgrade' && valueOf(args, '--approval-mode') === 'yolo') {
  process.stderr.write('Approval mode overridden to "default" because the current folder is not trusted.\n');
  await new Promise((resolve) => setTimeout(resolve, 20_000));
}
if (mode === 'echo-key') {
  // A sandboxed command that prints the key it was given; Duo must redact it from the stream.
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  out({ type: 'tool_use', id: 'k', name: 'run_shell_command', input: { command: 'env' } });
  out({ type: 'tool_result', tool_use_id: 'k', content: `OPENAI_API_KEY=${process.env.OPENAI_API_KEY}`, is_error: false });
  out({ type: 'result', subtype: 'success', is_error: false, session_id: session, result: `key is ${process.env.OPENAI_API_KEY}` });
  process.exit(0);
}
// Readiness probes: answer like a tool-capable agent (or a broken one) in the disposable repository.
if (prompt.includes('automated Duo capability test')) {
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  const probe = process.env.FAKE_QWEN_PROBE || 'honest';
  const plan = valueOf(args, '--approval-mode') === 'plan';
  out({ type: 'system', subtype: 'session_start', session_id: session });
  if (probe === 'notools') {
    out({ type: 'result', subtype: 'success', is_error: false, session_id: session, result: 'I cannot access files.' });
    process.exit(0);
  }
  // An empty turn with no retries: a server that ends generation instantly, without the
  // continuation-retry signature (for example when the CLI's wall time runs out first).
  if (probe === 'empty') {
    out({ type: 'result', subtype: 'success', is_error: false, session_id: session, result: '' });
    process.exit(0);
  }
  // The real failure signature of a context window too small for the agent: Qwen Code's
  // continuation retries end an empty turn without ever reaching a tool call.
  if (probe === 'truncated') {
    out({ type: 'system', subtype: 'retry', data: { reason: 'retry', discardedToolCalls: 0, preserveText: true } });
    out({ type: 'system', subtype: 'retry', data: { reason: 'retry', discardedToolCalls: 0, preserveText: true } });
    out({ type: 'system', subtype: 'retry', data: { reason: 'retry', discardedToolCalls: 0, preserveText: true } });
    out({ type: 'assistant', message: { id: 'qm', content: [{ type: 'thinking', thinking: 'The user has hit the output token limit and wants me to resume.' }] }, session_id: session });
    out({ type: 'result', subtype: 'success', is_error: false, session_id: session, result: '',
      usage: { input_tokens: 16242, output_tokens: 142, cache_read_input_tokens: 11665, total_tokens: 16384 } });
    process.exit(0);
  }
  if (probe === 'escape' && plan) writeFileSync(join(process.cwd(), 'review-write-attempt.txt'), 'test\n');
  if (prompt.includes('read the file proof.txt')) {
    const content = existsSync('proof.txt') ? readFileSync('proof.txt', 'utf8').trim() : '';
    out({ type: 'tool_use', id: 'r1', name: 'read_file', input: { path: 'proof.txt' } });
    out({ type: 'tool_result', tool_use_id: 'r1', content, is_error: false });
    out({ type: 'result', subtype: 'success', is_error: false, session_id: session, result: content });
    process.exit(0);
  }
  const marker = /DUO_WRITE_PROOF_\w+/.exec(prompt)?.[0];
  if (!plan && marker) {
    writeFileSync(join(process.cwd(), 'duo-writer-proof.txt'), marker + '\n');
    out({ type: 'tool_use', id: 'w1', name: 'write_file', input: { file_path: 'duo-writer-proof.txt' } });
    out({ type: 'tool_result', tool_use_id: 'w1', content: 'ok', is_error: false });
    if (probe === 'escape-write') { const outside = /try to create (\S+) containing/.exec(prompt)?.[1]; if (outside) writeFileSync(outside, 'test\n'); }
  }
  out({ type: 'result', subtype: 'success', is_error: false, session_id: session, result: 'done' });
  process.exit(0);
}
if (mode === 'exit') { process.stderr.write('invalid authentication or unknown model\n'); process.exit(2); }
if (mode === 'wait') { await new Promise((resolve) => setTimeout(resolve, 20_000)); }
if (mode === 'malformed') { console.log('{broken json'); process.exit(0); }
if (process.env.FAKE_QWEN_WRITE === '1' && valueOf(args, '--approval-mode') === 'yolo') {
  writeFileSync(join(process.cwd(), 'duo-qwen-fake.txt'), 'Qwen wrote this file in its assigned workspace.\n');
}
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
out({ type: 'system', subtype: 'session_start', session_id: session, model: valueOf(args, '--model') });
const text = `Qwen answered ${prompt.length} chars`;
out({ type: 'stream_event', event: { type: 'message_start', message: { id: 'qm' } } });
out({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } });
out({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } });
out({ type: 'tool_use', id: 'qt', name: 'read_file', input: { path: 'README.md' } });
out({ type: 'tool_result', tool_use_id: 'qt', content: 'file contents', is_error: false });
const obj = schema ? instance(JSON.parse(schema), { answer: text }) : undefined;
out({ type: 'assistant', message: { id: 'qm', content: [{ type: 'text', text }] }, session_id: session });
out({ type: 'result', subtype: 'success', is_error: false, session_id: session, result: obj ? JSON.stringify(obj) : text,
  ...(obj ? { structured_result: obj } : {}), usage: { input_tokens: 80, cache_read_input_tokens: 12, output_tokens: 15 } });
