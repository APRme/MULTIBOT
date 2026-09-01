const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  createAuthCacheFactory,
  createAuthCacheFileName
} = require('../src/session/createAuthCacheFactory');

function writeCacheFile(directoryPath, fileName, payload, mtimeMs) {
  fs.mkdirSync(directoryPath, { recursive: true });
  const filePath = path.join(directoryPath, fileName);
  fs.writeFileSync(filePath, JSON.stringify(payload), 'utf8');
  if (mtimeMs) {
    const time = new Date(mtimeMs);
    fs.utimesSync(filePath, time, time);
  }
  return filePath;
}

test('auth cache factory falls back to nmp-cache when primary file is missing', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'multibot-auth-cache-'));
  const primaryDir = path.join(tempRoot, 'auth-cache');
  const fallbackDir = path.join(tempRoot, 'nmp-cache');
  const fileName = createAuthCacheFileName('live', 'alpha@example.com');

  writeCacheFile(fallbackDir, fileName, { source: 'fallback', token: 'abc' }, Date.now());

  const factory = createAuthCacheFactory({ primaryDir, fallbackDir });
  const cache = factory({ cacheName: 'live', username: 'alpha@example.com' });
  const cached = await cache.getCached();

  assert.deepEqual(cached, { source: 'fallback', token: 'abc' });
  const migratedPayload = JSON.parse(fs.readFileSync(path.join(primaryDir, fileName), 'utf8'));
  assert.deepEqual(migratedPayload, { source: 'fallback', token: 'abc' });
});

test('auth cache factory prefers the newer file when both primary and fallback exist', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'multibot-auth-cache-'));
  const primaryDir = path.join(tempRoot, 'auth-cache');
  const fallbackDir = path.join(tempRoot, 'nmp-cache');
  const fileName = createAuthCacheFileName('mca', 'alpha@example.com');

  writeCacheFile(primaryDir, fileName, { source: 'primary-old', token: 'old' }, Date.now() - 10000);
  writeCacheFile(fallbackDir, fileName, { source: 'fallback-new', token: 'new' }, Date.now());

  const factory = createAuthCacheFactory({ primaryDir, fallbackDir });
  const cache = factory({ cacheName: 'mca', username: 'alpha@example.com' });
  const cached = await cache.getCached();

  assert.deepEqual(cached, { source: 'fallback-new', token: 'new' });
  const migratedPayload = JSON.parse(fs.readFileSync(path.join(primaryDir, fileName), 'utf8'));
  assert.deepEqual(migratedPayload, { source: 'fallback-new', token: 'new' });
});

test('auth cache factory writes refreshed data back to the primary auth-cache directory', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'multibot-auth-cache-'));
  const primaryDir = path.join(tempRoot, 'auth-cache');
  const fallbackDir = path.join(tempRoot, 'nmp-cache');
  const fileName = createAuthCacheFileName('xbl', 'alpha@example.com');

  writeCacheFile(fallbackDir, fileName, { source: 'fallback', token: 'old' }, Date.now());

  const factory = createAuthCacheFactory({ primaryDir, fallbackDir });
  const cache = factory({ cacheName: 'xbl', username: 'alpha@example.com' });

  await cache.setCachedPartial({ source: 'primary', token: 'new' });

  const primaryPayload = JSON.parse(fs.readFileSync(path.join(primaryDir, fileName), 'utf8'));
  assert.deepEqual(primaryPayload, { source: 'primary', token: 'new' });
});

test('auth cache factory can read legacy email-keyed cache for a username-keyed bot and migrate it', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'multibot-auth-cache-'));
  const primaryDir = path.join(tempRoot, 'auth-cache');
  const fallbackDir = path.join(tempRoot, 'nmp-cache');
  const username = 'AlphaBot';
  const email = 'alpha@example.com';
  const emailFileName = createAuthCacheFileName('live', email);

  writeCacheFile(fallbackDir, emailFileName, { source: 'legacy-email', token: 'abc' }, Date.now());

  const factory = createAuthCacheFactory({
    primaryDir,
    fallbackDir,
    primaryUsername: email
  });
  const cache = factory({ cacheName: 'live', username });
  const cached = await cache.getCached();

  assert.deepEqual(cached, { source: 'legacy-email', token: 'abc' });
  const migratedPayload = JSON.parse(fs.readFileSync(path.join(primaryDir, emailFileName), 'utf8'));
  assert.deepEqual(migratedPayload, { source: 'legacy-email', token: 'abc' });
});

test('auth cache factory prefers the newest cache across username and email lookup keys', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'multibot-auth-cache-'));
  const primaryDir = path.join(tempRoot, 'auth-cache');
  const fallbackDir = path.join(tempRoot, 'nmp-cache');
  const username = 'AlphaBot';
  const email = 'alpha@example.com';
  const usernameFileName = createAuthCacheFileName('mca', username);
  const emailFileName = createAuthCacheFileName('mca', email);

  writeCacheFile(primaryDir, usernameFileName, { source: 'username-old', token: 'old' }, Date.now() - 10000);
  writeCacheFile(fallbackDir, emailFileName, { source: 'email-new', token: 'new' }, Date.now());

  const factory = createAuthCacheFactory({
    primaryDir,
    fallbackDir,
    primaryUsername: email
  });
  const cache = factory({ cacheName: 'mca', username });
  const cached = await cache.getCached();

  assert.deepEqual(cached, { source: 'email-new', token: 'new' });
  const migratedPayload = JSON.parse(fs.readFileSync(path.join(primaryDir, emailFileName), 'utf8'));
  assert.deepEqual(migratedPayload, { source: 'email-new', token: 'new' });
});

test('auth cache factory writes refreshed data to the email-keyed primary file when email is configured', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'multibot-auth-cache-'));
  const primaryDir = path.join(tempRoot, 'auth-cache');
  const fallbackDir = path.join(tempRoot, 'nmp-cache');
  const username = 'AlphaBot';
  const email = 'alpha@example.com';
  const emailFileName = createAuthCacheFileName('xbl', email);
  const usernameFileName = createAuthCacheFileName('xbl', username);

  const factory = createAuthCacheFactory({
    primaryDir,
    fallbackDir,
    primaryUsername: email
  });
  const cache = factory({ cacheName: 'xbl', username });

  await cache.setCachedPartial({ source: 'email-primary', token: 'new' });

  const primaryPayload = JSON.parse(fs.readFileSync(path.join(primaryDir, emailFileName), 'utf8'));
  assert.deepEqual(primaryPayload, { source: 'email-primary', token: 'new' });
  assert.equal(fs.existsSync(path.join(primaryDir, usernameFileName)), false);
});
