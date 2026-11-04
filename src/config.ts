import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { binVersion, binVersionAsync, resolveClaude, resolveCodex, runBin, runBinAsync, type BinSpec } from './bins.ts';
import { CACHE_DIR, CONFIG_PATH } from './paths.ts';
import type { SeatDefaults } from './seats.ts';

export { binVersion, type BinSpec } from './bins.ts';

export interface Preset {
  seats: string[];
  chair?: string;
  rounds?: number;
  description?: string;
}

export interface GuiDefaults {
  claude: { spec: string; access: string };
  codex: { spec: string; access: string; useConfig: boolean };
  theme: 'system' | 'light' | 'dark';
  /** Desktop notification when a run or a long chat turn finishes while the window is in the background. */
  notify: boolean;
}

export interface Config {
  gui: GuiDefaults;
  defaults: SeatDefaults & { preset: string };
  presets: Record<string, Preset>;
  codexBin?: string;
  claudeBin?: string;
  /** Flag a quota window at or above this percentage. */
  warnPercent: number;
  /** Per-turn timeout by engine, seconds (a seat's +timeout= wins). */
  timeoutSec: { codex: number; claude: number };
  maxDiffChars: number;
}

// Starting points follow the Codex docs: Luna at high, Sol at medium, Astra for the hardest work.
export const DEFAULT_CONFIG: Config = {
  gui: {
    claude: { spec: 'claude:opus@high', access: 'ask' },
    codex: { spec: 'codex:gpt-6-sol@medium', access: 'workspace', useConfig: false },
    theme: 'system',
    notify: true,
  },
  defaults: { preset: 'std', codexModel: 'gpt-6-sol', claudeModel: 'opus', claudeEffort: 'high' },
  presets: {
    quick: { seats: ['codex:gpt-6-luna@high', 'claude:haiku'], rounds: 2, description: 'cheap sanity checks' },
    std: { seats: ['codex:gpt-6-sol@medium', 'claude:sonnet@medium'], rounds: 3, description: 'everyday reviews and debates' },
    deep: { seats: ['codex:gpt-6-astra@high', 'claude:opus@high'], rounds: 3, description: 'hard design and debugging' },
    max: {
      seats: ['codex:gpt-6-astra@xhigh+verbosity=high', 'claude:opus@max'],
      rounds: 4,
      chair: 'claude:opus@high',
      description: 'no expense spared',
    },
  },
  warnPercent: 85,
  timeoutSec: { codex: 3600, claude: 3600 },
  maxDiffChars: 200_000,
};

/** Persist a partial update (the GUI's settings) on top of whatever the file already holds. */
export function saveConfig(patch: Partial<Config>): Config {
  let current: Record<string, unknown> = {};
  if (existsSync(CONFIG_PATH)) current = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  const next = { ...current, ...patch };
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2) + '\n');
  return loadConfig();
}

export function loadConfig(): Config {
  const cfg: Config = structuredClone(DEFAULT_CONFIG);
  if (!existsSync(CONFIG_PATH)) return cfg;
  let user: Partial<Config>;
  try {
    user = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    throw new Error(`cannot parse ${CONFIG_PATH}: ${(e as Error).message}`);
  }
  if (user.gui) {
    if (user.gui.claude) Object.assign(cfg.gui.claude, user.gui.claude);
    if (user.gui.codex) Object.assign(cfg.gui.codex, user.gui.codex);
    if (user.gui.theme) cfg.gui.theme = user.gui.theme;
    if (typeof user.gui.notify === 'boolean') cfg.gui.notify = user.gui.notify;
  }
  if (user.defaults) Object.assign(cfg.defaults, user.defaults);
  if (user.presets) Object.assign(cfg.presets, user.presets);
  if (user.timeoutSec) Object.assign(cfg.timeoutSec, user.timeoutSec);
  for (const key of ['codexBin', 'claudeBin', 'warnPercent', 'maxDiffChars'] as const) {
    if (user[key] !== undefined) (cfg as unknown as Record<string, unknown>)[key] = user[key];
  }
  return cfg;
}

export function resolveCodexBin(cfg: Pick<Config, 'codexBin'>): BinSpec {
  return resolveCodex({ codexBin: cfg.codexBin });
}

export function resolveClaudeBin(cfg: Pick<Config, 'claudeBin'>): BinSpec {
  return resolveClaude({ claudeBin: cfg.claudeBin });
}

export interface CodexModel {
  slug: string;
  display: string;
  description: string;
  visibility: string;
  defaultEffort?: string;
  efforts: string[];
  contextWindow?: number;
}

const CATALOG_CACHE = () => join(CACHE_DIR, 'codex-models.json');
const CATALOG_MAX_AGE_MS = 6 * 3600_000;

function readCatalogCache(): { version: string; at: number; models: CodexModel[] } | undefined {
  try {
    const c = JSON.parse(readFileSync(CATALOG_CACHE(), 'utf8'));
    return Array.isArray(c.models) ? c : undefined;
  } catch {
    return undefined;
  }
}

/** Codex's own model catalog for this account and client version (cached for 6h). */
export function codexCatalog(codexBin: BinSpec, refresh = false): CodexModel[] {
  const version = binVersion(codexBin);
  const c = refresh ? undefined : readCatalogCache();
  if (c && c.version === version && Date.now() - c.at < CATALOG_MAX_AGE_MS) return c.models;
  try {
    const r = runBin(codexBin, ['debug', 'models'], { encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    return saveCatalog(version, String(r.stdout ?? ''));
  } catch {
    return [];
  }
}

let catalogRefresh: Promise<CodexModel[]> | undefined;

/**
 * The catalog for the GUI engine, which must never wait on `codex debug models` (it can take up to
 * a minute): a cached catalog is returned at once, even one from another client version or older
 * than 6h, and refreshed in the background, one refresh at a time; `onRefresh` gets the new one.
 * Only with no catalog at all does the caller wait, and then without blocking the event loop.
 */
export async function codexCatalogAsync(codexBin: BinSpec, onRefresh?: (models: CodexModel[]) => void): Promise<CodexModel[]> {
  const version = await binVersionAsync(codexBin);
  const c = readCatalogCache();
  if (c && c.version === version && Date.now() - c.at < CATALOG_MAX_AGE_MS) return c.models;
  catalogRefresh ??= runBinAsync(codexBin, ['debug', 'models'], { timeout: 60_000 })
    .then((r) => {
      try {
        return r.status === 0 ? saveCatalog(version, r.stdout) : [];
      } catch {
        return [];
      }
    })
    .finally(() => (catalogRefresh = undefined));
  if (!c) return catalogRefresh;
  void catalogRefresh.then((models) => models.length && onRefresh?.(models));
  return c.models;
}

/** Parse `codex debug models` output and keep it as the cached catalog for this client version. */
function saveCatalog(version: string, stdout: string): CodexModel[] {
  const raw: { models?: Record<string, unknown>[] } = JSON.parse(stdout);
  const models: CodexModel[] = (raw.models || []).map((m) => ({
    slug: String(m.slug),
    display: String(m.display_name ?? m.slug),
    description: String(m.description ?? ''),
    visibility: String(m.visibility ?? ''),
    defaultEffort: m.default_reasoning_level as string | undefined,
    efforts: ((m.supported_reasoning_levels as { effort: string }[]) || []).map((l) => l.effort),
    contextWindow: m.context_window as number | undefined,
  }));
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(CATALOG_CACHE() + '.tmp', JSON.stringify({ version, at: Date.now(), models }, null, 2));
  renameSync(CATALOG_CACHE() + '.tmp', CATALOG_CACHE());
  return models;
}

export const CLAUDE_MODELS = [
  { alias: 'fable', note: 'largest; availability depends on plan' },
  { alias: 'opus', note: 'strongest generally available' },
  { alias: 'sonnet', note: 'balanced' },
  { alias: 'haiku', note: 'fast, cheap' },
];
