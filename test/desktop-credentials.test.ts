import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { makeDeepSeekCredentialStore } = require('../desktop/credentials.cjs');
const tmp = mkdtempSync(join(tmpdir(), 'duo-credential-test-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

const encryptedStorage = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => 'kwallet6',
  encryptString: (s: string) => Buffer.from('cipher:' + [...s].reverse().join(''), 'utf8'),
  decryptString: (b: Buffer) => {
    const encoded = b.toString('utf8');
    if (!encoded.startsWith('cipher:')) throw new Error('corrupt');
    return [...encoded.slice(7)].reverse().join('');
  },
};

test('DeepSeek credential is stored separately, encrypted, and survives relaunch', () => {
  const dir = join(tmp, 'persist');
  const first = makeDeepSeekCredentialStore(encryptedStorage, dir, 'linux');
  assert.deepEqual(first.status(), { available: true, saved: false });
  first.save('secret-DEEPSEEK-123');
  const location = join(dir, 'credentials', 'deepseek.enc');
  assert.doesNotMatch(readFileSync(location, 'utf8'), /secret-DEEPSEEK-123/);
  // Windows ACLs govern file access; POSIX mode bits are not meaningful there.
  if (process.platform !== 'win32') assert.equal(statSync(location).mode & 0o777, 0o600);
  const second = makeDeepSeekCredentialStore(encryptedStorage, dir, 'linux');
  assert.equal(second.read(), 'secret-DEEPSEEK-123');
  assert.deepEqual(second.status(), { available: true, saved: true });
  second.save('replacement-DEEPSEEK-456');
  assert.equal(first.read(), 'replacement-DEEPSEEK-456');
  second.remove();
  assert.deepEqual(first.status(), { available: true, saved: false });
});

test('Linux plaintext safeStorage fallback fails closed, leaving no credential file', () => {
  const dir = join(tmp, 'insecure');
  const store = makeDeepSeekCredentialStore({ ...encryptedStorage, getSelectedStorageBackend: () => 'basic_text' }, dir, 'linux');
  assert.equal(store.status().available, false);
  assert.throws(() => store.save('secret-value'), /Secure OS credential storage is unavailable/);
  assert.equal(store.read(), undefined);
});

test('Malformed and blank credentials never reach disk', () => {
  const store = makeDeepSeekCredentialStore(encryptedStorage, join(tmp, 'invalid'), 'linux');
  assert.throws(() => store.save(''), /valid DeepSeek API key/);
  assert.throws(() => store.save('wrong\nline'), /valid DeepSeek API key/);
  assert.deepEqual(store.status(), { available: true, saved: false });
});
