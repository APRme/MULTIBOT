const test = require('node:test');
require('./helpers/tempDir'); // 测试临时目录统一重定向到工作区 .temp/test-run/
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

test('LockFeature invokes onExpire on natural expiry but not on manual unlock', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multibot-lock-expire-'));
  const lockHistoryPath = path.join(tempDir, 'lock_history.txt');
  const expired = [];
  const feature = new LockFeature({
    lockHistoryPath,
    onExpire: (lock, reason) => expired.push({ owner: lock.owner, reason })
  });

  const ownerContext = createMockContext('whisper', 'example_player');
  await feature.handleLockCommand(ownerContext, ['lock', '1m', '挂机']);

  assert.equal(feature.expireActiveTeleportLock('timer_expire'), true);
  assert.equal(expired.length, 1);
  assert.equal(expired[0].owner, 'example_player');
  assert.equal(expired[0].reason, 'timer_expire');

  // 再次锁定后手动 unlock 不触发 onExpire
  await feature.handleLockCommand(ownerContext, ['lock', '1m', '再锁']);
  assert.equal(feature.unlockActiveTeleportLock('example_player', 'manual_unlock'), true);
  assert.equal(expired.length, 1);
  feature.stop();
});

test('LockFeature onExpire fires with startup_expire when restoring an already expired lock', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multibot-lock-startup-expire-'));
  const lockHistoryPath = path.join(tempDir, 'lock_history.txt');
  const now = Date.now();

  fs.writeFileSync(lockHistoryPath, `${JSON.stringify({
    type: 'lock',
    lockId: '1-example_player',
    owner: 'example_player',
    ownerLower: 'example_player',
    reason: '挂机中',
    createdAt: new Date(now - 120000).toISOString(),
    expiresAt: new Date(now - 60000).toISOString(),
    actor: 'example_player',
    source: 'whisper',
    version: 1
  })}\n`, 'utf8');

  const expired = [];
  const feature = new LockFeature({
    lockHistoryPath,
    onExpire: (lock, reason) => expired.push({ owner: lock.owner, reason })
  });
  feature.start();

  assert.equal(feature.getTeleportLockStatus().locked, false);
  assert.equal(expired.length, 1);
  assert.equal(expired[0].reason, 'startup_expire');
  feature.stop();
});

test('LockFeature allows lockstatus during lock for non-owners', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multibot-lock-lockstatus-'));
  const lockHistoryPath = path.join(tempDir, 'lock_history.txt');
  const feature = new LockFeature({ lockHistoryPath });

  const ownerContext = createMockContext('whisper', 'example_player');
  await feature.handleLockCommand(ownerContext, ['lock', '1m', '挂机']);

  assert.equal(feature.isAllowedWhisperCommandDuringLock('lockstatus', ['lockstatus']), true);
  feature.stop();
});

test('LockFeature accepts panel (http/console) sources and records owner CONSOLE', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multibot-lock-panel-'));
  const lockHistoryPath = path.join(tempDir, 'lock_history.txt');
  const feature = new LockFeature({ lockHistoryPath });

  const panelContext = createMockContext('http', 'panel');
  const handled = await feature.handleLockCommand(panelContext, ['lock', '1m', '面板维护']);

  assert.equal(handled, true);
  const status = feature.getTeleportLockStatus();
  assert.equal(status.locked, true);
  assert.equal(status.owner, 'CONSOLE');
  assert.equal(status.source, 'http');

  const consoleContext = createMockContext('console', 'panel');
  assert.equal(await feature.handleUnlockCommand(consoleContext, ['unlock']), true);
  assert.equal(feature.getTeleportLockStatus().locked, false);
  feature.stop();
});

test('LockFeature rejects lock from non-management sources', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multibot-lock-badsource-'));
  const lockHistoryPath = path.join(tempDir, 'lock_history.txt');
  const feature = new LockFeature({ lockHistoryPath });

  const context = createMockContext('broadcast', 'bot-a');
  assert.equal(await feature.handleLockCommand(context, ['lock', '1m', 'x']), true);
  assert.equal(context.messages[0].type, 'error');
  assert.match(context.messages[0].message, /仅允许管理员/);
  assert.equal(feature.getTeleportLockStatus().locked, false);
  feature.stop();
});

test('LockFeature parses trailing true/false auto-exec flag', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multibot-lock-flag-'));
  const lockHistoryPath = path.join(tempDir, 'lock_history.txt');
  const feature = new LockFeature({ lockHistoryPath });
  const context = createMockContext('whisper', 'example_player');

  await feature.handleLockCommand(context, ['lock', '1m', '挂机', 'true']);
  assert.equal(feature.getTeleportLockStatus().locked, true);
  assert.equal(feature.getTeleportLockStatus().reason, '挂机');
  assert.equal(feature.activeTeleportLock.autoExecAfterExpire, true);

  await feature.handleUnlockCommand(createMockContext('whisper', 'example_player'), ['unlock']);
  await feature.handleLockCommand(context, ['lock', '1h', '不回家', 'false']);
  assert.equal(feature.activeTeleportLock.autoExecAfterExpire, false);
  assert.equal(feature.getTeleportLockStatus().reason, '不回家');

  await feature.handleUnlockCommand(createMockContext('whisper', 'example_player'), ['unlock']);
  await feature.handleLockCommand(context, ['lock', '1h', '默认行为']);
  assert.equal(feature.activeTeleportLock.autoExecAfterExpire, undefined);
  feature.stop();
});

test('LockFeature usage text explains the true/false flag', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multibot-lock-usage-'));
  const lockHistoryPath = path.join(tempDir, 'lock_history.txt');
  const feature = new LockFeature({ lockHistoryPath });
  const context = createMockContext('whisper', 'example_player');

  await feature.handleLockCommand(context, ['lock']);
  assert.ok(context.messages.some((entry) => entry.message.includes('[true|false]')));
  assert.ok(context.messages.some((entry) => entry.message.includes('true=')));

  const context2 = createMockContext('whisper', 'example_player');
  await feature.handleLockCommand(context2, ['lock', '1m']);
  assert.ok(context2.messages.some((entry) => entry.message.includes('[true|false]')));
  assert.ok(context2.messages.some((entry) => entry.message.includes('false=')));
  feature.stop();
});
