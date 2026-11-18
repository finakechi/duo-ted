import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { after, test } from 'node:test';
import { parseQwenStream } from '../src/tap.ts';
import { executeQwen, probeQwenProfile } from '../src/qwen.ts';
import { parseSeat, formatSeat } from '../src/seats.ts';
import { validateQwenProfiles } from '../src/config.ts';

const dir = mkdtempSync(join(tmpdir(), 'duo-qwen-'));
const file = join(import.meta.dirname, 'fakes', 'qwen.mjs');
const bin = { command: process.execPath, args: [file], env: {}, display: file };
after(() => rmSync(dir, { recursive: true, force: true }));

const available = process.platform === 'linux' && existsSync('/usr/bin/bwrap');
test('Qwen seat spec and profile round-trip', () => {
  const seat = parseSeat('qwen:qwen3-coder-plus+profile=hosted', 'A', { codexModel: 'x', claudeModel: 'y' });
  assert.equal(seat.engine, 'qwen');
  assert.equal(seat.profile, 'hosted');
  assert.equal(formatSeat(seat), 'qwen:qwen3-coder-plus+profile=hosted');
  assert.throws(() => parseSeat('qwen:x@high', 'A', { codexModel: 'x', claudeModel: 'y' }), /effort/);
});

test('profile validation rejects inline secrets, login URLs and unknown fields', () => {
  const good = validateQwenProfiles({ local: { name: 'Local', kind: 'local', model: 'qwen3-coder', baseUrl: 'http://127.0.0.1:11434/v1', keyEnv: 'QWEN_LOCAL_KEY' } });
  assert.equal(good.local.baseUrl, 'http://127.0.0.1:11434/v1');
  assert.throws(() => validateQwenProfiles({ local: { ...good.local, apiKey: 'do-not-store' } }), /unknown or secret/);
  assert.throws(() => validateQwenProfiles({ local: { ...good.local, baseUrl: 'http://user:pass@localhost/v1' } }), /endpoint URL/);
  assert.throws(() => validateQwenProfiles({ remote: { ...good.local, kind: 'hosted' } }), /insecure endpoint/);
});

test('Qwen fake streams tools, schema and session continuation in a read-only sandbox', { skip: !available }, async () => {
  const seen: string[] = [];
  const common = { bin, model: 'qwen3-coder-plus', cwd: dir, system: 'Be helpful', access: 'read' as const,
    configDir: dir, id: 'review', timeoutSec: 4, onLine: (line: string) => seen.push(line) };
  const schema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false };
  const first = await executeQwen({ ...common, schema, message: 'First turn' });
  assert.equal(first.error, undefined);
  assert.match(first.sessionId || '', /^[\w-]{36}$/);
  const parsed = parseQwenStream(seen.join('\n'));
  assert.equal(parsed.structured && typeof (parsed.structured as any).answer, 'string');
  assert.equal(parsed.tools[0]?.name, 'read_file');
  assert.match(parsed.tools[0]?.output || '', /file contents/);
  const next = await executeQwen({ ...common, resumeId: first.sessionId, message: 'Second turn' });
  assert.equal(next.sessionId, first.sessionId);
  const policy = JSON.parse(readFileSync(join(dir, 'qwen-policy-review.json'), 'utf8'));
  assert.equal(policy.tools.executionSandbox.filesystem, 'read-only');
});

test('Qwen fake distinguishes process error, malformed result, and timeout', { skip: !available }, async () => {
  const opts = { bin, model: 'qwen3-coder-plus', cwd: dir, system: 'Test', access: 'write' as const,
    configDir: dir, id: 'write', timeoutSec: 4, message: 'Test', onLine: () => undefined };
  process.env.FAKE_QWEN_MODE = 'exit';
  try { assert.match((await executeQwen(opts)).error ?? '', /exited 2/); } finally { delete process.env.FAKE_QWEN_MODE; }
  process.env.FAKE_QWEN_MODE = 'malformed';
  try { assert.match((await executeQwen(opts)).error ?? '', /no result/i); } finally { delete process.env.FAKE_QWEN_MODE; }
  process.env.FAKE_QWEN_MODE = 'wait';
  try { assert.match((await executeQwen({ ...opts, timeoutSec: 0.2 })).error ?? '', /timed out|terminated/i); } finally { delete process.env.FAKE_QWEN_MODE; }
  const policy = JSON.parse(readFileSync(join(dir, 'qwen-policy-write.json'), 'utf8'));
  assert.equal(policy.tools.executionSandbox.filesystem, 'workspace-write');
});

test('Qwen endpoint configuration uses env names and never logs credential values', { skip: !available }, async () => {
  const log = join(dir, 'qwen-calls.jsonl');
  process.env.FAKE_LOG = log;
  process.env.QWEN_TEST_KEY = 'private-test-secret-never-log';
  try {
    const result = await executeQwen({ bin, model: 'qwen3-coder-plus', cwd: dir, system: 'Local', access: 'read',
      configDir: dir, id: 'profile', message: 'Hello', timeoutSec: 4, onLine: () => undefined,
      profile: { name: 'Local', kind: 'local', model: 'qwen3-coder-plus', baseUrl: 'http://127.0.0.1:11434/v1', keyEnv: 'QWEN_TEST_KEY' } });
    assert.equal(result.error, undefined);
    assert.doesNotMatch(readFileSync(log, 'utf8'), /private-test-secret-never-log/);
    assert.match(readFileSync(log, 'utf8'), /127\.0\.0\.1:11434/);
  } finally { delete process.env.FAKE_LOG; delete process.env.QWEN_TEST_KEY; }
});

test('A local Qwen endpoint never inherits an unrelated OpenAI API key', { skip: !available }, async () => {
  const log = join(dir, 'local-secret-check.jsonl');
  process.env.FAKE_LOG = log;
  process.env.OPENAI_API_KEY = 'unrelated-openai-secret';
  try {
    const result = await executeQwen({ bin, model: 'local-coder', cwd: dir, system: 'Local test', access: 'read',
      configDir: dir, id: 'local-secret', message: 'Hello', timeoutSec: 4, onLine: () => undefined,
      profile: { name: 'Ollama', kind: 'local', model: 'local-coder', baseUrl: 'http://127.0.0.1:11434/v1' } });
    assert.equal(result.error, undefined);
    const call = JSON.parse(readFileSync(log, 'utf8').trim().split('\n').at(-1)!);
    assert.equal(call.usesPlaceholderKey, true);
    assert.doesNotMatch(readFileSync(log, 'utf8'), /unrelated-openai-secret/);
  } finally { delete process.env.FAKE_LOG; delete process.env.OPENAI_API_KEY; }
});

test('profile test separates HTTP connectivity/model listing from proven agent tool use', async () => {
  const server = createServer((req, res) => {
    if (req.url === '/v1/models') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'local-coder' }] })); }
    else { res.statusCode = 404; res.end(); }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing test HTTP port');
    const profile = { kind: 'local' as const, name: 'Local', model: 'local-coder', baseUrl: `http://127.0.0.1:${address.port}/v1` };
    const reachable = await probeQwenProfile(profile);
    assert.deepEqual({ reached: reachable.reachable, listed: reachable.modelListed, tools: reachable.toolUse }, { reached: true, listed: true, tools: 'unverified' });
    if (available) {
      const verified = await probeQwenProfile(profile, bin);
      assert.equal(verified.reachable, true);
      assert.equal(verified.toolUse, 'failed', 'fake CLI emits a read call but not the secret proof file content');
    }
  } finally { server.close(); }
});
