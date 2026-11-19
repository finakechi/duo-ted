/** Deterministic role selection: no model-quality guesses, benchmarks or price estimates.
 * An optional model (DeepSeek, a Qwen endpoint profile) is a candidate only for the roles its
 * readiness tests proved; Codex and Claude Code are eligible for every role. Nothing is ever
 * substituted silently: when a slot has no eligible agent, assignment fails with the reason. */
import type { EndpointLocation } from './config.ts';

export type AssignmentMode = 'manual' | 'automatic' | 'hybrid';
export type AssignmentPreference = 'local-first' | 'best-fit' | 'cloud-first';
export type RoleNeed = 'read' | 'write';
export interface AssignmentRequest {
  mode: AssignmentMode;
  preference: AssignmentPreference;
  /** Zero-based role slots explicitly owned by the user in hybrid mode. */
  overrides?: number[];
}
export interface AssignmentAvailability { codex: boolean; claude: boolean; }
/** An optional model with its verified roles (from the readiness tests of this Duo session). */
export interface OptionalCandidate { spec: string; engine: 'qwen' | 'codex'; label: string; location: EndpointLocation; review: boolean; write: boolean; }
export interface AssignmentOptions {
  requested: string[];
  assignment: AssignmentRequest;
  defaults: { codex: string; claude: string; };
  optional: OptionalCandidate[];
  availability: AssignmentAvailability;
  /** What each slot's role needs; a missing entry reads. */
  slots: RoleNeed[];
  pair: boolean;
}

interface Candidate { spec: string; engine: string; why: string; review: boolean; write: boolean; }

export function assignModels(o: AssignmentOptions): { seats: string[]; reasons: string[]; } {
  const { mode, preference } = o.assignment;
  if (!['manual', 'automatic', 'hybrid'].includes(mode) || !['local-first', 'best-fit', 'cloud-first'].includes(preference)) throw new Error('invalid assignment mode or preference');
  if (mode === 'manual') return { seats: [...o.requested], reasons: ['Manual: all agent assignments are yours'] };
  const where = (l: EndpointLocation) => (l === 'device' ? 'on this device' : l === 'lan' ? 'on your network' : 'cloud');
  const optional = (c: OptionalCandidate): Candidate => ({ spec: c.spec, engine: c.engine, review: c.review, write: c.write,
    why: `${c.label} (${where(c.location)}): ${c.write && c.review ? 'reviewer and writer tests passed' : c.write ? 'writer test passed' : 'reviewer test passed'}` });
  const local = o.optional.filter((c) => c.location !== 'cloud').sort((a, b) => a.spec.localeCompare(b.spec)).map(optional);
  const hosted = o.optional.filter((c) => c.location === 'cloud').sort((a, b) => a.spec.localeCompare(b.spec)).map(optional);
  const cloud: Candidate[] = [
    ...(o.availability.codex ? [{ spec: o.defaults.codex, engine: 'codex', why: 'Codex CLI available', review: true, write: true }] : []),
    ...(o.availability.claude ? [{ spec: o.defaults.claude, engine: 'claude', why: 'Claude CLI available', review: true, write: true }] : []),
  ];
  const candidates = preference === 'local-first' ? [...local, ...cloud, ...hosted]
    : preference === 'cloud-first' ? [...cloud, ...hosted, ...local]
      : [...cloud, ...local, ...hosted];
  if (!candidates.length) throw new Error('no eligible agents: install Codex or Claude Code, or pass the role tests for an optional model in Settings');
  const overrides = new Set(mode === 'hybrid' ? o.assignment.overrides ?? [] : []);
  if ([...overrides].some((i) => !Number.isInteger(i) || i < 0 || i >= o.requested.length)) throw new Error('invalid hybrid override index');
  const seats: string[] = [];
  const reasons: string[] = [];
  for (let i = 0; i < o.requested.length; i++) {
    const need = o.slots[i] ?? 'read';
    const role = need === 'write' ? 'writer' : o.pair ? 'reviewer' : 'participant';
    if (overrides.has(i)) {
      seats.push(o.requested[i]);
      reasons.push(`Seat ${i + 1} (${role}): user override`);
      continue;
    }
    const priorEngine = o.pair && i === 1 ? seats[0]?.split(':', 1)[0] : undefined;
    const fit = candidates.filter((c) => (need === 'write' ? c.write : c.review));
    const eligible = fit.filter((c) => c.engine !== priorEngine && !(o.pair && i === 1 && c.spec === seats[0]));
    if (!eligible.length) {
      throw new Error(o.pair && i === 1 && fit.length
        ? 'Pair review needs an independent available engine; select a different reviewer manually'
        : `Seat ${i + 1} (${role}): no agent is eligible. Install Codex or Claude Code, or pass the ${need === 'write' ? 'writer' : 'reviewer'} test for an optional model in Settings`);
    }
    const picked = eligible[i === 0 || o.pair ? 0 : i % eligible.length];
    seats.push(picked.spec);
    reasons.push(`Seat ${i + 1} (${role}): ${picked.why}; ${preference.replace('-', ' ')} ordering`);
  }
  return { seats, reasons };
}
