#!/usr/bin/env node
// Stand-in for git in tests that need a slow or hung repository: put its folder first on PATH
// (as `git`) and set FAKE_GIT_REAL to the real git. `status` waits FAKE_GIT_STATUS_MS first
// (FAKE_GIT_STATUS_MS=hang never answers); every call is passed on to the real git.
import { spawnSync } from 'node:child_process';
import { record } from './common.mjs';

const args = process.argv.slice(2);
if (args.includes('status')) {
  record({ cli: 'git', action: 'status' });
  const wait = process.env.FAKE_GIT_STATUS_MS;
  if (wait === 'hang') setInterval(() => undefined, 1 << 30);
  else await new Promise((r) => setTimeout(r, Number(wait ?? 0)));
}
if (process.env.FAKE_GIT_STATUS_MS !== 'hang' || !args.includes('status')) {
  const r = spawnSync(process.env.FAKE_GIT_REAL || 'git', args, { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}
