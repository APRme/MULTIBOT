const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AggregateLogService } = require('../src/logging/AggregateLogService');

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('AggregateLogService aggregates identical same-server chat messages within the batch window', async () => {
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'multibot-aggregate-chat-'));
  const service = new AggregateLogService({
    appRoot,
    config: {
      enabled: true,
      chat: true,
      playerList: false,
      chatBatchWindowMs: 15
    }
  });

  service.recordChatMessage({ serverDir: 'my_server', message: 'exampleplayer加入了游戏', sourceName: 'example_bot' });
  service.recordChatMessage({ serverDir: 'my_server', message: 'exampleplayer加入了游戏', sourceName: 'example_net' });
  await wait(40);

  service.recordChatMessage({ serverDir: 'my_server', message: 'exampleplayer加入了游戏', sourceName: 'example_bot' });
  await wait(40);

  const filePath = path.join(appRoot, 'BOTS', 'my_server', 'my_server_chat.log');
  const lines = fs.readFileSync(filePath, 'utf8').trim().split(/\r?\n/);

  assert.equal(lines.length, 2);
  assert.match(lines[0], /exampleplayer加入了游戏/);
  assert.doesNotMatch(lines[0], /\[example_bot\]/);
  assert.match(lines[1], /exampleplayer加入了游戏/);
  assert.match(lines[1], /\[example_bot\]/);
});

test('AggregateLogService tags single-bot chat messages with source name', async () => {
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'multibot-aggregate-chat-source-'));
  const service = new AggregateLogService({
    appRoot,
    config: {
      enabled: true,
      chat: true,
      playerList: false,
      chatBatchWindowMs: 10
    }
  });

  service.recordChatMessage({ serverDir: 'my_server', message: 'only one bot saw this', sourceName: 'example_bot' });
  await wait(30);

  const filePath = path.join(appRoot, 'BOTS', 'my_server', 'my_server_chat.log');
  const content = fs.readFileSync(filePath, 'utf8');

  assert.match(content, /\[example_bot\] only one bot saw this/);
});

test('AggregateLogService writes same chat text to different server files independently', async () => {
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'multibot-aggregate-chat-servers-'));
  const service = new AggregateLogService({
    appRoot,
    config: {
      enabled: true,
      chat: true,
      playerList: false,
      chatBatchWindowMs: 10
    }
  });

  service.recordChatMessage({ serverDir: 'my_server', message: 'same text', sourceName: 'example_bot' });
  service.recordChatMessage({ serverDir: 'another_server', message: 'same text', sourceName: 'example_net' });
  await wait(30);

  assert.match(fs.readFileSync(path.join(appRoot, 'BOTS', 'my_server', 'my_server_chat.log'), 'utf8'), /\[example_bot\] same text/);
  assert.match(fs.readFileSync(path.join(appRoot, 'BOTS', 'another_server', 'another_server_chat.log'), 'utf8'), /\[example_net\] same text/);
});

test('AggregateLogService unions player snapshots and removes stopped bots', async () => {
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'multibot-aggregate-players-'));
  const service = new AggregateLogService({
    appRoot,
    config: {
      enabled: true,
      chat: false,
      playerList: true,
      playerListIntervalMinutes: 1
    }
  });

  service.registerPlayerSnapshotProvider({
    serverDir: 'my_server',
    botId: 'alpha',
    getPlayers() {
      return ['example_player', 'BotSelf', 'example_trusted'];
    }
  });
  service.registerPlayerSnapshotProvider({
    serverDir: 'my_server',
    botId: 'beta',
    getPlayers() {
      return ['example_trusted', 'exampleplayer', 'BotSelf'];
    }
  });

  let result = service.flushPlayerList('my_server');
  assert.deepEqual(result.players, ['BotSelf', 'example_player', 'example_trusted', 'exampleplayer']);

  service.unregisterPlayerSnapshotProvider({
    serverDir: 'my_server',
    botId: 'beta'
  });

  result = service.flushPlayerList('my_server');
  assert.deepEqual(result.players, ['BotSelf', 'example_player', 'example_trusted']);
});

test('AggregateLogService automatic player list timer writes periodic union logs', async () => {
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'multibot-aggregate-players-timer-'));
  const service = new AggregateLogService({
    appRoot,
    config: {
      enabled: true,
      chat: false,
      playerList: true,
      playerListIntervalMinutes: 0.001
    }
  });

  service.registerPlayerSnapshotProvider({
    serverDir: 'my_server',
    botId: 'alpha',
    getPlayers() {
      return ['example_player', 'BotSelf'];
    }
  });

  service.start();
  await wait(90);
  service.stop('test_stop');

  const filePath = path.join(appRoot, 'BOTS', 'my_server', 'my_server_playerList.log');
  const lines = fs.readFileSync(filePath, 'utf8').trim().split(/\r?\n/);

  assert.ok(lines.length >= 1);
  assert.match(lines[0], /BotSelf, example_player/);
});
