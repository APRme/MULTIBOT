const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ActivityLogFeature } = require('../src/features/activityLog/ActivityLogFeature');
const { AggregateLogService } = require('../src/logging/AggregateLogService');

test('ActivityLogFeature writes chat log and player list files', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multibot-activity-log-'));
  const feature = new ActivityLogFeature({
    paths: {
      accountDir: tempDir
    },
    config: {
      logToFile: true,
      logFilePath: './assn_chat.log',
      logPlayerList: true,
      playerListPath: './assn_playerList.log',
      playerListIntervalMinutes: 1
    }
  });
  const bot = {
    username: 'BotSelf',
    player: {
      username: 'BotSelf'
    },
    players: {
      example_trusted: {},
      example_player: {}
    }
  };

  feature.attach(bot);
  feature.logChatMessage('hello world');
  feature.stop();

  const chatLog = fs.readFileSync(path.join(tempDir, 'assn_chat.log'), 'utf8');
  const playerListLog = fs.readFileSync(path.join(tempDir, 'assn_playerList.log'), 'utf8');

  assert.match(chatLog, /hello world/);
  assert.match(playerListLog, /BotSelf, example_player, example_trusted/);
});

test('ActivityLogFeature can write aggregate chat and player list logs while local logs stay disabled', async () => {
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'multibot-aggregate-activity-'));
  const accountDir = path.join(appRoot, 'BOTS', 'my_server', 'BotA');
  const aggregateService = new AggregateLogService({
    appRoot,
    config: {
      enabled: true,
      chat: true,
      playerList: true,
      chatBatchWindowMs: 10,
      playerListIntervalMinutes: 1
    }
  });
  const feature = new ActivityLogFeature({
    paths: {
      accountDir
    },
    config: {
      logToFile: false,
      logPlayerList: false
    },
    aggregateLogService: aggregateService,
    runtimeInfo: {
      botId: 'BotA',
      username: 'BotSelf',
      serverDir: 'my_server',
      sourceType: 'multibot_bots'
    }
  });
  const bot = {
    username: 'BotSelf',
    player: {
      username: 'BotSelf'
    },
    players: {
      example_trusted: {},
      example_player: {}
    }
  };

  feature.attach(bot);
  feature.logChatMessage('hello world');
  await new Promise((resolve) => setTimeout(resolve, 30));
  aggregateService.flushPlayerList('my_server');
  feature.stop();

  const aggregateChatPath = path.join(appRoot, 'BOTS', 'my_server', 'my_server_chat.log');
  const aggregatePlayerListPath = path.join(appRoot, 'BOTS', 'my_server', 'my_server_playerList.log');

  assert.equal(fs.existsSync(path.join(accountDir, 'assn_chat.log')), false);
  assert.equal(fs.existsSync(path.join(accountDir, 'assn_playerList.log')), false);
  assert.match(fs.readFileSync(aggregateChatPath, 'utf8'), /\[BotSelf\] hello world/);
  assert.match(fs.readFileSync(aggregatePlayerListPath, 'utf8'), /BotSelf, example_player, example_trusted/);
});

test('ActivityLogFeature skips aggregate logging for legacy bots', async () => {
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'multibot-aggregate-legacy-'));
  const accountDir = path.join(appRoot, 'BOTS', 'my_server', 'BotLegacy');
  const aggregateService = new AggregateLogService({
    appRoot,
    config: {
      enabled: true,
      chat: true,
      playerList: true,
      chatBatchWindowMs: 10,
      playerListIntervalMinutes: 1
    }
  });
  const feature = new ActivityLogFeature({
    paths: {
      accountDir
    },
    config: {
      logToFile: false,
      logPlayerList: false
    },
    aggregateLogService: aggregateService,
    runtimeInfo: {
      botId: 'legacyBot',
      serverDir: 'my_server',
      sourceType: 'legacy_assn'
    }
  });

  feature.attach({
    username: 'legacyBot',
    player: {
      username: 'legacyBot'
    },
    players: {}
  });
  feature.logChatMessage('legacy hello');
  await new Promise((resolve) => setTimeout(resolve, 30));
  aggregateService.flushPlayerList('my_server');
  feature.stop();

  assert.equal(fs.existsSync(path.join(appRoot, 'BOTS', 'my_server', 'my_server_chat.log')), false);
  assert.equal(fs.existsSync(path.join(appRoot, 'BOTS', 'my_server', 'my_server_playerList.log')), false);
});
