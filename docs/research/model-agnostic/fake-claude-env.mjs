#!/usr/bin/env node
// NON-PRODUCTION FEASIBILITY FAKE. Records the argv and provider-related environment that
// claw-orchestrator gives a Claude Code process, then delegates to Duo's existing fake Claude CLI
// (test/fakes/claude.mjs) so the stream-json conversation still works. Used only by probe.mjs.
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

if (process.env.PROBE_LOG && process.argv[2] !== '--version') {
  const i = process.argv.indexOf('--model');
  appendFileSync(process.env.PROBE_LOG, JSON.stringify({
    cli: 'claude',
    model: i >= 0 ? process.argv[i + 1] : null,
    ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL ?? null,
    // Never log the value of a credential, only whether one arrived.
    hasAuthToken: !!process.env.ANTHROPIC_AUTH_TOKEN,
  }) + '\n');
}
await import(pathToFileURL(join(import.meta.dirname, '..', '..', '..', 'test', 'fakes', 'claude.mjs')).href);
