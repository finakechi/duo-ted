# Changelog

## Unreleased

- The app engine no longer waits on the Codex model catalog, CLI version checks or git: a cached catalog is shown at once and refreshed in the background (the window updates when it arrives), and the Changes panel, workspace checks and pair diffs run git without blocking chats and runs, with timeouts and size limits. Concurrent refreshes share one subprocess.
- Stopping a CLI call (timeout, cancel or shutdown) ends everything it started, and a call settles even when a leftover process holds its output. Quota refreshes and live sign-in checks stop with the engine; a Claude Code update is left to finish.
- Permission-bridge files left behind by a crash, with their expired token, are removed when Duo starts.
- claw-orchestrator's "Unknown model … falling back to gpt-5.5 pricing" warning no longer appears; it came from claw's internal price table, which Duo does not use.
- CI: job timeouts, superseded pull-request runs are cancelled, and a Linux desktop smoke check runs on every pull request. CONTRIBUTING.md lists the steps to enable Actions and protect `main`.

- The bundled Codex CLI is 0.166.0 (was 0.159.0), whose model catalog offers GPT-6.1 Sol and GPT-6.1 Terra.
- Security updates within the existing version ranges: DOMPurify 3.4.17 (critical advisory GHSA-cg2g-xh64-v4q7, plus a high one), Electron 44.10.2 (GHSA-jr5w-w6x2-84p9), marked 18.1.3 and @preact/signals 2.11.4.

- Pricing: GPT-6.1 Terra has its published credit rate; it previously showed no cost at all. Model ids match regardless of case, an `openai/` prefix or a dated snapshot suffix.
- Pricing: a model, variant or service tier without a published rate shows as **no price** with the reason, and is left out of totals (with a note). Before, newer versions silently borrowed a neighbour's rate: `gpt-6.2-luna` was priced as GPT-6 Luna, and `gpt-6-sol-mini` as GPT-6.1 Sol. Ultrafast now counts 6×; it was charged at the Standard rate.
- Pricing: a Claude turn's cost is the per-result figure Claude Code states, so model switches and restarted CLIs no longer misprice the next turn, and subagents count towards token usage. When Claude Code has no price for a model (`costBasis: unknown`), its guess at another model's rate is not shown.
- Costs are labelled as what they are everywhere (plan credits, or Claude's API-equivalent estimate), and the model picker says when a Codex model has no published rate.

- The app engine no longer freezes while a slow CLI call runs: quota refresh, the setup and live sign-in checks, and **Update Claude Code** now run without blocking chats, runs and other requests. CLI versions are remembered until the binary changes instead of being asked on every app state call and run start.
- Pair check commands: a timeout or **Stop** ends the whole process tree the check started (not only its shell), a background process left behind no longer keeps the run waiting, and checks still running end with Duo.
- Deleting a chat while it is answering no longer brings it back after the turn ends; its stream trace is removed with it.
- Stopping a chat while its CLI is starting or restarting stops that CLI and never sends the message again; shutdown waits for chats that are still starting.
- A chat turn that fails after producing partial text keeps the text and shows the error; a reply the CLI explicitly completed still counts as done.
- The permission-bridge config that carries the launch token is owner-only (0600) on Linux and macOS, older files are repaired, and the files are removed on a normal shutdown.
- The Changes panel lists a renamed file once, by its new name.
- The Changes panel shows a working-tree diff larger than 4 MB truncated, instead of silently falling back to the staged diff.
- Streaming chats re-render only the turn that changed; finished run turns no longer keep their live output in the window's memory.
- The HTML export of a run is served with a script-free Content-Security-Policy.

## 0.3.0 — 2026-10-08

- **Custom Templates are the universal foundation for every Duo method.** Pair, Debate, Review, Council and Ask are fully constructed as templates in the same system, and all five can be recreated from a new method in the visual maker.
- Debate ends with every model reviewing the frozen claim ledger and explicitly agreeing or disagreeing with every peer claim. Incomplete reviews retry once and fail if still incomplete; reports, the run view, and continued debates retain the final decisions.
- The visual maker can create all five shipped methods from a new draft and add every built-in stage. Stage prompts, debate policies and round limits, shared context, starting model assignments and native response schemas (including nullable fields) are editable through the same definitions used by the executor.

- Custom coordination templates: versioned role and workflow definitions, model eligibility and ranking, conditional role changes, selective routing, structured replies, completion and exception rules, and bounded execution.
- Persistent memory channels with selected fields, role access rules, run or template scope, and entry/character retention limits.
- A visual desktop template builder for workflows, roles, routing, structured responses, conditions, memory and limits, with undo/redo and an explicitly selected JSON editor. Model-assisted authoring/repair/revision, saved templates, built-in copies, and a Method tab record the exact definition and state. Matching `duo template` CLI and authenticated local APIs.
- Migrated Pair, Debate, Review, Council and Ask to the shared workflow executor. Regression snapshots from the original implementations cover prompts, schemas, outcomes, reports and domain artifacts in 13 scenarios.
- Fixed eligible-seat selection when a count chooses only part of the pool, retained exception details through recovery/terminal steps, rejected ambiguous routes, and made malformed-template validation return actionable errors instead of crashing.
- Discarding JSON restores the visual draft across mode switches. Round and cycle counts can be cleared and retyped without inserting a default; invalid minimum/maximum rounds and CLI timeouts are refused.
- Saved templates can be deleted in the builder, and memory clearing asks for confirmation. Saving removed or run-only channels and deleting saved methods clears their cross-run storage.
- Generated drafts can be recovered from their authoring run and reopened in the visual builder. Recorded run methods can also be reopened for editing; seat columns stay in order beyond 25 models.
- Copied native methods reject additional write roles that would bypass native workspace isolation; fully custom write methods require explicit isolation.
- GUI cache checks all imported dependencies and generated assets, rebuilding after shared-code changes or missing CSS/fonts.
- Isolated desktop smoke checks with fake providers, bounded startup and useful failures. Added source release bundles with dependency lockfiles, built GUI, checksums, release notes and a checked draft-release workflow.

## 0.2.0

### New
- **Pair mode**: one model writes the code in its own git worktree (or in place, with a snapshot), the other reviews every change, and they cycle until the writer reports done, the reviewer approves with no P0/P1 finding open, and an optional check command passes. Apply, keep the branch, or discard the result; continue with a note. `duo pair`, `duo apply`.
- A redesigned desktop app: home screen with one composer for every mode, animated walkthroughs of each mode, live activity of every seat during runs, command palette, keyboard shortcuts, pinned chats, date-grouped history, confirm dialogs, notifications, Settings with a setup check (and a live sign-in test), light and dark themes.
- Runs can be stopped, deleted and exported as Markdown from the app; continuing a run opens the new run.
- `--no-project` (and "No folder" in the app) for questions that are not about a project: the seats get an empty folder.
- Linux, macOS and Windows support: platform data folders, launchers for each OS from `duo setup`, no shell scripts.

### Fixed (found in real runs)
- Windows short folder names (such as `RUNNER~1`) could send a pair writer outside its worktree when Git expanded the path; both paths are now resolved natively and the selected subfolder must stay inside the repository.
- A turn could record the previous turn's tool calls and errors when it started within a second of the last one.
- A Claude seat whose process died between turns failed every later turn with "Session not ready"; it is now restarted on the same conversation.
- Errors that a retry cannot fix (outdated Claude Code, expired sign-in, unknown model, plan limits) were retried and let the other seats spend quota for minutes; the run now stops at once with a fix hint.
- Codex reconnect notices ("Reconnecting… idle timeout") were recorded as errors.
- Models newer than the rate card (`gpt-6.1-sol`) were priced at zero credits; the card is updated and newer models are priced by family.
- Codex `none` and `minimal` efforts were silently dropped.
- Citations with spaces in the path (or Windows drive letters) were rejected as malformed.
- Debates with several seats produced hundreds of claims nobody could take a stance on; claims are capped per seat.
- Continuing a continued debate replayed only the last run's rounds.
- The chair's synthesis was recorded as round 0.
- Codex seats loaded the user's installed skills and read Duo's own skill file.
- Codex prompts are passed on stdin (long debate prompts hit argument length limits).
- The app's saved state was lost on every launch (the window's origin changed with the port); preferences are now kept by the engine and the port is stable.
- Empty chats piled up in the sidebar; a chat is now saved on its first message.
- The app hung for 45 seconds on logout and was killed; it now shuts down promptly and stops its sessions.
- Runs interrupted by a crash stayed "running" forever.

## 0.1.0

- First version: debate, review, council, ask and continue protocols; seat specs with per-seat model, effort and Codex options; full traces; the desktop app with chats, side by side and runs.
