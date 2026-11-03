#!/usr/bin/env node
// NON-PRODUCTION FEASIBILITY FAKE. Stand-in for `opencode run --format json` used only by probe.mjs.
// It records how claw-orchestrator invoked it and answers with opencode-shaped NDJSON events.
// It proves nothing about the real OpenCode CLI or any model behind it.
import { appendFileSync } from 'node:fs';

const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('0.0.0-fake-opencode');
  process.exit(0);
}
const message = args[0] === 'run' ? args[1] : '';
const at = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
if (process.env.PROBE_LOG) {
  appendFileSync(process.env.PROBE_LOG, JSON.stringify({
    cli: 'opencode',
    args: args.map((a) => (a === message ? `<message ${a.length} chars>` : a)),
    messageOnArgv: args[1] === message && message.length > 0,
    messageLength: message.length,
    messageStartsWithSystemText: message.startsWith('<probe_system>'),
    readOnlyAgentConfig: process.env.OPENCODE_CONFIG_CONTENT ? JSON.parse(process.env.OPENCODE_CONFIG_CONTENT) : null,
    session: at('--session') ?? null,
    agent: at('--agent') ?? null,
    model: at('--model') ?? null,
    variant: at('--variant') ?? null,
    hasSchemaFlag: args.some((a) => /schema/i.test(a)),
  }) + '\n');
}
const sid = at('--session') ?? `ses_fake_${process.pid}`;
const out = (o) => process.stdout.write(JSON.stringify({ timestamp: Date.now(), sessionID: sid, ...o }) + '\n');
out({ type: 'step_start', part: { type: 'step-start' } });
out({ type: 'tool_use', part: { type: 'tool', callID: 'c1', tool: 'read', state: { status: 'completed', input: { filePath: 'README.md' }, output: 'ok' } } });
// Cumulative text snapshots, as the claw wrapper documents for opencode.
out({ type: 'text', part: { type: 'text', id: 't1', text: '{"answer":' } });
out({ type: 'text', part: { type: 'text', id: 't1', text: '{"answer":"fake opencode reply"}' } });
out({ type: 'step_finish', part: { type: 'step-finish', tokens: { input: 120, output: 30, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0 } });
