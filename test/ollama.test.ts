/**
 * Ollama endpoint diagnostics: version fingerprinting, served-context reading and the
 * context-window remediation text. These helpers are pure HTTP reads of the server's own status
 * endpoints; they never load a model or generate text, and cloud endpoints are never probed.
 */
import assert from 'node:assert/strict';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { after, test } from 'node:test';
import { isOllamaEndpoint, ollamaContextFix, ollamaNativeBase, ollamaServedContext, OLLAMA_RECOMMENDED_CONTEXT, QWEN_MIN_CONTEXT_TOKENS } from '../src/ollama.ts';

const servers: Server[] = [];
after(() => { for (const s of servers) { s.close(); s.closeAllConnections(); } });

async function start(routes: Record<string, unknown | ((res: ServerResponse) => void)>, hits: number[] = []): Promise<string> {
  const server = createServer((req, res) => {
    hits.push(1);
    const path = String(req.url ?? '/').split('?')[0];
    const hit = routes[path];
    if (hit === undefined) { res.writeHead(404).end('not found'); return; }
    if (typeof hit === 'function') { hit(res); return; }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(hit));
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const a = server.address();
  if (!a || typeof a === 'string') throw new Error('no port');
  return `http://127.0.0.1:${a.port}/v1`;
}

test('the native API shares the endpoint host, without the /v1 suffix', () => {
  assert.equal(ollamaNativeBase('http://127.0.0.1:11434/v1'), 'http://127.0.0.1:11434');
  assert.equal(ollamaNativeBase('http://127.0.0.1:11434/v1/'), 'http://127.0.0.1:11434');
  assert.equal(ollamaNativeBase('http://127.0.0.1:11434'), 'http://127.0.0.1:11434');
});

test('an endpoint is Ollama exactly when /api/version answers with a version', async () => {
  const hits: number[] = [];
  const ollama = await start({ '/api/version': { version: '0.40.15' } }, hits);
  const other = await start({}, hits);
  assert.equal(await isOllamaEndpoint(ollama, 'device'), true);
  assert.equal(await isOllamaEndpoint(other, 'device'), false);
  assert.ok(hits.length >= 2);
  // Cloud endpoints are never probed, whatever they might answer.
  assert.equal(await isOllamaEndpoint(ollama, 'cloud'), false);
});

test('the served context window is read from /api/ps for the requested model', async () => {
  const url = await start({ '/api/ps': { models: [
    { name: 'qwen3.5:9b', context_length: 16384 },
    { name: 'other:1b', context_length: 4096 },
  ] } });
  assert.equal(await ollamaServedContext(url, 'qwen3.5:9b'), 16384);
  assert.equal(await ollamaServedContext(url, 'other:1b'), 4096);
  assert.equal(await ollamaServedContext(url, 'missing'), undefined);
});

test('a failing /api/ps and a truncated payload both yield no context', async () => {
  const down = await start({});
  assert.equal(await ollamaServedContext(down, 'm'), undefined);
  const junk = await start({ '/api/ps': { models: 'not-an-array' } });
  assert.equal(await ollamaServedContext(junk, 'm'), undefined);
});

test('the fix text names the model, the served window, the minimum and the exact remedy', () => {
  const text = ollamaContextFix('qwen3.5:9b', 4096);
  assert.match(text, /Ollama served qwen3\.5:9b/);
  assert.match(text, /4,096-token context/);
  assert.match(text, /OLLAMA_CONTEXT_LENGTH=32768/);
  assert.match(text, /systemctl edit ollama/);
  assert.ok(QWEN_MIN_CONTEXT_TOKENS > 4096, '4K can never host the agent prompt');
  assert.equal(OLLAMA_RECOMMENDED_CONTEXT, 32768);
});
