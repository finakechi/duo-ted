import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { gitState } from '../src/server/fsapi.ts';

const repo = mkdtempSync(join(tmpdir(), 'duo-fsapi-'));
after(() => rmSync(repo, { recursive: true, force: true }));
const git = (...args: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], { stdio: 'ignore' });
execFileSync('git', ['init', '-q', repo]);
writeFileSync(join(repo, 'big.txt'), 'start\n');
writeFileSync(join(repo, 'small.txt'), 'one\n');
git('add', '-A'); git('commit', '-qm', 'init');

test('the Changes panel shows a large working-tree diff truncated, not the staged diff', () => {
  // Over the 4 MiB buffer git output used to be read into.
  writeFileSync(join(repo, 'big.txt'), Array.from({ length: 120_000 }, (_, i) => `changed line ${i} ${'x'.repeat(30)}`).join('\n'));
  writeFileSync(join(repo, 'small.txt'), 'two\n');
  git('add', 'small.txt'); // staged: only the small change
  const s = gitState(repo);
  assert.equal(s.repo, true);
  if (!s.repo) return;
  assert.match(s.diff, /big\.txt/, 'the unstaged big change is missing from the diff');
  assert.match(s.diff, /diff truncated/);
  assert.ok(s.diff.length < 500_000);
  assert.deepEqual(s.files.map((f) => f.path).sort(), ['big.txt', 'small.txt']);
});

test('a small diff is shown whole', () => {
  git('checkout', '--', '.'); git('reset', '-q', '--hard');
  writeFileSync(join(repo, 'small.txt'), 'three\n');
  const s = gitState(repo);
  assert.ok(s.repo && /\+three/.test(s.diff) && !/truncated/.test(s.diff));
});

// Ported from the Codex maintenance review.
test('Changes treats NUL-delimited rename sources as paths, even when they look like status entries', () => {
  const dir = mkdtempSync(join(tmpdir(), 'duo-git-state-'));
  const g = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' });
  try {
    g('init', '--quiet');
    const source = ' M source with spaces.txt';
    const target = 'renamed with spaces.txt';
    writeFileSync(join(dir, source), 'rename me\n');
    g('add', '--all');
    g('-c', 'user.name=Test', '-c', 'user.email=test@localhost', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'initial');
    renameSync(join(dir, source), join(dir, target));
    writeFileSync(join(dir, 'untracked.txt'), 'hello');
    g('add', '--', target, source);
    const state = gitState(dir);
    assert.equal(state.repo, true);
    if (state.repo) assert.deepEqual(state.files, [{ status: 'R', path: target }, { status: '??', path: 'untracked.txt' }]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
