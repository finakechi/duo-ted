import type { Usage } from './store.ts';

/**
 * What a turn cost, in the unit each provider meters subscription use in.
 *
 * Codex: ChatGPT plans meter Codex in credits, so a Codex turn is priced in credits from the
 * table below (Standard speed, per 1M tokens). These are credit costs, not dollars and not the
 * share of a plan's included usage (Fast draws included usage down at a different multiplier).
 *
 * Claude: Claude Code prices every call itself at its built-in list prices and reports the cost on
 * each result; duo records that figure as an API-equivalent estimate and holds no Claude rates of
 * its own (see claudeTurnCost in tap.ts).
 *
 * Updating: when OpenAI publishes a model or changes a rate, edit CODEX_RATES with the source and
 * date. A model that is not listed is reported as unpriced; it never borrows another model's rate.
 */
export interface CodexRate {
  /** Credits per 1M fresh (uncached) input tokens. */
  input: number;
  /** Credits per 1M cached input tokens. */
  cached: number;
  /** Credits per 1M output tokens (reasoning tokens are part of output). */
  output: number;
  /** Where the rate was read, and when it was last checked. */
  source: string;
}

const RATE_CARD = 'Codex rate card: developers.openai.com/codex/pricing and the help.openai.com ChatGPT rate card, as published on 2026-11-04';

export const CODEX_RATES: Readonly<Record<string, CodexRate>> = {
  'gpt-6-astra': { input: 250, cached: 25, output: 1250, source: RATE_CARD },
  'gpt-6.1-sol': { input: 50, cached: 2.5, output: 250, source: RATE_CARD },
  'gpt-6.1-terra': { input: 25, cached: 1.25, output: 125, source: RATE_CARD },
  'gpt-6-sol': { input: 50, cached: 5, output: 250, source: RATE_CARD },
  'gpt-6-luna': { input: 2.5, cached: 0.25, output: 12.5, source: RATE_CARD },
  // Promotional rate, announced as running at least through 2026-11-21.
  'gpt-5.6-sol': { input: 100, cached: 10, output: 500, source: RATE_CARD },
  'gpt-5.6-terra': { input: 50, cached: 5, output: 300, source: RATE_CARD },
  'gpt-5.6-luna': { input: 5, cached: 0.5, output: 30, source: RATE_CARD },
  // Not found on the November 2026 rate card; kept from the October 2026 card duo shipped with.
  'gpt-5.5': { input: 125, cached: 12.5, output: 750, source: 'Codex pricing page, October 2026 (not re-verified)' },
};

/**
 * Credit multipliers by Codex service tier, for purchased credits: Fast (the `priority` tier)
 * 2x and Ultrafast 6x the Standard rate. Included plan usage is drawn down at other multipliers
 * (2.5x and 8x), which are limits rather than credit prices.
 */
const TIER_MULTIPLIER: Record<string, number> = {
  '': 1, default: 1, auto: 1, standard: 1,
  fast: 2, priority: 2,
  ultrafast: 6,
};

/**
 * The model id as the rate card names it: case-insensitive, without an `openai/` provider prefix
 * or a dated snapshot suffix (gpt-6.1-sol-2026-09-30 is gpt-6.1-sol).
 */
export function canonicalCodexModel(model: string): string {
  return model.trim().toLowerCase().replace(/^openai\//, '').replace(/-\d{4}-\d{2}-\d{2}$/, '');
}

/** The published rate for exactly this model, or undefined; a newer or unknown model never inherits another's. */
export function codexRate(model: string): CodexRate | undefined {
  return CODEX_RATES[canonicalCodexModel(model)];
}

export type CodexPrice = { credits: number; unpriced?: undefined } | { credits?: undefined; unpriced: string };

/** A turn's credit cost, or why it has none. Codex reports input including cached tokens. */
export function codexPrice(model: string, u: Usage, tier?: string): CodexPrice {
  const rate = codexRate(model);
  if (!rate) return { unpriced: `no published Codex credit rate for ${model} in this version of duo` };
  const multiplier = TIER_MULTIPLIER[(tier ?? '').toLowerCase()];
  if (multiplier === undefined) return { unpriced: `unknown Codex service tier "${tier}"` };
  const fresh = Math.max(0, u.input - u.cached);
  return { credits: ((fresh * rate.input + u.cached * rate.cached + u.output * rate.output) / 1e6) * multiplier };
}

export function codexCredits(model: string, u: Usage, tier?: string): number | undefined {
  return codexPrice(model, u, tier).credits;
}

/** Standard-tier rates as [input, cached, output] per 1M tokens, for the model picker and `duo models`. */
export function knownCodexRates(): Record<string, [number, number, number]> {
  return Object.fromEntries(Object.entries(CODEX_RATES).map(([k, r]) => [k, [r.input, r.cached, r.output]]));
}
