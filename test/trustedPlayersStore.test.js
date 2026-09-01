const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { TrustedPlayersStore, mergePlayerLists } = require('../src/features/trustedPlayers/TrustedPlayersStore');

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

test('mergePlayerLists preserves order and deduplicates case-insensitively', () => {
  assert.deepEqual(
    mergePlayerLists(['example_player', 'example_trusted'], ['example_player', 'Other', '']),
    ['example_player', 'example_trusted', 'Other']
  );
});

test('TrustedPlayersStore combines static and file players', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'multibot-trusted-players-'));
  fs.writeFileSync(path.join(tempRoot, 'trustedPlayers.txt'), 'FileUser\n#ignored\nStaticUser\n', 'utf8');

  const store = new TrustedPlayersStore({
    config: {
      trustedPlayersMergeParent: true,
      trustedPlayers: ['StaticUser'],
      trustedPlayersFile: 'trustedPlayers.txt'
    },
    paths: {
      accountDir: tempRoot
    }
  });

  store.refresh();

  assert.deepEqual(store.getEntries(), ['StaticUser', 'FileUser']);
  assert.equal(store.isTrustedPlayer('fileuser'), true);
  assert.equal(store.isTrustedPlayer('unknown'), false);
});

test('TrustedPlayersStore ignores trustedPlayers.txt when mergeParent is disabled', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'multibot-trusted-players-no-merge-'));
  fs.writeFileSync(path.join(tempRoot, 'trustedPlayers.txt'), 'FileUser\n', 'utf8');

  const store = new TrustedPlayersStore({
    config: {
      trustedPlayers: ['StaticUser'],
      trustedPlayersFile: 'trustedPlayers.txt'
    },
    paths: {
      accountDir: tempRoot
    }
  });

  store.refresh();

  assert.deepEqual(store.getEntries(), ['StaticUser']);
  assert.deepEqual(store.fileTrustedPlayers, []);
  assert.equal(store.getTrustedPlayersFilePath(), path.join(tempRoot, 'trustedPlayers.txt'));
  assert.equal(store.isTrustedPlayer('FileUser'), false);
  assert.equal(store.isTrustedPlayer('StaticUser'), true);
});

test('TrustedPlayersStore auto refreshes file players via fs.watch and stops watcher', async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'multibot-trusted-players-watch-'));
  const filePath = path.join(tempRoot, 'trustedPlayers.txt');
  fs.writeFileSync(filePath, 'FirstUser\n', 'utf8');

  const store = new TrustedPlayersStore({
    config: {
      trustedPlayersMergeParent: true,
      trustedPlayers: ['StaticUser'],
      trustedPlayersFile: 'trustedPlayers.txt'
    },
    paths: {
      accountDir: tempRoot
    }
  });

  t.after(() => store.stop());
  store.start();
  assert.ok(store.watcher);
  assert.equal(store.isTrustedPlayer('FirstUser'), true);

  fs.writeFileSync(filePath, 'SecondUser\n', 'utf8');
  await waitFor(() => store.isTrustedPlayer('SecondUser') && !store.isTrustedPlayer('FirstUser'));

  assert.deepEqual(store.getEntries(), ['StaticUser', 'SecondUser']);
  store.stop();
  assert.equal(store.watcher, null);
  assert.equal(store.refreshDebounceTimer, null);
});
