/**
 * Desktop-only DeepSeek credential storage. Never writes a plaintext API key to config.json.
 * Requires Electron safeStorage backed by a real OS credential store (not Linux basic_text).
 * This module accepts a storage implementation so its file and failure behavior is testable
 * without launching Electron or exposing secrets to the GUI renderer.
 */
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');

function makeDeepSeekCredentialStore(safeStorage, userData, platform = process.platform) {
  const dir = path.join(userData, 'credentials');
  const file = path.join(dir, 'deepseek.enc');

  function available() {
    try {
      if (!safeStorage.isEncryptionAvailable()) return false;
      if (platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text') return false;
      return true;
    } catch {
      return false;
    }
  }

  function read() {
    if (!available() || !fs.existsSync(file)) return undefined;
    const key = safeStorage.decryptString(fs.readFileSync(file));
    if (!key || key.length > 4096) throw new Error('Saved DeepSeek credential is invalid');
    return key;
  }

  function status() {
    const saved = fs.existsSync(file);
    if (!available()) return {
      available: false, saved,
      reason: 'Secure OS credential storage is unavailable. Unlock/configure the desktop keychain, or use an environment variable.',
    };
    if (saved) {
      try { read(); }
      catch {
        return { available: true, saved, reason: 'Saved key could not be decrypted. Replace or remove it.' };
      }
    }
    return { available: true, saved };
  }

  function save(key) {
    if (!available()) throw new Error('Secure OS credential storage is unavailable; the key was not saved');
    if (typeof key !== 'string' || !key || key.length > 4096 || key !== key.trim() || /[\r\n\0]/.test(key)) {
      throw new Error('Enter a valid DeepSeek API key without leading/trailing whitespace');
    }
    const encrypted = safeStorage.encryptString(key);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const temp = path.join(dir, `.${randomBytes(8).toString('hex')}.tmp`);
    try {
      fs.writeFileSync(temp, encrypted, { flag: 'wx', mode: 0o600 });
      fs.renameSync(temp, file);
      if (platform !== 'win32') fs.chmodSync(file, 0o600);
    } finally {
      fs.rmSync(temp, { force: true });
    }
  }

  function remove() {
    fs.rmSync(file, { force: true });
  }

  return { status, read, save, remove };
}

module.exports = { makeDeepSeekCredentialStore };
