/**
 * Duo desktop shell: starts the duo engine on a loopback port with a per-launch token, then shows
 * the UI in a normal window. The token only ever reaches this window.
 *
 * The engine runs on Node.js 22.18+ (it executes the TypeScript sources directly). It is found the
 * way a terminal would find it: DUO_NODE, then the PATH of the user's login shell (desktop
 * launchers on Linux and macOS start apps without the shell's PATH, which is where nvm, mise,
 * Homebrew and ~/.local/bin live), then the PATH this process has.
 */
const { app, BrowserWindow, dialog, ipcMain, nativeTheme, Notification, shell } = require('electron');
const { execFile, spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { loginShellEnv } = require('./shell-env.cjs');

const ROOT = path.resolve(__dirname, '..');
const SMOKE = process.env.DUO_DESKTOP_SMOKE === '1';
// Set by `duo gui`: this environment came from the user's terminal, so it already has their PATH.
const FROM_TERMINAL = process.env.DUO_ENV_FROM_TERMINAL === '1';
delete process.env.DUO_ENV_FROM_TERMINAL;
const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

app.setName('Duo');
if (SMOKE && process.env.DUO_SMOKE_USER_DATA) app.setPath('userData', process.env.DUO_SMOKE_USER_DATA);
if (typeof app.setDesktopName === 'function') app.setDesktopName('duo.desktop');
if (process.platform === 'linux') {
  // Native Wayland when available, with window decorations.
  app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
  app.commandLine.appendSwitch('enable-features', 'WaylandWindowDecorations');
}
// A second launch only hands over to the running window: it must not probe the shell or start an
// engine of its own (`ready` still fires after app.quit(), and an engine's startup sweeps files
// the running engine owns).
const PRIMARY = SMOKE || app.requestSingleInstanceLock();
if (!PRIMARY) app.quit();

let server = null;
let win = null;
let origin = '';
let token = '';
let quitting = false;
let shown = false;

// The login shell's startup files are the slowest part of a launch from the menu, so they run while
// Electron itself starts up.
const probe = new AbortController();
const shellEnvReady = PRIMARY && !SMOKE && !IS_WIN && !FROM_TERMINAL
  ? loginShellEnv({ shell: process.env.SHELL || (IS_MAC ? '/bin/zsh' : '/bin/bash'), node: process.execPath, signal: probe.signal })
  : Promise.resolve({});

function which(name, envPath) {
  const exts = IS_WIN ? ['.exe', '.cmd', ''] : [''];
  for (const dir of (envPath || '').split(path.delimiter)) {
    for (const ext of exts) {
      const p = path.join(dir, name + ext);
      try {
        if (fs.statSync(p).isFile()) return p;
      } catch {
        /* next */
      }
    }
  }
  return undefined;
}

function nodeVersionOk(bin) {
  return new Promise((resolve) => {
    execFile(bin, ['-p', 'process.versions.node'], { encoding: 'utf8', timeout: 10_000, killSignal: 'SIGKILL', windowsHide: true }, (err, out) => {
      const v = err ? '' : String(out).trim();
      const [maj, min] = v.split('.').map(Number);
      resolve(maj > 22 || (maj === 22 && min >= 18) ? v : undefined);
    });
  });
}

async function findNode(env) {
  const candidates = [process.env.DUO_NODE, which('node', env.PATH), which('node', process.env.PATH)];
  for (const c of candidates) if (c && (await nodeVersionOk(c))) return c;
  return undefined;
}

/** A port that stays the same across launches (so the window's storage persists), unless it is taken. */
function preferredPort() {
  let h = 0;
  for (const ch of require('node:os').userInfo().username) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return 47100 + (h % 700);
}

async function startEngine() {
  const env = { ...process.env, ...(await shellEnvReady) };
  delete env.ELECTRON_RUN_AS_NODE;
  const node = await findNode(env);
  return new Promise((resolve, reject) => {
    if (!node) {
      reject(new Error('Duo needs Node.js 22.18 or newer. Install it from https://nodejs.org (or with nvm, mise, Homebrew), then open Duo again. You can also point DUO_NODE at a node binary.'));
      return;
    }
    server = spawn(node, [path.join(ROOT, 'src', 'server', 'main.ts'), '--port', String(preferredPort()), '--parent-stdin'], {
      cwd: ROOT,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let buf = '';
    const timer = setTimeout(() => reject(new Error('the duo engine did not start within 90 seconds')), 90_000);
    server.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.startsWith('{')) continue;
        try {
          const j = JSON.parse(line);
          if (j.ready) {
            clearTimeout(timer);
            resolve(j);
          }
        } catch {
          /* not ours */
        }
      }
    });
    let errTail = '';
    server.stderr.on('data', (d) => {
      errTail = (errTail + d).slice(-4000);
      process.stderr.write(d);
    });
    server.on('error', (e) => { clearTimeout(timer); reject(new Error(`could not run ${node}: ${e.message}`)); });
    server.on('exit', (code, signal) => {
      clearTimeout(timer);
      if (!origin) {
        reject(new Error(`the duo engine exited (${code ?? signal}).\n\n${errTail}`));
        return;
      }
      // Session end, logout, or our own quit: leave quietly. A real crash is worth telling about.
      if (quitting || signal) {
        app.quit();
        return;
      }
      if (win && !win.isDestroyed()) {
        dialog.showMessageBox(win, { type: 'error', title: 'Duo', message: `The duo engine stopped (exit ${code}).`, detail: errTail.slice(-1500) }).finally(() => app.quit());
      } else app.quit();
    });
  });
}

/** Ask the engine to stop its sessions; if it does not answer quickly, end it. */
function stopEngine() {
  probe.abort();
  return new Promise((resolve) => {
    if (!server || server.exitCode !== null) return resolve();
    const done = () => resolve();
    server.once('exit', done);
    try {
      const req = http.request(`${origin}/api/internal/shutdown`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, timeout: 1500 });
      req.on('error', () => undefined);
      req.end();
    } catch {
      /* fall through to the kill */
    }
    try {
      server.stdin.end();
    } catch {
      /* already closed */
    }
    setTimeout(() => {
      if (server && server.exitCode === null) server.kill('SIGKILL');
      setTimeout(done, 300);
    }, 3000);
  });
}

async function createWindow() {
  const ready = await startEngine();
  origin = ready.url;
  token = ready.token;
  win = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 860,
    minHeight: 580,
    title: 'Duo',
    icon: path.join(__dirname, 'icon.png'),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#141413' : '#f7f6f2',
    autoHideMenuBar: true,
    titleBarStyle: IS_MAC ? 'hiddenInset' : 'default',
    show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  const reveal = () => {
    if (shown || win.isDestroyed()) return;
    shown = true;
    if (!SMOKE) win.show();
  };
  win.once('ready-to-show', reveal);
  // Links out of the app open in the real browser; the app itself never navigates away.
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (target.startsWith(origin + '/api/runs/')) return { action: 'allow' };
    if (/^https?:/.test(target)) void shell.openExternal(target);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, target) => {
    if (!target.startsWith(origin)) {
      e.preventDefault();
      if (/^https?:/.test(target)) void shell.openExternal(target);
    }
  });
  await win.loadURL(`${origin}/#${token}`);
  // A hidden window on Wayland gets no frame callbacks, so a page whose first paint is empty may
  // never paint again and 'ready-to-show' never comes (seen on a wlroots compositor: no window at
  // all). Once the page has loaded, show it regardless.
  setTimeout(reveal, 200);
  if (SMOKE) {
    await new Promise((r) => setTimeout(r, 4000));
    const ok = await win.webContents.executeJavaScript("document.title === 'Duo' && !!document.querySelector('.app .hero-composer textarea') && !!document.querySelector('.sidebar')");
    process.stdout.write(`DUO_DESKTOP_SMOKE ${ok ? 'OK ' + ok : 'FAILED'}\n`);
    quitting = true;
    await stopEngine();
    app.exit(ok ? 0 : 1);
  }
}

ipcMain.handle('duo:pick-folder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('duo:open-path', (_e, p) => {
  const target = String(p);
  // Folders only: opening a file could run it.
  if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) return 'not a folder';
  return shell.openPath(target);
});
// A notification nothing references is garbage collected, and its click handler with it: clicking
// it later (from the notification history, say) would do nothing. Keep the recent ones.
const notifications = new Set();
ipcMain.handle('duo:notify', (_e, o) => {
  if (!Notification.isSupported() || (win && win.isFocused())) return false;
  const n = new Notification({ title: String(o?.title ?? 'Duo').slice(0, 120), body: String(o?.body ?? '').slice(0, 300), silent: false });
  const forget = () => notifications.delete(n);
  n.on('click', () => {
    forget();
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      if (o?.route) win.webContents.send('duo:navigate', String(o.route));
    }
  });
  n.on('close', forget);
  n.on('failed', forget);
  notifications.add(n);
  if (notifications.size > 30) notifications.delete(notifications.values().next().value);
  n.show();
  return true;
});

if (PRIMARY) app.whenReady().then(createWindow).catch((e) => {
  if (SMOKE) process.stderr.write(`Duo could not start: ${String((e && e.message) || e)}\n`);
  else dialog.showErrorBox('Duo could not start', String((e && e.message) || e));
  app.exit(1);
});
app.on('second-instance', () => {
  // Before its first paint the window is about to show itself anyway.
  if (win && !win.isDestroyed() && shown) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
});
app.on('window-all-closed', () => app.quit());
app.on('before-quit', (e) => {
  if (quitting) return;
  quitting = true;
  e.preventDefault();
  void stopEngine().then(() => app.exit(0));
});
// Logout and shutdown send SIGTERM; quit promptly instead of waiting to be killed.
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(sig, () => {
    quitting = true;
    void stopEngine().then(() => app.exit(0));
  });
}
