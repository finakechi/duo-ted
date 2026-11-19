import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { parseQwenStream } from '../src/tap.ts';
import { executeQwen, qwenExcludedTools, qwenSupport, scrubCredentials, QWEN_TOOLS } from '../src/qwen.ts';
import { parseSeat, formatSeat } from '../src/seats.ts';
import { endpointLocation, profileIssues, validateProfilesForSave, validateQwenProfiles } from '../src/config.ts';

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

const calls = (log: string) => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

test('DT-01: a hosted profile never falls back to OPENAI_API_KEY', { skip: !available }, async () => {
  process.env.OPENAI_API_KEY = 'unrelated-openai-key-must-not-be-used';
  try {
    const hosted = { name: 'Hosted', kind: 'hosted' as const, model: 'qwen3-coder-plus', baseUrl: 'https://example.invalid/v1' };
    await assert.rejects(executeQwen({ bin, model: hosted.model, cwd: dir, system: 'x', access: 'read', configDir: dir, id: 'nofallback', message: 'hi', timeoutSec: 4, onLine: () => undefined, profile: hosted }), /must name the environment variable/);
    await assert.rejects(executeQwen({ bin, model: hosted.model, cwd: dir, system: 'x', access: 'read', configDir: dir, id: 'nofallback', message: 'hi', timeoutSec: 4, onLine: () => undefined, profile: { ...hosted, keyEnv: 'DUO_TEST_UNSET_KEY' } }), /set DUO_TEST_UNSET_KEY/);
  } finally { delete process.env.OPENAI_API_KEY; }
  assert.match(profileIssues('h', { name: 'h', kind: 'hosted', model: 'm', baseUrl: 'https://example.invalid/v1' })[0], /never falls back to OPENAI_API_KEY/);
  assert.throws(() => validateQwenProfiles({ h: { kind: 'hosted', model: 'm', baseUrl: 'https://example.invalid/v1' } }), /must name the environment variable/);
});

test('DT-01: profile runs pass only their own key and scrub every other credential and its echo', { skip: !available }, async () => {
  const log = join(dir, 'scrub.jsonl');
  process.env.FAKE_LOG = log;
  process.env.QWEN_TEST_KEY = 'hosted-secret-value-1234';
  process.env.DEEPSEEK_API_KEY = 'deepseek-secret-should-not-reach-qwen';
  process.env.ANTHROPIC_API_KEY = 'anthropic-secret-should-not-reach-qwen';
  process.env.FAKE_QWEN_MODE = 'echo-key';
  const lines: string[] = [];
  try {
    const result = await executeQwen({ bin, model: 'qwen3-coder-plus', cwd: dir, system: 'x', access: 'write', configDir: dir, id: 'scrub', message: 'hi', timeoutSec: 4,
      onLine: (l) => lines.push(l), profile: { name: 'Hosted', kind: 'hosted', model: 'qwen3-coder-plus', baseUrl: 'https://example.invalid/v1', keyEnv: 'QWEN_TEST_KEY' } });
    const call = calls(log).at(-1);
    assert.deepEqual(call.credentialNames, [], 'no other credential variable reaches the Qwen child');
    assert.equal(call.hasKey, true);
    assert.doesNotMatch(lines.join('\n'), /hosted-secret-value-1234/);
    assert.match(lines.join('\n'), /\[redacted\]/);
    assert.doesNotMatch(JSON.stringify(result), /hosted-secret-value-1234/);
  } finally {
    for (const k of ['FAKE_LOG', 'QWEN_TEST_KEY', 'DEEPSEEK_API_KEY', 'ANTHROPIC_API_KEY', 'FAKE_QWEN_MODE']) delete process.env[k];
  }
  assert.deepEqual(Object.keys(scrubCredentials({ PATH: '/bin', HOME: '/h', GITHUB_TOKEN: 'x', OPENAI_BASE_URL: 'u', MY_SERVICE_API_KEY: 'k', QWEN_HOME: '/q' })).sort(), ['HOME', 'PATH', 'QWEN_HOME']);
});

test('DT-04: endpoint location comes from the address, and unsafe local/LAN/plain-HTTP setups are refused', () => {
  assert.equal(endpointLocation('http://127.0.0.1:11434/v1'), 'device');
  assert.equal(endpointLocation('http://localhost:8080/v1'), 'device');
  assert.equal(endpointLocation('http://[::1]:8080/v1'), 'device');
  assert.equal(endpointLocation('http://192.168.1.20:11434/v1'), 'lan');
  assert.equal(endpointLocation('http://10.0.0.5/v1'), 'lan');
  assert.equal(endpointLocation('http://gpu-box.local:8000/v1'), 'lan');
  assert.equal(endpointLocation('http://[fd00::12]:8000/v1'), 'lan');
  assert.equal(endpointLocation('http://203.0.113.9:11434/v1'), 'cloud');
  assert.equal(endpointLocation('https://api.example.com/v1'), 'cloud');
  const local = (baseUrl: string, extra = {}) => ({ name: 'L', kind: 'local' as const, model: 'm', baseUrl, ...extra });
  assert.match(profileIssues('L', local('http://203.0.113.9:11434/v1'))[0], /remote address/);
  assert.match(profileIssues('L', local('http://192.168.1.20:11434/v1'))[0], /Allow local-network endpoint/);
  assert.deepEqual(profileIssues('L', local('http://192.168.1.20:11434/v1', { lan: true })), []);
  assert.match(profileIssues('L', local('http://192.168.1.20:11434/v1', { lan: true, keyEnv: 'LAN_KEY' }))[0], /plain HTTP/);
  assert.deepEqual(profileIssues('L', local('https://192.168.1.20/v1', { lan: true, keyEnv: 'LAN_KEY' })), []);
  assert.deepEqual(profileIssues('L', local('http://127.0.0.1:11434/v1', { keyEnv: 'LOCAL_KEY' })), [], 'loopback HTTP never leaves the device');
  assert.throws(() => validateQwenProfiles({ h: { kind: 'hosted', model: 'm', baseUrl: 'https://x.example/v1', keyEnv: 'K', lan: true } }), /lan applies only to local/);
  // A saved, unchanged older profile does not block saving other settings; an edited one must comply.
  const legacy = { old: { name: 'old', kind: 'local', model: 'm', baseUrl: 'http://192.168.1.20:11434/v1' } };
  assert.ok(validateProfilesForSave(legacy, legacy).old);
  assert.throws(() => validateProfilesForSave({ old: { ...legacy.old, model: 'n' } }, legacy), /Allow local-network endpoint/);
});

test('DT-05/web tools: every non-reviewer tool of the verified release is excluded, host-side web tools always', () => {
  const read = qwenExcludedTools('read');
  const write = qwenExcludedTools('write');
  for (const t of ['write_file', 'edit', 'run_shell_command', 'exec', 'notebook_edit', 'agent', 'web_fetch', 'web_search', 'monitor', 'send_message', 'cron_create', 'enter_worktree', 'skill', 'tool_call', 'exit_plan_mode']) assert.ok(read.includes(t), `reviewer excludes ${t}`);
  for (const t of ['web_fetch', 'web_search', 'exec', 'agent', 'monitor', 'enter_worktree', 'send_message', 'tool_call', 'tool_search']) assert.ok(write.includes(t), `writer excludes ${t}`);
  for (const t of ['read_file', 'write_file', 'edit', 'run_shell_command']) assert.ok(!write.includes(t), `writer keeps ${t}`);
  assert.ok(!read.includes('read_file') && !read.includes('grep_search'));
  assert.equal(new Set([...read, 'read_file', 'glob', 'grep_search', 'list_directory', 'structured_output']).size, QWEN_TOOLS.length, 'the reviewer allowlist plus its exclusions cover the whole catalog');
  assert.equal(qwenSupport('0.28.0').ok, true);
  assert.equal(qwenSupport('qwen 0.28.3').ok, true);
  assert.match(qwenSupport('0.29.0').reason!, /not verified by Duo/);
  assert.match(qwenSupport('unknown').reason!, /cannot read/);
});

test('DT-05: launch arguments carry the role deny list; an unverified release and a trust downgrade fail closed', { skip: !available }, async () => {
  const log = join(dir, 'policy.jsonl');
  process.env.FAKE_LOG = log;
  try {
    const opts = { bin, model: 'qwen3-coder-plus', cwd: dir, system: 'x', configDir: dir, message: 'hi', timeoutSec: 4, onLine: () => undefined };
    assert.equal((await executeQwen({ ...opts, access: 'read', id: 'policy-read' })).error, undefined);
    const readArgs: string[] = calls(log).at(-1).args;
    const excluded = readArgs[readArgs.indexOf('--exclude-tools') + 1].split(',');
    assert.ok(excluded.includes('web_fetch') && excluded.includes('write_file') && excluded.includes('run_shell_command'));
    assert.equal(readArgs[readArgs.indexOf('--approval-mode') + 1], 'plan');
    assert.ok(readArgs.includes('--safe-mode'));
    assert.equal((await executeQwen({ ...opts, access: 'write', network: true, id: 'policy-net' })).error, undefined);
    const net = JSON.parse(readFileSync(join(dir, 'qwen-policy-policy-net.json'), 'utf8'));
    assert.deepEqual(net.tools.executionSandbox, { backend: 'bwrap', filesystem: 'workspace-write', network: 'open' });
    await executeQwen({ ...opts, access: 'write', id: 'policy-closed' });
    assert.equal(JSON.parse(readFileSync(join(dir, 'qwen-policy-policy-closed.json'), 'utf8')).tools.executionSandbox.network, 'closed');
    const old = { ...bin, args: [file, '--fake-version=0.27.4'] };
    await assert.rejects(executeQwen({ ...opts, bin: old, access: 'read', id: 'old' }), /0\.27\.4 is not verified/);
    process.env.FAKE_QWEN_MODE = 'trust-downgrade';
    const started = Date.now();
    const downgraded = await executeQwen({ ...opts, access: 'write', id: 'trust', timeoutSec: 15 });
    assert.match(downgraded.error ?? '', /folder trust is enabled/);
    assert.ok(Date.now() - started < 10_000, 'stopped at once rather than waiting for the turn');
  } finally { delete process.env.FAKE_LOG; delete process.env.FAKE_QWEN_MODE; }
});
