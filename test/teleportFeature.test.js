const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { TeleportFeature } = require('../src/features/teleport/TeleportFeature');

function createBot(chats) {
  return {
    chat(message) {
      chats.push(message);
    }
  };
}

async function waitFor(predicate, timeoutMs = 2000, intervalMs = 20) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error('Timed out waiting for predicate');
}

test('TeleportFeature whitelist cache auto refreshes via fs.watch and stops watcher', async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'multibot-teleport-'));
  fs.writeFileSync(path.join(tempRoot, 'whitelist.txt'), 'example_player\n', 'utf8');

  const chats = [];
  const feature = new TeleportFeature({
    config: {
      trustedPlayers: ['example_player'],
      teleport: {
        mode: 'whitelist',
        whitelistFile: 'whitelist.txt'
      }
    },
    paths: {
      accountDir: tempRoot
    },
    lockFeature: {
      getTeleportLockStatus() {
        return { locked: false };
      },
      isTeleportLockOwner() {
        return false;
      }
    }
  });

  feature.attach(createBot(chats));
  t.after(() => feature.stop());
  feature.start();
  assert.ok(feature.whitelistWatcher);

  feature.handleTeleportRequest('example_player');
  feature.handleTeleportRequest('Other');

  fs.writeFileSync(path.join(tempRoot, 'whitelist.txt'), 'Other\n', 'utf8');
  await waitFor(() => feature.getWhitelistInfo().count === 1 && feature.getWhitelistInfo().entries[0] === 'Other');
  const info = feature.getWhitelistInfo();
  feature.handleTeleportRequest('example_player');
  feature.handleTeleportRequest('Other');

  assert.equal(info.count, 1);
  assert.deepEqual(chats, [
    '/tpaccept',
    '/minecraft:w example_player 已接受你的传送请求。',
    '/tpdeny',
    '/tpdeny',
    '/tpaccept',
    '/minecraft:w Other 已接受你的传送请求。'
  ]);
  feature.stop();
  assert.equal(feature.whitelistWatcher, null);
  assert.equal(feature.whitelistRefreshDebounceTimer, null);
});

test('TeleportFeature supports trustedPlayers teleport mode', (t) => {
  const chats = [];
  const logs = [];
  const feature = new TeleportFeature({
    config: {
      trustedPlayers: ['example_player'],
      teleport: {
        mode: 'trustedPlayers'
      }
    },
    logger: { info(message) { logs.push(message); } },
    lockFeature: {
      getTeleportLockStatus() {
        return { locked: false };
      },
      isTeleportLockOwner() {
        return false;
      }
    }
  });

  feature.attach(createBot(chats));
  t.after(() => feature.stop());
  feature.start();
  feature.handleTeleportRequest('example_player');
  feature.handleTeleportRequest('Other');

  assert.deepEqual(chats, [
    '/tpaccept',
    '/minecraft:w example_player 已接受你的传送请求。',
    '/tpdeny'
  ]);
  assert.deepEqual(logs.filter((message) => message.includes('接受') || message.includes('拒绝')), [
    '[TPA] 接受 example_player 的传送请求，原因: 信任玩家',
    '[TPA] 拒绝 Other 的传送请求，原因: 不在信任玩家列表'
  ]);
});

test('TeleportFeature uses trusted players store when available', (t) => {
  const chats = [];
  const feature = new TeleportFeature({
    config: {
      trustedPlayers: [],
      teleport: {
        mode: 'trustedPlayers'
      }
    },
    trustedPlayersStore: {
      isTrustedPlayer(sender) {
        return String(sender).toLowerCase() === 'fileuser';
      }
    },
    lockFeature: {
      getTeleportLockStatus() {
        return { locked: false };
      },
      isTeleportLockOwner() {
        return false;
      }
    }
  });

  feature.attach(createBot(chats));
  t.after(() => feature.stop());
  feature.start();
  feature.handleTeleportRequest('FileUser');
  feature.handleTeleportRequest('Other');
  feature.handleTeleportHereRequest('FileUser');

  assert.equal(chats[0], '/tpaccept');
  assert.equal(chats[2], '/tpdeny');
  assert.equal(chats[3], '/tpaccept');
});

test('TeleportFeature tpahere obeys lock and owner bypass', (t) => {
  const chats = [];
  const feature = new TeleportFeature({
    config: {
      trustedPlayers: ['example_player', 'Owner'],
      teleport: {
        mode: 'whitelist'
      }
    },
    lockFeature: {
      getTeleportLockStatus() {
        return {
          locked: true,
          owner: 'Owner',
          reason: 'busy',
          remainingText: '30s'
        };
      },
      isTeleportLockOwner(sender) {
        return sender === 'Owner';
      }
    }
  });

  feature.attach(createBot(chats));
  t.after(() => feature.stop());
  feature.handleTeleportHereRequest('example_player');
  feature.handleTeleportHereRequest('Owner');

  assert.deepEqual(chats, [
    '/tpdeny',
    '/minecraft:w example_player 已锁定，锁定人: Owner 原因: busy 剩余锁定时间: 30s',
    '/tpaccept',
    '/minecraft:w Owner 已接受你的传送请求。'
  ]);
});
