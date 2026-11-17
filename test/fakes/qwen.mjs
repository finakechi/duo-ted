#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { instance, record, valueOf } from './common.mjs';

const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('0.999.0 (fake Qwen Code)'); process.exit(0); }
let prompt = '';
for await (const line of createInterface({ input: process.stdin })) prompt += line + '\n';
const mode = process.env.FAKE_QWEN_MODE || '';
const session = valueOf(args, '--resume') || '00000000-0000-4000-8000-000000000001';
const schema = valueOf(args, '--json-schema');
record({ cli: 'qwen', args, prompt, cwd: process.cwd(), session, endpoint: process.env.OPENAI_BASE_URL || undefined,
  // Never print or record API keys; tests only inspect whether the key exists.
  hasKey: Boolean(process.env.OPENAI_API_KEY), systemPolicy: process.env.QWEN_CODE_SYSTEM_SETTINGS_PATH || undefined });
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
