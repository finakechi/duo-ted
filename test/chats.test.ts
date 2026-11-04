// Chat lifecycle in the GUI engine, with the claw SessionManager replaced by a controllable stub.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const tmp = mkdtempSync(join(tmpdir(), 'duo-chats-'));
Object.assign(process.env, { DUO_HOME: join(tmp, 'home'), DUO_CONFIG: join(tmp, 'config.json') });
const { ChatManager } = await import('../src/server/chats.ts');
const { PermissionBroker } = await import('../src/server/permissions.ts');
const { DEFAULT_CONFIG } = await import('../src/config.ts');
after(() => rmSync(tmp, { recursive: true, force: true }));

type Ev = { t: string } & Record<string, any>;
async function setup() {
  const events: Ev[] = [];
  const bus = { emit: (e: Ev) => events.push(e), add: () => undefined } as any;
  const bin = { command: process.execPath, args: [], env: {}, display: 'node' };
  const chats = new ChatManager(bus, structuredClone(DEFAULT_CONFIG), { codex: bin, claude: bin }, new PermissionBroker(bus), { url: 'http://127.0.0.1:1', token: 't' }, 'mcp.ts');
  await (chats as any).manager.shutdown();
  // A turn that only ends when its session is stopped, like a model still working.
  let release: (r: { error?: string }) => void = () => undefined;
  const live = new Set<string>();
  (chats as any).manager = {
    startSession: async (o: { name: string }) => { live.add(o.name); },
    hasSession: (n: string) => live.has(n),
    sendMessage: () => new Promise((r) => { release = r; }),
    stopSession: async (n: string) => { live.delete(n); release({ error: 'session stopped' }); },
    shutdown: async () => undefined,
  };
  return { chats, events };
}

const chatsDir = () => join(tmp, 'home', 'gui', 'chats');

test('deleting a chat while it is answering does not bring it back', async () => {
  const { chats, events } = await setup();
  const c = chats.create({ engine: 'claude', cwd: tmp });
  chats.send(c.id, 'hello');
  await new Promise((r) => setTimeout(r, 50));
  // The raw stream trace exists while the chat does.
  writeFileSync(join(tmp, 'home', 'gui', 'taps', `${c.id}.jsonl`), '{}\n');
  assert.ok(existsSync(join(chatsDir(), `${c.id}.json`)));
  await chats.remove(c.id);
  // Let the stopped turn finish (it waits briefly for the last stream lines).
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(existsSync(join(chatsDir(), `${c.id}.json`)), false, 'the deleted chat was written back to disk');
  assert.equal(existsSync(join(tmp, 'home', 'gui', 'taps', `${c.id}.jsonl`)), false, 'the deleted chat left its trace behind');
  assert.equal(chats.list().some((s) => s.id === c.id), false);
  const removedAt = events.findIndex((e) => e.t === 'chat_removed' && e.id === c.id);
  assert.ok(removedAt >= 0);
  assert.equal(events.slice(removedAt).some((e) => (e.t === 'chat' && e.chat.id === c.id) || (e.t === 'chat_turn_end' && e.chat === c.id)), false, 'the window was told about the deleted chat again');
});

test('stopping a chat still records the stopped turn', async () => {
  const { chats, events } = await setup();
  const c = chats.create({ engine: 'claude', cwd: tmp });
  chats.send(c.id, 'hello');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(chats.stop(c.id), true);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(chats.get(c.id).turns[0].status, 'stopped');
  assert.ok(events.some((e) => e.t === 'chat_turn_end' && e.chat === c.id));
  assert.ok(readdirSync(chatsDir()).includes(`${c.id}.json`));
});
