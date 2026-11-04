// Chat lifecycle races and persistence: deletion during startup, late and duplicate CLI events,
// shutdown mid-answer, permission-bridge files left by a crash, and chats saved by earlier
// versions. The claw session manager is stubbed; nothing reaches a real CLI or real chat folder.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test, type TestContext } from 'node:test';

const temp = mkdtempSync(join(tmpdir(), 'duo-chat-races-'));
Object.assign(process.env, { DUO_HOME: temp, DUO_CONFIG: join(temp, 'config.json') });
const { ChatManager } = await import('../src/server/chats.ts');
const { PermissionBroker } = await import('../src/server/permissions.ts');
const { loadConfig } = await import('../src/config.ts');
after(() => rmSync(temp, { recursive: true, force: true }));

const dir = (sub: string) => join(temp, 'gui', sub);
const deferred = <T = void>() => { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };
async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 300 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(check(), what);
}

function setup(t: TestContext) {
  const events: any[] = [];
  const bus = { emit: (e: any) => events.push(structuredClone(e)), add: () => undefined } as any;
  const bin = { command: process.execPath, args: [], env: {}, display: 'node' };
  const cm = new ChatManager(bus, loadConfig(), { claude: bin, codex: bin }, new PermissionBroker(bus), { url: 'http://127.0.0.1:1', token: 'launch-token' }, 'mcp.ts');
  const manager = (cm as any).manager;
  const stopped: string[] = [];
  let release: ((r: unknown) => void) | undefined;
  t.mock.method(manager, 'startSession', async () => ({}));
  t.mock.method(manager, 'hasSession', () => true);
  t.mock.method(manager, 'stopSession', async (name: string) => { stopped.push(name); release?.({ error: 'session stopped' }); });
  // By default a turn waits until its session is stopped, like a model still answering.
  t.mock.method(manager, 'sendMessage', () => new Promise((r) => { release = r; }));
  t.after(() => cm.close());
  const line = (id: string, e: unknown) => (cm as any).onLine(id, JSON.stringify(e));
  return { cm, manager, events, stopped, line };
}
const assistant = (id: string, text: string) => ({ type: 'assistant', message: { id, content: [{ type: 'text', text }] } });
const result = (cost: number) => ({ type: 'result', subtype: 'success', is_error: false, result: 'ok', usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: cost, model_usage_since_last_result: { 'claude-x': { inputTokens: 1, outputTokens: 1, costUSD: 0.01, costBasis: 'list' } } });

test('deleting a chat while its CLI is still starting removes everything and stops the late CLI', async (t) => {
  const { cm, manager, events, stopped } = setup(t);
  const gate = deferred();
  t.mock.method(manager, 'startSession', async () => { await gate.promise; return {}; });
  const send = t.mock.method(manager, 'sendMessage', async () => ({}));
  const chat = cm.create({ engine: 'claude', cwd: temp, access: 'ask' }); // "ask" writes a permission-bridge file
  cm.send(chat.id, 'hello');
  await until(() => existsSync(join(dir('mcp'), `${chat.id}.json`)), 'the bridge file is written while the CLI starts');
  const removing = cm.remove(chat.id);
  gate.resolve();
  await removing;
  assert.equal(send.mock.callCount(), 0, 'the message is never sent to a deleted chat');
  assert.equal(stopped.length, 1, 'the CLI that finished starting is stopped');
  for (const sub of ['chats', 'mcp']) assert.equal(existsSync(join(dir(sub), `${chat.id}.json`)), false, `${sub} file left behind`);
  const removed = events.findIndex((e) => e.t === 'chat_removed');
  assert.ok(removed >= 0);
  assert.equal(events.slice(removed + 1).some((e) => e.chat === chat.id || e.chat?.id === chat.id), false);
});

test('a duplicated assistant message or result is counted once', async (t) => {
  const { cm, manager, line } = setup(t);
  const chat = cm.create({ engine: 'claude', cwd: temp });
  t.mock.method(manager, 'sendMessage', async () => {
    for (const e of [assistant('m1', 'answer'), assistant('m1', 'answer'), result(0.01), result(0.01)]) line(chat.id, e);
    return {};
  });
  const turn = cm.send(chat.id, 'hello');
  await until(() => turn.status !== 'running', 'the turn ends');
  assert.equal(turn.blocks.filter((b) => b.kind === 'text').length, 1);
  assert.equal(turn.usd, 0.01);
});

test('events that arrive after a turn ended change neither it nor the next turn', async (t) => {
  const { cm, manager, line } = setup(t);
  const chat = cm.create({ engine: 'claude', cwd: temp });
  let n = 0;
  t.mock.method(manager, 'sendMessage', async () => {
    n++;
    line(chat.id, assistant(`m${n}`, `answer ${n}`));
    line(chat.id, result(0.01 * n));
    return {};
  });
  const first = cm.send(chat.id, 'one');
  await until(() => first.status !== 'running', 'turn 1 ends');
  const before = structuredClone(first);
  line(chat.id, assistant('late', 'a late line from the first turn'));
  const second = cm.send(chat.id, 'two');
  await until(() => second.status !== 'running', 'turn 2 ends');
  assert.deepEqual(cm.get(chat.id).turns[0], before);
  assert.deepEqual(second.blocks.map((b) => b.text), ['answer 2']);
});

test('quitting while a chat answers saves the turn as stopped and clears the bridge file', async (t) => {
  const { cm } = setup(t);
  const chat = cm.create({ engine: 'claude', cwd: temp, access: 'ask' });
  const turn = cm.send(chat.id, 'hello');
  await until(() => existsSync(join(dir('mcp'), `${chat.id}.json`)), 'the CLI started');
  await cm.close();
  assert.equal(turn.status, 'stopped');
  const saved = JSON.parse(readFileSync(join(dir('chats'), `${chat.id}.json`), 'utf8'));
  assert.equal(saved.turns[0].status, 'stopped');
  assert.equal(existsSync(join(dir('mcp'), `${chat.id}.json`)), false);
  assert.throws(() => cm.send(chat.id, 'again'), /closing/);
});

test('permission-bridge files a crashed launch left behind, with its token, are removed at start', async (t) => {
  mkdirSync(dir('mcp'), { recursive: true });
  const stale = join(dir('mcp'), 'crashed-chat.json');
  writeFileSync(stale, JSON.stringify({ mcpServers: { duo: { env: { DUO_API_TOKEN: 'token-of-a-dead-launch' } } } }));
  setup(t);
  assert.equal(existsSync(stale), false, 'an expired launch token stays on disk');
});

test('chats saved by earlier versions load, and interrupted or corrupt saves do not break loading', async (t) => {
  mkdirSync(dir('chats'), { recursive: true });
  const old = {
    id: 'saved-0-3-0', title: 'From 0.3.0', engine: 'codex', spec: 'codex:gpt-6-sol@medium', access: 'workspace', cwd: temp, useCodexConfig: false,
    createdAt: '2026-10-08T10:00:00.000Z', updatedAt: '2026-10-08T10:05:00.000Z', codexThreadId: 'thread-old',
    turns: [
      { id: 't1', user: 'hi', at: '2026-10-08T10:00:00.000Z', spec: 'codex:gpt-6-sol@medium', access: 'workspace', blocks: [{ id: 'b', kind: 'text', text: 'hello' }], status: 'done', credits: 0.04 },
      { id: 't2', user: 'more', at: '2026-10-08T10:05:00.000Z', spec: 'codex:gpt-6-sol@medium', access: 'workspace', blocks: [], status: 'running' },
    ],
  };
  writeFileSync(join(dir('chats'), 'saved-0-3-0.json'), JSON.stringify(old));
  writeFileSync(join(dir('chats'), 'half-written.json'), '{"id": "half-wr');
  writeFileSync(join(dir('chats'), 'mid-save.json.tmp'), '{"id": "mid-save"}');
  const empty = join(dir('chats'), 'empty-old.json');
  writeFileSync(empty, JSON.stringify({ ...old, id: 'empty-old', turns: [] }));
  utimesSync(empty, new Date(Date.now() - 3600_000), new Date(Date.now() - 3600_000));
  const { cm } = setup(t);
  const s = cm.get('saved-0-3-0');
  assert.equal(s.turns[0].credits, 0.04);
  assert.equal(s.turns[1].status, 'stopped', 'a turn running when the app closed is shown stopped');
  assert.equal(s.codexThreadId, 'thread-old', 'the conversation can still be resumed');
  assert.throws(() => cm.get('half-written'));
  assert.equal(existsSync(empty), false, 'an empty chat from an older version is cleared');
  assert.ok(existsSync(join(dir('chats'), 'half-written.json')), 'a corrupt file is left alone, not deleted');
  // Saving goes through a temporary file, so a crash mid-write cannot leave a half-written chat.
  cm.update('saved-0-3-0', { title: 'Renamed' });
  assert.equal(JSON.parse(readFileSync(join(dir('chats'), 'saved-0-3-0.json'), 'utf8')).title, 'Renamed');
  assert.equal(readdirSync(dir('chats')).some((f) => f === 'saved-0-3-0.json.tmp'), false);
});
