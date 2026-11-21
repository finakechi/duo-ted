/**
 * Ollama-specific endpoint facts used to diagnose local-model readiness failures.
 *
 * Qwen Code talks to local models over the OpenAI-compatible API, which cannot request a context
 * window: Ollama serves every such request with its server-side default context length (4K, 32K or
 * 256K chosen by VRAM tier, or OLLAMA_CONTEXT_LENGTH), and a 4K window is too small for Qwen Code's
 * agent prompt (~4K tokens) plus any thinking or tool calls. The result is the signature Duo sees
 * as "the model made no tool calls": every generation dies at the context ceiling, Qwen Code
 * retries it as a continuation, and the turn ends empty.
 *
 * These helpers only read the server's own status endpoints (version, running models); they never
 * load a model, generate text or cost anything. They are only ever called for endpoints the user
 * configured as local (never cloud), during a user-triggered check, with short timeouts.
 */
import type { EndpointLocation } from './config.ts';

/** Ollama's native API lives on the same host and port as its OpenAI-compatible one. */
export function ollamaNativeBase(baseUrl: string): string {
  return baseUrl.replace(/\/v1\/?$/, '');
}

/** True when the endpoint answers Ollama's own /api/version (never probed on cloud endpoints). */
export async function isOllamaEndpoint(baseUrl: string, location: EndpointLocation, timeoutMs = 5000): Promise<boolean> {
  if (location === 'cloud') return false;
  try {
    const reply = await fetch(`${ollamaNativeBase(baseUrl)}/api/version`, { signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
    if (!reply.ok) return false;
    const payload: unknown = await reply.json();
    return !!payload && typeof payload === 'object' && typeof (payload as { version?: unknown }).version === 'string';
  } catch {
    return false;
  }
}

/** The context window (tokens) Ollama is currently serving `model` with, when it is loaded. */
export async function ollamaServedContext(baseUrl: string, model: string, timeoutMs = 5000): Promise<number | undefined> {
  try {
    const reply = await fetch(`${ollamaNativeBase(baseUrl)}/api/ps`, { signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
    if (!reply.ok) return undefined;
    const payload: unknown = await reply.json();
    if (!payload || typeof payload !== 'object') return undefined;
    const models = (payload as { models?: unknown }).models;
    if (!Array.isArray(models)) return undefined;
    const entry = models.find((m) => !!m && typeof m === 'object' && (m as { name?: unknown }).name === model) as { context_length?: unknown } | undefined;
    const ctx = entry?.context_length;
    return typeof ctx === 'number' && Number.isFinite(ctx) && ctx > 0 ? ctx : undefined;
  } catch {
    return undefined;
  }
}

/** Qwen Code's agent prompt alone is about 4K tokens. Below this, a served model has no room to
 * think or call a tool, so Duo reports the real cause instead of blaming the model. */
export const QWEN_MIN_CONTEXT_TOKENS = 8192;
/** What to tell the user to serve models with: comfortable room, and Ollama's own 32K tier. */
export const OLLAMA_RECOMMENDED_CONTEXT = 32768;

/** Exact remediation for an Ollama server that serves a model with too small a context window. */
export function ollamaContextFix(model: string, ctx?: number): string {
  const served = ctx !== undefined && ctx > 0 ? ` (served with a ${ctx.toLocaleString('en-US')}-token context)` : '';
  const steps = [
    `Ollama served ${model}${served} with a context window too small for Qwen Code: its agent prompt alone is about 4,000 tokens, so every attempt ran out of room before the model could finish thinking or call a tool.`,
    `Set the server's context length to at least ${QWEN_MIN_CONTEXT_TOKENS.toLocaleString('en-US')} tokens (Ollama's own 32K tier, OLLAMA_CONTEXT_LENGTH=${OLLAMA_RECOMMENDED_CONTEXT}, is recommended):`,
    '· systemd (most Linux installs): `sudo systemctl edit ollama`, add `Environment="OLLAMA_CONTEXT_LENGTH=32768"` under `[Service]`, then `sudo systemctl restart ollama`;',
    '· otherwise stop Ollama and start it again with `OLLAMA_CONTEXT_LENGTH=32768` in its environment (Docker: add `-e OLLAMA_CONTEXT_LENGTH=32768`).',
    'Then run the readiness test again.',
  ];
  return steps.join(' ');
}
