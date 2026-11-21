# Local Qwen readiness: the Ollama context-window failure

Investigation and fix notes for the local-model readiness failure on Linux (Qwen Code 0.28.0 + Ollama), November 2026.

## Problem

On Linux, local Qwen models (qwen3.5:9b, qwen2.5-coder:14b/7b through Ollama's OpenAI-compatible endpoint) passed the connection check but **failed both writer and reviewer readiness** with:

> The model made no tool calls; it may not support tool calling through this endpoint

That message was wrong. The models support tools (Ollama advertises the `tools` capability, and a raw tool-call request succeeds). The real failure, reproduced and traced end-to-end on the reported setup (Qwen Code 0.28.0, Ollama 0.40.15, RTX 3080 10 GB):

1. Qwen Code sends an agent prompt of ~4,000 tokens (base instructions + allowed tool schemas) for every turn.
2. Ollama picks its serving context window by **VRAM tier**: 4K below 23 GB, 32K from 23 GB, 256K from 47 GB (or `OLLAMA_CONTEXT_LENGTH` if set). This machine's 10 GB card lands in the 4K tier.
3. The OpenAI-compatible `/v1/chat/completions` cannot request a context window — verified in Ollama 0.40.15's source (`openai/openai.go` maps only stop/num_predict/temperature/seed/penalties/top_p) and empirically (`num_ctx` at top level and under `options` are both ignored; only the native `/api/chat` honors `options.num_ctx`).
4. With ~4,074 tokens of prompt in a 4,096-token window, every generation dies ~22 tokens into the model's thinking. Qwen Code treats the early end as a transport continuation, injects its resume prompt, and retries (max 3) — the final result event is empty with totals landing exactly on 4K boundaries (4096 → 16384 = 4×4096).
5. Duo's probe saw zero tool calls and an empty turn and blamed the model's tool support.

Verified end-to-end: with the same model served at 32K, the same probe calls `read_file`, returns the proof marker, and the writer creates the file via `run_shell_command` — reviewer and writer both verify (real CLI, real bwrap sandbox, real Ollama).

## Fix

Duo now detects the true cause and says exactly how to fix it; it does not touch the user's server.

- **`src/tap.ts`** — the Qwen stream parser records continuation retries (`system/subtype=retry`) and the final result's `total_tokens`, and `looksLikeContextTruncation()` recognizes the signature: retries with usage totals landing on 4K boundaries, no tool calls, no reply.
- **`src/ollama.ts`** (new) — passive, timeout-bounded reads of the server's own status: `isOllamaEndpoint()` (`/api/version`), `ollamaServedContext()` (`/api/ps`, read after the probe leaves the model loaded — no load, no cost), and `ollamaContextFix()`: the exact remediation (≥8K required, `OLLAMA_CONTEXT_LENGTH=32768` recommended, with the systemd drop-in steps). Cloud endpoints are never probed.
- **`src/readiness.ts`** — when a reviewer or writer probe produces no tool calls, `noToolCallsDetail()` reports the context-window cause: the server's own served-context reading is authoritative for Ollama (even without retries in the stream), and the retry signature covers other OpenAI-compatible servers. The misleading "may not support tool calling" message is now only used when neither evidence exists.
- **`src/doctor.ts`** — the setup check warns when a local Ollama profile's model is currently loaded with too small a window, with the same fix steps, before the user runs a readiness test.
- README and CHANGELOG document the requirement and the remedy.

## Tests

- New `test/ollama.test.ts` for the endpoint detection, served-context reading and fix text.
- `test/tap.test.ts` covers the truncation-signature classifier (boundary totals, retry counts, tool-call/error/reply exclusions).
- `test/readiness.test.ts` proves the diagnosis replaces the generic guess for both roles, for Ollama endpoints (with and without retry events in the stream) and for non-Ollama endpoints with the retry signature. Fake Qwen CLI gained `truncated` and `empty` failure modes.
- Full suite: 250/250 pass; `tsc` clean for the server and the GUI.

## Verification on the reported hardware (all real, not fakes)

- Qwen Code 0.28.0 + bwrap + Ollama serving `qwen3.5:9b`:
  - at the server's 4K default: reviewer test now fails with *"Ollama served qwen3.5:9b (served with a 4,096-token context) with a context window too small for Qwen Code … `sudo systemctl edit ollama` … `OLLAMA_CONTEXT_LENGTH=32768` …"* — the exact cause and fix, not a model accusation.
  - at 32K (`OLLAMA_CONTEXT_LENGTH=32768`): reviewer **read-verified** (read_file + marker returned, read-only boundary intact, sandbox self-test passed) and writer **write-verified** (file created with run_shell_command, outside write blocked) through Duo's real server API.
- `doctor` reports the same warning live against the 4K server.

## Notes / follow-ups

- The root cause is server configuration Duo cannot (and should not) change on the user's behalf: no request-level parameter can raise Ollama's window through `/v1`, a Modelfile `PARAMETER num_ctx` is ignored by Ollama 0.40.x, and preloading with a larger native-API context is reloaded away by the scheduler as soon as a `/v1` request arrives (`needsReload`). The honest fix is detection + the one-line server change.
- Worth watching: on GPUs at the 4K tier, thinking models (qwen3.5 default `thinking: true`) spend their whole budget thinking; the 120 s model timeout is comfortable once the window is fixed (the successful reviewer probe took ~59 s on this 3080 with the model loaded).
