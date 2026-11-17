import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assignModels, type AssignmentOptions } from '../src/assignment.ts';

const baseline: AssignmentOptions = {
  requested: ['codex:default', 'claude:default'],
  assignment: { mode: 'automatic', preference: 'local-first' },
  defaults: { codex: 'codex:gpt-6-sol', claude: 'claude:sonnet', qwen: 'qwen:qwen3-coder-plus' },
  profiles: {
    remote: { name: 'Hosted', kind: 'hosted', model: 'qwen3-coder-plus', baseUrl: 'https://example.invalid/v1' },
    local: { name: 'Local', kind: 'local', model: 'local-coder', baseUrl: 'http://127.0.0.1:11434/v1' },
  },
  verified: new Set(['local', 'remote']),
  availability: { claude: true, codex: true, qwen: true },
  pair: true,
};

test('automatic Local First selects verified local Qwen writer and an independent cloud reviewer', () => {
  const result = assignModels(baseline);
  assert.deepEqual(result.seats, ['qwen:local-coder+profile=local', 'codex:gpt-6-sol']);
  assert.match(result.reasons[0], /tool-use test passed/);
});

test('Cloud First and Best Fit use deterministic eligibility rather than fabricated quality', () => {
  const cloud = assignModels({ ...baseline, assignment: { mode: 'automatic', preference: 'cloud-first' } });
  const fit = assignModels({ ...baseline, assignment: { mode: 'automatic', preference: 'best-fit' } });
  assert.deepEqual(cloud.seats, ['codex:gpt-6-sol', 'claude:sonnet']);
  assert.deepEqual(fit.seats, cloud.seats);
});

test('hybrid override preserves the selected writer and selects a distinct reviewer', () => {
  const hybrid = assignModels({ ...baseline, requested: ['claude:opus', 'codex:placeholder'], assignment: { mode: 'hybrid', preference: 'cloud-first', overrides: [0] } });
  assert.deepEqual(hybrid.seats, ['claude:opus', 'codex:gpt-6-sol']);
  assert.match(hybrid.reasons[0], /user override/);
});

test('unverified Qwen profiles do not enter automatic selection; manual is unchanged', () => {
  const unverified = { ...baseline, verified: new Set<string>(), availability: { claude: false, codex: true, qwen: true } };
  assert.throws(() => assignModels(unverified), /independent/);
  assert.deepEqual(assignModels({ ...unverified, assignment: { mode: 'manual', preference: 'local-first' } }).seats, baseline.requested);
  assert.throws(() => assignModels({ ...baseline, assignment: { mode: 'hybrid', preference: 'local-first', overrides: [-1] } }), /override index/);
});
