# Model-agnostic backends for Duo: feasibility study and implementation plan

**Status:** investigation only. This document and the isolated probe under
[`docs/research/model-agnostic/`](research/model-agnostic/) are the whole change. No production code,
dependency or behavior changed.

**Repository state examined:** branch `ccr-7d1fae70-weeo3v` at `25b9cff` (Duo 0.3.0), with
`@enderfga/claw-orchestrator` 7.6.0 and `@openai/codex` 0.159.0 as pinned in `package.json`.
`npm run check` (strict typecheck plus 114 tests) passed before and after this work.

**Date of research:** 2026-11-03. External documentation was read through a search index on that
date. Direct page fetches of `api-docs.deepseek.com` and `qwenlm.github.io` were blocked by this
session's network policy, so I could not read those pages' own dates. Facts taken from them are
labelled *official docs (via search index)*. Re-read them before you rely on a price or model name.

**Revision 2 (2026-11-03): cross-checked against an independent Codex study** of the same brief.
The user supplied it as an upload; it is not in this repository. This revision adds:
- DeepSeek's Codex-tuned Responses API as a second DeepSeek route (C, D, G);
- six source findings from that study, each re-verified against commit `25b9cff` (A.5, B19-B24);
- DeepSeek concurrency and error semantics, now corroborated in DeepSeek's docs (D.1);
- a merged first milestone: a shared per-seat child environment for both CLIs (H).

Claims taken from that study that I could not corroborate are labelled *Codex study*. One of its
recommendations contradicts **Probe P4**; it is noted in C.2.

**Evidence labels used throughout**

| Label | Meaning |
|---|---|
| **Repo** | Read directly in this repository or in the pinned dependency's shipped code. |
| **Probe** | Seen in the isolated fake-CLI probe (`docs/research/model-agnostic/probe.mjs`). This shows only how the libraries pass data to a CLI. It does not prove that any real CLI, provider or model behaves the same way. |
| **Official docs** | Stated in the vendor's or project's own documentation. This is advertised behavior, not something tested here. |
| **Third-party** | Community guides, blogs or issues. Weak evidence. |
| **Estimate** | My own arithmetic or extrapolation. Needs a measurement on the desktop. |
| **Unverified** | Plausible, but nobody here has checked it. |

---

## Executive summary

1. **Duo is a two-harness application, and the coupling is real but narrow.** Model identity,
   provider, harness, permissions, stream format, usage and quota are all keyed by one value:
   `Engine = 'codex' | 'claude'` (`src/seats.ts:15`). It branches on that value in about 30 places
   across the engine, server, prompts, pricing, quota, templates and GUI (section B). Above the
   engine, the coordination layer is already engine-neutral: the template executor, operations,
   ledger, routing and memory never call a provider.
2. **`@enderfga/claw-orchestrator` supplies more than Duo uses.** It already wraps OpenCode, a
   generic "custom" CLI engine and four other harnesses, and it can point Claude Code at another
   endpoint (`baseUrl`). Duo uses only its Claude and Codex session lifecycle. Duo itself supplies
   the raw-stream capture, parsing, live translation, error policy, usage accounting and all
   permission choices. The library's provider support has traps. With `baseUrl` set, claw rewrites
   any non-Claude model to `--model opus` and changes the URL to a proxy-only `/real/<model>` form
   (**Probe P4**). DeepSeek's own docs say `claude-opus*` names are billed as `deepseek-v4-pro`.
3. **The smallest credible path does not add a new harness first.** It adds *provider profiles for
   the existing Claude Code harness* that point at Anthropic-compatible endpoints. One mechanism
   covers:
   - **DeepSeek cloud:** DeepSeek documents `https://api.deepseek.com/anthropic` and has an official
     Claude Code integration page (official docs).
   - **Local Qwen:** Ollama ≥ 0.14 serves the Anthropic Messages API, and so does llama.cpp's
     `llama-server` since PR #17570 (official docs).

   The tool execution, permission modes, read-only tool allowlist, sandbox settings, stream-json
   events, session resume and `--json-schema` plumbing stay those of Claude Code. Duo's parser,
   translator, permission broker and every coordination template keep working unchanged.
   **Probe P5** confirms that claw passes the model and an environment-provided endpoint through
   untouched when `baseUrl` is not used.

   **A second DeepSeek route deserves qualification in parallel.** DeepSeek also documents a
   Responses API "specifically adapted for Codex" (changelog, 2026-08-13) and an official Codex
   integration guide. That route keeps Codex's proven OS sandbox, which makes it the stronger
   candidate for a DeepSeek *writer*. It costs more to build: Duo must generate a trusted provider
   block and model catalog that pass `CFG_DENY` and `--ignore-user-config`, and that is unverified
   on the pinned Codex 0.159.0. It also does not cover local Qwen. The Claude Code route stays the
   cheaper single mechanism for DeepSeek reviewers plus local models.
4. **A new harness (OpenCode, Qwen Code, DeepSeek's `dsh`) is a later, conditional step.** It is
   worth doing only if desktop benchmarks show that a Qwen-tuned harness beats Claude Code on the
   same local model. OpenCode through claw has concrete blockers:
   - **Major:** prompts go on argv. A debate-sized prompt fails with `spawn E2BIG` (**Probe P3-argv**).
   - **Major:** there is no output-schema flag (**Probe P3b**).
   - **Major:** there is no OS sandbox for writers (not found in the docs).
   - **Moderate:** the event schema is undocumented and changes often.
5. **Direct API or local inference without a harness is for tool-less roles only.** That means the
   optional Narrator, summaries and lightweight helpers. Duo's debate, review and pair roles depend
   on the model reading the repository and on citation checks, and a bare chat-completions call
   cannot do either.
6. **Local feasibility on an RTX 3080 depends on whether it is the 10 GB or 12 GB card.** Neither
   variant can hold the current Qwen agentic MoE (Qwen3.6-35B-A3B, about 22 GB at 4-bit) in VRAM.
   It needs expert offload to system RAM, whose size is also unknown. Small dense Qwen3.5 4B/9B
   models fit fully, and they are the realistic Narrator/helper/explainer tier. No DeepSeek model
   that DeepSeek currently ships is practical locally: the open-weight Flash models are ≥ 284 B
   total parameters. Every throughput number below is an estimate. Section E gives the desktop
   benchmark plan.
7. **Recommended strategy:** *Option A+, a minimal provider-profile extension of the existing
   harnesses, plus a capability registry*. Use two transports on the CLIs Duo already drives:
   - Claude Code → Anthropic-compatible endpoints, for DeepSeek, Ollama and llama.cpp;
   - Codex → DeepSeek Responses, for DeepSeek as a writer, once qualified.

   Add one harness adapter later only if it earns its place. Avoid the broad model-independent
   refactor (Option C).
8. **Correctness and security issues exist independent of new providers** (A.5):
   - the launch token is written to disk despite `SECURITY.md`;
   - a chat turn with an error is shown as "done" if any text arrived;
   - the setup check and quota refresh send billable prompts;
   - the server requires both CLIs at startup.

   The first and second must be fixed before Duo adds backends whose errors and approvals are less
   familiar.
9. **Next Codex task (section H):** "Shared per-seat child environment for Codex and Claude spawn
   routes". This is a small internal primitive. It builds each seat's process environment from an
   explicit omit-list plus overlay, never mutates `process.env`, and is keyed per Codex route and
   per Claude session id. It has no user-facing syntax and no new dependencies, and old routes
   behave identically.

   Both provider routes need this primitive. The provider-profile work (`+provider=`, the claw
   rewrite guard, attribution and cost labels) follows as milestone H.2.

---

## A. Current architecture

### A.1 Component diagram (observed in the repository)

```
 Electron shell (desktop/main.cjs, preload.cjs)          CLI (bin/duo.js → src/cli.ts, bin/duo-safe.js)
        │ loopback HTTP + SSE, per-launch token                    │
        ▼                                                          │
 src/server/main.ts ── routes ──┬── ChatManager (src/server/chats.ts) ── own claw SessionManager
   state(): models, efforts,    │       │  PermissionBroker (permissions.ts) ◄── permission-mcp.ts (stdio MCP "approve")
   access tables, versions      │       │
                                └── RunManager (src/server/runs.ts)
                                        │
                                        ▼
                      RunContext (src/protocols/common.ts) — retries, abort, turn budget, totals, quota
                                        │
               ┌────────────────────────┴───────────────────────────┐
     protocols (ask/review/council/debate/pair/continue)   templates/runtime.ts executeWorkflow()
     wrapped as library operations (templates/builtins.ts)  turn / assign / branch / finish / operation nodes
               └────────────────────────┬───────────────────────────┘
                                        ▼
                         Engines (src/engine.ts) — one claw SessionManager per run
                           openSeat(): engine branch → claw startSession(engine:'codex'|'claude')
                           send():     claw sendMessage → raw stream → tap.ts parse → TurnRecord
                                        │
                     src/hooks.ts: patched child_process.spawn
                       duo-codex://… route → codex binary, -c overrides after `exec`, prompt on stdin, tee stdout
                       duo-claude://… route → claude binary, tee stdout per --session-id/--resume
                                        │
                        Codex CLI (bundled @openai/codex 0.159.0)  ·  Claude Code CLI (user-installed)
                                        │
                              OpenAI (ChatGPT plan) · Anthropic (Claude plan)
```

### A.2 Request lifecycle, traced through the source

| Stage | Where | What happens | Claude/Codex coupling |
|---|---|---|---|
| UI model choice | `gui/src/SeatPicker.tsx:46` (engine toggle is literally `['claude','codex']`), `gui/src/spec.ts:13-14` (any head that is not `codex`/`cx` becomes `claude`), `gui/src/Shell.tsx:242-246` (home targets) | User picks an engine, model and effort. The model list comes from `/api/state`. | GUI `Engine` type `gui/src/types.ts:2`. |
| Catalog | `src/server/main.ts:174-177` | Codex models from `codex debug models` (`src/config.ts:115`, cached 6 h). Claude models are a static alias list (`src/config.ts:147`). Efforts come from fixed ladders (`src/seats.ts:17-18`). | Hardcoded per engine. |
| Seat spec | `src/seats.ts:68-97` `parseSeat()` | Grammar `engine[:model][@effort][+opt…]`. Aliases are in `ENGINE_ALIASES` (`:23`), and an unknown engine is an error (`:75`). The Codex `cfg:` passthrough denies `model_provider`/`model_providers` (`:32-37`). | **Probe P1** confirms that `opencode:`, `deepseek:` and `ollama:` heads are refused. |
| Config / auth | `src/config.ts:24-60` `Config`. Binaries come from `src/bins.ts:277` `resolveCodex` and `:309` `resolveClaude`. `src/env.ts:20` `sanitizeEnvironment()` deletes `OPENAI_API_KEY` so that Codex bills the ChatGPT plan. | Duo never handles credentials. Both CLIs use their own logins (`claude /login`, `codex login`). `doctor.ts` checks login status. | Auth is fully delegated to the two CLIs. |
| Run start | `src/server/runs.ts:146-200` `start()`, `src/protocols/common.ts:102-135` `RunContext.create()` | Seats are parsed, and seat count and protocol rules are checked. The record captures both CLI versions, git state and a quota snapshot for both plans. | `versions.codex/claude`, quota `{codex, claude}` (`src/store.ts:61-64`). |
| Coordination | `src/templates/run.ts`, `src/templates/runtime.ts:72` `executeWorkflow()` | Template nodes choose seats with `selected()` (`runtime.ts:11`), whose selector can filter by `engine` (`types.ts:5`, validated as `codex`/`claude` at `validate.ts:43`, **Probe P2**). | Selector `engine` is the only provider-facing template field. The maker exposes it as "Provider" (`gui/src/template-fields.tsx:63`). |
| Seat/session creation | `src/engine.ts:111-227` `openSeat()` | **Codex:** a route with `-c` overrides, sandbox `read-only`/`workspace-write`/`danger-full-access`, and `--ignore-user-config`/`--ignore-rules`. **Claude:** a session id is pre-assigned, read seats get `tools: Read,Grep,Glob[,WebSearch,WebFetch]` (`:201-203`), and writers get `acceptEdits`/`bypassPermissions` plus Claude sandbox settings (`:210-211`). | Two hard branches. Write access is expressed only as `codexSandbox` and `claudeMode` (`SeatAccess`, `engine.ts:31-33`, and `writerSeatAccess`, `src/protocols/pair.ts:71`). |
| Prompts | `src/prompts.ts:31` `systemRules()`, with `seat.engine === 'codex'` branches at `:47`, `:73`, `:267`, `:278`, `:286`. `seatPeerName()` at `src/seats.ts:179-181` names the vendor "Codex" or "Claude". | Codex gets the system block at the top of the first message (claw has no system flag for Codex). Claude gets `--append-system-prompt`. | Peer labels assume two vendors. |
| Transport | `src/hooks.ts:115-157` (spawn patch), `:103` `rewriteCodexArgs()` (flags after `exec`, prompt via stdin) | claw spawns `CODEX_BIN`/`claudeBin`. Duo gives it route names and intercepts the spawn. `withCodexBin()` serializes the `process.env.CODEX_BIN` handoff (`engine.ts:392-405`). | Only two route maps exist (`hooks.ts:34-36`). Any other engine's process is invisible to Duo's capture. |
| Tools/permissions | Seats: CLI-enforced as above. Chats: `src/server/chats.ts:34-46` access tables. Claude "ask" mode uses `--permission-prompt-tool mcp__duo__approve` → `permission-mcp.ts` → `PermissionBroker` (`permissions.ts:30`). | Duo never executes model tool calls itself. The harness does, under the CLI's own sandbox or permission mode. | Approval cards exist only for Claude chats. Codex chats rely on sandbox modes. |
| Streaming events | `engine.ts:153-161` `onLine` → tap file + `feedLive()` → `ClaudeTranslator`/`CodexTranslator` (`src/live.ts:59`, `:141`) → `Block[]` (normalized UI type, `live.ts:7-18`) → `RunEvent.live` (`common.ts:14-20`) → Bus SSE (`src/server/bus.ts`) | Raw CLI events become normalized blocks (`text`, `thinking`, `tool`, `patch`, `todo`, `note`), throttled at 150 ms (runs) or 90 ms (chats). | Translators are per-engine. The `Block` model is engine-neutral, and it is the natural normalization boundary. |
| Turn record | `engine.ts:294-347`: `parseCodexStream`/`parseClaudeStream` (`src/tap.ts:51`, `:119`) → `TurnRecord` (`src/store.ts:66-89`). Structured replies come from `result.structured_output` (Claude) or `extractJson` (`tap.ts:174`). | Each turn writes prompt, reply, thinking, tools, meta and raw stream to disk. | Parsers are per-engine. |
| Sessions/resume | `SeatRecord.codexThreadId`/`claudeSessionId` (`store.ts:48-49`), restart on a dead session (`engine.ts:275-284`), continuation (`src/protocols/continue.ts:43`, `:71`) | Codex resumes with `exec resume <thread>`. Claude keeps a persistent process and resumes with `--resume <id>`. | Two id fields, and nothing generic. |
| Tokens/limits/cost | `engine.ts:350` `turnUsage()` (Codex usage is cumulative per thread, so it is subtracted), Claude's `total_cost_usd` running total (`:315-321`), Codex credits from the rate card (`src/pricing.ts`), Claude quota from `rate_limit_event` (`engine.ts:312`, `src/quota.ts`), Codex quota from rollout files | Totals are summed in `RunContext.finish()` (`common.ts:258-285`). | Two cost units are hardcoded (`codexCredits`, `usd`). Quota is shaped for two plans. |
| Inter-agent coordination | Routed messages (`runtime.ts:47` `routed()`), memory channels, ledger/ranking/merge operations | Engine-neutral. | None, apart from selector `engine`. |
| Errors/cancellation | `src/errors.ts:22-38` regex classes, `RunContext.send()` retry policy (`common.ts:212-242`), `abort()` → `engines.stopAll()` (`common.ts:163-169`) | `fatal`/`quota` remove the seat and abort the run when it falls below `minSeats`. `capacity`/`dead_session` get one retry after 30 s. Anything else gets one "your previous reply could not be used" retry. | The regexes are tuned to the two CLIs' messages. **Probe P6:** `ECONNREFUSED`, `ENOTFOUND`, `402 Insufficient Balance` and "maximum context length" all classify as `other`, so an offline local server gets a meaningless format-repair retry. |

### A.3 What `@enderfga/claw-orchestrator` supplies, and what Duo supplies

Evidence: **Repo**, from the package shipped in `node_modules/@enderfga/claw-orchestrator@7.6.0`
(`dist/src/*.js`, `skills/references/multi-engine.md`).

| Concern | claw supplies | Duo supplies / overrides |
|---|---|---|
| Process lifecycle | `SessionManager.startSession/sendMessage/stopSession/shutdown`, persistent Claude subprocess, one-shot Codex `exec`/`exec resume`, orphan reaping, a per-engine circuit breaker | Restart of a dead session with the conversation resumed (`engine.ts:192-223`), and cancel via `stopAll`. |
| Engines | `ENGINE_TYPES = claude, codex, codex-app, gemini, agy, cursor, grok, opencode, custom` (`types.d.ts`). `_createSession()` dispatch (`session-manager.js:2225-2255`). Each binary is read from an env var (`OPENCODE_BIN`, `GROK_BIN`, …). | Uses only `claude` and `codex`. |
| Custom CLI engine | `CustomEngineConfig` (flag mapping, persistent or one-shot, permission-mode mapping, pricing, env, stderr redaction). Community presets are signed off by a named maintainer and date (`engine-presets.d.ts`, `configs/engines/`). | Not used. |
| OpenCode | `PersistentOpencodeSession`: `opencode run <msg> --format json`, `--session` resume, `--variant` effort, and a read-only agent injected through `OPENCODE_CONFIG_CONTENT` that denies edit/bash/task/webfetch, refusing the turn if that agent fails to load. | Not used. |
| Provider redirection | `SessionConfig.baseUrl` sets `ANTHROPIC_BASE_URL`. For a non-Claude model *with* `baseUrl`, claw passes `--model opus` and rewrites the URL to `<baseUrl>/real/<model>` (`persistent-session.js:181-184`, `:366-369`). Without `baseUrl`, it auto-starts a proxy only if an OpenClaw gateway is detected (`session-manager.js:537-543`, `:1877-1885`). `isClaudeModel()` is a substring heuristic (`models.js:679`). | Not used today. **Probe P4/P5** confirm both behaviors. |
| Structured output | `jsonSchema` → `--json-schema` (Claude) / `--output-schema` file (Codex). Dropped for OpenCode (**Probe P3b**). | Local schema validation and one repair retry (`templates/validate.ts` `schemaError`, `common.ts:234-241`). |
| System prompts | `appendSystemPrompt` → Claude flag, or prepended to the first message for one-shot engines (`base-oneshot-session.js:111-115`, **Probe P3c**) | Writes the rules text (`prompts.ts`). |
| Events | Normalized events and stats, but it drops thinking, rate-limit and per-tool output detail (comment in `src/tap.ts:1-4`) | Duo reads the **untouched** stream through its own spawn hook and parses it itself. |
| Cost | A model price registry, which falls back to Sonnet pricing for unknown models (seen as warnings during the probe) | Duo ignores claw cost. It uses CLI-reported USD (Claude) or its own credit card (Codex). |
| Councils, autoloop, ACP server, OpenAI-compat server, MCP server, ultra* | Present | Not used. Duo's coordination is its own template executor. claw's `openai-compat.js` goes the other way (it exposes CLIs *as* an OpenAI endpoint). It is not a client for OpenAI-compatible providers. |

The keyword `deepseek-harness` in claw's `package.json` and `@enderfga/dsh-clawo` refer to
**DeepSeek's `dsh` driving claw** as an ACP subagent provider (npm description, 2026-08-17). It is
not claw driving DeepSeek. As the instructions warn, an abstraction's name does not show
arbitrary-provider support.

### A.4 Tests and dependencies relevant to this work

- `test/engine.test.ts` drives real claw sessions against `test/fakes/claude.mjs` and
  `test/fakes/codex.mjs`. The fakes record argv, prompts and cwd to `FAKE_LOG` and support
  `FAKE_*_MODE` failure modes (`fatal`, `slow`, `reconnect`, `old`, `die-after-1`).
- `test/template-parity.test.ts` + `test/fixtures/templates/legacy-protocols.json` hold 13
  protocol snapshots (system prompts, prompts, schema hashes, access settings, outcomes). Any
  change to prompts or access for the *existing* seats will fail these, which is the right guard.
- `test/templates.test.ts`, `test/template-builder.test.ts` and `test/debate.test.ts` cover the
  validator, visual-maker model operations, round trips and execution. Seat selectors are covered
  at `templates.test.ts:117-129`.
- `test/units.test.ts` covers error classes and the Codex argv rewrite. `test/tap.test.ts` parses
  real captured streams (`test/fixtures/*-stream.jsonl`). `test/server.test.ts` covers token,
  origin and host checks.
- CI (`.github/workflows/ci.yml`) runs `npm run check` + `npm run build` on Linux, macOS and
  Windows with Node 22 and 24.
- Runtime dependencies (`package.json`): `@enderfga/claw-orchestrator@7.6.0` (pulls `re2`,
  `@modelcontextprotocol/sdk`, `@agentclientprotocol/sdk`, `diff`), `@openai/codex@0.159.0`,
  Electron, Preact and esbuild. None of the recommendations below need a new dependency. Node's
  built-in `fetch` is enough for the later direct-inference client.

### A.5 Further source observations (added in revision 2)

The independent Codex study raised these. Each was re-checked against commit `25b9cff` (**Repo**).

| Observation | Evidence | Why it matters for new backends |
|---|---|---|
| The local API launch token **is written to disk**, contradicting `SECURITY.md:8` ("it is never written to disk or sent anywhere else"). | `ChatManager.mcpConfig()` writes `DUO_API_TOKEN` into `DUO_HOME/gui/mcp/<chat>.json` (`src/server/chats.ts:240`). `remove()` deletes the file (`:227`); `close()` does not (`:465-468`). No restrictive file mode is set; effective access depends on umask and was not tested. | The permission bridge is the pattern a new harness's approval channel would copy. Provider keys must never follow it, and the local control-plane token must not double as an adapter credential. |
| A chat turn that ends with an error is shown as **done** when any text block arrived. | `endTurn()`: `turn.status = o.stopped ? 'stopped' : o.error && !answered ? 'error' : 'done'` (`chats.ts:452-453`). The error and hint are still recorded (`:454-457`). | This is the "silent downgraded success" the brief warns about. Third-party endpoints that stream partial text and then fail (truncation, context overflow, dropped connection) would look successful in chats. Runs are stricter: `Engines.send` treats a transport error as success only when the CLI reported completion (`engine.ts:323`). |
| `doctor --live` and quota refresh **send real prompts**. | `src/doctor.ts:102`, `:120` and `src/quota-refresh.ts:13`, `:18` each run a "Reply with: ok" turn. | A provider health check must be passive by default (version, `/models`, local `/api/version`). A paid probe needs explicit consent per provider. |
| The server **requires both CLIs at startup**. | `src/server/main.ts:45` resolves both binaries eagerly, and `RunContext.create()` resolves both again (`src/protocols/common.ts:103`). | A local-only or DeepSeek-only user without Claude Code or Codex cannot start the app. Resolve only the CLIs that the selected seats need. |
| The pair **check command runs on the host**, outside the model's sandbox. | `runCheck()` spawns with `shell: true` and `env: process.env` (`src/worktree.ts:184`). Its timeout calls `p.kill()` on the direct child only (`:195`). | Correct by design, since it is the user's command. But it must never be chosen by a model or provider. Descendant cleanup on timeout or cancellation needs tests before broader guarantees. |
| **Continue** supports only Debate, Ask and Pair. | `src/protocols/continue.ts:38`, `:42`. | A provider profile must not imply universal resume. Continuation of a provider seat must also fail visibly if its profile was removed or changed (F.6). |

---

## B. Integration barriers

Severity: **minor** means a local edit with low regression risk. **Moderate** means several files
or a new contract, with existing tests protecting the change. **Major** means a new subsystem, a
security boundary, or behavior the library cannot provide.

| # | Assumption (evidence) | Impact | Severity |
|---|---|---|---|
| B1 | `Engine = 'codex' \| 'claude'` drives everything (`src/seats.ts:15`, `src/store.ts:41`, `src/server/chats.ts:31`, `gui/src/types.ts:2`, `src/templates/types.ts:5`). | One value means model family, provider, harness, auth, permission vocabulary and stream format all at once. | Moderate. The type itself is a small change. Separating its meanings is the real work. |
| B2 | Seat grammar refuses other heads (`seats.ts:74-75`, **Probe P1**). GUI `parseSpec` silently turns any unknown head into `claude` with an empty model (`gui/src/spec.ts:13-14`). | A new *head* such as `deepseek:` would be **silently downgraded** to a Claude subscription seat if edited in an older GUI. A `+provider=` *option* survives the GUI round trip, because `parseSpec`/`buildSpec` preserve unknown options, and an older server refuses it explicitly. | Minor, but it decides the spec design (section F). |
| B3 | Only two spawn routes exist (`hooks.ts:34-36`). claw reads `OPENCODE_BIN`/`GROK_BIN` from `process.env` when it constructs a session (`session-manager.js:2246`). | A new claw engine runs, but Duo sees **no raw stream**. Without a stream it has no trace, live view, parsed tools or usage. Duo would need new routes and a `withCodexBin`-style env handoff lock for each engine. | Moderate. |
| B4 | Per-engine parsers and translators (`tap.ts:51/119`, `live.ts:59/141`) selected by `seat.engine` (`engine.ts:263`, `:296`; `chats.ts:377`). | Every new wire format needs a parser, a translator and captured fixtures. OpenCode's JSON events are undocumented and change often (claw's own warning). | Moderate per harness. None for Claude Code on another provider, because the stream format is unchanged. |
| B5 | Write access exists only as `codexSandbox` + `claudeMode` (`engine.ts:31-33`, `pair.ts:71-79`). | A harness without an OS sandbox (OpenCode: no sandbox found in its docs; Qwen Code: sandbox off by default per its docs) cannot honor Duo's "Sandboxed" writer promise (README "Pair mode"). | **Major** for writers on such harnesses. None for read-only roles where the harness enforces the allowlist. |
| B6 | Prompts are passed on argv by claw's one-shot engines (**Probe P3-argv**: a 200,000-char prompt fails with `spawn E2BIG`). Duo fixes this only for Codex (`hooks.ts:103-113`). | Debate and review prompts exceed the Linux 128 KiB per-argument limit, and on Windows the whole command line is limited to about 32 K characters. | **Major** for OpenCode/one-shot custom engines unless the CLI accepts stdin (unverified for OpenCode). Not an issue for Claude Code, which reads prompts from stream-json stdin. |
| B7 | Structured output relies on the CLI enforcing a schema (README "How the protocols keep models honest"). OpenCode gets no schema (**Probe P3b**). Duo then falls back to `extractJson` + local validation + one retry. | Debate, review, council and pair all depend on schema compliance. Weaker models fail more often, and Duo retries once, then fails visibly. That failure is good behavior, but it costs turns. | Moderate. |
| B8 | claw's `baseUrl` path rewrites a non-Claude model to `opus` and the URL to `/real/<model>` (**Probe P4**). Its gateway auto-detection (`GATEWAY_URL` or `~/.openclaw/openclaw.json`) can inject that path without Duo asking. | A DeepSeek seat could silently run, and bill, as `deepseek-v4-pro`: DeepSeek maps `claude-opus*` to V4 Pro (official docs via search index, "Messages API"). That is a hidden model change. | **Moderate. Must be guarded in milestone H.2.** |
| B9 | An inherited `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN` in the user's shell reaches every Claude seat today. `sanitizeEnvironment()` (`src/env.ts:20-24`) strips only `OPENAI_API_KEY`, and claw keeps a non-Anthropic key whenever a base URL is set (`persistent-session.js:338-346`; pass-through shown by **Probe P5**). | Present-day hazard. A user who exported DeepSeek variables for their own `claude` would get "Claude opus" seats that actually run elsewhere, labeled as Anthropic, with source code sent to that endpoint. | Moderate (privacy/attribution). Fix by detecting and showing it, not silently stripping, because some users intend a gateway. |
| B10 | Cost and quota are shaped for two plans: `codexCredits`/`usd` (`store.ts:82-83`), the Claude quota cache written from any `rate_limit_event` (`engine.ts:312`), and `costUsd` taken from Claude's `total_cost_usd` (`engine.ts:315-321`). | Claude Code on another provider will report a USD figure computed from Anthropic prices or zero. That figure is unverified and should be treated as untrustworthy. Rate-limit events, if any, would overwrite the Claude-plan quota display. | Moderate. |
| B11 | Error classes are regexes over the two CLIs' messages (`errors.ts:22-38`). | **Probe P6:** an offline local server, DNS failure, insufficient balance or context overflow is `other`, which triggers a format-repair retry with a misleading note and no actionable hint. `429` is `quota`, so the seat is removed with the plan hint. That is right for a plan but wrong for an API rate limit, which wants back-off. | Minor to moderate. |
| B12 | Model catalog and efforts: the Codex catalog comes from the bundled CLI and Claude aliases are static (`config.ts:147`). The effort ladders are fixed (`seats.ts:17-18`). | DeepSeek documents its own effort levels (low/high/max, official docs via search index). Local models may have none. A Claude ladder value may be ignored or rejected upstream (unverified). | Minor. |
| B13 | Prompts name only two vendors (`seatPeerName`, `seats.ts:179-181`) and add per-family style rules (`prompts.ts:47-54`). | A DeepSeek seat would introduce itself to peers as "Claude deepseek-flash". That is misleading in the transcript and a minor honesty issue. | Minor. Note: changing labels for *existing* seats breaks the parity snapshots by design. |
| B14 | Chat access tables are per engine (`chats.ts:34-46`), and approval cards exist only for Claude (`permissionPromptTool`). | Claude Code on another provider keeps approval cards for free. A new harness needs its own permission bridge, or it must be read-only in chats. | Moderate per new harness. |
| B15 | Session semantics: two id fields (`store.ts:48-49`) and continuation requiring one of them (`continue.ts:71`). | Direct inference has no harness-side conversation, so Duo would have to own history. Templates already support `session: 'fresh'` and explicit routing, which suits stateless direct roles. | Moderate (direct inference only). |
| B16 | Template selector `engine` enum (`validate.ts:43`, maker `template-fields.tsx:63`). | Authors cannot target a provider, locality ("local only") or capability. Under AGENTS.md, any such targeting must arrive in the shared model, validator, executor and visual controls together. | Moderate. |
| B17 | `CFG_DENY` blocks `model_provider(s)` for Codex seats (`seats.ts:32-37`). | Pointing Codex at a local provider is deliberately impossible through `cfg:`. A Duo-owned, validated provider profile would have to set it. The current Codex docs say custom `wire_api` must be `responses`, so a local server needs the Responses API (official docs, Codex config reference). | Moderate. Addressed by phase 1b (DeepSeek) and phase 5 (local), both through Duo-generated trusted config, never user `cfg:`. |
| B18 | Run records: `versions.codex/claude` and `codexBin/claudeBin` only (`common.ts:113-122`). | The provider and endpoint host are not recorded, so audit and reproduction are incomplete for non-default backends. | Minor. |
| B19 | Per-seat environment is additive only: `BinSpec.env` is merged over `options.env ?? process.env` (`hooks.ts:130`, `:146`). There is no way to *remove* an inherited variable for one seat. | Mixed seats (ChatGPT-plan Codex beside DeepSeek Codex, or Anthropic beside DeepSeek Claude) cannot be isolated from each other's routing and auth variables. The serialized `CODEX_BIN` handoff (`engine.ts:392-405`) is a route-selection workaround, not isolation. | **Major** for reliable mixed credentials. This is the H.1 primitive. |
| B20 | The launch token is persisted for the permission bridge (`chats.ts:240`), and `close()` does not clean it up (A.5). | It contradicts `SECURITY.md`, and it is the pattern any new approval bridge would copy. | Moderate to implement; major for the credential boundary. Fix before generalizing the bridge. |
| B21 | Chat turns are "done" when text arrived despite an error (`chats.ts:453`). | A failure after partial output is shown as success. | Moderate (correctness-critical for new providers). |
| B22 | Both CLIs are resolved at startup (`main.ts:45`, `common.ts:103`). | A setup without one CLI fails to start, even if no seat uses it. | Moderate. |
| B23 | Health checks are billable (`doctor.ts:102`, `:120`; `quota-refresh.ts:13`, `:18`). | Applying the same pattern to providers would spend money on a "check". | Minor. |
| B24 | Codex provider settings can come only from Duo-generated config. `CFG_DENY` blocks `model_provider(s)` (`seats.ts:32-37`), and seats run with `ignoreUserConfig: true` (`engine.ts:187`). DeepSeek's Codex guide edits the shared `~/.codex/config.toml` and stores the key in `experimental_bearer_token` (official docs). | Duo must pass a provider block, an environment-key reference and a model catalog through trusted `-c` overrides on both initial and resumed turns. Whether the pinned Codex 0.159.0 accepts `model_providers.*` and a catalog path this way is **unverified**. | Moderate. It is a qualification gate for the Codex + DeepSeek route. |

---

## C. Strategy comparison

### C.1 Three layers that must stay separate

- **Model:** the weights (for example DeepSeek-V4.1-Flash, Qwen3.6-35B-A3B, Claude Opus).
- **Provider / inference endpoint:** who serves the model and over which protocol. Examples are the
  Anthropic Messages API (Anthropic, DeepSeek `/anthropic`, Ollama, llama.cpp), OpenAI Chat
  Completions or Responses (OpenAI, DeepSeek, Ollama, LM Studio, llama.cpp), and the vendor
  subscription inside a CLI.
- **Agent harness:** the program that turns a model into a coding agent (Claude Code, Codex CLI,
  OpenCode, Qwen Code, DeepSeek `dsh`).

**What a harness adds beyond an OpenAI-compatible API:**
- the tool loop (read, grep, edit, patch, shell, web) and tool schemas;
- **permission enforcement** that Duo relies on: Claude tool allowlists and plan mode, the Codex
  read-only and workspace-write sandbox, and OS sandboxing (bubblewrap/Landlock/Seatbelt);
- patch application and diff events;
- conversation and session persistence with resume ids;
- context compaction;
- streaming event formats with tool inputs and outputs;
- reported usage;
- headless structured output (`--json-schema` / `--output-schema`);
- repository-instruction handling.

A bare API gives Duo text, and at best tool-call JSON that **Duo would have to execute itself**.
That would make Duo a harness, which is out of scope and a security liability.

### C.2 Options

| Strategy | Benefit | Change scope | Maintenance | Limits | Regression risk |
|---|---|---|---|---|---|
| **1a. CLI/config extension: Claude Code → Anthropic-compatible endpoints** (DeepSeek `/anthropic`, Ollama ≥ 0.14, llama.cpp `/v1/messages`) | Adds DeepSeek cloud and local Qwen while keeping Claude Code's permissions, events, resume and schema plumbing. Duo's parsers, broker, templates and tests are reused. | `seats.ts`, `config.ts`, `hooks.ts`, `engine.ts`, `chats.ts`, `store.ts`, `errors.ts`, `doctor.ts`, then GUI. About 300-500 lines plus tests. | Low. It tracks two env var conventions that DeepSeek, Ollama and llama.cpp document. | Harness prompts and tools are tuned for Claude models, so reliability on other models is **unverified**. Claude Code background calls need model mapping. Cost is unpriced. Each provider's Anthropic compatibility is partial (DeepSeek ignores some fields). | Low, if existing seats get byte-identical spawn args and env (parity tests). |
| **1b. CLI/config extension: Codex → DeepSeek Responses API** (official DeepSeek Codex guide; API "specifically adapted for Codex", 2026-08-13) | Keeps Codex's OS sandbox, `--output-schema`, `exec resume` and Duo's Codex parser. The endpoint is tuned for this harness, so it is the strongest DeepSeek *writer* candidate. | The Codex branch of `engine.ts` (Duo-generated `-c model_provider=…`, `model_providers.<id>.*` with an env-key reference, and a model catalog file), `seats.ts`, `pricing.ts` (USD, not plan credits), `quota.ts` gating, `errors.ts`, plus H.1's child environment. | Medium. It tracks Codex's provider and catalog schema, which can be ahead of or behind the pinned 0.159.0. | Unverified on the pin: provider settings via `-c` under `--ignore-user-config` and on `exec resume` (B24). The Responses API is stateless (no `previous_response_id`, `store` always false, per DeepSeek docs), so `exec resume` must replay history itself (unverified). Web search only with V4 Pro (DeepSeek guide). It does not cover local models. | Medium (Codex argv and env), guarded by `units.test.ts` and `engine.test.ts`. |
| **2. Harness adapters** (OpenCode via claw; Qwen Code / `dsh` via claw `custom` or a new adapter) | Qwen Code's tool formats are presumably tuned for Qwen models (unverified). OpenCode is provider-agnostic. claw already wraps OpenCode. | New spawn route per harness, parser, translator, fixtures, access mapping, structured-output strategy and an argv workaround. | High. OpenCode releases often and its JSON schema is not formally documented. Qwen Code is at 0.26.x and `dsh` is a release candidate. | No OS sandbox (OpenCode), sandbox off by default (Qwen Code), schema not enforced by claw (OpenCode), E2BIG (**Probe**). | Medium. |
| **3. Direct cloud APIs** (DeepSeek Chat/Responses, no harness) | Cheapest and fastest path for tool-less work. Native JSON modes (DeepSeek `json_object`, Responses `json_schema`; official docs). | New HTTP client, history ownership, usage mapping. | Medium. | No repository access and no tools, so it cannot do debate, review or pair as designed: citation checks would fail and there is nothing to verify against. | Low, if confined to new tool-less roles. |
| **4. Local direct inference** (Ollama / llama.cpp / LM Studio, OpenAI-compatible) | Private, no per-token cost, good for the Narrator and helpers. | Same client as option 3, pointed at loopback. | Low/medium. | VRAM, prefill latency, `num_ctx` not settable per request through Ollama's OpenAI API (official docs), and llama.cpp tool-call format bugs (issue #20198). | Low. |
| **5. Hybrid** | Puts each model where it is strongest (section C.4). | Composition of 1 and 4. | Inherits 1 and 4. | Remote-source transmission must be explicit per seat. | Low/medium. |

Architecture options for the code base:

| | A. Minimal CLI/config extension | B. Provider + agent adapters | C. Broad model-independent refactor |
|---|---|---|---|
| Shape | Add `provider` to seats; inject per-session env in the existing hook; keep `engine` as the harness. | Introduce `HarnessAdapter` (spawn route, parser, translator, access mapping, usage semantics) and `ProviderProfile`, then replace the ~30 `engine ===` branches with table lookups. | Duo executes tools itself over a unified chat API and treats every model alike. |
| Benefit | DeepSeek + local Qwen soon, with low risk. | Clean room for a third harness. | Maximum uniformity. |
| Scope | Small. | Medium (mostly mechanical). | Very large. It rebuilds what harnesses do: sandbox, patching, approvals, compaction. |
| Risk | Low. | Medium. Parity snapshots catch drift. | High. It weakens permissions and contradicts "Duo drives the official CLIs". |
| Verdict | **Do first.** | **Do only when a third harness is justified by benchmarks** (phase 6). | **Reject.** |

### C.3 Recommendation

**Strategy 1 / Option A+, with two transports on the existing harnesses.**
- **1a (Claude Code → Anthropic-compatible) first.** One mechanism covers DeepSeek reviewers and
  debaters plus local Qwen, it needs only environment variables, and **Probe P5** shows clean
  pass-through.
- **1b (Codex → DeepSeek Responses) qualified in parallel** as the DeepSeek writer route, because
  it keeps Codex's sandbox and uses the endpoint DeepSeek tuned for Codex. Ship it only if the
  pinned Codex accepts Duo-generated provider settings on both initial and resumed turns.

Both need the same per-seat environment isolation (H.1), the same capability registry and the
same run-start compatibility checks.

**Correction to the Codex study.** It suggests controlling claw's non-Claude-model proxy behavior
"with an explicit base URL". **Probe P4** shows the opposite: passing an explicit `baseUrl` is
exactly what makes claw 7.6.0 pass `--model opus` and rewrite the URL to `<baseUrl>/real/<model>`.
The endpoint must reach Claude Code through the seat's environment, with `baseUrl` left unset, and
Duo must refuse the spawn if claw rewrote the model anyway (H.2).

Beyond the two transports, add direct inference only for tool-less roles, with
the Narrator as the first consumer. Add Option B's adapter seam and one more harness only if
desktop benchmarks show a Qwen-tuned harness clearly beats Claude Code on the same local model.
This keeps permissions where they are enforced today, by the harness and its sandbox. It reuses
every coordination template, and it never asks Duo to execute model-chosen tools.

### C.4 Useful hybrids

| Combination | Mode | Value | Risks and requirements |
|---|---|---|---|
| **Codex writes, DeepSeek reviews** | Pair: writer `codex:gpt-6-sol@high`, reviewer `claude:deepseek-flash+provider=deepseek` | An independent second model family at low cost. The reviewer stays read-only through Claude Code's `Read,Grep,Glob` allowlist (`engine.ts:201-203`), which the harness enforces whatever model is behind it. | The reviewer's `PAIR_REVIEW_SCHEMA` compliance through Claude Code `--json-schema` on DeepSeek is **unverified**. The diff and the files the reviewer reads go to DeepSeek, so it needs an explicit remote-provider acknowledgment. |
| **Claude writes, local Qwen explains** | Chat or Pair with the Narrator (or an Ask seat) on local Qwen3.5-4B/9B | Private commentary. The cloud writer means no GPU contention with the coding agent. | Explanations must be bounded to observed events (section F.7). Small-model accuracy is unverified. |
| **DeepSeek + Codex independent review** | Review: `-s codex:… -s claude:deepseek-flash+provider=deepseek` | Cross-family confirmation of findings, the strongest signal in Review mode (README). Cheap. | Citation verification still works, because Duo checks files locally (`src/citations.ts`). |
| **Cloud coordinator, local helpers** | Council or Ask with a cloud chair and local participants; or Debate with one local seat | Cheap breadth, with a strong synthesizer. | One GPU serializes local seats. A "parallel" step with two local seats runs roughly sequentially or with doubled KV memory. Use at most one local *agentic* seat at a time. |

---

## D. Capability matrix

### D.1 Candidates (models / providers)

Current names and dates come from official documentation via the search index on 2026-11-03,
unless marked otherwise. Prices change; re-check them.

| Candidate | Status and naming | Access/protocol | Facts relevant to Duo | Verification |
|---|---|---|---|---|
| **DeepSeek Flash** (`deepseek-flash`, served by DeepSeek-V4.1-Flash-1017 since the 2026-10-17 update) | Changelog: V4 preview 2026-04-24, V4-Pro GA 2026-08-13, V4.1-Flash 2026-09-10 (V4-Flash retired, legacy names routed to V4.1-Flash), V4.1-Flash-1017 on 2026-10-17. `deepseek-chat`/`deepseek-reasoner` are legacy (retirement 2026-07-24 per third-party guides). | OpenAI-compatible `https://api.deepseek.com`. Anthropic-compatible `https://api.deepseek.com/anthropic`. API key (`ANTHROPIC_AUTH_TOKEN` in DeepSeek's Claude Code guide). | Context 1,048,576 and max output 393,216 (list-models endpoint). Thinking on by default, with effort low/high/max. Tool calls; strict-schema tool calls (beta, `/beta` base URL); `json_object` mode; `json_schema` in the Responses API. Price per 1M tokens, peak: input cache-miss $0.30, cache-hit $0.006, output $1.20; off-peak 50%. Server-side Search/Fetch billed from 2026-10-31. | Official docs (via search index). **Conflict:** third-party pages list $0.14/$0.28 (April V4 pricing). They are older; check the pricing page. |
| **DeepSeek V4 Pro** (`deepseek-v4-pro`) | **Conflicting:** a 2026-09-10 news post says requests route to V4.1-Flash from 2026-09-14. The 2026-09-10 changelog says Pro service continues. The pricing page still lists it. | As above. Text-only. | Input $1.32 (cache-miss) / $0.044 (hit), output $3.96 (peak). **`claude-opus*` names map to V4 Pro** on DeepSeek's Anthropic endpoint, and other `claude*` names map to Flash. | Official docs (via search index); status unresolved. |
| **DeepSeek open weights** (V4-Flash 284 B total / 13 B active, MIT; V4.1-Flash larger, reported 552 B+) | Hugging Face model cards | Self-host | Far beyond an RTX 3080 even at 2-bit (section E). | Official model cards (via search index); parameter counts partly conflicting. |
| **Qwen3.6-35B-A3B** | Weights posted 2026-04-16 (Qwen blog: "agentic coding") | Self-host (GGUF Q4 ≈ 22.1 GB, Unsloth) or providers | MoE, about 3 B active, so it suits expert offload. The local agent candidate. | Official card/blog (via search index); file size from the HF listing. |
| **Qwen3.6-27B** (dense) | 2026-04-22 | Self-host | Q4 ≈ 16-17 GB (**estimate**). Dense, so partial offload is slow. | Official blog (via search index). |
| **Qwen3.5 small: 0.8 B / 2 B / 4 B / 9 B** | 2026-03-02 | Self-host | Fits entirely in 10 GB at Q4 (**estimate**). The Narrator, helper and explainer tier. | Official changelog (via search index). |
| **Qwen3-Coder-30B-A3B / Qwen3-Coder-Next (80B-A3B, 262 K ctx) / 480B-A35B** | 2025-2026 | Self-host / providers | 30B-A3B Q4 ≈ 18-19 GB (**estimate**). Next Q4 ≈ 45-50 GB (**estimate**), so it needs ≥ 64 GB RAM. | Official cards (via search index). |
| **Anthropic Claude / OpenAI Codex models** (current) | As today | Vendor subscription through the CLIs | Baseline. | Repo + end-to-end by users. |

**DeepSeek operational details (added in revision 2):**
- **Concurrency.** Limits are per account, regardless of API key: **2,500** concurrent requests for
  `deepseek-flash` and **500** for `deepseek-v4-pro`. A request counts from send until the
  response finishes, and exceeding the limit returns **429** (official docs:
  [Rate Limit & Isolation](https://api-docs.deepseek.com/quick_start/rate_limit/), via search
  index). So a 429 from DeepSeek means *throttling*, not an exhausted plan. Duo's current
  `quota` class (`errors.ts:28`) would wrongly remove the seat.
- **Error codes.** **402** = insufficient balance: top up, do not retry. 408, 429 and 5xx: wait and
  retry (official docs: [Error Codes](https://api-docs.deepseek.com/quick_start/error_codes/), via
  search index). This confirms the classes proposed in F.6.
- **V4 Pro status.** The Codex study reads the pricing page as listing `deepseek-v4-pro` as current
  (V4-Pro-0813), with the same prices as D.1. That fits the 2026-09-10 changelog entry saying Pro
  service continues. Treat Pro as available, but record the requested *and* resolved model on
  every turn.
- **Not corroborated here** (*Codex study*, from DeepSeek's pricing, Responses and thinking-mode
  pages):
  - Peak hours are 01:00-04:00 and 06:00-10:00 UTC on weekdays.
  - Responses streams end with `response.completed`, `response.incomplete` or `response.failed`
    rather than `[DONE]`.
  - With Chat Completions plus `tools`, earlier `reasoning_content` must be replayed.
  - Strict tool schemas require every property and `additionalProperties: false`.

  The only one that changes this plan is the first: off-peak pricing can halve cost for long runs.

### D.2 Harness / endpoint combinations

The "Into Duo today" column describes what works without new code.

| Combination | Into Duo today | Tools and permissions | Structured output | Resume | Events into Duo | Usage/cost | Verification |
|---|---|---|---|---|---|---|---|
| Claude Code + Anthropic (current) | Yes | Allowlist, plan, acceptEdits, bypass; Claude sandbox; approval cards | `--json-schema` → `structured_output` | `--resume` (persistent) | Full (`parseClaudeStream`) | Per-turn tokens; CLI USD; plan quota | Repo, fake-tested, real use |
| Codex + ChatGPT (current) | Yes | Read-only, workspace-write, full sandbox | `--output-schema` | `exec resume` | Full (`parseCodexStream`) | Cumulative tokens → credits | Repo, fake-tested, real use |
| **Claude Code + DeepSeek `/anthropic`** | Not safely (B8/B9). Milestone H. | **Same harness enforcement** (it is local) | Through Claude Code; DeepSeek compliance **unverified** | Claude Code resume (local transcript); provider-side caching automatic per DeepSeek docs | Same stream format (expected), but `rate_limit_event` and `total_cost_usd` semantics are **unverified** | Tokens yes; USD untrustworthy → mark "unpriced" or use a dated rate card | Official docs (DeepSeek integration page); **Probe P5** for plumbing |
| **Claude Code + Ollama ≥ 0.14 / llama-server `/v1/messages` (local Qwen)** | Not safely. Milestone H covers it. | Same harness enforcement | Through Claude Code; depends on the model's tool calls (`--jinja` for llama.cpp) | As above | As above. Thinking blocks may be dropped by llama.cpp conversion (issue #20090). Context is set server-side (`OLLAMA_CONTEXT_LENGTH`/`-c`), and Ollama may truncate silently (third-party report) | Tokens; cost "none (local)" | Official docs (Ollama blog, llama.cpp HF blog); local reliability **unverified** |
| **Codex + DeepSeek Responses** (`https://api.deepseek.com/`, `wire_api = "responses"`) | Not yet (B17, B24). Phase 1b. | **Codex OS sandbox retained**, which is the main advantage for writers | `--output-schema` through Codex; DeepSeek compliance **unverified** | `exec resume` with Codex's local history; the API itself is stateless (official docs) | Same Codex stream (expected; capture a fixture) | Tokens yes; must be API USD, never plan credits | Official docs (DeepSeek Codex guide, changelog 2026-08-13); pinned-CLI acceptance of Duo-generated config **unverified** |
| Codex + `--oss` (Ollama / LM Studio) | No (B17) | Codex sandbox retained | `--output-schema` (model-dependent) | `exec resume` | Same Codex stream | Credits meaningless → "none" | Official docs (Codex CLI reference); Responses API support by local servers **unverified** |
| OpenCode (claw `opencode` engine) | No (B3, B6, B7) | Read-only via the injected `clawo-readonly` agent (**Probe P3d**); writers: permission rules only, **no OS sandbox found** | None from claw (**Probe P3b**) | `--session` (**Probe P3e**) | New parser needed; undocumented schema | `step_finish` tokens per claw | Repo (claw) + Probe; opencode-ai 1.19.5 (npm, 2026-10-28) |
| Qwen Code (`qwen`, 0.26.6, npm 2026-11-02) | No (no claw engine; would be `custom`) | Approval modes plan/default/auto-edit/auto/yolo; sandbox **off by default** | `--json-schema` (headless only, synthetic `structured_output` tool that ends the session) | **Unverified** for headless | `--output-format stream-json` (similar message types to Claude Code; equivalence **unverified**) | Unverified | Official docs (via search index) + bundle inspection of the npm package |
| DeepSeek `dsh` (`@deepseek-ai/dsh` 0.2.1-rc.5, npm 2026-11-03) | No | Has plan-mode, bash and fs tool packages (dependency names) | Unknown | Unknown | ACP/headless packages exist | Unknown | npm metadata only; **release candidate**, so defer |
| Direct DeepSeek / local OpenAI-compatible (no harness) | No | **None:** no repository access, no tools | `json_object` / `json_schema` (Responses) / llama.cpp grammar | Duo-owned history | Duo-owned SSE parsing | Response `usage` | Official docs |

### D.3 Role suitability

The recommendations below are *starting defaults* and are **not tested**. They assume Claude Code
as the harness unless stated. Each should be promoted only after the section E benchmark or a
recorded end-to-end run.

| Role | Requirements (derived from Duo's code) | Suitable now | Conditional (after verification) | Not suitable |
|---|---|---|---|---|
| **Full agent / writer** (pair writer, write roles) | File edit + shell **inside an OS sandbox** (`writerSeatAccess`); reliable multi-step tool use; `PAIR_WRITER_SCHEMA` | Claude/Anthropic, Codex/ChatGPT | DeepSeek Flash/Pro **through Codex (preferred: OS sandbox, endpoint tuned for Codex)** or through Claude Code (Claude sandbox settings apply locally); Qwen3.6-35B-A3B local only after the fixture test passes reliably | OpenCode/Qwen Code writers until sandboxing is solved; any direct API; small Qwen |
| **Reviewer** (pair reviewer, Review participants) | Read-only repo tools, citations, `REVIEW_SCHEMA`/`PAIR_REVIEW_SCHEMA` | Current two | DeepSeek via Claude Code (best first candidate); local Qwen3.6-35B-A3B | Direct APIs (no repo access); small Qwen |
| **Technical debate participant** | Read-only tools, `DEBATE_SCHEMA` (claims, stances), up to 8 claims, final ledger review with complete stances (strict: incomplete → fail) | Current two | DeepSeek via Claude Code; local 35B-A3B (latency per round is the concern) | Direct APIs; small models (strict ledger review likely to fail; unverified) |
| **Coordinator / chair / summarizer** | Reads the routed record. Optional read-only fact checks. No schema by default (`builtins.ts` chair role) | Current two | DeepSeek via Claude Code; direct DeepSeek (no repo checks); local 35B-A3B | Small Qwen for faithful synthesis of long records (unverified) |
| **Read-only explainer** (Ask seat on "explain this diff", Narrator Q&A) | Text in, text out; bounded to supplied material | — | Small local Qwen (4 B/9 B), direct DeepSeek | — |
| **Lightweight helper** (titles, summaries of a turn, deterministic-fallback polish) | Short context, fast | Deterministic code (no model) | Qwen3.5-0.8B/2B/4B local | — |

**Preventing unsupported assignments and silent downgrades** (design in F.4):
- Each backend gets a capability profile with *evidence levels*. Templates and protocols derive
  role requirements from data that already exists (`role.access`, `role.schema`, library operation
  needs).
- At run start Duo refuses `unsupported` capabilities. It requires a recorded, visible user
  override for `unverified` ones. It never drops a requirement, for example by removing a schema
  or giving a writer read access, to make a backend "work".
- Duo already fails visibly on schema errors and incomplete ledger reviews (`debate.test.ts:155`).
  That behavior must stay.

---

## E. Local feasibility on the RTX 3080 desktop

**Nothing in this section was measured.** Codex Cloud and this session have no access to the
desktop GPU. All sizes and speeds are labeled as estimates, apart from the cited file sizes.

### E.1 Hardware facts and unknowns

- **RTX 3080 has two variants** (NVIDIA product page, accessed 2026-11-03): 10 GB GDDR6X, 320-bit,
  8704 CUDA cores, 760 GB/s; and 12 GB GDDR6X, 384-bit, 8960 cores, about 912 GB/s
  (**estimate**: 19 Gbps × 384 bit / 8). **Which one the user has is unverified.** Run
  `nvidia-smi --query-gpu=name,memory.total --format=csv`.
- Ampere (sm_86) is supported by current CUDA builds of llama.cpp and Ollama (**unverified for the
  specific CachyOS packages**; check `nvidia-smi` driver/CUDA version first).
- **System RAM size and speed are unknown.** They decide MoE expert offload. The Ryzen 7 5800X
  supports dual-channel DDR4, and AMD rates it at DDR4-3200, about 51 GB/s theoretical (official
  CPU spec; actual DIMMs unverified).
- The Linux desktop (compositor, browser, Electron) holds some VRAM, typically hundreds of MB to
  about 1.5 GB (**estimate**). Measure idle VRAM with Duo open.

### E.2 Memory arithmetic

- **Weights:** Q4_K_M is about 4.6-4.9 bits per weight, so roughly 0.6 GB per billion parameters
  (**estimate**). Mixed "UD" quants are slightly larger.
- **KV cache per token** = 2 × layers × KV heads × head dim × bytes per element. Example for a
  generic 36-layer GQA model with 8 KV heads × 128 dims at fp16: 2·36·8·128·2 = 147 KB per token,
  so **32 K tokens ≈ 4.5 GB** and q8_0 KV ≈ 2.3 GB (**illustrative, not a specific Qwen model**).
  Qwen3.5/3.6 may use hybrid linear attention with smaller KV (**unverified**). Read the real
  numbers from llama.cpp's load log.
- **A concrete model example** (*Codex study*): Qwen2.5-Coder-7B has 28 layers, 4 KV heads and head
  dimension 128, read from its `config.json` (huggingface.co is blocked in this session, so not
  re-read here). The arithmetic checks out: 2·28·4·128·2 = 57,344 B ≈ **56 KiB per token** at
  fp16, so 8 K ≈ 448 MiB, 32 K ≈ 1.75 GiB and 128 K ≈ 7 GiB, before working buffers. Its small KV
  footprint makes **Qwen2.5-Coder-7B a useful stable local baseline** to compare against
  Qwen3.5-9B (add it to E.3 step 2).
- **The Claude Code harness adds a large fixed prompt:** system prompt plus tool definitions,
  re-sent each turn. Its token count is **unknown** (measure the first turn's `input_tokens`). On
  local hardware, prefill of that prefix sets the time to first token. llama.cpp prompt caching
  (`cache_prompt`, on by default in llama-server; unverified for `/v1/messages`) helps later turns.

| Model (Q4 class) | Weights | Fits 10 GB? | Fits 12 GB? | Mode | Decode speed (**estimate**) | Intended role |
|---|---|---|---|---|---|---|
| Qwen3.5-4B | ≈ 2.5 GB (est.) | Yes, with ≥ 32 K ctx | Yes | Full GPU | ≈ 80-150 tok/s | Narrator, helper, explainer |
| Qwen3.5-9B | ≈ 5.5 GB (est.) | Yes, with about 16-32 K ctx (tight with desktop) | Yes, with 32 K | Full GPU | ≈ 50-90 tok/s | Explainer, light reviewer (unverified) |
| Qwen3.6-27B (dense) | ≈ 16-17 GB (est.) | No | No | Partial offload | Single digits | Not recommended locally |
| **Qwen3.6-35B-A3B** | 22.1 GB (UD-Q4_K_M, HF listing) | Attention/shared layers on GPU; experts in RAM (≥ 32 GB system RAM, unverified) | Same, more layers on GPU | `--n-cpu-moe` / `-ot ".ffn_.*_exps.=CPU"` | ≈ 10-25 tok/s; long-prompt prefill may take minutes | Local reviewer/agent candidate |
| Qwen3-Coder-30B-A3B | ≈ 18-19 GB (est.) | As above | As above | Expert offload | Similar to above | Coding-specialized comparison |
| Qwen3-Coder-Next 80B-A3B | ≈ 45-50 GB (est.) | Needs ≥ 64 GB RAM | Same | Expert offload | Lower | Probably impractical |
| DeepSeek V4/V4.1 Flash (≥ 284 B) | ≥ 150 GB at 4-bit (est.) | No | No | — | — | **Use DeepSeek through its API** |

**Coexistence.** Claude Code and Codex processes use no GPU; they are cloud-backed. A local model
server holds its weights while loaded (Ollama `keep_alive`), so plan for one resident local model.
Use at most one local agentic seat, plus optionally a 4 B Narrator, which competes for the same
VRAM and bandwidth. Concurrent requests (Ollama `OLLAMA_NUM_PARALLEL`, llama-server `--parallel`)
multiply KV memory. Duo's parallel template steps (`runtime.ts:180`) would queue on one GPU.

**Direct inference vs local models through a harness.** Direct local calls (no harness) are the
fast path for the Narrator and helpers: short prompts and no tools. Running a local model inside
Claude Code (or Qwen Code/OpenCode) is what reviewer and agent roles need: repository tools and
enforced permissions. It costs the harness's large fixed prompt, and it depends on the model's
tool-call reliability. Those are two separate benchmark tracks.

### E.3 Desktop benchmark plan (run by the user; record results in a CSV)

Tests that need the desktop are marked **[desktop]**. Nothing here was run.

0. **Inventory [desktop].**
   - `nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv`, `free -g`,
     `lscpu | grep 'Model name'`, `sudo dmidecode -t memory | grep -i 'configured.*speed'`.
   - Idle VRAM with the desktop plus Duo open: `nvidia-smi --query-gpu=memory.used --format=csv -l 1`.
1. **Install a CUDA inference server [desktop].** Use llama.cpp (CUDA build) and/or Ollama with
   CUDA. CachyOS/Arch package names need checking (for example `ollama-cuda`, `llama.cpp-cuda`).
   Check: `curl http://127.0.0.1:11434/api/version` (Ollama ≥ 0.14 for `/v1/messages`).
2. **Raw throughput [desktop].**
   - Run `llama-bench -m <gguf> -ngl 99 -fa 1 -p 512,4096,16384 -n 128` for Qwen3.5-4B, Qwen2.5-Coder-7B (stable baseline), Qwen3.5-9B,
     Qwen3.6-35B-A3B (with `-ot ".ffn_.*_exps.=CPU"`, then tune `--n-cpu-moe`) and
     Qwen3-Coder-30B-A3B.
   - Record prefill tok/s, decode tok/s and peak VRAM. Repeat with q8_0 KV (`-ctk q8_0 -ctv q8_0`).
3. **Anthropic endpoint smoke [desktop].**
   - Start `llama-server -m <gguf> --jinja -c 32768 -fa on -ngl 99 [--n-cpu-moe N] --port 8080`,
     or use Ollama.
   - Then `curl -s http://127.0.0.1:8080/v1/messages -H 'content-type: application/json' -d '{"model":"local","max_tokens":64,"messages":[{"role":"user","content":"Reply with: ok"}]}'`.
4. **Claude Code harness on the local model [desktop].**
   - In a scratch folder:
     `ANTHROPIC_BASE_URL=http://127.0.0.1:8080 ANTHROPIC_AUTH_TOKEN=local claude -p --model <served-name> --tools Read,Grep,Glob --output-format stream-json --verbose "Summarize README.md"`.
   - Record time to first token, the first turn's `input_tokens` (the harness prefix), success, and
     whether `result` and `rate_limit_event` appear.
   - Check background-model mapping. Claude Code env var names such as
     `ANTHROPIC_DEFAULT_HAIKU_MODEL` must be verified against the Claude Code env-vars page.
5. **Structured-output compliance [desktop, optional DeepSeek account].**
   - Run 20 calls of `claude -p --json-schema "$(node -e "import('./src/schemas.ts').then(m=>console.log(JSON.stringify(m.REVIEW_SCHEMA)))")" …`
     against a small diff.
   - Count `structured_output` present and schema-valid (validate with Duo's `schemaError`). Do the
     same for `DEBATE_SCHEMA`. Repeat with DeepSeek Flash; **this is a paid call, and needs the
     user's key and consent.**
6. **Agentic fixture [desktop].**
   - Copy `test/fixtures/workspace/stats.py` into a fresh git repository. It has two real defects:
     `average([])` returns `0` instead of `0.0`, and `median` is wrong for even-length lists.
   - Task: "fix both, add pytest tests, run them". Five runs per combination:
     Claude Code + local 35B-A3B; Qwen Code + same model (`--openai-base-url`); OpenCode + same
     model; Claude Code + DeepSeek Flash; Codex + DeepSeek Flash through the Responses route
     (both paid and optional; the Codex one only after phase 1b's config gate).
   - Record pass/fail of `python -m pytest`, wall time, tool errors, turns, and whether any write
     escaped the folder.
7. **Duo end-to-end [desktop, after milestone H.2].**
   - `duo review -s 'claude:<local-model>+provider=local-llama' -s codex:gpt-6-sol@medium --base HEAD~1 -C <fixture repo>`
     and `duo ask --no-project -s 'claude:<model>+provider=…' "…"`.
   - Inspect `run.json` (provider host recorded, no key), taps, the report and the error hints.
8. **Coexistence [desktop].** Repeat step 4 while Duo's GUI, a browser and a cloud Pair run are
   active. Watch VRAM headroom, desktop responsiveness and time to first token. Test a 4 B Narrator
   model resident alongside the 35B-A3B.
9. **Failure behavior [desktop].** Stop the server mid-turn, start a turn with the server offline,
   and send an over-long context. Expect a clear, classified error and no format-repair retry
   (after phase 1 fixes B11).

CSV columns: `date, gpu, vram_total, ram, server+version, model+quant, ctx, kv_type, offload,
pp_tok_s(512/4k/16k), tg_tok_s, ttft_s, harness+version, task, runs, passes, schema_valid_rate,
tool_errors, notes`.

---

## F. Recommended architecture

### F.1 Boundaries

| Concern | Owner after the change | Notes |
|---|---|---|
| **Provider auth** | Provider profile names an **env var** (`credentialEnv`), never a value. Duo reads it at spawn and injects it into **that seat's** process only. | Nothing in `config.json`, run records, taps or the GUI state. `doctor` reports set/unset only. No new keychain dependency. |
| **Child environment** | One pure builder (H.1): inherited env → omit listed routing/auth variables → apply the seat's overlay. Keyed per Codex route and per Claude session id. It never mutates `process.env`. | Prerequisite for mixed seats (B19). The key still reaches the harness process and any shell it runs, so it is not a vault; document that residual boundary. Duo's own launch token never enters a provider overlay (B20). |
| **Model identity** | `seat.model` plus `seat.provider` (default `vendor`). Recorded in `SeatRecord` with the requested *and* resolved model. | Peer label "DeepSeek deepseek-flash (via Claude Code)" or "(via Codex)". |
| **Harness** | `seat.engine`, kept as is (`claude` = Claude Code, `codex` = Codex CLI). | No rename, so saved templates and specs stay valid. |
| **Direct inference** | Separate `DirectClient` (OpenAI-chat-compatible, Node `fetch`) used **only** by tool-less features (Narrator, later helper roles). | Never a coding seat. |
| **Capabilities** | Static registry per (harness, provider kind), refined by a profile's dated user assertions and optional probes. | Evidence levels as in this document. |
| **Tool/permission authority** | Always the harness (CLI tools allowlist, sandbox, approval cards). Duo only *selects* modes. | Adapters must never broaden access to make a backend work. |
| **Session lifecycle** | claw, as today. Restart/resume logic in `Engines` unchanged. | Direct roles are stateless (`session: 'fresh'`). |
| **Event normalization** | `Block` + `TurnFacts` (`src/live.ts`) is the normalized model, and `ParsedTurn` (`src/tap.ts`) is the turn summary. Claude Code on any provider reuses them. | A future harness adapter supplies parser + translator + fixtures. |
| **Usage/cost** | `Usage` unchanged. Cost gains a *source*. | Avoids presenting fabricated USD. |
| **Roles** | Templates (role access/schema) + library operations. A compatibility check at run start. | Template-first (F.5). |
| **UI** | Seat picker gains a provider choice. The chip shows a locality badge (Local / Remote: host). The template selector gains provider/locality filters. | Phase 2. |

### F.2 Component diagram (target, after phases 1-4)

```
 Seat spec  claude:deepseek-flash@high+provider=deepseek
   │ parseSeat (+provider)                        config.providers[deepseek] = { kind:'anthropic-messages',
   ▼                                              baseUrl:'https://api.deepseek.com/anthropic',
 Run start ─ capability check (role reqs × backend profile) ─► refuse | require override | ok
   │
   ▼
 Engines.openSeat ── engine 'claude' branch (unchanged args) ─► claw startSession (NO baseUrl)
   │      └─ hooks.claudeEnv(sessionId, {ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN, model maps})
   ▼                                   │
 hooks spawn ─ guard: argv --model == profile model, no "/real/" URL ─► claude CLI ─► DeepSeek | Ollama | llama-server
   │ tee raw stream (unchanged)
   ▼
 parseClaudeStream / ClaudeTranslator (unchanged) ─► TurnRecord{ usage, cost{source:'unpriced'|'rate-card'} }
                                                       └─ quota: Claude-plan cache written only for provider 'vendor'
 Bus ─► GUI blocks ─► (optional) Narrator: event selector → batcher → deterministic summary | DirectClient(local Qwen)
```

### F.3 Minimal TypeScript contracts

```ts
// src/providers.ts (new, browser-safe types; validation in config.ts)
export type ProviderKind = 'vendor' | 'anthropic-messages' /* phase 1 */ | 'openai-responses' /* phase 1b (DeepSeek), phase 5 (local) */ | 'openai-chat' /* direct only */;

export interface ProviderProfile {
  id: string;                    // ^[a-z][a-z0-9-]{0,31}$ ; 'vendor' reserved
  label: string;                 // "DeepSeek", "Local llama.cpp"
  kind: ProviderKind;
  baseUrl: string;               // https://… or http://127.0.0.1|localhost|[::1] only
  credentialEnv?: string;        // NAME of an env var, ^[A-Z_][A-Z0-9_]*$ ; never a value
  harnesses: ('claude' | 'codex')[]; // 'claude' for anthropic-messages (phase 1), 'codex' for openai-responses (phase 1b)
  models?: string[];             // offered in the picker; any model allowed if absent
  backgroundModel?: string;      // maps Claude Code's small/background model calls
  pricing?: { asOf: string; source: string; perMTok: { input: number; cachedInput?: number; output: number }; currency: 'USD' };
  assert?: Partial<Record<Capability, { level: Evidence; on: string; note?: string }>>; // user-attested
}
// derived, never stored:  locality = isLoopback(baseUrl) ? 'local' : 'remote'

export type Evidence = 'verified-e2e' | 'fake-tested' | 'official-docs' | 'user-asserted' | 'unverified' | 'unsupported';
export type Capability =
  | 'repoRead' | 'fileEdit' | 'shell' | 'osSandbox' | 'readOnlyEnforced'
  | 'structuredOutput' | 'resume' | 'streaming' | 'usageTokens' | 'costReported' | 'approvalPrompts';

export interface BackendProfile {           // (harness × provider kind) → static defaults
  harness: 'claude' | 'codex' | 'direct';
  provider: ProviderKind;
  capabilities: Record<Capability, Evidence>;
}

export interface CostRecord { amount?: number; unit: 'usd' | 'codex-credits' | 'none'; source: 'cli-reported' | 'rate-card' | 'estimated' | 'unpriced' | 'local'; }
```

`Seat` gains `provider?: string`. `SeatRecord` gains
`provider?: { id: string; host: string; locality: 'local' | 'remote' }`. `TurnRecord` gains
`cost?: CostRecord`, and the existing `usd`/`codexCredits` stay for compatibility.

### F.4 Permissions and compatibility checks

- **Read seats:** the Claude Code allowlist `Read,Grep,Glob[,WebSearch,WebFetch]`
  (`engine.ts:201-203`) is enforced by the local CLI regardless of provider. That is why read-only
  roles are safe on any Anthropic-compatible provider. `WebSearch`/`WebFetch` depend on
  server-side tools, which third-party endpoints may not implement (**unverified**). The capability
  profile marks `web` as `unverified` for non-vendor providers, and the seat option `+web` is
  refused unless overridden.
- **Writers:** unchanged `writerSeatAccess` (`pair.ts:71`). Claude's sandbox settings are local.
  Template roles still cannot grant full access (`docs/templates.md`).
- **Run-start check** (phase 2), in `RunManager.start` and the CLI equivalent. It computes
  requirements per seat from the template: role `access` ≠ `read` → `fileEdit, shell, osSandbox`;
  role `schema` → `structuredOutput`; library ops → their schemas. It compares them with the
  backend profile:
  - `unsupported` → error naming seat, role, capability and source.
  - `unverified` → error unless the start request carries `acknowledge: [{seat, capability}]`.
    The acknowledgment is recorded in `run.json.options.acknowledged` and shown in the report
    header: "used with unverified capability".
  - Never silently downgrade.
- **duo-safe:** refuses `+provider=` for remote providers. Remote providers mean source-code
  transmission that the Codex allow-rule did not consent to.
- **Remote transmission:** the first use of a remote non-vendor provider in the GUI shows a
  one-time confirmation naming the host ("files the model reads and the prompts will be sent to
  api.deepseek.com"). The CLI prints the same once per run. The seat chip shows the badge
  permanently.

### F.5 Template-first integration (per `AGENTS.md`)

- **No hidden stages.** Provider profiles change *who answers a turn*, never the workflow. Every
  shipped method stays a template, and the parity snapshots must stay byte-identical for vendor
  seats.
- **Selector extension** (phase 2): `Selector.provider?: string[]` and
  `Selector.locality?: 'local' | 'remote'`. These are added to `types.ts`, the validator
  (`validate.ts:41-43`, unknown keys still refused), the executor (`runtime.ts:12` `selected()`,
  plus `model.provider`/`model.locality` for transitions at `runtime.ts:204`) and the visual maker
  (`template-fields.tsx` `SelectorEditor`: Provider multi-select, Locality pick). Also round-trip
  tests in `template-builder.test.ts` and execution tests in `templates.test.ts`. `engine` keeps
  its meaning (the harness), so saved templates remain valid.
- **Capability requirements are derived from existing template data**, so no new template field is
  needed to enforce them. If authors later need explicit requirements ("must be verified-e2e for
  structured output"), add `Role.requires?: Capability[]` through the same four places.
- **The Narrator is an observer, not a coordination stage.** It never sends messages to seats,
  writes memory or changes state. It is available identically for chats, all built-ins and fully
  custom templates. Its settings live in run options and preferences. If it is ever allowed to
  feed anything back to agents, it must become a template role with explicit routes.

### F.6 Session, event and usage semantics

- **Sessions:** Claude Code on another provider keeps its local transcript and `--resume`.
  Continuation (`continue.ts`) works unchanged, provided the profile still exists. If the profile
  was removed, Duo fails with "provider X no longer configured", not a vendor fallback. Provider
  prompt caching is the provider's (DeepSeek documents automatic context caching; unverified
  through Claude Code).
- **Events:** unchanged parser and translator, plus a fixture captured from a real DeepSeek or
  llama-server stream in phase 1's verification step. Unknown event types are already ignored by
  both.
- **Usage:**
  - Tokens come from `result.usage` as today.
  - For cost, `costUsd` from a non-vendor provider is **ignored**, and `cost.source = 'unpriced'`
    is recorded, unless the profile has a dated `pricing` block. In that case
    `cost = rate-card estimate`, labeled as such in reports.
  - Local providers get `{unit:'none', source:'local'}`.
  - The Claude quota cache (`engine.ts:312`, `chats.ts:426`) is written only for `provider ===
    'vendor'`.
- **Terminal status** (phase 0). A turn is `done` only if the CLI reported completion **and** there
  is no unrecovered error. Chats currently show `done` when any text arrived (`chats.ts:453`). With
  partial text plus an error, show `error`/`partial` and keep the text. Runs already follow this
  rule (`engine.ts:323`).
- **Errors** (phase 1). New classes:
  - `unreachable` (`ECONNREFUSED`, `ENOTFOUND`, "connection refused"): fatal for the seat. Hint:
    "Start the local server or check the provider URL".
  - `billing` (`402`, "insufficient balance"): fatal. Hint: "top up or switch provider".
  - `context` ("maximum context length", "prompt is too long", `context_length_exceeded`): fatal.
    Hint: "raise the server context (`-c`, `OLLAMA_CONTEXT_LENGTH`) or shorten the route".
  - `rate_limited`: provider `429`s get backoff and retry within the turn budget. A plan `quota`
    stays fatal.
  - All new classes skip the format-repair retry.

### F.7 Optional Narrator: a read-only activity explainer

**Purpose.** Plain-language, bounded commentary on what agents *visibly did*, for oversight. It is
supporting functionality. It is off by default.

- **Input = existing events only.** Server-side subscription to the same events the Bus emits:
  `run_event` kinds `turn_start`/`live`/`turn`/`round`/`done` (`common.ts:14-20`) and chat
  `chat_blocks`/`chat_turn_end` (`chats.ts:275`, `:460`). It needs no new hooks into CLIs. It
  cannot interrupt seats, because it holds no session handle.
- **Event selection.** Use block *transitions* only: tool started or finished (with exit code),
  patch done, todo updated, turn end, verdict or error, round stats. Text, thinking and
  input-json **deltas are never narrated**. Only the final text of a block is eligible, clipped.
- **Batching and backpressure.**
  - Coalesce by block id into a bounded map (latest state wins).
  - Flush on turn end, every N seconds (default 20), or after K transitions (default 12).
  - If the narrator is still busy, keep coalescing. At the cap, drop the oldest *non-error*
    entries and count them ("12 earlier steps omitted").
  - `Bus.emit` is synchronous and must never await the narrator.
- **Verbosity:** `off` / `milestones` (turn ends, verdicts, errors) / `steps` (tools and patches) /
  `detailed` (adds the model's own stated plan text, quoted and attributed: "B wrote: …").
- **No claims about intentions.**
  - The system prompt allows only observed facts and quoted self-reports. It requires citations to
    event refs (`turn 7, tool 3`) and requires "not observed" when the event log lacks an answer.
  - Thinking/reasoning text is excluded by default. It is model output of uncertain fidelity and
    can be sensitive.
  - Narrations are labeled "summary of observed activity".
- **Questions about activity.** The user asks in a side panel. The question goes to the narrator
  with the *captured event log for that run or chat only*, bounded by characters. Answers are
  stored separately (`runs/<id>/narration.jsonl`, `gui/narration/<chat>.jsonl`), never in
  `turns/`, `coordination.json` or template memory, so they cannot leak into coordination.
- **Model choice is independent of the seats.** Default is a **deterministic fallback**: template
  sentences built from blocks, such as "A ran `npm test` → exit 1 (12 s)", "B edited 3 files:
  src/a.ts, …", "Reviewer approved, 0 blocking findings". Optionally `DirectClient` to a **local**
  small Qwen (4 B Q4, about 3 GB VRAM est.). A remote narrator needs the same remote-transmission
  acknowledgment as a seat, because tool outputs contain source code.
- **Resource policy.**
  - If a local agentic seat uses the same server, the narrator yields: it waits for the seat's
    turn end or falls back to deterministic output.
  - One in-flight narration per run.
  - Context ≤ 8 K tokens (est.).
- **Isolation:** no tools, no repository access, no write paths. HTTP only to the configured
  endpoint. AbortController on run end or cancel.
- **Tests:**
  - deterministic summaries for each block kind;
  - coalescing and drop counts under a synthetic flood (10 k events);
  - the narrator never blocks `Bus.emit`;
  - narration files are excluded from `coordination.json` and memory;
  - "not observed" behavior with a fake DirectClient;
  - cancellation aborts in-flight requests.

### F.8 UX

- Seat picker: Engine (Claude Code / Codex) → **Provider** (Subscription / DeepSeek / Local
  llama.cpp …, from config) → Model (profile `models` or free text) → Effort (profile-specific
  ladder if declared).
- Chips show `Local`/`Remote: api.deepseek.com` and a capability indicator: ✓ verified,
  ~ unverified, ✗ unsupported for the role the seat would hold.
- Sensible defaults: no providers are configured out of the box, so behavior is identical to
  today. "Add provider" offers presets for DeepSeek (Anthropic URL, `DEEPSEEK_API_KEY`), Ollama
  (`http://127.0.0.1:11434`) and llama.cpp (`http://127.0.0.1:8080`). Presets are data, labeled
  with the doc date they were written from.
- Advanced settings (collapsed): background model mapping, pricing card, capability assertions,
  per-provider timeout and "time to first token" watchdog (local prefill can take minutes).
- Setup check: per provider, credential env set/unset, URL locality, optional free reachability
  check (`GET /api/version` for local; no paid call). A paid live test needs explicit consent.

---

## G. Phased roadmap

Every phase keeps `npm run check` green on Linux, macOS and Windows and the 13 parity snapshots
unchanged for vendor seats.

### Phase 0: Isolation primitive, guardrails and hygiene (milestone H.1 plus focused follow-ups)

- **Objective:**
  - Give every seat a deliberately constructed child environment (B19).
  - Make an inherited Claude endpoint visible (B9).
  - Fix the two existing correctness and security issues before new backends depend on them
    (B20, B21).
  - Stop health checks from spending money silently (B23).
  - Ship these as separate small PRs, H.1 first.
- **Code areas:**
  - **H.1:** `src/env.ts` (pure `childEnv()` builder), `src/hooks.ts` (`CodexRoute.unsetEnv`, a
    per-Claude-session overlay keyed like `claudeSinks`), new tests. See H.1.
  - **Endpoint visibility:** `src/env.ts` detects an inherited `ANTHROPIC_BASE_URL`,
    `ANTHROPIC_AUTH_TOKEN` or non-`sk-ant` `ANTHROPIC_API_KEY`;
    `src/protocols/common.ts:113-122` records `versions.claudeEndpoint` (host only); `doctor.ts`
    warns; `server/main.ts` `state()` exposes it for a GUI banner.
  - **Token hygiene:** `ChatManager.mcpConfig()` (`chats.ts:231-245`) writes its file with mode
    `0600`, and `close()` removes all `gui/mcp/*.json`. Prefer an approval-only token scoped to
    the permission routes over the full launch token. Correct `SECURITY.md:8` either way.
  - **Turn status:** `chats.ts` `endTurn()` (`:452-453`) adds a `partial` status for "text plus
    error"; GUI `Chat.tsx` shows it.
  - **Health checks:** `doctor.ts` and `quota-refresh.ts` label their live steps "sends one small
    paid/plan request". The GUI asks before running them (wording only; behavior already needs a
    click).
- **Dependencies:** none.
- **Difficulty:** low each.
- **Regression risk:**
  - Low for detection and labels.
  - Moderate for the child environment, because env precedence affects binary resolution,
    `DUO_DEPTH` and managed-Codex variables. H.1 keeps old routes byte-identical.
  - Low-moderate for chat status, because GUI states change.
- **Tests:**
  - H.1 tests (below).
  - Env with `ANTHROPIC_BASE_URL` → doctor warning and host recorded in `run.json`, with no key
    value in the run dir.
  - The MCP file is created `0600` on POSIX and removed by `close()`.
  - The launch token is absent from `DUO_HOME` after shutdown.
  - A fake Claude turn emitting text then `is_error: true` ends as `partial`, not `done`.
  - Parity snapshots unchanged.
- **Definition of done:**
  - Two concurrent fake seats with different overlays and omissions cannot see each other's
    synthetic variables.
  - The parent environment is untouched.
  - An inherited endpoint is visible in `run.json`, `duo doctor` and the GUI.
  - No launch token remains on disk after a clean shutdown.
  - `SECURITY.md` matches behavior.
  - Partial-failure chats are not shown as done.
  - All tests pass on the three CI OSes.

### Phase 1: Provider profiles for Claude Code seats (milestone H.2, then hardening)

- **Objective:** DeepSeek cloud and local Anthropic-compatible servers as Claude Code seats, with
  correct attribution, no quota or cost misattribution, and classified errors.
- **Code areas:**
  - `src/config.ts` (providers + validation), `src/seats.ts` (`+provider=`), `src/hooks.ts`
    (per-session env + guard), `src/engine.ts` (env registration, cost source, quota gate),
    `src/server/chats.ts` (same for chats), `src/store.ts`, `src/errors.ts`, `src/seats.ts`
    (`seatPeerName` for provider seats only), `src/doctor.ts`, README, CHANGELOG.
  - Hardening: a captured real stream fixture (`test/fixtures/claude-deepseek-stream.jsonl`)
    once a user records one.
- **Dependencies:** phase 0's child environment (H.1). User credentials only for optional manual
  verification.
- **Difficulty:** low-medium.
- **Regression risk:** low (env and argv for vendor seats byte-identical; parity tests).
- **Tests:** see H.2, plus error-class tests for the new classes (including DeepSeek `402` →
  billing and DeepSeek `429` → `rate_limited`, not plan `quota`).
- **Definition of done:**
  - `claude:<model>+provider=<id>` works in `duo ask/review/debate/pair/template run` and GUI
    chats/runs started with that spec;
  - provider host recorded, key absent everywhere;
  - claw rewrite refused;
  - offline server gives `unreachable` with a hint and no format retry;
  - one manual run each against DeepSeek and a local server documented in the PR, as
    CONTRIBUTING asks: "which models you tried".

### Phase 1b (parallel): Codex profile for DeepSeek's Responses API

- **Objective:** a DeepSeek seat inside Codex's OS sandbox, the preferred DeepSeek *writer* route.
  Start read-only (reviewer, debater). Promote it to writer only after the writer gates in
  phase 6's test list pass on this profile.
- **Code areas:**
  - The Codex branch of `src/engine.ts` (`:173-195`): Duo-generated trusted overrides
    `model_provider="<id>"`, `model_providers.<id>.base_url`,
    `model_providers.<id>.wire_api="responses"`, `model_providers.<id>.env_key="<ENV NAME>"` and a
    model catalog path. All are restated on `exec resume` alongside the sandbox. They are passed
    through `codexOverrides`-style arguments, never through user `cfg:`, which `CFG_DENY` (`seats.ts:32-37`)
    keeps refusing.
  - A Duo-written catalog file under `CACHE_DIR`, from the profile's model metadata, replacing
    DeepSeek's shared-config setup script and its `experimental_bearer_token`.
  - `src/seats.ts` (`+provider=` allowed on Codex seats whose profile kind is `openai-responses`).
  - `src/pricing.ts` and `engine.ts:338`: no plan credits for provider seats; API USD from a
    dated rate card or "unpriced".
  - `src/quota.ts`: provider runs do not touch the plan quota.
  - `src/config.ts:115`: the Codex catalog for the plan does not list provider models.
  - `src/errors.ts`: DeepSeek 402/429 classes.
  - The child environment from H.1, which omits `OPENAI_API_KEY` and plan-routing variables and
    adds the DeepSeek key variable.
- **Dependencies:**
  - Phase 0.
  - **Gate:** a recorded check that pinned Codex 0.159.0 accepts these `-c` provider keys and the
    catalog path with `--ignore-user-config`, on both `exec` and `exec resume`. This can be done in
    Codex Cloud with `codex exec --help` and a fake endpoint for argv acceptance. Real acceptance
    needs one capped live call with the user's key.
  - DeepSeek's catalog metadata states a minimum client of 0.144.0 (*Codex study*), which the pin
    satisfies.
- **Difficulty:** medium.
- **Regression risk:** medium (Codex argv/env), guarded by `units.test.ts` and `engine.test.ts`.
- **Tests:**
  - The fake Codex records provider overrides on initial and resumed calls, with **no literal key
    in argv** (key name only).
  - The sandbox, `--ignore-rules` and `--ignore-user-config` are unchanged.
  - A ChatGPT-plan Codex seat and a DeepSeek Codex seat in the same run cannot cross-route (env
    markers).
  - Provider turns show USD/unpriced, never credits.
  - The quota cache is unchanged.
  - Error classes for 402/429/503.
  - Vendor Codex argv is byte-identical (snapshot).
- **Definition of done:**
  - A pinned-CLI acceptance record exists.
  - `codex:deepseek-flash@high+provider=deepseek` runs Review and Debate in fake tests.
  - At least one documented live read-only run (model, version, date) shows valid schemas,
    citations and a two-turn resume.
  - If the gate fails, the phase is dropped and documented; DeepSeek stays on phase 1's route.

### Phase 2: Capability registry, run-start checks, template and maker support, picker

- **Objective:** prevent unsupported assignments; let templates select by provider or locality;
  make providers selectable in the GUI.
- **Code areas:**
  - new `src/providers.ts` (static `BackendProfile` table + evidence);
  - `src/server/runs.ts` `start()` and `src/cli.ts` (check + `--acknowledge`);
  - `src/templates/types.ts`, `validate.ts`, `runtime.ts` (`selected`, transition `model.*`);
  - `gui/src/template-fields.tsx` (`SelectorEditor`), `gui/src/SeatPicker.tsx`, `gui/src/spec.ts`,
    `gui/src/types.ts`, `docs/templates.md`, `src/templates/generate.ts` (author prompt includes
    new selector keys).
- **Dependencies:** phase 1.
- **Difficulty:** medium.
- **Regression risk:** medium (template validator, maker). Protected by `templates.test.ts`,
  `template-builder.test.ts`, parity.
- **Tests:**
  - validator accepts/rejects provider/locality;
  - maker round trip (author → save → load → identical JSON);
  - execution selects only local seats;
  - unverified capability without acknowledgment refuses before any turn (no FAKE_LOG calls);
  - acknowledgment recorded in run.json and report;
  - `parseSpec`/`buildSpec` preserve `+provider=`;
  - `describe with AI` drafts using the new keys validate.
- **Definition of done:** a new method built only in the visual maker can restrict a role to
  local models and run; a writer role on a backend lacking `osSandbox` is refused with a precise
  message; every shipped template is still recreatable from a new method.

### Phase 3: Usage, cost and quota semantics; setup check; lazy CLI resolution

- **Objective:** honest accounting per provider, and an app that starts with only the CLIs the
  user's seats need (B22).
- **Code areas:** `src/store.ts` (`CostRecord`), `src/engine.ts:314-338`, `src/server/chats.ts:430-451`, `src/render.ts` (usage section, turn line), `src/protocols/common.ts:258-285` (totals by unit), `gui/src/Run.tsx`/`Chat.tsx` (labels), `src/doctor.ts` (reachability without paid calls), `src/server/main.ts:45` and
  `src/protocols/common.ts:103` (resolve a CLI only when a seat needs it, report the missing one
  as an unavailable backend instead of failing startup).
- **Dependencies:** phase 1 (and 1b for Codex provider seats).
- **Difficulty:** low-medium.
- **Regression risk:** medium (report snapshots). Update only for provider seats.
- **Tests:**
  - totals never mix units;
  - unpriced turns show "unpriced", not $0;
  - a rate card with `asOf` shows "estimate (asOf)";
  - local providers show tokens only;
  - Claude-plan quota is unchanged by provider runs.
- **Definition of done:** reports and GUI never present fabricated USD; the quota bar is unaffected
  by non-vendor seats; the app starts and runs provider-only seats with one of the two CLIs absent
  (fake test with `DUO_CLAUDE_BIN` pointing at a missing path).

### Phase 4: Narrator (deterministic first, then optional local model)

- **Objective:** F.7.
- **Code areas:**
  - new `src/narrator/` (selector, batcher, deterministic summarizer, `DirectClient` using `fetch`);
  - `src/server/main.ts` (bus subscription, endpoints `/api/narration/...`);
  - `gui/src/Run.tsx`, `gui/src/Chat.tsx` (side panel, verbosity), prefs.
- **Dependencies:** phases 1 and 3 for the provider model; the deterministic part has none.
- **Difficulty:** medium.
- **Regression risk:** low (observer only).
- **Tests:** F.7 list; also the server test that narration endpoints require the token.
- **Definition of done:**
  - deterministic narration on by user choice for chats, every built-in and a custom template;
  - model-backed narration optional, local by default;
  - remote narrator gated by the transmission acknowledgment;
  - coding turns' timing unchanged within noise in the engine tests.

### Phase 5 (conditional): Codex harness on local Responses-compatible providers

- **Objective:** let Codex's sandboxed agent use a local model.
- **Code areas:** `src/engine.ts` Codex branch (Duo-owned `-c model_provider=…`/`--oss`
  `--local-provider`, never from `cfg:`), `src/seats.ts` (provider on Codex seats),
  `src/pricing.ts` (no credits for non-vendor), `src/config.ts:115` (catalog not applicable).
- **Dependencies:** phase 1b (it reuses the Codex provider plumbing; only the endpoint and
  locality differ), phases 2-3, and desktop verification that Ollama/LM Studio serve the Responses
  API that Codex requires (Codex config reference: `wire_api = "responses"` only).
- **Difficulty:** medium.
- **Regression risk:** medium (Codex argv, guarded by `units.test.ts`/`engine.test.ts`).
- **Tests:** fake Codex records provider flags; `CFG_DENY` still refuses user `model_provider`; vendor Codex seats byte-identical.
- **Definition of done:** a desktop-verified Codex writer on a local model completes the `stats.py` fixture in the sandbox; otherwise the phase is dropped and documented.

### Phase 6 (conditional): One additional harness adapter

- **Objective:** OpenCode or Qwen Code, whichever wins the E.3 step 6 comparison, starting with
  **read-only roles only**.
- **Code areas:**
  - introduce `HarnessAdapter` (spawn route + raw tee, parser, translator, access mapping, usage
    semantics) in `src/engine.ts`, `src/hooks.ts`, `src/tap.ts`, `src/live.ts`, `src/server/chats.ts`;
  - replace `engine ===` branches with the adapter table (Option B);
  - prompt delivery via stdin or a temp file (B6); new fake CLI under `test/fakes/`;
  - captured real fixtures.
- **Dependencies:** phases 1-3; pinned harness version (bundled like Codex, or version-checked);
  benchmark evidence.
- **Difficulty:** high.
- **Regression risk:** medium-high (touches engine core; parity tests guard).
- **Tests:**
  - argv length (200 KB prompt succeeds);
  - read-only enforcement against adversarial "write a file" and "delegate to a subagent" prompts
    with the real CLI (claw's own guidance);
  - schema compliance via Duo validation and retry;
  - resume across turns; cancellation kills the process;
  - Windows `.cmd` resolution via `bins.ts`.
- **Definition of done:**
  - read-only roles on the new harness pass all fake tests and a recorded real session;
  - writers stay refused until an OS sandbox or an equivalent boundary is demonstrated;
  - the adapter is documented with a pinned version and date.

---

## H. First implementation milestone (one Codex Cloud PR), then the next

This revision merges the Codex study's milestone (environment omission for Codex routes) with
mine (provider profiles for Claude seats). **H.1** is the shared prerequisite, small enough for
one Codex Cloud PR and invisible to users. **H.2** is the first user-visible step, built on H.1.

### H.1 Shared per-seat child environment for Codex and Claude spawn routes

**Scope:** an internal primitive only. No seat or template syntax, provider definitions, key
handling, pricing, prompts or new dependencies, and no network calls. Routes that do not use the
new fields must spawn with **identical argv and environment**.

**Exact changes**

1. `src/env.ts`: add a pure builder:

   ```ts
   export function childEnv(inherited: NodeJS.ProcessEnv, omit: readonly string[] = [], overlay: Record<string, string> = {}): NodeJS.ProcessEnv
   ```

   - Precedence is explicit: copy `inherited` → delete each name in `omit` (missing names are
     harmless) → apply `overlay`.
   - Never mutate the arguments or `process.env`.
   - Throw if `omit` contains `DUO_DEPTH` (`DEPTH_VAR`), or if `overlay` sets it to anything other
     than `'1'`. Seats must never lose the recursion guard.
2. `src/hooks.ts`
   - `CodexRoute` gains an optional `unsetEnv?: readonly string[]`.
   - In the Codex branch of `install()` (`:122-140`), build
     `env: childEnv(options.env ?? process.env, codex.unsetEnv, codex.bin.env)`.
   - Add `claudeEnv(sessionId, spec | undefined)` with `spec = { unset?: readonly string[]; overlay?: Record<string,string> }`,
     stored in a map keyed by Claude session id, like `claudeSinks` (`:36`, `:60-63`).
   - In the Claude branch (`:141-151`), when an entry exists for the session parsed by
     `claudeSessionOf(args)`, build
     `env: childEnv(options.env ?? process.env, spec.unset, { ...claude.env, ...spec.overlay })`.
   - Without an entry, keep today's exact merge.
   - Export `claudeEnv` and clear entries wherever `claudeSink(…, undefined)` is called
     (`engine.ts:369`, `:382`; `chats.ts:222`).
   - Nothing calls the new fields yet, apart from tests.
3. `test/fakes/codex.mjs` and `test/fakes/claude.mjs`: in the existing `record()` entry, add
   `markers` with the values of variables matching `^DUO_TEST_MARKER_` only. Also add `presence`
   flags (booleans) for `OPENAI_API_KEY`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` and
   `ANTHROPIC_API_KEY`. Never record other values.
4. New `test/child-env.test.ts`:
   - precedence and omission;
   - inputs are not mutated;
   - `DUO_DEPTH` cannot be omitted or changed;
   - overlay wins over inherited values.
5. New `test/hooks-env.test.ts`, using real claw sessions against the fakes, as `engine.test.ts`
   does:
   - Two Codex routes run concurrently with different `DUO_TEST_MARKER_*` overlays, and one omits
     `OPENAI_API_KEY` (set in the parent to a synthetic value). Each fake sees only its own marker,
     and only the omitting route lacks the key. The same holds on the resumed (`exec resume`)
     turn.
   - Long stdin prompts (150 KB), `--ignore-rules` and the sandbox flags are unchanged.
   - Two Claude sessions in one manager, one registered with `claudeEnv`: only that process sees
     its overlay and omissions.
   - `process.env` is identical before and after.
   - A route without the new fields records exactly the same argv and `presence` as before (assert
     against a run with the feature unused).
6. Run `npm run check`. In the PR, state that no provider, model or account was called, and that
   this proves process configuration only.

**Acceptance:**
- All 114 baseline tests pass, plus the new ones.
- Parity snapshots are unchanged.
- There is no new `process.env` mutation (the existing `CODEX_BIN` handoff stays as it is).
- Concurrent fake seats cannot read each other's synthetic configuration.

**Excluded:** applying a scrub policy to existing users. Which variables to omit by default is a
reviewed decision in H.2 and phase 1b.

### H.2 Next PR: seat provider profiles for Claude Code seats (Anthropic-compatible endpoints)

**Scope:** engine and CLI path, plus chats and runs that receive such a spec. It builds on H.1.
No GUI editor, no template-selector change, no Codex providers (phase 1b), no new dependencies,
and no network calls in tests. Existing vendor seats must spawn with **identical argv and
environment**.

**Exact changes**

1. `src/config.ts`
   - Add `providers?: Record<string, ProviderProfile>` to `Config`. `loadConfig()` copies it.
   - New `validateProviders()`:
     - `id` matches `^[a-z][a-z0-9-]{0,31}$` and is not `vendor`;
     - `kind === 'anthropic-messages'` (others refused for now);
     - `baseUrl` parses as a URL and is `https:`, or `http:` only for `127.0.0.1`, `localhost` or
       `[::1]`;
     - `credentialEnv` optional, matching `^[A-Z_][A-Z0-9_]*$`;
     - the keys `apiKey`/`token`/`key` are **refused** with "store the key in an environment
       variable and name it in credentialEnv";
     - `models?: string[]`, `backgroundModel?: string`.
   - Unknown keys refused. Errors name the provider.
2. `src/seats.ts`
   - Option `provider=<id>`: Claude-only (`claudeOnly`). Sets `seat.provider`.
   - `formatSeat` appends `+provider=<id>` after effort-related options.
   - In safe mode (`duo-safe`), refuse with "custom providers are disabled in duo-safe".
3. New `src/providers.ts`
   - `resolveProvider(cfg, id)`: throws a `SeatError` "unknown provider X (configured: …)" when
     missing.
   - `providerEnv(profile, model)`: builds `{ ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN }` from
     `process.env[credentialEnv]`, throwing a fatal-class message "provider X: environment
     variable Y is not set" if it is configured but empty. It adds the background-model variables
     when `backgroundModel` is set. The exact Claude Code variable names must be checked against
     <https://code.claude.com/docs/en/env-vars> before merging, and the PR must name the doc date.
   - `isLoopback(url)` and `providerRecord(profile)` → `{ id, host, locality }`.
4. `src/hooks.ts` (on top of H.1's `claudeEnv`)
   - Extend the H.1 spec with `expect?: { model: string }`.
   - In the spawn hook's Claude branch (`hooks.ts:141-151`), when an entry with `expect` exists for
     the session:
     - **Guard:** if argv `--model` ≠ `expect.model`, or the inherited `ANTHROPIC_BASE_URL`
       contains `/real/`, do not spawn the CLI. Return a process that exits 1 with stderr
       "duo: refused to start provider seat: claw-orchestrator changed the model/endpoint
       (OpenClaw gateway detected?)". This becomes a turn error, which the fatal rule must match.
     - Otherwise use H.1's `childEnv()`. Pass `unset` = `ANTHROPIC_API_KEY` plus any inherited
       `ANTHROPIC_*` routing variables, so the documented gateway token takes precedence
       unambiguously. Pass `overlay` = `providerEnv(...)`.
   - No behavior change when there is no entry.
5. `src/engine.ts` `openSeat()` Claude branch (`:196-224`)
   - If `seat.provider`, resolve the profile, call `claudeEnv(sessionId, providerEnv(...), { model: seat.model })`.
   - Never pass `baseUrl` to claw.
   - Set `record.provider = providerRecord(profile)`.
   - Clear the env entry in `retire()`/`close()` next to `claudeSink(…, undefined)`.
   - In `send()`, skip `saveClaudeQuota` (`:312`) for provider seats and set `usd` to `undefined`.
     Record `turn.costSource = 'unpriced'` (a minimal optional field on `TurnRecord`; the full
     `CostRecord` comes in phase 3).
6. `src/server/chats.ts` `ensureLive()` (`:310-327`): the same env registration for Claude chats
   with a provider seat. Skip `saveClaudeQuota` (`:426`) and USD (`:447-451`) for provider chats.
   Add the provider to the `key` (`:280`) so changing provider restarts the session.
7. `src/store.ts`: `SeatRecord.provider?: { id: string; host: string; locality: 'local' | 'remote' }`; `TurnRecord.costSource?: 'unpriced'`.
8. `src/errors.ts`: add, before `other`, an `unreachable` rule for
   `/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|connection refused|refused to start provider seat/i`. Treat
   it like `fatal` in `RunContext.send()` (`common.ts:218`), so it gets no retry. Add matching
   `errorHint`s. Keep existing classifications unchanged (`units.test.ts`).
9. `src/seats.ts:179` `seatPeerName()`: for provider seats only, return
   `"<label> <model> (via Claude Code)"`. Vendor seats are unchanged, so the parity snapshots are
   unchanged.
10. `src/doctor.ts`: list providers with host, locality and "credential env set/unset". No network.
11. `README.md` (a "Other providers" subsection with the remote-transmission warning and DeepSeek,
    Ollama and llama.cpp examples, each with its doc link and date) and `CHANGELOG.md` (Unreleased).

**Tests** (all with fakes; no network):

- `test/fakes/claude.mjs`: additionally record `{ env: { ANTHROPIC_BASE_URL, hasAuthToken: !!ANTHROPIC_AUTH_TOKEN, hasApiKey: !!ANTHROPIC_API_KEY } }`
  in the existing `record()` call. It must stay backward compatible, and it must never record
  token values.
- `test/seats.test.ts`:
  - `claude:deepseek-flash@high+provider=deepseek` round-trips through `parseSeat`/`formatSeat`;
  - `codex:…+provider=x` is refused;
  - duo-safe refuses.
- New `test/providers.test.ts`:
  - validation accepts https and loopback http;
  - it refuses `http://192.168.1.5`, a bad env name, an inline `apiKey`, an unknown `kind`, and
    the reserved id `vendor`;
  - `isLoopback` covers `[::1]`.
- `test/engine.test.ts` (new cases, using `DUO_CONFIG` with a provider and `PROBE_KEY=secret-value` in env):
  1. In an `ask` run with seats `claude:local-model+provider=local` and `claude:sonnet`, the
     provider seat's fake sees `ANTHROPIC_BASE_URL=http://127.0.0.1:9`, `hasAuthToken: true`,
     `hasApiKey: false` and `--model local-model`. The vendor seat sees none of these, and its
     argv equals the pre-change argv.
  2. The string `secret-value` appears nowhere under the run directory (run.json, turns, taps) or
     in `GUI_DIR` chats.
  3. `run.json` seat has `provider: { id: 'local', host: '127.0.0.1:9', locality: 'local' }`.
  4. The Claude quota cache file is not written by the provider seat (`CACHE_DIR/claude-quota.json`
     absent, or unchanged after the run).
  5. A missing credential env makes the seat fail fatally with the hint, and the run stops
     (`minSeats`) without the other seat making extra calls.
  6. Guard: with `GATEWAY_URL=http://127.0.0.1:9` set (claw then injects its proxy `baseUrl` for a
     non-Claude model name), the provider seat's turn errors with the "refused to start provider
     seat" message, is classified `unreachable`/fatal, and the run is `failed`, **not**
     `completed`.
- `test/units.test.ts`: new error classes; existing expectations unchanged.
- `test/server.test.ts`: a chat created with a provider spec stores the spec, and
  `PATCH` to a different provider changes the session key (assert via the fake log: two spawns).
- New `test/gui-spec.test.ts` (imports `gui/src/spec.ts`, which is pure TS):
  `buildSpec(parseSpec('claude:deepseek-flash@high+provider=deepseek'))` returns the same string.
- **Must stay green unchanged:** `template-parity.test.ts`, `templates.test.ts`,
  `template-builder.test.ts`, `debate.test.ts`.

**Definition of done:**
- `npm run check` passes on all CI OSes.
- Vendor-seat argv and env are unchanged (asserted).
- No credential value is persisted.
- The claw model/URL rewrite is refused visibly.
- The PR description lists what was verified with fakes only, and any manual DeepSeek/local run
  with model, version and date (CONTRIBUTING "Tried it with real models").

---

## I. Open questions and risks

### I.1 Confirmed findings

Confirmed by repository reading or the probe:

- Duo accepts only `codex`/`claude` engines in seat specs, chats, templates and the GUI (Repo;
  **Probe P1/P2**).
- claw 7.6.0 has OpenCode/custom engines and Claude `baseUrl` support that Duo does not use (Repo).
- claw passes OpenCode prompts on argv: 200 K chars → `spawn E2BIG`. It does not forward
  `jsonSchema` to OpenCode, prepends the system text to the first message, enforces read-only via
  an injected agent, and resumes by `--session` (**Probe P3**).
- claw rewrites non-Claude models to `opus` with a `/real/` URL when `baseUrl` is set, and passes
  model and env through unchanged otherwise (**Probe P4/P5**).
- Duo classifies offline, billing and context errors as `other` (**Probe P6**).
- An inherited `ANTHROPIC_BASE_URL` reaches Claude seats today (Repo + **Probe P5**).
- Re-verified from the Codex study (Repo, A.5):
  - the launch token is written to disk despite `SECURITY.md:8`;
  - chat turns with partial text and an error show as `done`;
  - `doctor --live` and quota refresh send real prompts;
  - both CLIs are resolved at startup;
  - the pair check runs on the host with `shell: true` and a direct-child-only kill;
  - Continue covers Debate, Ask and Pair only.
- Per-seat environment is additive only. No seat can drop an inherited variable today (B19).

### I.2 Supported by official docs, untested here

- DeepSeek's Anthropic endpoint and Claude Code integration; its model naming, prices and context.
- DeepSeek's Codex integration: a Responses API "specifically adapted for Codex" (2026-08-13),
  `wire_api = "responses"`, a model catalog, a stateless API, and web search with V4 Pro only.
- DeepSeek per-account concurrency (2,500 Flash / 500 Pro), and 402 vs 429 semantics.
- Ollama ≥ 0.14 and llama.cpp `/v1/messages`.
- Qwen Code `--json-schema`, stream-json and approval modes.
- Codex `--oss` and its `responses`-only custom wire API.
- The Claude Code gateway env vars and their precedence over a saved login.

### I.3 Hypotheses that need evidence

- The pinned Codex 0.159.0 accepts Duo-generated `model_provider`/`model_providers.<id>.*` and a
  catalog path via `-c`, under `--ignore-user-config`, on both `exec` and `exec resume` (B24).
  This is the phase 1b gate.
- `exec resume` against DeepSeek's stateless Responses API replays enough history for multi-turn
  Debate and Pair (no `previous_response_id`).
- DeepSeek through Codex (an endpoint tuned for Codex) is more reliable for writers than DeepSeek
  through Claude Code. That needs E.3 step 6 with both routes.
- *Codex study* items not corroborated here: DeepSeek peak-hour windows, Responses end-of-stream
  events, `reasoning_content` replay rules, strict-schema constraints, and the minimum Codex
  version in DeepSeek's catalog.
- Claude Code's `--json-schema` produces schema-valid `structured_output` reliably on DeepSeek Flash
  and on local Qwen3.6-35B-A3B (E.3 step 5).
- Claude Code's stream-json events from a third-party endpoint match the fixtures Duo parses,
  especially `result.usage`, `total_cost_usd` and `rate_limit_event` (capture one real stream).
- Claude Code accepts arbitrary model names with a gateway and routes background calls as
  configured. Check the env-var names.
- Effort values (`@high`) are honored, ignored or rejected by DeepSeek and local servers.
- Qwen-tuned harnesses (Qwen Code) outperform Claude Code on the same local Qwen model
  (E.3 step 6).
- Local prefill latency of the Claude Code prefix is acceptable on the 3080 (E.3 step 4).
- OpenCode accepts a prompt on stdin (would fix B6).

### I.4 Provider credentials and live API tests

- No account was accessed and no paid call was made. DeepSeek verification needs the user's key,
  consent and budget. A minimal plan is about 20 short schema calls on Flash.
- Credentials go in environment variables named in the config. Keychain integration is deferred
  to avoid new dependencies. It is a reasonable later choice for the desktop.

### I.5 Desktop and GPU validation

- Everything in section E: VRAM variant, RAM size and speed, the CUDA stack on CachyOS, throughput
  and coexistence.

### I.6 Unresolved decisions for the maintainer

1. Should Duo ever show provider-reported USD for third-party providers, or only dated rate cards?
2. Should `duo-safe` permit *local* providers (no remote transmission)? The milestone refuses all.
3. Should DeepSeek V4 Pro be offered at all while its status is contradictory in DeepSeek's own
   docs?
4. Should a Narrator ever be allowed to see thinking or reasoning text?
5. Should phase 6 bundle a pinned harness (as Duo does for Codex) or rely on a user install with a
   version check?
6. Which DeepSeek route ships first to users: 1a (Claude Code, simpler, covers local) or 1b
   (Codex, sandboxed writer)? My recommendation is 1a for reviewers, 1b for writers if its gate
   passes.
7. The permission-bridge token: give it file mode `0600` plus cleanup, or replace it with an
   approval-only scoped token? The second is safer; the first is smaller.
8. Should a chat with partial text plus an error show a distinct `partial` status, or `error`
   with the text kept?

### I.7 Risks

- Third-party Anthropic compatibility is partial and can change silently. Mitigation: capability
  levels, a captured fixture per provider, and the visible-failure policy.
- Harness/model mismatch: Claude Code's prompts are tuned for Claude models (unverified effect).
- DeepSeek pricing and model routing have changed several times in 2026. Presets must carry dates.
- Source-code transmission to new hosts. Mitigation: locality badge, acknowledgment and duo-safe
  refusal.

---

## Verification and limitations

- `AGENTS.md`, `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, `docs/templates.md`,
  `package.json`, CI config, all of `src/` relevant to the trace, the GUI files cited, the tests
  and fakes, and the shipped `@enderfga/claw-orchestrator@7.6.0` package were read. The paths and
  line numbers cited were checked against commit `25b9cff`.
- The probe (`docs/research/model-agnostic/probe.mjs`, output in `probe-output.txt`) uses **fake
  CLIs only**. It shows how the pinned libraries pass prompts, schemas, permissions, URLs and
  session ids. **It does not demonstrate compatibility with real Claude Code, OpenCode, DeepSeek,
  Ollama, llama.cpp or any model.** It runs on Linux and macOS, where the fakes are spawned via
  their `#!` line. It is not wired into `npm test`.
- Qwen Code facts beyond its docs come from inspecting the published npm bundle (0.26.6). It was
  not executed.
- External docs were accessed on 2026-11-03 via a search index. Direct fetches of
  `api-docs.deepseek.com` and `qwenlm.github.io` were blocked by this session's network policy,
  so page dates could not be read and quoted figures may lag the live pages.
- No GPU benchmark was run. Codex Cloud and this session cannot reach the desktop GPU. All
  throughput and memory figures marked *estimate* are arithmetic, not measurements.
- **Cross-check (revision 2).** An independent Codex study of the same brief was compared with this
  report.
  - Every repository claim adopted from it was re-checked in source (A.5, B19-B24).
  - DeepSeek's concurrency and error semantics were corroborated through DeepSeek's docs (search
    index).
  - Claims I could not corroborate (huggingface.co was also blocked) are labelled *Codex study*.
  - That study is not in this repository, and the branch it names (`docs/model-agnostic-feasibility`)
    was not on the remote at the time of writing.
- No production file, dependency or test was changed. `npm run check` passed (typecheck + 114
  tests).

## References

All accessed 2026-11-03. Publication or update dates are given where the source showed them.

**Repository and pinned dependencies**
- Duo source at commit `25b9cff` (this repository); `AGENTS.md`; `docs/templates.md`.
- claw-orchestrator 7.6.0 (npm tarball): `dist/src/session-manager.js`, `persistent-session.js`, `persistent-opencode-session.js`, `base-oneshot-session.js`, `types.d.ts`, `engine-presets.d.ts`, `models.js`, `skills/references/multi-engine.md`, `skills/references/acp.md`, `configs/engines/README.md` — <https://github.com/Enderfga/claw-orchestrator>
- npm registry metadata (modified dates): `@anthropic-ai/claude-code` 2.1.317 (2026-11-03); `@openai/codex` 0.166.0 (2026-11-03; Duo pins 0.159.0); `opencode-ai` 1.19.5 (2026-10-28); `@qwen-code/qwen-code` 0.26.6 (2026-11-02); `@deepseek-ai/dsh` 0.2.1-rc.5 (2026-11-03, repo <https://github.com/deepseek-ai/deepseek-harness>); `@deepseek-ai/dsh-subagent-acp` 0.0.1-rc.1 (2026-11-03); `@enderfga/dsh-clawo` 0.1.0 (2026-08-17).

**DeepSeek** (official; read via search index, page dates not visible)
- Models & Pricing — <https://api-docs.deepseek.com/quick_start/pricing/>
- Change Log — <https://api-docs.deepseek.com/updates/> (entries 2026-08-13 Responses/Codex, 2026-09-10, 2026-10-17)
- Integrate with Codex — <https://api-docs.deepseek.com/quick_start/agent_integrations/codex/>; Using the Responses API — <https://api-docs.deepseek.com/guides/responses_api/>
- Rate Limit & Isolation — <https://api-docs.deepseek.com/quick_start/rate_limit/>; Error Codes — <https://api-docs.deepseek.com/quick_start/error_codes/>
- Cited via the Codex study only (not re-read here): Thinking Mode — <https://api-docs.deepseek.com/guides/thinking_mode>
- News: V4 Preview (2026-04-24) <https://api-docs.deepseek.com/news/news260424/>; V4-Pro GA (2026-08-13) <https://api-docs.deepseek.com/news/news260813/>; V4.1-Flash (2026-09-10) <https://api-docs.deepseek.com/news/news260910/>; V4.1-Flash-1017 (2026-10-17) <https://api-docs.deepseek.com/news/news261017/>
- Using the Anthropic API — <https://api-docs.deepseek.com/guides/anthropic_api/>; Messages API — <https://api-docs.deepseek.com/api/create-message/>; Integrate with Claude Code — <https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code/>
- Tool Calls — <https://api-docs.deepseek.com/guides/tool_calls/>; JSON Output — <https://api-docs.deepseek.com/guides/json_mode/>; Responses API — <https://api-docs.deepseek.com/guides/responses_api/>; List Models — <https://api-docs.deepseek.com/api/list-models/>
- Model cards: <https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash>, <https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash>
- Third-party (older, conflicting prices; not relied on): <https://www.morphllm.com/deepseek-api>, <https://www.nxcode.io/resources/news/deepseek-api-pricing-complete-guide-2026>, <https://apidog.com/blog/deepseek-v4-api-pricing/>

**Qwen**
- Qwen2.5-Coder-7B-Instruct config — <https://huggingface.co/Qwen/Qwen2.5-Coder-7B-Instruct/raw/main/config.json> (values via the Codex study; huggingface.co blocked in this session)
- Qwen3.6-35B-A3B — <https://huggingface.co/Qwen/Qwen3.6-35B-A3B> (weights 2026-04-16); blog <https://qwen.ai/blog?id=qwen3.6-35b-a3b>; Qwen3.6-27B blog <https://qwen.ai/blog?id=qwen3.6-27b> (2026-04-22)
- Qwen3.5 collection — <https://huggingface.co/collections/Qwen/qwen35> (2026-02-24 / 2026-03-02)
- Qwen3-Coder — <https://github.com/QwenLM/Qwen3-Coder>; <https://huggingface.co/Qwen/Qwen3-Coder-30B-A3B-Instruct>; <https://huggingface.co/Qwen/Qwen3-Coder-Next>
- Unsloth Qwen3.6 local guide — <https://unsloth.ai/docs/models/qwen3.6>; GGUF file listing <https://huggingface.co/unsloth/Qwen3.6-35B-A3B-GGUF/tree/main>; Qwen3-Coder offload guide <https://unsloth.ai/docs/models/tutorials/qwen3-coder-how-to-run-locally>
- Qwen Code docs — headless <https://qwenlm.github.io/qwen-code-docs/en/users/features/headless/>; structured output <https://qwenlm.github.io/qwen-code-docs/en/users/features/structured-output/>; settings <https://qwenlm.github.io/qwen-code-docs/en/users/configuration/settings/>; source <https://github.com/QwenLM/qwen-code>

**Harnesses and local inference**
- OpenCode — providers <https://opencode.ai/docs/providers/>; permissions <https://opencode.ai/docs/permissions/>; CLI <https://opencode.ai/docs/cli/>; agents <https://opencode.ai/docs/agents/>
- Claude Code gateways — <https://code.claude.com/docs/en/llm-gateway-connect>; <https://code.claude.com/docs/en/llm-gateway>; env vars <https://code.claude.com/docs/en/env-vars>
- Codex — config reference <https://developers.openai.com/codex/config-reference>; CLI reference <https://developers.openai.com/codex/cli/reference>
- Ollama — OpenAI compatibility <https://docs.ollama.com/api/openai-compatibility>; structured outputs <https://docs.ollama.com/capabilities/structured-outputs>; Claude Code / Anthropic API compatibility <https://ollama.com/blog/claude>; `num_ctx` issue <https://github.com/ollama/ollama/issues/16814>
- llama.cpp — server README <https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md>; function calling <https://github.com/ggml-org/llama.cpp/blob/master/docs/function-calling.md>; Anthropic Messages API <https://huggingface.co/blog/ggml-org/anthropic-messages-api-in-llamacpp> (PR <https://github.com/ggml-org/llama.cpp/pull/17570>); issues #20198 <https://github.com/ggml-org/llama.cpp/issues/20198>, #20090 <https://github.com/ggml-org/llama.cpp/issues/20090>

**Hardware**
- NVIDIA GeForce RTX 3080 family — <https://www.nvidia.com/en-us/geforce/graphics-cards/30-series/rtx-3080-3080ti/>

**Cross-check source**
- Independent Codex study, "Capability-aware coding backends for Duo: feasibility and implementation plan" (2026-11-03), supplied by the user as an upload; not in this repository.
