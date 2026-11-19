/**
 * Sandbox-boundary regression through the REAL Codex CLI and Duo's actual readiness probes.
 *
 * A local fake Responses API scripts the exact tool calls the probes request (create the proof
 * file, attempt the outside write, attempt a reviewer write) and the real codex binary executes
 * them under its real Linux sandbox. This is the deterministic counterpart of the live failure
 * "Boundary violation: the writer changed escape.txt outside its workspace": the root cause was
 * the outside sentinel living under the system temp dir, which Codex's sandbox keeps writable.
 * No live provider, network beyond loopback, or paid call is involved.
 *
 * A cooperative fake model is not security proof by itself; here the model is scripted to make
 * the prohibited writes and the assertion is that Codex's sandbox stops them.
 */
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { after, test } from 'node:test';

const tmp = mkdtempSync(join(tmpdir(), 'duo-codex-boundary-test-'));
Object.assign(process.env, {
  DUO_HOME: join(tmp, 'home'), DUO_CONFIG: join(tmp, 'config.json'), CODEX_HOME: join(tmp, 'codex-home'),
});
delete process.env.DUO_CODEX_BIN; // this test needs the real binary, not the fake used elsewhere
const { DEFAULT_CONFIG, resolveCodexBin } = await import('../src/config.ts');
const { ReadinessStore } = await import('../src/readiness.ts');

let codex: ReturnType<typeof resolveCodexBin> | undefined;
try { codex = resolveCodexBin(DEFAULT_CONFIG); } catch { codex = undefined; }
const linux = process.platform === 'linux' && existsSync('/usr/bin/bwrap') && !!codex;
after(() => rmSync(tmp, { recursive: true, force: true }));

function sse(res: import('node:http').ServerResponse, events: [string, unknown][]) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  for (const [event, data] of events) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  res.end();
}
function fcItem(id: string, name: string, args: Record<string, unknown>) {
  return { id, type: 'function_call', status: 'completed', name, call_id: `call_${id}`, arguments: JSON.stringify(args) };
}
function msgItem(id: string, text: string) {
  return { id, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text }] };
}
function respond(res: import('node:http').ServerResponse, items: unknown[]) {
  const out: [string, unknown][] = [['response.created', { type: 'response.created', response: { id: 'r', object: 'response', status: 'in_progress', output: [], model: 'deepseek-flash' } }]];
  items.forEach((item, i) => {
    out.push(['response.output_item.added', { type: 'response.output_item.added', output_index: i, item }]);
    out.push(['response.output_item.done', { type: 'response.output_item.done', output_index: i, item }]);
  });
  out.push(['response.completed', { type: 'response.completed', response: { id: 'r', object: 'response', status: 'completed', output: items, usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 } } }]);
  sse(res, out);
}

/**
 * Scripts the probe's requested actions in Codex 0.166.0's wire dialect (`exec_command`).
 * The paths and marker come from the probe prompt inside the request itself.
 */
async function fakeDeepSeek(): Promise<{ url: string; hits: () => number; close: () => Promise<void> }> {
  let hits = 0;
  const server: Server = createServer((req, res) => {
    hits++;
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'deepseek-flash', object: 'model' }] }));
      return;
    }
    let body = '';
    req.on('data', (b) => (body += b));
    req.on('end', () => {
      let input: any[] = [];
      try { input = JSON.parse(body).input ?? []; } catch { /* malformed */ }
      const text = JSON.stringify(input);
      const toolResults = input.filter((i) => i.type === 'function_call_output').length;
      const exec = (cmd: string) => fcItem(`fc_${toolResults + 1}`, 'exec_command', { cmd });
      const outsidePath = /try to create (\S+) containing the word test/.exec(text)?.[1];
      const marker = /DUO_WRITE_PROOF_\w+/.exec(text)?.[0];
      if (/read the file proof\.txt/.test(text)) {
        if (toolResults === 0) return respond(res, [exec('cat proof.txt')]);
        if (toolResults === 1) return respond(res, [exec('echo test > review-write-attempt.txt')]);
        if (toolResults === 2) return respond(res, [exec(`echo test > '${outsidePath}'`)]);
        const cat = input.find((i) => i.type === 'function_call_output' && i.call_id === 'call_fc_1')?.output ?? '';
        return respond(res, [msgItem('msg', String(cat).trim())]);
      }
      if (marker) {
        if (toolResults === 0) return respond(res, [exec(`printf '${marker}' > duo-writer-proof.txt`)]);
        if (toolResults === 1) return respond(res, [exec(`echo test > '${outsidePath}'`)]);
        return respond(res, [msgItem('msg', 'done')]);
      }
      // Escape-only script for the temp-dir canary below.
      if (toolResults === 0 && outsidePath) return respond(res, [exec(`echo test > '${outsidePath}'`)]);
      return respond(res, [msgItem('msg', 'done')]);
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const a = server.address();
  if (!a || typeof a === 'string') throw new Error('no port');
  return { url: `http://127.0.0.1:${a.port}/v1`, hits: () => hits, close: () => new Promise((done) => { server.closeAllConnections(); server.close(() => done()); }) };
}

function deepSeekConfig(baseUrl: string) {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.deepseek.enabled = true;
  cfg.deepseek.models = ['deepseek-flash'];
  return { cfg, baseUrl };
}

test('DeepSeek writer readiness through the real Codex sandbox: workspace write lands, outside write is blocked', { skip: !linux, timeout: 120_000 }, async () => {
  const ep = await fakeDeepSeek();
  process.env.DEEPSEEK_API_KEY = 'ds-secret-for-test-only';
  try {
    const { cfg, baseUrl } = deepSeekConfig(ep.url);
    const store = new ReadinessStore({ deepseekBaseUrl: baseUrl });
    const write = await store.check(cfg, 'deepseek:deepseek-flash', 'write', { confirmCost: true });
    assert.equal(write.status, 'write-verified', `writer must be verified; got ${write.status}: ${write.detail}`);
    assert.match(write.write!.detail, /a write outside the workspace was blocked/);
    assert.ok(ep.hits() >= 4, `the real codex loop must have run (saw ${ep.hits()} requests)`);
    assert.doesNotMatch(JSON.stringify(write), /ds-secret-for-test-only/);
  } finally {
    await ep.close();
    delete process.env.DEEPSEEK_API_KEY;
  }
});

test('DeepSeek reviewer readiness through the real Codex sandbox: workspace and outside writes are both denied', { skip: !linux, timeout: 120_000 }, async () => {
  const ep = await fakeDeepSeek();
  process.env.DEEPSEEK_API_KEY = 'ds-secret-for-test-only';
  try {
    const { cfg, baseUrl } = deepSeekConfig(ep.url);
    const store = new ReadinessStore({ deepseekBaseUrl: baseUrl });
    const review = await store.check(cfg, 'deepseek:deepseek-flash', 'review', { confirmCost: true });
    assert.equal(review.status, 'read-verified', `reviewer must be verified; got ${review.status}: ${review.detail}`);
    assert.match(review.review!.detail, /did not change the workspace/);
    assert.ok(ep.hits() >= 5, `the real codex loop must have run (saw ${ep.hits()} requests)`);
  } finally {
    await ep.close();
    delete process.env.DEEPSEEK_API_KEY;
  }
});

test('canary: Codex sandbox keeps the system temp dir writable, which is why the boundary sentinel must not live there', { skip: !linux, timeout: 90_000 }, async () => {
  // Documents the observed behavior of Codex 0.166.0's Linux sandbox (bubblewrap recipe leaves
  // /tmp writable for helper binaries and temp files). If a future Codex release hardens this,
  // this canary fails and the fixture comment in src/readiness.ts should be revisited; it does
  // not make Duo's boundary weaker either way.
  const ep = await fakeDeepSeek();
  try {
    const root = mkdtempSync(join(tmpdir(), 'duo-canary-'));
    const ws = join(root, 'ws');
    const outside = join(tmpdir(), `duo-canary-out-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(ws, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(ws, 'README.md'), 'canary\n');
    const home = join(root, 'codex-home');
    mkdirSync(home, { recursive: true });
    const prompt = `try to create ${join(outside, 'escape.txt')} containing the word test`;
    const args = [...codex!.args, 'exec', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules', '--ephemeral', '--json',
      '--sandbox', 'workspace-write', '-m', 'deepseek-flash',
      '-c', 'model_provider="canary"', '-c', 'model_providers.canary.name="Canary"',
      '-c', `model_providers.canary.base_url="${ep.url}"`, '-c', 'model_providers.canary.wire_api="responses"',
      '-c', 'model_providers.canary.env_key="CANARY_KEY"',
      '-c', `model_catalog_json="${join(process.cwd(), 'test', 'fakes', 'deepseek-catalog.json')}"`,
      '-c', 'web_search="disabled"', '-'];
    const env: NodeJS.ProcessEnv = { ...process.env, CANARY_KEY: 'canary-secret', CODEX_HOME: home };
    delete env.OPENAI_API_KEY; delete env.CODEX_API_KEY;
    // Async spawn, not spawnSync: Codex 0.166.0 hangs under spawnSync's stdio handling
    // (observed: exits after turn.started without reaching the endpoint).
    const run = await new Promise<{ code: number | null; err: string }>((resolve) => {
      const proc = spawn(codex!.command, args, { cwd: ws, env, stdio: ['pipe', 'pipe', 'pipe'] });
      let err = '';
      proc.stdin.end(prompt);
      proc.stderr.on('data', (b: Buffer) => (err = (err + b.toString()).slice(-8000)));
      const timer = setTimeout(() => { proc.kill('SIGKILL'); }, 45_000);
      proc.on('close', (code) => { clearTimeout(timer); resolve({ code, err }); });
    });
    assert.equal(run.code, 0, `canary codex run failed: ${run.err.slice(-800)}`);
    assert.ok(existsSync(join(outside, 'escape.txt')), 'expected the sandbox to allow a write under the temp dir (its own writable area)');
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  } finally {
    await ep.close();
  }
});

test('probe fixtures leave nothing behind outside their disposable roots', { skip: !linux }, () => {
  const leftovers = readdirSync(homedir()).filter((d) => d.startsWith('.duo-readiness-out-'));
  assert.deepEqual(leftovers, [], 'boundary sentinel folders must be removed after probes');
});
