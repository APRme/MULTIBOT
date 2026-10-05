const test = require('node:test');
require('./helpers/tempDir'); // 测试临时目录统一重定向到工作区 .temp/test-run/
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { InstanceService } = require('../src/config/InstanceService');

function createFakeBotManager() {
  const runtimes = new Map();
  const runtimesByInstance = new Map();
  const calls = [];

  return {
    calls,
    getBotByInstance(serverDir, botDir) {
      return runtimesByInstance.get(`${serverDir}/${botDir}`) || null;
    },
    async addOrReplaceBotConfig(botConfig, options = {}) {
      calls.push(['addOrReplaceBotConfig', botConfig.id, botConfig.serverDir, botConfig.botDir, options.reason || null]);
      const key = `${botConfig.serverDir}/${botConfig.botDir}`;
      const runtime = {
        config: botConfig,
        state: options.start === true || (options.respectAutoStart === true && botConfig.autoStart === true)
          ? 'online'
          : 'stopped',
        getDetails() {
          return {
            id: botConfig.id,
            state: this.state
          };
        },
        async start() {
          this.state = 'online';
          return this.getDetails();
        }
      };

      const previous = runtimesByInstance.get(key);
      if (previous) {
        runtimes.delete(previous.config.id);
      }

      runtimes.set(botConfig.id, runtime);
      runtimesByInstance.set(key, runtime);
      return runtime.getDetails();
    },
    async removeBotByInstance(serverDir, botDir, reason) {
      calls.push(['removeBotByInstance', serverDir, botDir, reason]);
      const key = `${serverDir}/${botDir}`;
      const runtime = runtimesByInstance.get(key) || null;
      if (!runtime) {
        return null;
      }

      runtimes.delete(runtime.config.id);
      runtimesByInstance.delete(key);
      return runtime.getDetails();
    }
  };
}

function createServiceFixture() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'multibot-instance-service-'));
  const appRoot = path.join(repoRoot, 'tests', 'MULTIBOT');
  fs.mkdirSync(appRoot, { recursive: true });

  const botManager = createFakeBotManager();
  const masterConfig = {
    repoRoot,
    appRoot,
    defaults: {
      auth: 'microsoft',
      version: '1.21.11',
      viewDistance: 'tiny',
      disableChatSigning: true,
      autoStart: false,
      restartOnDisconnect: true,
      restartDelayMs: 15000
    },
    discovery: {
      enabled: true,
      botsRoot: './BOTS'
    },
    bots: []
  };

  return {
    repoRoot,
    appRoot,
    botManager,
    service: new InstanceService({
      masterConfig,
      botManager
    })
  };
}

test('InstanceService creates, lists, updates and deletes BOTS instances', async () => {
  const { service, botManager, appRoot } = createServiceFixture();

  const created = await service.createInstance({
    serverDir: 'server_a',
    botDir: 'bot_one',
    server: {
      host: '127.0.0.1',
      port: 25565
    },
    bot: {
      email: 'bot@example.com',
      username: 'bot@example.com',
      autoStart: true,
      teleport: {
        mode: 'whitelist'
      }
    }
  });

  assert.equal(created.id, 'server_a__bot_one');
  assert.equal(created.state, 'online');
  assert.equal(service.listInstances().length, 1);
  assert.ok(fs.existsSync(created.paths.botConfigPath));
  assert.ok(fs.existsSync(created.paths.serverConfigPath));

  const detailed = service.getInstance('server_a', 'bot_one');
  assert.equal(detailed.botConfig.email, 'bot@example.com');
  assert.equal(detailed.serverConfig.host, '127.0.0.1');

  const updated = await service.updateInstance('server_a', 'bot_one', {
    bot: {
      teleport: {
        whitelistFile: 'trusted.txt'
      }
    }
  });

  assert.deepEqual(updated.affectedBotIds, ['server_a__bot_one']);
  assert.equal(updated.instance.botConfig.teleport.mode, 'whitelist');
  assert.equal(updated.instance.botConfig.teleport.whitelistFile, 'trusted.txt');

  const serverDir = path.join(appRoot, 'BOTS', 'server_a');
  const whitelistPath = path.join(serverDir, 'whitelist.txt');
  const aggregateLogPath = path.join(serverDir, 'server_a_chat.log');
  fs.writeFileSync(whitelistPath, 'TrustedPlayer\n', 'utf8');
  fs.writeFileSync(aggregateLogPath, 'history\n', 'utf8');

  const deleted = await service.deleteInstance('server_a', 'bot_one');
  assert.equal(deleted.deleted, true);
  assert.equal(deleted.serverPreserved, true);
  assert.equal(fs.existsSync(serverDir), true);
  assert.equal(fs.existsSync(whitelistPath), true);
  assert.equal(fs.existsSync(aggregateLogPath), true);
  assert.equal(service.listInstances().length, 0);
  assert.equal(botManager.getBotByInstance('server_a', 'bot_one'), null);
  assert.deepEqual(botManager.calls, [
    ['addOrReplaceBotConfig', 'server_a__bot_one', 'server_a', 'bot_one', 'instance_create'],
    ['addOrReplaceBotConfig', 'server_a__bot_one', 'server_a', 'bot_one', 'instance_update'],
    ['removeBotByInstance', 'server_a', 'bot_one', 'instance_delete']
  ]);
});

test('InstanceService restores config files when runtime synchronization fails', async () => {
  const { service, botManager } = createServiceFixture();
  await service.createInstance({
    serverDir: 'server_rollback',
    botDir: 'bot_one',
    server: { host: '127.0.0.1', port: 25565 },
    bot: { username: 'before@example.com', teleport: { mode: 'whitelist' } }
  });

  const before = service.getInstance('server_rollback', 'bot_one').botConfig;
  botManager.addOrReplaceBotConfig = async () => {
    throw new Error('runtime sync failed');
  };

  await assert.rejects(
    service.updateInstance('server_rollback', 'bot_one', {
      bot: { username: 'after@example.com' }
    }),
    /runtime sync failed/
  );

  assert.deepEqual(service.getInstance('server_rollback', 'bot_one').botConfig, before);
  assert.equal(botManager.getBotByInstance('server_rollback', 'bot_one').config.username, 'before@example.com');
});

test('InstanceService reloads all bots under one server when server config changes', async () => {
  const { service, botManager } = createServiceFixture();

  await service.createInstance({
    serverDir: 'server_b',
    botDir: 'bot_one',
    server: {
      host: '127.0.0.1',
      port: 25565
    },
    bot: {
      email: 'one@example.com'
    }
  });
  await service.createInstance({
    serverDir: 'server_b',
    botDir: 'bot_two',
    bot: {
      email: 'two@example.com'
    }
  });

  botManager.calls.length = 0;
  const result = await service.updateInstance('server_b', 'bot_one', {
    server: {
      port: 25566
    }
  });

  assert.deepEqual(result.affectedBotIds.sort(), ['server_b__bot_one', 'server_b__bot_two']);
  assert.deepEqual(botManager.calls, [
    ['addOrReplaceBotConfig', 'server_b__bot_one', 'server_b', 'bot_one', 'instance_server_update'],
    ['addOrReplaceBotConfig', 'server_b__bot_two', 'server_b', 'bot_two', 'instance_server_update']
  ]);
  assert.equal(service.getInstance('server_b', 'bot_two').serverConfig.port, 25566);
});

test('InstanceService can replace bot config file and persist deleted fields', async () => {
  const { service, botManager } = createServiceFixture();

  await service.createInstance({
    serverDir: 'server_replace',
    botDir: 'bot_one',
    server: {
      host: '127.0.0.1',
      port: 25565
    },
    bot: {
      email: 'bot@example.com',
      username: 'bot@example.com',
      autoStart: true,
      teleport: {
        mode: 'whitelist',
        whitelistFile: 'trusted.txt'
      }
    }
  });

  botManager.calls.length = 0;
  const updated = await service.updateInstance('server_replace', 'bot_one', {
    replace: true,
    bot: {
      email: 'bot@example.com',
      username: 'bot@example.com',
      autoStart: true,
      teleport: {
        whitelistFile: 'trusted.txt'
      }
    }
  });

  assert.deepEqual(updated.affectedBotIds, ['server_replace__bot_one']);
  assert.deepEqual(updated.instance.botConfig.teleport, {
    whitelistFile: 'trusted.txt'
  });
  assert.equal(updated.instance.botConfig.teleport.mode, undefined);
  assert.deepEqual(botManager.calls, [
    ['addOrReplaceBotConfig', 'server_replace__bot_one', 'server_replace', 'bot_one', 'instance_update']
  ]);
});

test('InstanceService updates shared default.config.json and reloads all bots under one server', async () => {
  const { service, botManager } = createServiceFixture();

  await service.createInstance({
    serverDir: 'server_d',
    botDir: 'bot_one',
    server: {
      host: '127.0.0.1',
      port: 25565
    },
    bot: {
      email: 'one@example.com'
    }
  });
  await service.createInstance({
    serverDir: 'server_d',
    botDir: 'bot_two',
    bot: {
      email: 'two@example.com'
    }
  });

  botManager.calls.length = 0;
  const result = await service.updateInstance('server_d', 'bot_one', {
    defaultBotConfig: {
      autoStart: true,
      teleport: {
        mode: 'trustedPlayers',
        whitelistFile: 'shared.txt'
      },
      recording: {
        enabled: true
      }
    }
  });

  assert.deepEqual(result.affectedBotIds.sort(), ['server_d__bot_one', 'server_d__bot_two']);
  assert.deepEqual(result.instance.defaultBotConfig, {
    autoStart: true,
    teleport: {
      mode: 'trustedPlayers',
      whitelistFile: 'shared.txt'
    },
    recording: {
      enabled: true
    }
  });
  assert.equal(service.getInstance('server_d', 'bot_two').defaultBotConfig.recording.enabled, true);
  assert.equal(service.getInstance('server_d', 'bot_two').legacyConfig.teleport.mode, 'trustedPlayers');
  assert.deepEqual(botManager.calls, [
    ['addOrReplaceBotConfig', 'server_d__bot_one', 'server_d', 'bot_one', 'instance_default_bot_update'],
    ['addOrReplaceBotConfig', 'server_d__bot_two', 'server_d', 'bot_two', 'instance_default_bot_update']
  ]);
});

test('InstanceService inherits server default.config.json for new instances while preserving bot overrides', async () => {
  const { service } = createServiceFixture();

  await service.createInstance({
    serverDir: 'server_c',
    botDir: 'bot_one',
    server: {
      host: '127.0.0.1',
      port: 25565
    },
    bot: {
      email: 'one@example.com'
    }
  });

  const serverPaths = service.getPaths('server_c', 'bot_one');
  fs.writeFileSync(serverPaths.defaultLegacyConfigPath, JSON.stringify({
    autoStart: true,
    teleport: {
      mode: 'trustedPlayers',
      whitelistFile: 'shared.txt'
    },
    recording: {
      enabled: true
    }
  }, null, 2), 'utf8');

  const created = await service.createInstance({
    serverDir: 'server_c',
    botDir: 'bot_two',
    bot: {
      email: 'two@example.com',
      autoStart: false,
      teleport: {
        whitelistFile: 'instance.txt'
      }
    }
  });

  assert.equal(created.autoStart, false);
  assert.equal(created.paths.defaultBotConfigPath, serverPaths.defaultLegacyConfigPath);
  assert.deepEqual(created.defaultBotConfig, {
    autoStart: true,
    teleport: {
      mode: 'trustedPlayers',
      whitelistFile: 'shared.txt'
    },
    recording: {
      enabled: true
    }
  });
  assert.equal(created.legacyConfig.teleport.mode, 'trustedPlayers');
  assert.equal(created.legacyConfig.teleport.whitelistFile, 'instance.txt');
  assert.equal(created.legacyConfig.recording.enabled, true);
});

test('InstanceService skips the full server resync when the default bot config is unchanged', async () => {
  const { service, botManager } = createServiceFixture();
  const defaultBotConfig = { chat: { unknownWhisperReply: 'hi' } };

  await service.createInstance({
    serverDir: 'server_a',
    botDir: 'bot_one',
    server: { host: '127.0.0.1', port: 25565 },
    bot: { username: 'bot_one', autoStart: true },
    defaultBotConfig
  });

  botManager.calls.length = 0;

  await service.createInstance({
    serverDir: 'server_a',
    botDir: 'bot_two',
    bot: { username: 'bot_two', autoStart: true },
    defaultBotConfig
  });

  const touchedBots = botManager.calls
    .filter((entry) => entry[0] === 'addOrReplaceBotConfig')
    .map((entry) => entry[1]);
  assert.deepEqual(touchedBots, ['server_a__bot_two'], '默认配置未变时只应同步新实例');
  assert.equal(
    botManager.calls.some((entry) => entry[0] === 'addOrReplaceBotConfig' && entry[4] === 'instance_default_bot_update'),
    false,
    '不应触发该服务器的全量重建(那会导致所有 bot 重连)'
  );
});

test('InstanceService still resyncs the whole server when the default bot config changes', async () => {
  const { service, botManager } = createServiceFixture();

  await service.createInstance({
    serverDir: 'server_a',
    botDir: 'bot_one',
    server: { host: '127.0.0.1', port: 25565 },
    bot: { username: 'bot_one', autoStart: true },
    defaultBotConfig: { chat: { unknownWhisperReply: 'before' } }
  });

  botManager.calls.length = 0;

  await service.createInstance({
    serverDir: 'server_a',
    botDir: 'bot_two',
    bot: { username: 'bot_two', autoStart: true },
    defaultBotConfig: { chat: { unknownWhisperReply: 'after' } }
  });

  const touchedBots = botManager.calls
    .filter((entry) => entry[0] === 'addOrReplaceBotConfig')
    .map((entry) => entry[1]);
  assert.ok(touchedBots.includes('server_a__bot_one'), '默认配置变化时已有 bot 也必须同步');
  assert.ok(touchedBots.includes('server_a__bot_two'));
  assert.equal(
    botManager.calls.some((entry) => entry[0] === 'addOrReplaceBotConfig' && entry[4] === 'instance_default_bot_update'),
    true,
    '默认配置变化时仍应走全量同步'
  );
});

test('InstanceService resyncs existing bots when server.json changes even if default config is unchanged', async () => {
  const { service, botManager } = createServiceFixture();
  const defaultBotConfig = { chat: { unknownWhisperReply: 'hi' } };

  await service.createInstance({
    serverDir: 'server_a',
    botDir: 'bot_one',
    server: { host: 'old.example.com', port: 25565 },
    bot: { username: 'bot_one', autoStart: true },
    defaultBotConfig
  });

  botManager.calls.length = 0;

  await service.createInstance({
    serverDir: 'server_a',
    botDir: 'bot_two',
    server: { host: 'new.example.com', port: 25566 },
    bot: { username: 'bot_two', autoStart: true },
    defaultBotConfig
  });

  const synced = botManager.calls.filter((entry) => entry[0] === 'addOrReplaceBotConfig');
  const syncedIds = synced.map((entry) => entry[1]);
  assert.ok(syncedIds.includes('server_a__bot_one'), 'server.json 变化必须下发到该服务器已有 bot');
  assert.ok(
    synced.some((entry) => entry[1] === 'server_a__bot_one' && entry[4] === 'instance_server_update'),
    'reason 应为 instance_server_update'
  );
});

test('InstanceService still creates an instance when default.config.json is corrupt', async () => {
  const { service, appRoot } = createServiceFixture();

  await service.createInstance({
    serverDir: 'server_a',
    botDir: 'bot_one',
    server: { host: '127.0.0.1', port: 25565 },
    bot: { username: 'bot_one' }
  });

  const defaultPath = path.join(appRoot, 'BOTS', 'server_a', 'default.config.json');
  fs.writeFileSync(defaultPath, '{ this is not json', 'utf8');

  const created = await service.createInstance({
    serverDir: 'server_a',
    botDir: 'bot_two',
    bot: { username: 'bot_two' },
    defaultBotConfig: { chat: { unknownWhisperReply: 'fixed' } }
  });

  assert.equal(created.id, 'server_a__bot_two');
  assert.deepEqual(
    JSON.parse(fs.readFileSync(defaultPath, 'utf8')),
    { chat: { unknownWhisperReply: 'fixed' } },
    '坏掉的默认配置应被覆盖为合法内容'
  );
});

test('InstanceService does not resync any bot when a PATCH changes nothing', async () => {
  const { service, botManager } = createServiceFixture();
  const defaultBotConfig = { chat: { unknownWhisperReply: 'hi' } };

  await service.createInstance({
    serverDir: 'server_a',
    botDir: 'bot_one',
    server: { host: '127.0.0.1', port: 25565 },
    bot: { username: 'bot_one', autoStart: true },
    defaultBotConfig
  });

  await service.createInstance({
    serverDir: 'server_a',
    botDir: 'bot_two',
    bot: { username: 'bot_two', autoStart: true }
  });

  botManager.calls.length = 0;

  const result = await service.updateInstance('server_a', 'bot_one', {
    server: { host: '127.0.0.1', port: 25565 },
    defaultBotConfig
  });

  assert.deepEqual(result.affectedBotIds, [], '内容未变时不应报告任何受影响 bot');
  assert.equal(
    botManager.calls.filter((entry) => entry[0] === 'addOrReplaceBotConfig').length,
    0,
    '内容未变时不应重建任何 bot(避免全量重连)'
  );
});

test('InstanceService still resyncs the whole server when a PATCH really changes content', async () => {
  const { service, botManager } = createServiceFixture();

  await service.createInstance({
    serverDir: 'server_a',
    botDir: 'bot_one',
    server: { host: '127.0.0.1', port: 25565 },
    bot: { username: 'bot_one', autoStart: true }
  });

  await service.createInstance({
    serverDir: 'server_a',
    botDir: 'bot_two',
    bot: { username: 'bot_two', autoStart: true }
  });

  botManager.calls.length = 0;

  const result = await service.updateInstance('server_a', 'bot_one', {
    server: { host: 'changed.example.com' }
  });

  assert.ok(result.affectedBotIds.includes('server_a__bot_one'));
  assert.ok(result.affectedBotIds.includes('server_a__bot_two'));
  assert.ok(
    botManager.calls.some((entry) => entry[4] === 'instance_server_update'),
    '内容真的变化时仍应全量同步'
  );
});

test('InstanceService still starts the instance when a PATCH only asks to start it', async () => {
  const { service, botManager } = createServiceFixture();

  await service.createInstance({
    serverDir: 'server_a',
    botDir: 'bot_one',
    server: { host: '127.0.0.1', port: 25565 },
    bot: { username: 'bot_one' }
  });

  botManager.calls.length = 0;

  const result = await service.updateInstance('server_a', 'bot_one', { start: true });

  assert.deepEqual(result.affectedBotIds, [], '仅要求启动时不应重建');
  assert.equal(botManager.getBotByInstance('server_a', 'bot_one').state, 'online', 'start 仍应生效');
});
