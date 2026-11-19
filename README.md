# Duo

**Claude Code, Codex, optional DeepSeek, and experimental Qwen Code with local models in one desktop app.** Chat with an agent, run them side by side, or let them work on the same problem together: one writes the code while another reviews it, they debate until every claim is agreed, or they cross-check each other's code reviews. Agent prompts and tool calls are recorded; token/price reporting depends on provider support.

Duo drives the official CLIs you already use, signed in with your own plans: [Claude Code](https://docs.claude.com/claude-code) (Claude subscription) and the [Codex CLI](https://github.com/openai/codex) (ChatGPT subscription). Nothing goes through a third-party server.

Runs on Linux, macOS and Windows.

![Duo home screen with the unified composer and animated mode walkthroughs](docs/screenshots/home.png)

## Modes

| Mode | What happens |
|---|---|
| **Chat** | Claude Code, Codex or Qwen Code in a project folder (or none), with streaming agent progress where supported. Pick model and permissions per chat. |
| **Side by side** | One message, two answers. Hand either answer to the other for a critical review in one click. |
| **Pair** | One model writes the code in its own git worktree, the other reviews every change, and they cycle until the writer says done, the reviewer approves, and your check command passes. You then apply the result, keep the branch, or discard it. |
| **Debate** | Blind first answers, then cross-examination over a claim ledger. After discussion ends, every model reviews the frozen ledger and records agreement or disagreement on every peer claim. File citations are verified against your code. |
| **Review** | Independent code reviews of a diff, then each reviewer confirms or rejects the others' findings. Issues found by both are the strongest signal. |
| **Council** | Several answers, ranked anonymously by peers who never see their own; a chair writes the synthesis and keeps the dissent. |
| **Ask** | The same question to several models in parallel, answers side by side. |
| **Custom** | Define roles, model assignment and switching, message routes, completion and exceptions, with bounded persistent memory. Describe a method to your chosen model to generate an editable template. |

The app shows an animated walkthrough of each mode on its home screen and next to the run form.

## Install

You need:

- **Node.js 22.18 or newer** (Duo runs its TypeScript sources directly).
- **git** (pair mode and the Changes panel use it).
- **Claude Code**, installed and signed in: run `claude` once and use `/login`.
- **A ChatGPT account for Codex**: Duo bundles a pinned Codex CLI; sign in with `npx codex login` from the Duo folder, or through the ChatGPT desktop app.

```bash
git clone https://github.com/finakechi/duo-ted.git
cd duo-ted
npm install
node bin/duo.js setup
duo doctor
```

For a versioned release, download the source bundle and `SHA256SUMS` from [GitHub Releases](https://github.com/finakechi/duo-ted/releases), verify the checksum, extract it, and run `npm ci` followed by `node bin/duo.js setup` in the extracted folder. Bundles include the built GUI and require the same Node.js, Git and CLI sign-ins as a checkout. See the [0.3.0 release notes](docs/releases/0.3.0.md).

`duo setup` adds an app launcher (the application menu on Linux, `~/Applications/Duo.app` on macOS, the Start menu on Windows), the `duo` and `duo-safe` commands, a `/duo` skill for Claude Code, a `$duo` skill for Codex, and a Codex rule that pre-approves `duo-safe`. `duo setup --uninstall` removes all of it.

Then open **Duo** from your launcher, or run `duo gui`.

### Optional models: DeepSeek and local/hosted endpoints (Linux)

Claude Code and Codex work exactly as before with both optional integrations **off**, which is the default. Turning one on never changes Claude or Codex settings, and a disabled integration or profile makes no connections and shows no startup warnings.

Duo keeps four things apart, and shows each of them in Settings and in the model picker:

| | DeepSeek | Local or hosted endpoint profile |
|---|---|---|
| **Coding engine** (runs the agent loop and tools) | Codex | Qwen Code |
| **Model provider** | DeepSeek API | your inference server (Ollama, LM Studio, vLLM…) or a hosted OpenAI-compatible endpoint |
| **Model** | e.g. `deepseek-flash` | the profile's exact model ID |
| **Where it runs** | Cloud | judged from the endpoint **address**: *On this device* (loopback), *Local network* (private/LAN address, explicit opt-in), or *Cloud* |

#### Setup

- **DeepSeek:** set `DEEPSEEK_API_KEY` (or another variable you name) in the environment **before starting Duo**, then **Settings → DeepSeek → Enable**, choose model IDs and save. The key itself is never saved, put in command arguments, logged or exported.
- **Local models:** start your own OpenAI-compatible server (Duo never installs a server or downloads weights). **Settings → Local Models → Enable**, add a profile with the endpoint (e.g. `http://127.0.0.1:11434/v1`) and exact model ID, and save. **Discover models** lists what the server offers.
  - An address on your LAN (e.g. `http://192.168.1.20:11434/v1`) needs **Allow local-network endpoint**. A "local" profile pointing at a remote/public address is refused; configure that as a hosted profile.
  - A key sent to anything other than this device must use HTTPS: an authenticated plain-HTTP LAN or remote endpoint is refused. Loopback HTTP is fine.
  - **Ollama context window:** Qwen Code sends an agent prompt of about 4,000 tokens, so a server must serve the model with more room than that. Ollama picks its serving context by VRAM tier (4K below 23 GB, 32K from 23 GB, 256K from 47 GB) or from `OLLAMA_CONTEXT_LENGTH`. With a 4K window every turn dies before the model can call a tool, and the readiness tests now say exactly that: set `OLLAMA_CONTEXT_LENGTH=32768` when starting Ollama (systemd: `sudo systemctl edit ollama` → `Environment="OLLAMA_CONTEXT_LENGTH=32768"` under `[Service]`, then `sudo systemctl restart ollama`), then test again.
- **Hosted endpoints:** **Settings → General → Hosted Qwen endpoint profiles**. HTTPS only, and the profile **must name its own API-key variable**: Duo never falls back to `OPENAI_API_KEY` or any other provider's key.
- **Qwen Code harness:** endpoint profiles run through [Qwen Code](https://github.com/QwenLM/qwen-code), on `PATH` or via `DUO_QWEN_BIN` / `qwenBin`. Duo has verified the tool set and flags of **Qwen Code 0.28.x** and refuses other releases (fail closed), because an unknown release may ship tools Duo cannot restrict. Qwen also requires **Linux with `/usr/bin/bwrap` (Bubblewrap)**; there is no unsandboxed fallback. **Settings → Setup check** reports both.

Older saved profiles that break these rules stay saved and are shown as *Unsupported* with the reason; fix them in Settings. Saving other settings is not blocked by an unchanged older profile.

#### Role readiness: proving a model can do the job

A reachable endpoint, a model list, or a model's name says nothing about whether the model can act as a coding agent. Each saved optional model therefore has three explicit, user-triggered tests in Settings:

| Test | What it proves |
|---|---|
| **Test connection** | The endpoint answers, accepts the credential, and lists the model. No text is generated. |
| **Test reviewer** | In a disposable git repository (never your project), the agent read a file **with a tool** and returned its contents. The reviewer boundary was checked: Qwen's own `qwen sandbox --verify` passed under the read-only, network-closed policy, the launch carried the reviewer tool deny list, and requested writes (inside and outside the workspace) left everything unchanged. |
| **Test writer** | In a separate disposable workspace the agent created a file with the requested content using a write tool, and a write outside the workspace did not land. |

Each test is bounded (connection 10 s, sandbox check 30 s, model task 120 s), can be cancelled, and removes its folder afterwards. Failures say why: unreachable endpoint, rejected key, no tool calls (the model or server lacks tool calling), malformed stream, timeout, missing sandbox, or a boundary violation. **Cloud models** (DeepSeek, hosted endpoints) ask you to confirm before the reviewer/writer tests, because they send a few short prompts that the provider may bill.

The outside-write sentinel does not sit next to the disposable workspace: the Linux sandboxes Duo relies on (Codex's bubblewrap sandbox, Qwen's executionSandbox) keep the system temp dir writable, so a "sibling in /tmp" is inside the sandbox, not outside it. The sentinel lives under your home directory, which the sandbox mounts read-only; a successful escape write there is a real boundary violation and fails the test. If no such location exists (e.g. HOME points into the temp dir), the test fails closed instead of pretending a boundary.

Results are kept **in memory only** and are tied to the profile, endpoint, model, credential variable, harness version, sandbox and Duo's tool policy. After a restart, or any change to those, the model shows *Needs a new test*. Status labels: *Disabled*, *Unsupported*, *Not tested*, *Unreachable*, *Connected · roles not verified*, *Role test failed*, *Verified: reviewer*, *Verified: writer*, *Verified: reviewer and writer*.

#### Using optional models in runs

- **Every workflow enforces the same rule** (chats, Pair, Review, Ask, Debate, Council, continuations, queued reassignments and custom templates): an optional model may hold a **writer** role only after passing the writer test, and any other role (reviewer, participant, chair) only after passing the reviewer test. Codex and Claude Code need no test. The run setup shows the exact reason before you start, and the executor checks again when it opens each agent (a chat fails its turn before any CLI or endpoint is contacted).
- **Manual** assignment uses your choices exactly and explains any ineligible one. **Automatic** considers only optional models with a verified role, plus available Codex/Claude CLIs; **Hybrid** keeps your pinned seats. If no eligible agent exists for a slot, the run does not start: Duo never substitutes a model silently. Local First / Cloud First / Best Fit are fixed orderings, not quality scores.
- A **Qwen writer** always runs inside Bubblewrap with workspace-write access. *Sandboxed + network* opens command networking for it; *Full access* is refused for Qwen. Host-side web tools (`web_fetch`, `web_search`) are never available to Qwen seats, and reviewers get only read/search tools. If Qwen's folder trust is enabled and the workspace is untrusted, Qwen silently downgrades write access; Duo detects this and stops the turn with instructions instead of reporting a writer that cannot write.
- Pair worktrees, the independent reviewer, revision cycles, verification commands, the completion check and **human approval before applying** are unchanged. Stop cancels running work, and a turn cancelled during a queued reassignment never starts afterwards.

#### Privacy boundaries

- Task context goes to whichever provider each seat uses: DeepSeek's cloud, your hosted endpoint, or your own server. A Pair reviewer sees the writer's diff by design.
- **Switching providers never carries a stored conversation along.** In chat, moving to another provider or endpoint (or editing the profile's endpoint) starts a new conversation and says so; earlier messages from a local model are not sent. In a run, reassigning a seat that ran on this device or your LAN to a cloud model asks you to confirm, because Duo forwards up to three of that seat's earlier replies; unconfirmed, the cloud model starts without them. A recorded session is resumed only on the backend that created it.
- For endpoint profiles, the Qwen process (and anything the model runs) receives only that profile's own key; other credential variables in Duo's environment are removed, and the key is redacted from streams, traces and errors.
- Duo points Qwen at its own operator policy file through `QWEN_CODE_SYSTEM_SETTINGS_PATH`; this replaces any `/etc/qwen-code/settings.json` policy for Duo's Qwen seats.

#### Example: mixed-provider Pair

1. Make sure the writer has passed **Test writer** (e.g. DeepSeek `deepseek-flash`, or a local profile) in Settings.
2. **New run → Pair**. Writer: pick **DeepSeek · deepseek-flash** (Codex model picker) or your local profile (Qwen model picker). Reviewer: `claude:sonnet@medium` or a Codex model.
3. Choose **Git worktree**, writer access **Sandboxed**, and a check command such as `npm test`.
4. Start, watch the cycles, then review the diff and **Apply**, **Keep** or **Discard**. CLI equivalent: `duo pair -s codex:deepseek-flash@high+provider=deepseek -s claude:sonnet@medium --check "npm test" -C ~/code/app "Fix the failing parser test"` (the CLI does not run readiness tests; it relies on you to choose eligible models).

#### Troubleshooting

- **Unsupported: set `KEY` in the environment:** export the variable in the shell that starts Duo, then restart Duo.
- **Unreachable / model not listed:** start the server; check the address, the `/v1` suffix and the exact model ID.
- **"made no tool calls":** the model or the server's chat template does not support tool calling. Pick a tool-capable model or server configuration; connectivity alone is not enough.
- **Sandbox not established / Bubblewrap missing:** install Bubblewrap and make sure unprivileged user namespaces are allowed. Claude and Codex keep working.
- **Qwen Code X is not verified by Duo:** install Qwen Code 0.28.x.
- **Needs a new test:** a setting, the harness or Duo restarted since the last test; run it again.
- **Codex read-only sandbox errors (DeepSeek):** the host may block Codex's sandbox. Do not disable review isolation to work around it.

**Limitations.** The repository's tests use fake Qwen/Codex CLIs and fake endpoints: they verify Duo's routing, isolation, gating and evidence handling, not any real model's ability. Whether a given model passes the role tests depends on the model, server and harness on your machine. macOS and Windows are not supported for optional models in this release. Usage from DeepSeek and endpoint profiles is shown as *unpriced*.

Notes:

- `npm install` builds or downloads one native module (`re2`, used by claw-orchestrator). If your npm asks to approve install scripts, approve `re2` and `electron`.
- `duo doctor` (or **Settings → Setup check** in the app) checks both CLIs, their sign-ins and versions; **Test both sign-ins** sends one tiny message through each to prove they work.

## The desktop app

- **Home**: one box for everything. Type, pick Claude, Codex, Both, Pair, Debate, Council, Ask or Review, press Enter.
- **Chats**: live tool steps, thinking, diffs and plans; Claude permission modes from *Plan* to *Full access*, with *Ask before acting* approval cards; Codex sandbox modes; switch model or effort mid-conversation without losing the thread; retry, copy, hand an answer to the other model, or escalate a question to a debate, council or pair run.
- **Runs**: a live view of every seat while it works, the rounds or cycles as they land, the claim ledger, findings, rankings, the report, and every turn's exact prompt, reply, tool calls and reasoning. Stop a run at any time; continue a finished one with a note.
- **Always in view**: both plans' 5-hour and weekly usage, the project's git changes, and a token, time and cost trace.
- **Quality of life**: command palette (`Ctrl/⌘ K`), keyboard shortcuts (`Ctrl/⌘ /`), pinned chats, search, drafts that survive restarts, desktop notifications when a long run finishes in the background, light and dark themes.

## Pair mode

![Pair mode setup with writer and reviewer seats and workspace controls](docs/screenshots/pair.png)

```
duo pair -s codex:gpt-6-sol@high -s claude:opus@high --check "npm test" -C ~/code/app "Add rate limiting to the login endpoint"
```

1. Duo creates a git worktree on a new `duo/…` branch from `HEAD` (or, with `--in-place`, snapshots the folder so it can show and revert exactly what changed).
2. The **writer** (first seat) implements the task, runs what it can, and reports what it did.
3. Duo runs your **check command**, if you gave one.
4. The **reviewer** (second seat, read-only) verifies the diff against the request and approves or files findings with severity, location and fix.
5. The writer fixes or disputes each finding; repeat.

It stops when the writer reports done, the reviewer approves with no P0/P1 finding open, and the check passes. It also stops if the writer is blocked, if the two deadlock on a finding (you decide), or at the cycle cap. Nothing touches your folder until you choose **Apply** (`duo apply <run>`), **Keep branch**, or **Discard**.

Writer permissions: *Sandboxed* (Codex `workspace-write`; Claude auto-accepts edits and runs commands in its sandbox where available), *Sandboxed + network*, or *Full access*.

## Custom coordination templates

Choose **Custom** in the app to build a method visually: define roles, connect workflow steps, choose shared context, add conditions and set memory retention. A **New method** can select any of the five **Operation libraries** and add their stages directly; prompts, settings, model selectors and native response fields are editable. JSON is available only when you select its alternate editor. Use **Describe with AI** to have your chosen model generate or revise a draft in the same visual builder, then save or run it with your seats and brief. You can also copy any built-in method.

Templates are versioned JSON state machines with roles, eligibility and score-based assignment, conditional role changes, selective message routing, output schemas, completion rules, exceptions and execution budgets. Named memory channels specify the fields retained, who reads and writes them, whether they survive across runs, and maximum entries and characters. Role changes happen between model turns. Each run saves its exact definition and workflow state.

The five existing modes now run through the same executor, using trusted operations for their claim ledgers, anonymous rankings, finding merges and pair workspaces. Debate adds a final ledger review; Continue preserves its decisions and model sessions. Memory retention controls the state referenced by future turns; Duo’s full audit trace and model CLI conversation files remain separate records.

See the [template specification](docs/templates.md) and [complete example](docs/templates/example.json).

```bash
duo template generate -s claude:opus@high -o method.json "Two researchers, a skeptic, then a decision maker; retain only decisions"
duo template validate method.json
duo template save method.json
duo template run method.json -s codex:gpt-6-sol@high -s claude:opus@high --no-project "Choose a storage design"
```

## Command line

Every mode the app runs is also a command.

```
engine[:model][@effort][+option...]

codex:gpt-6-astra@xhigh+verbosity=high+summary=detailed
codex:gpt-6-sol@high+web=live+tier=fast
claude:opus@max+web
claude:sonnet@medium+name=Skeptic+persona=@~/personas/skeptic.md
```

| option | engine | effect |
|---|---|---|
| `verbosity=low\|medium\|high` | codex | `model_verbosity` |
| `summary=auto\|concise\|detailed\|none` | codex | `model_reasoning_summary` |
| `web[=live\|cached\|disabled]` | both | Codex web search / Claude WebSearch |
| `tier=fast` (or `+fast`) | codex | `service_tier` (2× credits) |
| `cfg:key=<toml>` | codex | raw `-c` override (sandbox, approval, shell and MCP keys are refused) |
| `fetch` | claude | WebFetch |
| `dir=PATH` | claude | extra readable directory |
| `name=`, `persona=text\|@file`, `timeout=SEC` | both | label, role instructions, per-turn timeout |

```bash
duo pair    -s codex:gpt-6-sol@high -s claude:opus@high --cycles 4 --check "npm test" -C ~/repo -f task.md
duo debate  -s codex:gpt-6-sol@high -s claude:opus@high --rounds 4 --chair claude:opus@high -C ~/repo -f brief.md
duo debate  --no-project -s codex:gpt-6-sol@high -s claude:opus@high "Postgres or SQLite for a single-user desktop app?"
duo review  -s codex:gpt-6-astra@high -s claude:opus@high --base main -C ~/repo "concurrency and error paths"
duo council -s codex:gpt-6-astra@high -s codex:gpt-6-sol@high -s claude:opus@high --chair claude:opus@max "question"
duo ask     -s codex:gpt-6-luna@high -s claude:haiku "quick question"
duo continue <run> --rounds 2 "moderator note: focus on the migration risk"
duo apply <run> [--keep-branch | --discard]
```

`duo runs` · `duo trace <run>` · `duo show <run> [--report] [--turn N --part reply|prompt|thinking|tools|meta|raw|json]` · `duo export <run> --format html|json|md` · `duo quota [--refresh]` · `duo models` · `duo doctor` · `duo config`. `Ctrl-C` cancels a run cleanly (the record is kept).

Codex efforts: none, minimal, low, medium, high, xhigh, max, ultra (per model; `duo models` lists what the bundled client offers). Claude efforts: low, medium, high, xhigh, max. Presets live in the config file (`duo config --init`).

## How the protocols keep models honest

- **Structured output** is enforced by the CLIs themselves (`--output-schema`, `--json-schema`). Answers stay prose; claims, stances, findings and verdicts become machine-checkable.
- **Citation checks**: every `path:line` citation and quote is verified against the file, and failures are shown to every seat the next round.
- **Strict convergence**: verdicts alone are not trusted. Two seats can each say "agree" while holding the other's earlier position; only a ledger where every claim is agreed by every peer counts.
- **Final ledger review**: after discussion rounds, every seat sees all final positions and the same frozen ledger, then gives an agree/disagree stance with a reason on every peer claim. This extra pass does not consume the discussion round budget. Partial agreement or uncertainty is recorded as disagreement with an explanation; incomplete reviews retry once, then fail the run rather than finish with unaddressed claims.
- **Bounded ledgers**: each seat keeps at most eight load-bearing claims, so peers can actually take a stance on all of them.
- **Fail fast**: an error retrying cannot fix (an outdated CLI, an expired sign-in, an unknown model, a plan limit) stops the run at once instead of letting the other seats spend your quota. A CLI process that died between turns is restarted on the same conversation; a model at capacity gets one retry after a pause; Codex reconnects are recorded as warnings, not failures.
- **Isolation**: discussion seats are read-only and see none of your installed Codex skills or rules; a pair writer edits only its own worktree; `DUO_DEPTH` stops any seat from starting Duo again.

## Traceability

Each run lives in its own folder in Duo's data folder (`duo config` prints it):

```
run.json        seats (+ Codex thread / Claude session ids), versions, git state, quota before/after, totals, outcome
transcript.md   every round, readable
report.md       outcome, final positions, claims, findings or cycles, usage
ledger.json     claims, evidence, citation results, stance history   (debate)
findings.json   merged findings with confirmations and rejections     (review)
council.json    anonymization maps, rankings, scores                  (council)
pair.json       cycles, checks, findings and their history            (pair)
template.json   exact coordination definition used by the run
coordination.json  workflow visits, outputs, roles and retained memory
turns/NN-<seat>-r<round>-<kind>/   prompt.md reply.md reply.json thinking.md tools.json meta.json raw.jsonl
taps/           the untouched CLI event stream of every seat
```

Codex turns are priced in plan credits from the Codex rate card (`src/pricing.ts`, Standard rate; Fast counts double). Claude turns show Claude Code's own API-equivalent estimate for that turn, at its list prices. Neither is what a subscription charges. A model without a published rate in Duo, an unknown service tier, or a model Claude Code cannot price is shown as **no price** with the reason, and left out of totals. It never borrows another model's rate. When OpenAI publishes a new model or changes a rate, add it to `CODEX_RATES` with its source; update Claude Code to price new Claude models.

## Where things live

| | Linux | macOS | Windows |
|---|---|---|---|
| config | `~/.config/duo/config.json` | `~/Library/Application Support/duo/config.json` | `%LOCALAPPDATA%\duo\config.json` |
| data (runs, chats, worktrees) | `~/.local/share/duo` | `~/Library/Application Support/duo` | `%LOCALAPPDATA%\duo` |

Override with `DUO_CONFIG` and `DUO_HOME`. `DUO_CODEX_BIN` and `DUO_CLAUDE_BIN` (or `codexBin`/`claudeBin` in the config) point Duo at specific CLIs; `DUO_NODE` picks the Node.js the app uses.

## Security

The app is an Electron window over a local engine bound to `127.0.0.1`. Every API call needs a random per-launch token shared with the app's window and local permission bridge; the engine refuses non-loopback `Host` headers and cross-site origins, so no web page can drive it. Model output is sanitized before it is rendered. Chats run with the permissions you pick; discussion seats are read-only; pair writers are sandboxed unless you choose full access. See [SECURITY.md](SECURITY.md).

## Using Duo from the agents

- **Claude Code**: `/duo pair codex:gpt-6-sol@high writes, claude:opus@high reviews: <task>`, or just ask for a Codex debate. The skill passes your model and effort choices through unchanged.
- **Codex**: `$duo ...` runs `duo-safe`, the restricted entry point (read-only seats, no `cfg:`, no WebFetch, no pair mode). The rule `duo setup` writes pre-approves only `duo-safe`; restart the Codex or ChatGPT app after setup.

## Troubleshooting

- **A Claude seat fails with "OAuth session expired" or "not logged in"**: run `claude` in a terminal and use `/login`, then **Continue** the run.
- **"Claude Code x.y does not support this model; version … or newer is required"**: run `claude update` (or **Settings → Setup check → Update Claude Code**).
- **"Selected model is at capacity"**: Duo retries once; try again later or pick another model.
- **The app says it needs Node.js** though it is installed: start it once from a terminal with `duo gui`, or set `DUO_NODE` to your `node` binary.
- **Codex cannot write in pair mode on Linux**: its sandbox needs Landlock or bubblewrap; choose *Full access* for the writer in a worktree, or check `codex sandbox --help`.

## Development

```bash
npm run check     # strict typecheck (engine and GUI) and all tests
npm run dev       # engine + GUI in a browser at http://127.0.0.1:47821/#dev
npm run smoke     # the desktop shell end to end, without showing a window
npm run release:prepare  # checks + build + source bundle, checksum and notes in dist/
```

The tests run the whole engine through claw-orchestrator against fake Claude and Codex CLIs (`test/fakes`), so they need no network and no account and run the same on every OS. The GUI (`gui/src`, Preact + TSX) is bundled by esbuild when the engine starts. See [CONTRIBUTING.md](CONTRIBUTING.md).

The desktop smoke check also uses fake providers and temporary data. Release tags run the platform test matrix and create a draft release for review; see [the release guide](docs/releasing.md).

```
bin/          duo, duo-safe
desktop/      Electron shell (main.cjs), preload, icons
gui/src/      the app: Shell, Chat, Run, demos (animated mode walkthroughs), styles
src/          engine: seats, protocols (pair, debate, review, council, ask, continue), hooks, pricing, quota
src/server/   local HTTP + SSE server for the app: chats, runs, permissions, git
skills/       the /duo (Claude Code) and $duo (Codex) skills
test/         unit and end-to-end tests, fake CLIs, real stream fixtures
```

## Credits

This repository is a fork of Duo by Aditya Shrivastav (`Audatic07/duo`). Please report problems with this fork here, not to the original project.

Built on [claw-orchestrator](https://github.com/Enderfga/claw-orchestrator) (MIT), which drives both CLIs as persistent sessions. Protocol ideas from Karpathy's llm-council (anonymized peer ranking), STRML/cc-debate (contradiction rounds) and TorpedoD/claude-council (dissent preservation). Inter and JetBrains Mono fonts (OFL).

Duo is not affiliated with Anthropic or OpenAI. Claude and Claude Code are trademarks of Anthropic; ChatGPT and Codex are trademarks of OpenAI.

## License

[MIT](LICENSE)
