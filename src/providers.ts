/** Optional inference providers. Nothing here contacts a provider at startup. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { endpointLocation, profileIssues, type Config, type DeepSeekSettings, type EndpointLocation, type QwenProfile } from './config.ts';
import type { Seat } from './seats.ts';

export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
/** Only the Electron shell sets this; it is never persisted in Duo's public config. */
export const DEEPSEEK_SAVED_KEY_ENV = 'DUO_DEEPSEEK_SAVED_KEY';
export function deepseekCredentialEnv(settings: DeepSeekSettings): string {
  return process.env[DEEPSEEK_SAVED_KEY_ENV] ? DEEPSEEK_SAVED_KEY_ENV : settings.keyEnv;
}

/** Codex requires a model catalog for models outside its built-in OpenAI catalog.
 * Metadata here follows DeepSeek's published Codex integration; custom identifiers can be
 * listed manually, but are deliberately not assumed to inherit Flash's capabilities. */
function codexModel(slug: string) {
  const flash = slug === 'deepseek-flash';
  const pro = slug === 'deepseek-v4-pro';
  return {
    slug, display_name: slug, description: 'DeepSeek API model', visibility: 'list', priority: 1,
    minimal_client_version: '0.164.0', supported_in_api: true,
    context_window: flash || pro ? 1048576 : 128000,
    max_context_window: flash || pro ? 1048576 : 128000,
    effective_context_window_percent: 95,
    default_reasoning_level: 'high',
    supported_reasoning_levels: ['low', 'high', 'max'].map((effort) => ({ effort, description: `${effort} reasoning` })),
    shell_type: 'shell_command', apply_patch_tool_type: 'freeform',
    supports_parallel_tool_calls: true, prefer_websockets: false, experimental_supported_tools: [],
    input_modalities: flash ? ['text', 'image'] : ['text'],
    support_verbosity: true, default_verbosity: 'low',
    reasoning_summary_format: 'experimental', default_reasoning_summary: 'none',
    truncation_policy: { mode: 'tokens', limit: 10000 },
    base_instructions: 'You are a coding agent using a DeepSeek model through the Codex CLI. Follow the user instructions, respect the provided tool permissions and workspace boundaries, use tools to verify changes, and report results honestly.',
  };
}

export function deepseekForSeat(cfg: Config, seat: Seat, catalogDir: string, baseUrl = DEEPSEEK_BASE_URL): { overrides: string[]; unsetEnv: string[] } | undefined {
  if (!seat.provider) return undefined;
  if (seat.provider !== 'deepseek' || seat.engine !== 'codex') throw new Error(`unsupported model provider ${seat.provider} for ${seat.engine}`);
  const s = cfg.deepseek;
  if (!s.enabled) throw new Error('DeepSeek is disabled in Settings');
  if (!s.models.includes(seat.model)) throw new Error(`DeepSeek model ${seat.model} is not configured`);
  const keyEnv = deepseekCredentialEnv(s);
  if (!process.env[keyEnv]) throw new Error(`DeepSeek: save an API key in Settings or set environment variable ${s.keyEnv} before starting Duo`);
  mkdirSync(catalogDir, { recursive: true });
  const catalog = join(catalogDir, 'duo-deepseek-models.json');
  writeFileSync(catalog, JSON.stringify({ models: s.models.map(codexModel) }), { mode: 0o600 });
  const q = JSON.stringify;
  return {
    overrides: [
      'model_provider="duo_deepseek"',
      'model_providers.duo_deepseek.name="DeepSeek"',
      `model_providers.duo_deepseek.base_url=${q(baseUrl)}`,
      'model_providers.duo_deepseek.wire_api="responses"',
      `model_providers.duo_deepseek.env_key=${q(keyEnv)}`,
      `model_catalog_json=${q(catalog)}`,
      'web_search="disabled"', 'features.standalone_web_search=false',
    ],
    unsetEnv: ['OPENAI_API_KEY', 'CODEX_API_KEY'],
  };
}

/** Guard both automatic and manual assignment, including chat, CLI and templates. */
export function validateProviderSeat(cfg: Config, seat: Seat, codingToolsRequired = true): QwenProfile | undefined {
  if (seat.provider) {
    if (seat.engine !== 'codex' || seat.provider !== 'deepseek') throw new Error('DeepSeek requires the Codex coding engine');
    if (!cfg.deepseek.enabled) throw new Error('DeepSeek is disabled in Settings');
    if (!cfg.deepseek.models.includes(seat.model)) throw new Error(`DeepSeek model ${seat.model} is not configured`);
    if (seat.effort && !['low', 'high', 'max'].includes(seat.effort)) throw new Error(`DeepSeek reasoning effort ${seat.effort} is unsupported; choose low, high or max`);
    if (seat.web || seat.tier) throw new Error('DeepSeek does not enable web search or Codex plan fast mode');
  }
  if (seat.engine !== 'qwen' || !seat.profile) {
    seat.backend = { provider: seat.provider === 'deepseek' ? 'deepseek' : seat.engine === 'codex' ? 'openai' : seat.engine === 'claude' ? 'anthropic' : 'qwen', locality: 'cloud', location: 'cloud' };
    return undefined;
  }
  const profile = cfg.qwenProfiles[seat.profile];
  if (!profile) throw new Error(`unknown model profile ${seat.profile}`);
  if (profile.enabled === false) throw new Error(`model profile ${seat.profile} is disabled`);
  if (profile.kind === 'local' && !cfg.localModelsEnabled) throw new Error('Local Models are disabled in Settings');
  if (profile.model !== seat.model) throw new Error(`profile ${seat.profile} requires model ${profile.model}`);
  const issue = profileIssues(seat.profile, profile)[0];
  if (issue) throw new Error(issue);
  if (codingToolsRequired && profile.capabilities?.tools === false) throw new Error(`profile ${seat.profile} has tool calling disabled and cannot run as a coding agent`);
  const location = endpointLocation(profile.baseUrl);
  seat.backend = { provider: profile.kind === 'local' ? 'local' : 'hosted', locality: location === 'cloud' ? 'cloud' : 'local', location };
  return profile;
}

/** Where a seat's model runs, from the endpoint address (DeepSeek, OpenAI, Anthropic: cloud). */
export function seatLocation(cfg: Config, seat: Seat): EndpointLocation {
  const profile = seat.engine === 'qwen' && seat.profile ? cfg.qwenProfiles[seat.profile] : undefined;
  return profile ? endpointLocation(profile.baseUrl) : 'cloud';
}

/**
 * Identity of the model backend behind a conversation. A stored Qwen/Codex/Claude session may be
 * resumed only by the same backend: resuming it elsewhere would transmit its history, including any
 * local tool output, to a different provider.
 */
export function backendKey(cfg: Config, seat: Seat): string {
  if (seat.provider === 'deepseek') return `deepseek|${DEEPSEEK_BASE_URL}`;
  if (seat.engine === 'qwen' && seat.profile) {
    // Provider identity: the endpoint and its credential. Another model on the same endpoint is the
    // same provider, as with a model switch on Codex or Claude.
    const p = cfg.qwenProfiles[seat.profile];
    return p ? `qwen-endpoint|${p.kind}|${p.baseUrl}|${p.keyEnv ?? ''}` : `qwen-profile|${seat.profile}|missing`;
  }
  return seat.engine === 'qwen' ? 'qwen|configured' : seat.engine === 'codex' ? 'codex|openai' : 'claude|anthropic';
}

/** True for a seat whose model comes from an optional provider and so needs a role readiness check. */
export function optionalTarget(seat: Seat): string | undefined {
  if (seat.provider === 'deepseek') return `deepseek:${seat.model}`;
  if (seat.engine === 'qwen' && seat.profile) return `qwen:${seat.profile}`;
  return undefined;
}

export async function discoverModels(baseUrl: string, keyEnv?: string, timeoutMs = 7000): Promise<string[]> {
  const key = keyEnv ? process.env[keyEnv] : undefined;
  if (keyEnv && !key) throw new Error(`Set ${keyEnv} in the environment before starting Duo`);
  const reply = await fetch(`${baseUrl.replace(/\/$/, '')}/models`, {
    headers: key ? { Authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(timeoutMs), redirect: 'error',
  });
  if (!reply.ok) throw new Error(`Model discovery returned HTTP ${reply.status}`);
  const payload: unknown = await reply.json();
  if (!payload || typeof payload !== 'object' || !Array.isArray((payload as { data?: unknown }).data)) throw new Error('Endpoint does not support OpenAI-compatible model discovery');
  return (payload as { data: unknown[] }).data
    .filter((m): m is { id: string } => !!m && typeof m === 'object' && typeof (m as { id?: unknown }).id === 'string')
    .map((m) => m.id);
}

export async function discoverDeepSeek(settings: DeepSeekSettings): Promise<string[]> {
  if (!settings.enabled) throw new Error('Enable DeepSeek before testing its connection');
  const keyEnv = deepseekCredentialEnv(settings);
  if (!process.env[keyEnv]) throw new Error(`Save a key in Settings or set ${settings.keyEnv} before testing DeepSeek`);
  return discoverModels(DEEPSEEK_BASE_URL, keyEnv);
}
