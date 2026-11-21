import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DEFAULT_CONFIG, resolveCodexBin, validateDeepSeekSettings, validateQwenProfiles } from '../src/config.ts';
import { DEEPSEEK_SAVED_KEY_ENV, deepseekForSeat, discoverModels, validateProviderSeat } from '../src/providers.ts';
import { formatSeat, parseSeat } from '../src/seats.ts';
import { initialState } from '../src/templates/runtime.ts';
import { validateTemplate } from '../src/templates/validate.ts';

const scratch = mkdtempSync(join(tmpdir(), 'duo-deepseek-test-'));
after(() => rmSync(scratch, { recursive: true, force: true }));
const cfg = () => structuredClone(DEFAULT_CONFIG);
const defaults = DEFAULT_CONFIG.defaults;

test('DeepSeek is opt-in and never saves an inline credential', () => {
  assert.equal(cfg().deepseek.enabled, false);
  assert.equal(cfg().localModelsEnabled, false);
  assert.throws(() => validateDeepSeekSettings({ enabled: true, keyEnv: 'DEEPSEEK_API_KEY', models: ['deepseek-flash'], apiKey: 'secret' }), /secret-bearing/);
  assert.throws(() => validateDeepSeekSettings({ enabled: true, keyEnv: 'foo$bar', models: ['deepseek-flash'] }), /environment variable/);
  assert.deepEqual(validateDeepSeekSettings({ enabled: true, keyEnv: 'MY_KEY', models: ['deepseek-flash', 'deepseek-flash'] }).models, ['deepseek-flash']);
});

test('DeepSeek seat labels the provider separately from its Codex harness', () => {
  const spec = 'codex:deepseek-flash@high+provider=deepseek';
  const seat = parseSeat(spec, 'A', defaults);
  assert.equal(formatSeat(seat), spec);
  assert.throws(() => parseSeat(spec, 'A', defaults, { safe: true }), /duo-safe/);
  assert.throws(() => parseSeat('claude:deepseek-flash+provider=deepseek', 'A', defaults), /Codex-only/);
  assert.throws(() => validateProviderSeat(cfg(), seat), /disabled/);
});

test('Codex provider overrides keep credentials out of argv and catalog', () => {
  const configuration = cfg();
  configuration.deepseek.enabled = true;
  const seat = parseSeat('codex:deepseek-v4-pro@high+provider=deepseek', 'A', defaults);
  assert.equal(validateProviderSeat(configuration, seat), undefined);
  assert.deepEqual(seat.backend, { provider: 'deepseek', locality: 'cloud' });
  assert.throws(() => deepseekForSeat(configuration, seat, scratch), /DEEPSEEK_API_KEY/);
  process.env.DEEPSEEK_API_KEY = 'private-secret-not-for-logs';
  try {
    const route = deepseekForSeat(configuration, seat, scratch)!;
    assert.equal(route.unsetEnv.includes('OPENAI_API_KEY'), true);
    assert.match(route.overrides.join(' '), /env_key="DEEPSEEK_API_KEY"/);
    assert.match(route.overrides.join(' '), /web_search="disabled"/);
    assert.doesNotMatch(JSON.stringify(route), /private-secret-not-for-logs/);
    assert.doesNotMatch(readFileSync(join(scratch, 'duo-deepseek-models.json'), 'utf8'), /private-secret-not-for-logs/);
  } finally { delete process.env.DEEPSEEK_API_KEY; }
});

test('Saved desktop key takes precedence over an environment key without entering args or catalog', () => {
  const configuration = cfg();
  configuration.deepseek.enabled = true;
  const seat = parseSeat('codex:deepseek-flash@high+provider=deepseek', 'A', defaults);
  process.env.DEEPSEEK_API_KEY = 'fallback-secret-not-for-logs';
  process.env[DEEPSEEK_SAVED_KEY_ENV] = 'saved-secret-not-for-logs';
  try {
    const route = deepseekForSeat(configuration, seat, scratch)!;
    assert.match(route.overrides.join(' '), /env_key="DUO_DEEPSEEK_SAVED_KEY"/);
    assert.doesNotMatch(JSON.stringify(route), /saved-secret-not-for-logs|fallback-secret-not-for-logs/);
    assert.doesNotMatch(readFileSync(join(scratch, 'duo-deepseek-models.json'), 'utf8'), /saved-secret-not-for-logs/);
  } finally {
    delete process.env[DEEPSEEK_SAVED_KEY_ENV];
    delete process.env.DEEPSEEK_API_KEY;
  }
});

test('Local profile gates are optional and fail safely for incompatible tools', () => {
  const configuration = cfg();
  configuration.qwenProfiles = validateQwenProfiles({ desk: { name: 'Desk', kind: 'local', model: 'my-coder', baseUrl: 'http://127.0.0.1:11434/v1' } });
  const seat = parseSeat('qwen:my-coder+profile=desk', 'A', defaults);
  assert.throws(() => validateProviderSeat(configuration, seat), /disabled/);
  configuration.localModelsEnabled = true;
  assert.ok(validateProviderSeat(configuration, seat));
  assert.deepEqual(seat.backend, { provider: 'local', locality: 'local' });
  configuration.qwenProfiles.desk.enabled = false;
  assert.throws(() => validateProviderSeat(configuration, seat), /disabled/);
  configuration.qwenProfiles.desk.enabled = true;
  configuration.qwenProfiles.desk.capabilities = { tools: false };
  assert.throws(() => validateProviderSeat(configuration, seat), /tool calling disabled/);
  assert.throws(() => validateQwenProfiles({ desk: { ...configuration.qwenProfiles.desk, apiKey: 'secret' } }), /secret-bearing/);
});

test('Local model discovery uses only the explicitly requested endpoint and never generates text', async () => {
  let calls = 0;
  const server = createServer((req, res) => {
    calls++;
    assert.equal(req.url, '/v1/models');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: [{ id: 'local-a' }, { id: 'local-b' }] }));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  try {
    const a = server.address();
    if (!a || typeof a === 'string') throw new Error('missing port');
    assert.deepEqual(await discoverModels(`http://127.0.0.1:${a.port}/v1`), ['local-a', 'local-b']);
    assert.equal(calls, 1);
  } finally { server.close(); }
});

test('Model discovery reports authentication and malformed protocol responses without exposing secrets', async () => {
  let authorized = false;
  const server = createServer((_req, res) => {
    if (!authorized) { res.writeHead(401).end('unauthorized'); return; }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: [null, { id: 'local-c' }, { invalid: true }] }));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  try {
    const a = server.address();
    if (!a || typeof a === 'string') throw new Error('missing port');
    const endpoint = `http://127.0.0.1:${a.port}/v1`;
    await assert.rejects(discoverModels(endpoint), /HTTP 401/);
    authorized = true;
    assert.deepEqual(await discoverModels(endpoint), ['local-c']);
  } finally { server.close(); }
});

test('Visual-template provider and locality selectors validate and execute', () => {
  const t = validateTemplate({ version: 1, id: 'provider-check', name: 'Provider check',
    roles: { writer: { instructions: 'Write.' } },
    assignments: [{ role: 'writer', select: { provider: 'deepseek', locality: 'cloud', count: 1 } }],
    start: 'write', steps: { write: { type: 'turn', role: 'writer', prompt: 'Write', next: 'done' }, done: { type: 'finish', status: 'completed', reason: 'done' } },
    limits: { maxSteps: 2, maxTurns: 1, maxDurationSec: 10, maxContextChars: 1000 },
  });
  const configuration = cfg(); configuration.deepseek.enabled = true;
  const cloud = parseSeat('codex:deepseek-flash+provider=deepseek', 'A', defaults);
  const local = parseSeat('qwen:my-coder', 'B', defaults);
  validateProviderSeat(configuration, cloud);
  validateProviderSeat(configuration, local);
  assert.deepEqual(initialState(t, [cloud, local]).roles.writer, ['A']);
  assert.throws(() => initialState(t, [local]), /does not match/);
});

test('Pinned Codex accepts an isolated DeepSeek provider and reaches a fake Responses server', { timeout: 15000 }, async (t) => {
  let reached = false;
  const server = createServer((_req, res) => {
    reached = true;
    res.statusCode = 400;
    res.end(JSON.stringify({ error: { message: 'test endpoint, no inference' } }));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('missing port');
  const configuration = cfg(); configuration.deepseek.enabled = true;
  const seat = parseSeat('codex:deepseek-flash@high+provider=deepseek', 'A', defaults);
  process.env.DEEPSEEK_API_KEY = 'dummy-test-key';
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const provider = deepseekForSeat(configuration, seat, scratch)!;
    const overrides = provider.overrides.map((s) => s.startsWith('model_providers.duo_deepseek.base_url=') ? `model_providers.duo_deepseek.base_url="http://127.0.0.1:${addr.port}"` : s);
    const bin = resolveCodexBin(configuration);
    const argv = [...bin.args, 'exec', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules', '--ephemeral', '--strict-config', '--json', '-s', 'read-only', '-m', seat.model, ...overrides.flatMap((o) => ['-c', o]), '-'];
    const env: NodeJS.ProcessEnv = { ...process.env, ...bin.env, CODEX_HOME: scratch };
    delete env.OPENAI_API_KEY;
    child = spawn(bin.command, argv, { env, cwd: scratch, stdio: ['pipe', 'pipe', 'pipe'] });
    if (!child.stdin || !child.stderr || !child.stdout) throw new Error('Codex test pipes unavailable');
    child.stdin.end('Reply with ok.');
    let output = '';
    child.stderr.on('data', (b) => { output += b.toString(); });
    child.stdout.on('data', (b) => { output += b.toString(); });
    const deadline = Date.now() + 9000;
    while (!reached && child.exitCode === null && Date.now() < deadline) await new Promise((done) => setTimeout(done, 100));
    if (!reached && /fs sandbox helper failed|Operation not permitted/.test(output)) {
      t.skip('Host environment blocks Codex read-only sandbox; provider config/catalog parsed successfully');
      return;
    }
    assert.ok(reached, `Codex did not route to the local test provider: ${output.slice(0, 800)}`);
  } finally {
    child?.kill();
    delete process.env.DEEPSEEK_API_KEY;
    server.close();
  }
});
