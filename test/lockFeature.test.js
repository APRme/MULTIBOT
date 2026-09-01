const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { LockFeature } = require('../src/features/lock/LockFeature');

function createMockContext(source, sender) {
  const messages = [];
  return {
    source,
    sender,
    label: sender || source,
    messages,
    replyInfo(message) {
      messages.push({ type: 'info', message });
    },
    replyError(message) {
      messages.push({ type: 'error', message });
    }
  };
}

test('LockFeature creates lock and blocks other whisper admins', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multibot-lock-'));
  const lockHistoryPath = path.join(tempDir, 'lock_history.txt');
  const feature = new LockFeature({ lockHistoryPath });

  const ownerContext = createMockContext('whisper', 'example_player');
  const handled = await feature.handleLockCommand(ownerContext, ['lock', '1m', '开宝库']);

  assert.equal(handled, true);
  assert.equal(feature.getTeleportLockStatus().locked, true);
  assert.equal(feature.getTeleportLockStatus().owner, 'example_player');
  assert.match(ownerContext.messages[0].message, /锁定成功/);

  const otherAdminContext = createMockContext('whisper', 'example_trusted');
  assert.equal(feature.shouldEnforceWhisperLock(otherAdminContext), true);
  assert.equal(feature.isAllowedWhisperCommandDuringLock('send /home gj', ['send', '/home', 'gj']), false);
  assert.equal(feature.isAllowedWhisperCommandDuringLock('broadcast send hello', ['broadcast', 'send', 'hello']), true);
  assert.equal(feature.isAllowedWhisperCommandDuringLock('broadcast inv info', ['broadcast', 'inv', 'info']), true);
  assert.equal(feature.isAllowedWhisperCommandDuringLock('broadcast inv dropall', ['broadcast', 'inv', 'dropall']), false);
  assert.equal(feature.isAllowedWhisperCommandDuringLock('broadcast eat bread', ['broadcast', 'eat', 'bread']), false);
  feature.replyTeleportLockBlocked(otherAdminContext);
  assert.match(otherAdminContext.messages[0].message, /已锁定/);
  feature.stop();
});

test('LockFeature restores active lock from history', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multibot-lock-restore-'));
  const lockHistoryPath = path.join(tempDir, 'lock_history.txt');
  const now = Date.now();

  fs.writeFileSync(lockHistoryPath, `${JSON.stringify({
    type: 'lock',
    lockId: '1-example_player',
    owner: 'example_player',
    ownerLower: 'example_player',
    reason: '挂机中',
    createdAt: new Date(now - 1000).toISOString(),
    expiresAt: new Date(now + 60 * 1000).toISOString(),
    actor: 'example_player',
    source: 'whisper',
    version: 1
  })}\n`, 'utf8');

  const feature = new LockFeature({ lockHistoryPath });
  feature.start();

  const status = feature.getTeleportLockStatus();
  assert.equal(status.locked, true);
  assert.equal(status.owner, 'example_player');
  assert.equal(feature.isTeleportLockOwner('example_player'), true);
  feature.stop();
});

test('LockFeature allows lock owner to use broadcast inv commands', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multibot-lock-owner-'));
  const lockHistoryPath = path.join(tempDir, 'lock_history.txt');
  const feature = new LockFeature({ lockHistoryPath });

  const ownerContext = createMockContext('whisper', 'example_player');
  await feature.handleLockCommand(ownerContext, ['lock', '1m', '挂机']);

  assert.equal(feature.shouldEnforceWhisperLock(ownerContext), false);
  assert.equal(feature.isAllowedWhisperCommandDuringLock('broadcast inv dropall', ['broadcast', 'inv', 'dropall']), false);
  feature.stop();
});
