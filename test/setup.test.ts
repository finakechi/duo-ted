import assert from 'node:assert/strict';
import { test } from 'node:test';
import { desktopExecArg, isDuoLauncher, linuxDesktopEntry } from '../src/setup.ts';

/** Exec= as a launcher reads it (Desktop Entry spec): string escapes, then quoting, then %%. */
function parseExec(value: string): string[] {
  const s = value.replace(/\\([\\snrt])/g, (_m, c: string) => ({ '\\': '\\', s: ' ', n: '\n', r: '\r', t: '\t' })[c]!);
  const args: string[] = [];
  let cur = '';
  let quoted = false;
  let started = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '\\' && /["`$\\]/.test(s[i + 1] ?? '')) cur += s[++i];
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') {
      quoted = true;
      started = true;
    } else if (ch === ' ') {
      if (started) args.push(cur);
      cur = '';
      started = false;
    } else {
      cur += ch;
      started = true;
    }
  }
  assert.equal(quoted, false, 'quotes are balanced');
  if (started) args.push(cur);
  return args.map((a) => a.replace(/%%/g, '%'));
}

const execLine = (entry: string) => /^Exec=(.*)$/m.exec(entry)?.[1] ?? '';

test('Exec survives paths with spaces, quotes, $, backticks, backslashes and %', () => {
  for (const p of ['/home/me/My Apps/duo/node_modules/electron/dist/electron', '/opt/a "quoted" dir/$HOME/`x`/back\\slash/100%/electron']) {
    const main = p.replace(/electron$/, 'main.cjs');
    assert.deepEqual(parseExec(execLine(linuxDesktopEntry(p, main, '/icons/duo.png'))), [p, main]);
    assert.deepEqual(parseExec(desktopExecArg(p)), [p]);
  }
});

test('the launcher matches the window Electron opens and takes no files', () => {
  const entry = linuxDesktopEntry('/e', '/m.cjs', '/i.png');
  // WM_CLASS under X11/XWayland and the Wayland app_id are both "duo".
  assert.match(entry, /^StartupWMClass=duo$/m);
  assert.doesNotMatch(execLine(entry), /%[fFuU]/, 'Duo opens no files or URLs');
  assert.match(entry, /^\[Desktop Entry\]\n/);
});

test('uninstall recognises launchers duo wrote, old and new, and nothing else', () => {
  const main = '/home/me/duo/desktop/main.cjs';
  assert.ok(isDuoLauncher(linuxDesktopEntry('/e', main, '/i.png'), main));
  // What earlier versions wrote.
  assert.ok(isDuoLauncher(`[Desktop Entry]\nType=Application\nName=Duo\nExec="/e" "${main}" %U\nStartupWMClass=Duo\n`, main));
  assert.ok(!isDuoLauncher('[Desktop Entry]\nType=Application\nName=Duo\nExec=/usr/bin/some-other-duo\n', main));
  assert.ok(!isDuoLauncher(`[Desktop Entry]\nName=My Duo tweak\nExec="/e" "${main}" --flag\n`, main));
});
