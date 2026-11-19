import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assignModels, type AssignmentOptions } from '../src/assignment.ts';

const baseline: AssignmentOptions = {
  requested: ['codex:default', 'claude:default'],
  assignment: { mode: 'automatic', preference: 'local-first' },
  defaults: { codex: 'codex:gpt-6-sol', claude: 'claude:sonnet' },
  optional: [
    { spec: 'qwen:qwen3-coder-plus+profile=remote', engine: 'qwen', label: 'Hosted', location: 'cloud', review: true, write: true },
    { spec: 'qwen:local-coder+profile=local', engine: 'qwen', label: 'Local', location: 'device', review: true, write: true },
  ],
  availability: { claude: true, codex: true },
  slots: ['write', 'read'],
  pair: true,
};

test('automatic Local First selects a verified local Qwen writer and an independent cloud reviewer', () => {
  const result = assignModels(baseline);
  assert.deepEqual(result.seats, ['qwen:local-coder+profile=local', 'codex:gpt-6-sol']);
  assert.match(result.reasons[0], /writer tests passed/);
  assert.match(result.reasons[0], /on this device/);
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

test('unverified optional models do not enter automatic selection; manual is unchanged', () => {
  const unverified = { ...baseline, optional: [], availability: { claude: false, codex: true } };
  assert.throws(() => assignModels(unverified), /independent/);
  assert.deepEqual(assignModels({ ...unverified, assignment: { mode: 'manual', preference: 'local-first' } }).seats, baseline.requested);
  assert.throws(() => assignModels({ ...baseline, assignment: { mode: 'hybrid', preference: 'local-first', overrides: [-1] } }), /override index/);
});

test('a reviewer-only model is never assigned to a writer slot, and no slot is filled by substitution', () => {
  const reviewOnly: AssignmentOptions = { ...baseline, availability: { claude: false, codex: false },
    optional: [{ spec: 'qwen:local-coder+profile=local', engine: 'qwen', label: 'Local', location: 'device', review: true, write: false }] };
  assert.throws(() => assignModels(reviewOnly), /Seat 1 \(writer\): no agent is eligible/);
  const ask = assignModels({ ...reviewOnly, pair: false, slots: ['read', 'read'], requested: ['a', 'b'] });
  assert.deepEqual(ask.seats, ['qwen:local-coder+profile=local', 'qwen:local-coder+profile=local']);
  assert.match(ask.reasons[0], /reviewer test passed/);
  const writerOnly: AssignmentOptions = { ...baseline, availability: { claude: true, codex: false },
    optional: [{ spec: 'codex:deepseek-flash+provider=deepseek', engine: 'codex', label: 'DeepSeek deepseek-flash', location: 'cloud', review: false, write: true }] };
  // Claude takes the writer slot; the only other candidate cannot review, so assignment fails explicitly.
  assert.throws(() => assignModels({ ...writerOnly, assignment: { mode: 'automatic', preference: 'cloud-first' } }), /independent/);
  const withCodex = assignModels({ ...writerOnly, availability: { claude: true, codex: true }, assignment: { mode: 'automatic', preference: 'cloud-first' } });
  assert.deepEqual(withCodex.seats, ['codex:gpt-6-sol', 'claude:sonnet']);
});
