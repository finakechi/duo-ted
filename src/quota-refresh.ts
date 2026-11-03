import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { runBinAsync } from './bins.ts';
import { resolveClaudeBin, resolveCodexBin, type Config } from './config.ts';
import { DUO_HOME } from './paths.ts';
import { saveClaudeQuota } from './quota.ts';

/**
 * Ping the cheapest model on each side once, so the local quota snapshots are current. Both run
 * at once and never block the event loop (the GUI engine keeps streaming meanwhile).
 */
export async function refreshQuota(cfg: Config): Promise<void> {
  const tmp = join(DUO_HOME, 'cache');
  mkdirSync(tmp, { recursive: true });
  const codex = (async () => {
    try {
      await runBinAsync(resolveCodexBin(cfg), ['exec', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules', '-s', 'read-only', '-m', 'gpt-6-luna', '-c', 'model_reasoning_effort="low"', '--json', '-'], { cwd: tmp, input: 'Reply with: ok', timeout: 180_000 });
    } catch {
      /* no Codex: nothing to refresh */
    }
  })();
  const claude = (async () => {
    try {
      const r = await runBinAsync(resolveClaudeBin(cfg), ['-p', '--model', 'haiku', '--tools', '', '--no-session-persistence', '--output-format', 'stream-json', '--verbose', 'Reply with: ok'], { cwd: tmp, timeout: 180_000 });
      for (const line of r.stdout.split('\n')) {
        try {
          const ev = JSON.parse(line);
          if (ev.type === 'rate_limit_event') saveClaudeQuota(ev.rate_limit_info);
        } catch {
          /* not JSON */
        }
      }
    } catch {
      /* no Claude: nothing to refresh */
    }
  })();
  await Promise.all([codex, claude]);
}
