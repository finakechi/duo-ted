/**
 * Role readiness: connection, reviewer and writer checks through the fake Qwen Code and Codex CLIs
 * against local fake endpoints. These prove Duo's evidence handling, isolation and gating; they do
 * not prove that any real model or provider can do the work.
 */
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const tmp = mkdtempSync(join(tmpdir(), 'duo-readiness-test-'));
const LOG = join(tmp, 'calls.jsonl');
Object.assign(process.env, {
  DUO_HOME: join(tmp, 'home'), DUO_CONFIG: join(tmp, 'config.json'), CODEX_HOME: join(tmp, 'codex-home'),
  DUO_CODEX_BIN: join(import.meta.dirname, 'fakes', 'codex.mjs'), DUO_QWEN_BIN: join(import.meta.dirname, 'fakes', 'qwen.mjs'), FAKE_LOG: LOG,
});
const { DEFAULT_CONFIG } = await import('../src/config.ts');
const { ReadinessStore } = await import('../src/readiness.ts');
const { parseSeat } = await import('../src/seats.ts');
after(() => rmSync(tmp, { recursive: true, force: true }));

const linux = process.platform === 'linux' && existsSync('/usr/bin/bwrap');
const calls = () => (existsSync(LOG) ? readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const probeDirs = () => readdirSync(tmpdir()).filter((d) => d.startsWith('duo-readiness-') && !tmp.endsWith(d));

async function endpoint(models: string[], o: { status?: number; ollama?: { servedContext: number } } = {}): Promise<{ url: string; hits: () => number; auth: () => string[]; server: Server }> {
  let hits = 0;
  const auth: string[] = [];
  const server = createServer((req, res) => {
    hits++;
    auth.push(String(req.headers.authorization ?? ''));
    if (o.status) { res.writeHead(o.status).end('denied'); return; }
    res.setHeader('content-type', 'application/json');
    const path = String(req.url ?? '/').split('?')[0];
    if (o.ollama && path === '/api/version') { res.end(JSON.stringify({ version: '0.40.15' })); return; }
    if (o.ollama && path === '/api/ps') {
      res.end(JSON.stringify({ models: models.map((id) => ({ name: id, context_length: o.ollama!.servedContext })) }));
      return;
    }
    res.end(JSON.stringify({ data: models.map((id) => ({ id })) }));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const a = server.address();
  if (!a || typeof a === 'string') throw new Error('no port');
  return { url: `http://127.0.0.1:${a.port}/v1`, hits: () => hits, auth: () => auth, server };
}

function config(profile: Record<string, unknown>, enabled = true) {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.localModelsEnabled = enabled;
  cfg.qwenProfiles = { desk: { name: 'Desk', kind: 'local', model: 'local-coder', baseUrl: 'http://127.0.0.1:9/v1', ...profile } as any };
  return cfg;
}

test('disabled providers make no connection attempts and are reported as disabled', async () => {
  const ep = await endpoint(['local-coder']);
  try {
    const store = new ReadinessStore();
    const off = config({ baseUrl: ep.url }, false);
    const view = await store.describe(off, 'qwen:desk');
    assert.equal(view.status, 'disabled');
    assert.equal((await store.check(off, 'qwen:desk', 'review')).status, 'disabled');
    const disabledProfile = config({ baseUrl: ep.url, enabled: false });
    assert.equal((await store.check(disabledProfile, 'qwen:desk', 'connection')).status, 'disabled');
    const ds = structuredClone(DEFAULT_CONFIG);
    assert.deepEqual(Object.keys(await store.describeAll(ds)), [], 'DeepSeek off: no targets at all');
    assert.equal(ep.hits(), 0);
  } finally { ep.server.close(); }
});

test('policy problems make a profile unsupported without contacting it', async () => {
  const ep = await endpoint(['local-coder']);
  try {
    const store = new ReadinessStore();
    const remote = config({ baseUrl: 'http://203.0.113.9:11434/v1' });
    const v = await store.check(remote, 'qwen:desk', 'connection');
    assert.equal(v.status, 'unsupported');
    assert.match(v.detail, /remote address/);
    const noTools = config({ baseUrl: ep.url, capabilities: { tools: false } });
    assert.match((await store.describe(noTools, 'qwen:desk')).detail, /Tool calling is turned off/);
    assert.equal(ep.hits(), 0);
  } finally { ep.server.close(); }
});

test('connection, model listing and authentication are evidence of reachability only', async () => {
  const ep = await endpoint(['local-coder']);
  const denied = await endpoint([], { status: 401 });
  process.env.DESK_KEY = 'desk-secret-value-xyz';
  try {
    const store = new ReadinessStore();
    const cfg = config({ baseUrl: ep.url });
    const v = await store.check(cfg, 'qwen:desk', 'connection');
    assert.equal(v.status, linux ? 'connected' : 'unsupported');
    assert.equal(v.connection?.modelListed, true);
    assert.deepEqual(v.roles, { review: false, write: false }, 'a reachable endpoint is not a coding agent');
    assert.match(await store.eligibility(cfg, parseSeat('qwen:local-coder+profile=desk', 'A', cfg.defaults), 'read') ?? '', /not verified as a reviewer/);
    const offline = config({ baseUrl: 'http://127.0.0.1:9/v1' });
    const down = await store.check(offline, 'qwen:desk', 'review');
    if (linux) assert.equal(down.status, 'unreachable');
    assert.match(down.detail, /Cannot use the endpoint|Not attempted/);
    const auth = config({ baseUrl: denied.url, keyEnv: 'DESK_KEY' });
    const rejected = await store.check(auth, 'qwen:desk', 'connection');
    assert.match(rejected.connection?.detail ?? '', /authentication was rejected/);
    assert.doesNotMatch(JSON.stringify(rejected), /desk-secret-value-xyz/);
    assert.deepEqual(denied.auth(), ['Bearer desk-secret-value-xyz'], 'the profile key goes only to its own endpoint');
  } finally { ep.server.close(); denied.server.close(); delete process.env.DESK_KEY; }
});

test('reviewer and writer tests prove different roles, in disposable folders that are removed', { skip: !linux }, async () => {
  const ep = await endpoint(['local-coder']);
  const before = new Set(probeDirs());
  try {
    const store = new ReadinessStore();
    const cfg = config({ baseUrl: ep.url });
    const seat = parseSeat('qwen:local-coder+profile=desk', 'A', cfg.defaults);
    const review = await store.check(cfg, 'qwen:desk', 'review');
    assert.equal(review.status, 'read-verified', review.detail);
    assert.deepEqual(review.roles, { review: true, write: false });
    assert.match(review.review!.detail, /read_file/);
    assert.equal(await store.eligibility(cfg, seat, 'read'), undefined);
    assert.match(await store.eligibility(cfg, seat, 'write') ?? '', /not verified as a writer/);
    const write = await store.check(cfg, 'qwen:desk', 'write');
    assert.equal(write.status, 'write-verified', write.detail);
    assert.deepEqual(write.roles, { review: true, write: true });
    assert.equal(await store.eligibility(cfg, seat, 'write'), undefined);
    // The endpoint goes away: the proofs are dropped until it is back and tested again.
    ep.server.close();
    ep.server.closeAllConnections();
    const down = await store.check(cfg, 'qwen:desk', 'connection');
    assert.equal(down.status, 'unreachable');
    assert.deepEqual(down.roles, { review: false, write: false });
    const probes = calls().filter((c) => c.cli === 'qwen');
    assert.ok(probes.some((c) => c.action === 'sandbox'), 'Qwen sandbox self-test ran');
    const reviewCall = probes.find((c) => c.prompt?.includes('proof.txt'));
    const excluded = reviewCall.args[reviewCall.args.indexOf('--exclude-tools') + 1].split(',');
    assert.ok(excluded.includes('write_file') && excluded.includes('web_fetch'));
    assert.match(reviewCall.qwenHome ?? '', /duo-readiness-/, 'probe sessions stay in the disposable folder');
    assert.deepEqual(probeDirs().filter((d) => !before.has(d)), [], 'probe folders are removed');
  } finally { ep.server.close(); }
});

test('missing tool calls, a broken reviewer boundary and a missing sandbox each fail with the reason', { skip: !linux }, async () => {
  const ep = await endpoint(['local-coder']);
  try {
    const cfg = config({ baseUrl: ep.url });
    process.env.FAKE_QWEN_PROBE = 'notools';
    const none = await new ReadinessStore().check(cfg, 'qwen:desk', 'review');
    assert.equal(none.status, 'failed');
    assert.match(none.detail, /no tool calls/);
    process.env.FAKE_QWEN_PROBE = 'escape';
    const escape = await new ReadinessStore().check(cfg, 'qwen:desk', 'review');
    assert.equal(escape.status, 'failed');
    assert.match(escape.detail, /Boundary violation: the read-only reviewer changed review-write-attempt\.txt/);
    process.env.FAKE_QWEN_PROBE = 'escape-write';
    const out = await new ReadinessStore().check(cfg, 'qwen:desk', 'write');
    assert.match(out.detail, /Boundary violation: the writer changed escape\.txt outside its workspace/);
    delete process.env.FAKE_QWEN_PROBE;
    process.env.FAKE_QWEN_SANDBOX = 'fail';
    const sandbox = await new ReadinessStore().check(cfg, 'qwen:desk', 'write');
    assert.match(sandbox.detail, /sandbox not established.*Permission denied/);
  } finally { ep.server.close(); delete process.env.FAKE_QWEN_PROBE; delete process.env.FAKE_QWEN_SANDBOX; }
});

test('a context window too small for the agent is diagnosed instead of blaming the model', { skip: !linux }, async () => {
  const ep = await endpoint(['local-coder']);
  try {
    const cfg = config({ baseUrl: ep.url });
    process.env.FAKE_QWEN_PROBE = 'truncated';
    const review = await new ReadinessStore().check(cfg, 'qwen:desk', 'review');
    assert.equal(review.status, 'failed');
    assert.match(review.detail, /context window is too small/);
    assert.match(review.detail, /16,384-token total/);
    assert.doesNotMatch(review.detail, /may not support tool calling/, 'the truncation signature overrides the generic guess');
    const write = await new ReadinessStore().check(cfg, 'qwen:desk', 'write');
    assert.equal(write.status, 'failed');
    assert.match(write.detail, /context window is too small/);
  } finally { ep.server.close(); delete process.env.FAKE_QWEN_PROBE; }
});

test('an Ollama server that serves a small context window is named with its exact fix', { skip: !linux }, async () => {
  const ep = await endpoint(['local-coder'], { ollama: { servedContext: 4096 } });
  try {
    const cfg = config({ baseUrl: ep.url });
    process.env.FAKE_QWEN_PROBE = 'truncated';
    const review = await new ReadinessStore().check(cfg, 'qwen:desk', 'review');
    assert.equal(review.status, 'failed');
    assert.match(review.detail, /Ollama served local-coder/);
    assert.match(review.detail, /4,096-token context/);
    assert.match(review.detail, /OLLAMA_CONTEXT_LENGTH=32768/);
    assert.match(review.detail, /systemctl edit ollama/);
    // The server's own served context is enough evidence: an empty turn with no retry events
    // still gets the exact diagnosis instead of the generic guess.
    process.env.FAKE_QWEN_PROBE = 'empty';
    const empty = await new ReadinessStore().check(cfg, 'qwen:desk', 'write');
    assert.equal(empty.status, 'failed');
    assert.match(empty.detail, /Ollama served local-coder/);
    assert.match(empty.detail, /OLLAMA_CONTEXT_LENGTH=32768/);
  } finally { ep.server.close(); delete process.env.FAKE_QWEN_PROBE; }
});

test('a change to the profile, endpoint or harness makes earlier proof stale', { skip: !linux }, async () => {
  const ep = await endpoint(['local-coder', 'other-coder']);
  try {
    const store = new ReadinessStore();
    const cfg = config({ baseUrl: ep.url });
    assert.equal((await store.check(cfg, 'qwen:desk', 'review')).status, 'read-verified');
    const edited = config({ baseUrl: ep.url, model: 'other-coder' });
    const stale = await store.describe(edited, 'qwen:desk');
    assert.equal(stale.stale, true);
    assert.deepEqual(stale.roles, { review: false, write: false });
    assert.match(await store.eligibility(edited, parseSeat('qwen:other-coder+profile=desk', 'A', edited.defaults), 'read') ?? '', /changed since the last test/);
    assert.equal((await new ReadinessStore().describe(cfg, 'qwen:desk')).status, 'untested', 'a new Duo session trusts nothing proven earlier');
  } finally { ep.server.close(); }
});

test('cloud model checks require cost confirmation; DeepSeek roles are tested through Codex in an isolated home', async () => {
  const ep = await endpoint(['deepseek-flash']);
  process.env.DEEPSEEK_API_KEY = 'ds-secret-for-test-only';
  try {
    const store = new ReadinessStore({ deepseekBaseUrl: ep.url.replace(/\/v1$/, '') });
    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.deepseek.enabled = true;
    await assert.rejects(store.check(cfg, 'deepseek:deepseek-flash', 'review'), /may be billed by the provider\. Confirm the cost/);
    assert.equal(ep.hits(), 0, 'nothing was sent before confirmation');
    const conn = await store.check(cfg, 'deepseek:deepseek-flash', 'connection');
    assert.equal(conn.status, 'connected');
    const review = await store.check(cfg, 'deepseek:deepseek-flash', 'review', { confirmCost: true });
    assert.equal(review.status, 'read-verified', review.detail);
    const write = await store.check(cfg, 'deepseek:deepseek-flash', 'write', { confirmCost: true });
    assert.equal(write.status, 'write-verified', write.detail);
    const codex = calls().filter((c) => c.cli === 'codex' && c.prompt?.includes('automated Duo capability test'));
    assert.equal(codex.length, 2);
    assert.ok(codex.every((c) => c.args.includes('--ignore-user-config') && c.args.some((a: string) => a.startsWith('model_provider='))));
    assert.deepEqual(codex.map((c) => c.args[c.args.indexOf('--sandbox') + 1]), ['read-only', 'workspace-write']);
    assert.doesNotMatch(JSON.stringify(write), /ds-secret-for-test-only/);
    const hosted = structuredClone(DEFAULT_CONFIG);
    hosted.qwenProfiles = { cloud: { name: 'Cloud', kind: 'hosted', model: 'q', baseUrl: 'https://example.invalid/v1', keyEnv: 'DEEPSEEK_API_KEY' } };
    if (linux) await assert.rejects(store.check(hosted, 'qwen:cloud', 'write'), /Confirm the cost/);
  } finally { ep.server.close(); delete process.env.DEEPSEEK_API_KEY; }
});
