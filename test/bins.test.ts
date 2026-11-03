import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { binVersion, runBinAsync, type BinSpec } from '../src/bins.ts';

const tmp = mkdtempSync(join(tmpdir(), 'duo-bins-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

function fakeCli(version: string): { bin: BinSpec; calls: () => number } {
  const script = join(tmp, 'cli.mjs');
  const log = join(tmp, 'calls.log');
  writeFileSync(script, `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(log)}, 'x');\nconsole.log(${JSON.stringify(version)});\n`);
  writeFileSync(log, '');
  return { bin: { command: process.execPath, args: [script], env: {}, display: script }, calls: () => readFileSync(log, 'utf8').length };
}

test('binVersion asks a CLI once and again only after the binary changes', () => {
  const { bin, calls } = fakeCli('1.0.0');
  assert.equal(binVersion(bin), '1.0.0');
  assert.equal(binVersion(bin), '1.0.0');
  assert.equal(calls(), 1, 'the second call reuses the remembered version');
  // An update rewrites the file.
  appendFileSync(bin.args[0], `console.log('2.0.0');\n`);
  assert.equal(binVersion(bin), '1.0.0\n2.0.0');
  assert.equal(calls(), 2);
});

test('binVersion does not remember a CLI that could not run', () => {
  const missing: BinSpec = { command: join(tmp, 'no-such-cli'), args: [], env: {}, display: 'missing' };
  assert.equal(binVersion(missing), 'unknown');
  assert.equal(binVersion(missing), 'unknown');
});

test('runBinAsync feeds stdin, collects output and enforces its timeout', async () => {
  const echo: BinSpec = { command: process.execPath, args: ['-e', 'process.stdin.pipe(process.stdout)'], env: {}, display: 'echo' };
  const r = await runBinAsync(echo, [], { input: 'hello' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, 'hello');
  const hang: BinSpec = { command: process.execPath, args: ['-e', 'setTimeout(() => {}, 60_000)'], env: {}, display: 'hang' };
  const t0 = Date.now();
  const slow = await runBinAsync(hang, [], { timeout: 300 });
  assert.ok(Date.now() - t0 < 5000);
  assert.match(slow.error?.message ?? '', /timed out/);
  const gone = await runBinAsync({ command: join(tmp, 'no-such-cli'), args: [], env: {}, display: 'missing' }, []);
  assert.equal(gone.status, null);
  assert.ok(gone.error);
});
