/** Role readiness of an optional model: what it is, where it runs, and which roles it has proved. */
import { useState } from 'preact/hooks';
import { api } from './api.ts';
import { app, confirmAction } from './store.ts';
import type { EndpointLocation, ReadinessView } from './types.ts';
import { Spinner } from './ui.tsx';

export const LOCATION_LABEL: Record<EndpointLocation, string> = { device: 'On this device', lan: 'Local network', cloud: 'Cloud' };

export function statusLabel(v: ReadinessView): string {
  switch (v.status) {
    case 'disabled': return 'Disabled';
    case 'unsupported': return 'Unsupported';
    case 'untested': return v.stale ? 'Needs a new test' : 'Not tested';
    case 'checking': return 'Testing…';
    case 'unreachable': return 'Unreachable';
    case 'connected': return 'Connected · roles not verified';
    case 'failed': return 'Role test failed';
    case 'read-verified': return 'Verified: reviewer';
    case 'write-verified': return v.roles.review ? 'Verified: reviewer and writer' : 'Verified: writer';
  }
}

function tone(v: ReadinessView): 'good' | 'warn' | 'bad' | 'muted' {
  if (v.status === 'read-verified' || v.status === 'write-verified') return 'good';
  if (v.status === 'unreachable' || v.status === 'failed' || v.status === 'unsupported') return 'bad';
  if (v.status === 'connected' || v.status === 'checking' || v.stale) return 'warn';
  return 'muted';
}

/** One-line status for model pickers: roles and location, never inferred from the model name. */
export function readinessLine(target: string): string | undefined {
  const v = app.value?.readiness?.[target];
  if (!v) return undefined;
  const roles = v.roles.review || v.roles.write ? `${v.roles.review ? 'reviewer ✓' : 'reviewer –'} · ${v.roles.write ? 'writer ✓' : 'writer –'}` : statusLabel(v);
  return `${roles} · ${LOCATION_LABEL[v.location]}`;
}

export function StatusPill({ view }: { view: ReadinessView }) {
  return <span class={`readiness-pill ${tone(view)}`}>{view.status === 'checking' && <Spinner size={11} />}{statusLabel(view)}</span>;
}

function Outcome({ label, o }: { label: string; o?: { ok: boolean; detail: string; at: string } }) {
  if (!o) return <li><span class="muted">{label}: not run</span></li>;
  return <li><span class={o.ok ? 'good-text' : 'bad-text'} aria-hidden="true">{o.ok ? '✓' : '✗'}</span> <strong>{label}</strong> <span class="muted">({new Date(o.at).toLocaleTimeString()})</span> — {o.detail}</li>;
}

/**
 * Status and explicit test controls for one saved optional model. Tests run only when clicked;
 * cloud model tests ask for cost confirmation first. Results last until Duo restarts or the
 * settings, endpoint or harness change.
 */
export function ReadinessPanel({ target, saved = true }: { target: string; saved?: boolean }) {
  const v = app.value?.readiness?.[target];
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState('');
  if (!saved || !v) return <p class="muted small">Save Settings, then reopen them, to test this model.</p>;
  const checking = v.status === 'checking' || !!busy;
  const blocked = v.status === 'disabled' || v.status === 'unsupported';
  const host = (() => { try { return new URL(v.endpoint).host; } catch { return v.endpoint; } })();
  const run = async (kind: 'connection' | 'review' | 'write', confirmCost = false) => {
    setBusy(kind);
    setError('');
    try {
      const view = await api<ReadinessView>('/api/readiness/check', { method: 'POST', body: { target, kind, confirmCost } });
      const s = app.value;
      if (s) app.value = { ...s, readiness: { ...s.readiness, [target]: view } };
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };
  const start = (kind: 'connection' | 'review' | 'write') => {
    if (kind !== 'connection' && v.paid) {
      confirmAction({
        title: `Run a paid ${kind === 'write' ? 'writer' : 'reviewer'} test?`,
        body: `${v.label} runs in the cloud. The test sends a few short prompts about a disposable test folder to ${host}, and the provider may bill for them. No project files are sent.`,
        action: 'Run test',
      }, () => void run(kind, true));
    } else void run(kind);
  };
  return (
    <div class="readiness" aria-busy={checking}>
      <div class="row wrap readiness-head">
        <StatusPill view={v} />
        {v.stale && <span class="muted small">Earlier results no longer match these settings.</span>}
      </div>
      <dl class="readiness-facts">
        <dt>Coding engine</dt><dd>{v.engine === 'codex' ? 'Codex' : 'Qwen Code'}{v.harness ? ` (${v.harness.replace(/^(Codex|Qwen Code) /, '')})` : ''}</dd>
        <dt>Model provider</dt><dd>{v.provider === 'deepseek' ? 'DeepSeek API' : v.provider === 'local' ? 'Your inference server' : 'Hosted endpoint'}</dd>
        <dt>Model</dt><dd class="mono">{v.model}</dd>
        <dt>Runs</dt><dd>{LOCATION_LABEL[v.location]} · <span class="mono">{host}</span></dd>
      </dl>
      <p class="muted small" role="status" aria-live="polite">{v.detail}</p>
      {(v.connection || v.review || v.write) && <ul class="readiness-checks small">
        <Outcome label="Connection" o={v.connection} />
        <Outcome label="Reviewer (read tools, read-only boundary)" o={v.review} />
        <Outcome label="Writer (edits in a disposable workspace)" o={v.write} />
      </ul>}
      {!blocked && <div class="row wrap">
        <button type="button" class="btn small" disabled={checking} onClick={() => start('connection')}>{busy === 'connection' ? 'Testing…' : 'Test connection'}</button>
        <button type="button" class="btn small" disabled={checking} onClick={() => start('review')}>{busy === 'review' ? 'Testing…' : v.review && !v.review.ok ? 'Retry reviewer test' : 'Test reviewer'}</button>
        <button type="button" class="btn small" disabled={checking} onClick={() => start('write')}>{busy === 'write' ? 'Testing…' : v.write && !v.write.ok ? 'Retry writer test' : 'Test writer'}</button>
        {checking && <button type="button" class="btn small" onClick={() => void api('/api/readiness/cancel', { method: 'POST', body: { target } })}>Cancel test</button>}
      </div>}
      {!blocked && <p class="muted small">Tests use a disposable folder (never your project) and stop after at most {v.engine === 'qwen' ? '3' : '2'} minutes.{v.paid ? ' Reviewer and writer tests call a paid cloud API after you confirm.' : ''}</p>}
      {error && <p class="bad-text small" role="alert">{error}</p>}
    </div>
  );
}
