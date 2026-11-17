/** Deterministic role selection: no model-quality guesses, benchmarks or price estimates. */
import type { QwenProfile } from './config.ts';

export type AssignmentMode = 'manual' | 'automatic' | 'hybrid';
export type AssignmentPreference = 'local-first' | 'best-fit' | 'cloud-first';
export interface AssignmentRequest {
  mode: AssignmentMode;
  preference: AssignmentPreference;
  /** Zero-based role slots explicitly owned by the user in hybrid mode. */
  overrides?: number[];
}
export interface AssignmentAvailability { codex: boolean; claude: boolean; qwen: boolean; }
export interface AssignmentOptions {
  requested: string[];
  assignment: AssignmentRequest;
  defaults: { codex: string; claude: string; qwen: string; };
  profiles: Record<string, QwenProfile>;
  verified: ReadonlySet<string>;
  availability: AssignmentAvailability;
  pair: boolean;
}

export function assignModels(o: AssignmentOptions): { seats: string[]; reasons: string[]; } {
  const { mode, preference } = o.assignment;
  if (!['manual', 'automatic', 'hybrid'].includes(mode) || !['local-first', 'best-fit', 'cloud-first'].includes(preference)) throw new Error('invalid assignment mode or preference');
  if (mode === 'manual') return { seats: [...o.requested], reasons: ['Manual: all agent assignments are yours'] };
  const local = Object.entries(o.profiles).filter(([id, p]) => p.kind === 'local' && o.verified.has(id)).sort(([a], [b]) => a.localeCompare(b));
  const hosted = Object.entries(o.profiles).filter(([id, p]) => p.kind === 'hosted' && o.verified.has(id)).sort(([a], [b]) => a.localeCompare(b));
  const profileSpecs = (entries: [string, QwenProfile][]) => entries.map(([id, p]) => ({ spec: `qwen:${p.model}+profile=${id}`, engine: 'qwen', why: `${p.kind} Qwen profile ${id}: tool-use test passed` }));
  const cloud = [
    ...(o.availability.codex ? [{ spec: o.defaults.codex, engine: 'codex', why: 'Codex CLI available' }] : []),
    ...(o.availability.claude ? [{ spec: o.defaults.claude, engine: 'claude', why: 'Claude CLI available' }] : []),
  ];
  const qwenLocal = o.availability.qwen ? profileSpecs(local) : [];
  const qwenHosted = o.availability.qwen ? profileSpecs(hosted) : [];
  const candidates = preference === 'local-first' ? [...qwenLocal, ...cloud, ...qwenHosted]
    : preference === 'cloud-first' ? [...cloud, ...qwenHosted, ...qwenLocal]
      : [...cloud, ...qwenLocal, ...qwenHosted];
  if (!candidates.length) throw new Error('no eligible agents: install a CLI and verify Qwen profiles with the tool-use test');
  const overrides = new Set(mode === 'hybrid' ? o.assignment.overrides ?? [] : []);
  if ([...overrides].some((i) => !Number.isInteger(i) || i < 0 || i >= o.requested.length)) throw new Error('invalid hybrid override index');
  const seats: string[] = [];
  const reasons: string[] = [];
  for (let i = 0; i < o.requested.length; i++) {
    if (overrides.has(i)) {
      seats.push(o.requested[i]);
      reasons.push(`Seat ${i + 1}: user override`);
      continue;
    }
    const priorEngine = o.pair && i === 1 ? seats[0]?.split(':', 1)[0] : undefined;
    const eligible = candidates.filter((c) => c.engine !== priorEngine);
    if (!eligible.length) throw new Error('Pair review needs an independent available engine; select a different reviewer manually');
    const picked = eligible[i === 0 ? 0 : (o.pair ? 0 : i % eligible.length)];
    seats.push(picked.spec);
    reasons.push(`Seat ${i + 1}: ${picked.why}; ${preference.replace('-', ' ')} ordering`);
  }
  return { seats, reasons };
}
