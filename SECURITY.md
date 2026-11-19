# Security

Duo can make AI agents edit files and run commands on your computer, so its local surface is designed to be driven only by its own window.

## Model

- The engine (`src/server/main.ts`) listens on `127.0.0.1` only.
- Every API call needs a random token generated at each launch. The desktop shell passes it to its own window in the URL fragment. Claude chats that request GUI approvals also pass it to the local permission bridge through an MCP config file, restricted to owner access on POSIX systems and removed when the chat is deleted or Duo shuts down normally. A crash may leave a file containing an expired launch token until Duo next starts, which removes it; Windows relies on the user's data-folder ACLs.
- Requests with a non-loopback `Host` header (DNS rebinding) or a cross-site `Origin` are refused.
- Model output is rendered through DOMPurify; links open in the system browser; the page has a strict Content-Security-Policy.
- The Electron window runs with `contextIsolation`, `sandbox` and no Node integration. The preload exposes four functions: pick a folder, show a folder, show a notification, and receive a navigation request.
- Discussion seats (debate, review, council, ask) are read-only: Codex runs in its read-only sandbox with `--ignore-user-config --ignore-rules`, and Claude gets only Read, Grep and Glob (plus web tools if you ask for them).
- A pair-mode writer works in a separate git worktree by default and is sandboxed unless you choose full access. Nothing reaches your folder until you apply it.
- `duo-safe`, the entry point the Codex allow-rule permits, refuses raw Codex config, WebFetch, pair mode, setup and the GUI.
- Seats run with `DUO_DEPTH` set, and Duo refuses to start under it, so a model cannot start Duo again.
- DeepSeek sessions use an isolated Codex provider override and read the key from a named environment variable. They do not modify `~/.codex/config.toml`, inherit unrelated OpenAI keys, or enable paid DeepSeek search. Qwen endpoint profiles never fall back to `OPENAI_API_KEY` or any other credential: a hosted profile must name its own key variable, the Qwen process receives only that key (other credential variables are removed from its environment), and the key is redacted from streams, traces and errors.
- Endpoint locality is judged from the address, not the profile label: loopback is *on this device*, a private/LAN address needs an explicit opt-in, and anything else is cloud. A "local" profile at a remote address, and any key sent over plain HTTP off this device, are refused.
- Qwen seats run only on Linux with Bubblewrap and only on a verified Qwen Code release (0.28.x). Reviewers get a read-only, network-closed sandbox and only read/search tools; writers get workspace-write; host-side web tools are always excluded; full access is refused. Unverified releases, a missing sandbox, or Qwen's folder-trust downgrade of a writer fail closed.
- An optional model takes a writer or reviewer role only after passing that role's readiness test in a disposable folder; results live in memory and are invalidated by any relevant change or a restart. A recorded conversation resumes only on the backend that created it, and forwarding a local seat's earlier replies to a cloud model requires explicit confirmation. The same role tests gate chats: an unverified optional model's chat turn fails before any CLI or endpoint is contacted.

Chats run with the permissions you choose for them. *Full access* (Claude `bypassPermissions`, Codex `danger-full-access`) means exactly that.

## Reporting a vulnerability

Please report security problems privately through [GitHub private vulnerability reporting](https://github.com/finakechi/duo-ted/security/advisories/new) rather than a public issue. Include the steps to reproduce and the version (`duo --version`). We aim to reply within a week.
