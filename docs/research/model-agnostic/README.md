# Model-agnostic feasibility probe (non-production)

Supporting material for [`docs/model-agnostic-feasibility.md`](../../model-agnostic-feasibility.md).

- `probe.mjs` runs the pinned `@enderfga/claw-orchestrator` `SessionManager` and Duo's own seat and
  template validators against fake CLIs. It needs no network, account, model or GPU.
- `fake-opencode.mjs` stands in for `opencode run --format json`. `fake-claude-env.mjs` records the
  model and endpoint claw hands to Claude Code (never credential values), then delegates to
  `test/fakes/claude.mjs`.
- `probe-output.txt` is the captured output.

Run it after `npm ci`, on Linux or macOS (the fakes are spawned via their `#!` line):

```bash
node docs/research/model-agnostic/probe.mjs
```

Scope: these checks describe how libraries pass prompts, schemas, permissions, URLs and session ids
to a CLI. They do **not** show that any real CLI, provider or model behaves the same way. Nothing
here is imported by Duo or run by `npm test`.
