const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadLegacyBotConfig } = require('../src/config/loadLegacyBotConfig');

test('loadLegacyBotConfig no longer injects legacy ../replays outputDir by default', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'multibot-legacy-config-'));
  const configPath = path.join(tempRoot, 'config.json');

  fs.writeFileSync(configPath, JSON.stringify({
    recording: {
      enabled: true
    }
  }), 'utf8');

  const config = loadLegacyBotConfig(configPath);

  assert.equal(config.recording.enabled, true);
  assert.equal(Object.prototype.hasOwnProperty.call(config.recording, 'outputDir'), false);
});

test('loadLegacyBotConfig preserves explicit recording outputDir overrides', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'multibot-legacy-config-explicit-'));
  const configPath = path.join(tempRoot, 'config.json');

  fs.writeFileSync(configPath, JSON.stringify({
    recording: {
      enabled: true,
      outputDir: '../custom-replays'
    }
  }), 'utf8');

  const config = loadLegacyBotConfig(configPath);

  assert.equal(config.recording.outputDir, '../custom-replays');
});

test('loadLegacyBotConfig defaults capabilities to enabled', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'multibot-legacy-config-cap-default-'));
  const configPath = path.join(tempRoot, 'config.json');

  fs.writeFileSync(configPath, JSON.stringify({}), 'utf8');

  const config = loadLegacyBotConfig(configPath);

  assert.equal(config.trustedPlayersFile, null);
  assert.deepEqual(config.trustedPlayers, []);
  assert.deepEqual(config.capabilities, {
    entityHandling: true,
    terrainHandling: true
  });
});

test('loadLegacyBotConfig lets instance config override inherited capability defaults', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'multibot-legacy-config-cap-override-'));
  const defaultConfigPath = path.join(tempRoot, 'default.config.json');
  const configPath = path.join(tempRoot, 'config.json');

  fs.writeFileSync(defaultConfigPath, JSON.stringify({
    capabilities: {
      entityHandling: false,
      terrainHandling: false
    }
  }), 'utf8');

  fs.writeFileSync(configPath, JSON.stringify({
    capabilities: {
      entityHandling: true
    }
  }), 'utf8');

  const config = loadLegacyBotConfig(configPath, {
    inheritedConfigPath: defaultConfigPath
  });

  assert.deepEqual(config.capabilities, {
    entityHandling: true,
    terrainHandling: false
  });
});

test('loadLegacyBotConfig inherits and overrides trustedPlayersFile', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'multibot-legacy-config-trusted-file-'));
  const defaultConfigPath = path.join(tempRoot, 'default.config.json');
  const configPath = path.join(tempRoot, 'config.json');

  fs.writeFileSync(defaultConfigPath, JSON.stringify({
    trustedPlayersFile: '../trustedPlayers.txt'
  }), 'utf8');

  fs.writeFileSync(configPath, JSON.stringify({
    trustedPlayersFile: 'localTrustedPlayers.txt'
  }), 'utf8');

  const config = loadLegacyBotConfig(configPath, {
    inheritedConfigPath: defaultConfigPath
  });

  assert.equal(config.trustedPlayersFile, 'localTrustedPlayers.txt');
});

test('loadLegacyBotConfig merges trustedPlayers from inherited config when enabled', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'multibot-legacy-config-trusted-merge-'));
  const defaultConfigPath = path.join(tempRoot, 'default.config.json');
  const configPath = path.join(tempRoot, 'config.json');

  fs.writeFileSync(defaultConfigPath, JSON.stringify({
    trustedPlayers: ['ParentA', 'SharedUser'],
    trustedPlayersMergeParent: false
  }), 'utf8');

  fs.writeFileSync(configPath, JSON.stringify({
    trustedPlayersMergeParent: true,
    trustedPlayers: ['SharedUser', 'ChildB']
  }), 'utf8');

  const config = loadLegacyBotConfig(configPath, {
    inheritedConfigPath: defaultConfigPath
  });

  assert.equal(config.trustedPlayersMergeParent, true);
  assert.deepEqual(config.trustedPlayers, ['ParentA', 'SharedUser', 'ChildB']);
});

test('loadLegacyBotConfig keeps instance trustedPlayers override when merge is disabled', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'multibot-legacy-config-trusted-override-'));
  const defaultConfigPath = path.join(tempRoot, 'default.config.json');
  const configPath = path.join(tempRoot, 'config.json');

  fs.writeFileSync(defaultConfigPath, JSON.stringify({
    trustedPlayers: ['ParentA', 'SharedUser']
  }), 'utf8');

  fs.writeFileSync(configPath, JSON.stringify({
    trustedPlayersMergeParent: false,
    trustedPlayers: ['ChildB', 'SharedUser']
  }), 'utf8');

  const config = loadLegacyBotConfig(configPath, {
    inheritedConfigPath: defaultConfigPath
  });

  assert.equal(config.trustedPlayersMergeParent, false);
  assert.deepEqual(config.trustedPlayers, ['ChildB', 'SharedUser']);
});

test('loadLegacyBotConfig keeps only warehouse activation and rules file settings', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'multibot-legacy-config-warehouse-'));
  const configPath = path.join(tempRoot, 'config.json');

  fs.writeFileSync(configPath, JSON.stringify({
    warehouse: {
      enabled: true,
      rulesFile: 'custom-rules.json',
      movement: { lockY: { enabled: true, value: 72 } },
      idle: { enabled: true, position: { x: 1, y: 72, z: 3 } },
      automation: {
        pickupSort: { enabled: true, delaySeconds: 12 },
        scheduled: { enabled: true, intervalSeconds: 60, action: 'audit' }
      }
    }
  }), 'utf8');

  const config = loadLegacyBotConfig(configPath);

  assert.deepEqual(config.warehouse, {
    enabled: true,
    rulesFile: 'custom-rules.json'
  });
});
