const test = require('node:test');
require('./helpers/tempDir'); // 测试临时目录统一重定向到工作区 .temp/test-run/
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const EventEmitter = require('events');
const { BlockBreakFeature } = require('../src/features/blockBreak/BlockBreakFeature');

function createPosition(x, y, z) {
  return {
    x,
    y,
    z,
    distanceTo(other) {
      const dx = x - other.x;
      const dy = y - other.y;
      const dz = z - other.z;
      return Math.sqrt((dx * dx) + (dy * dy) + (dz * dz));
    }
  };
}

function createLogger() {
  const entries = [];
  return {
    warn(...parts) {
      entries.push({ level: 'warn', message: parts.join(' ') });
    },
    info(...parts) {
      entries.push({ level: 'info', message: parts.join(' ') });
    },
    get entries() {
      return entries;
    }
  };
}

function createBot() {
  const bot = new EventEmitter();
  const chatMessages = [];
  bot.chat = (message) => {
    chatMessages.push(message);
  };
  bot.players = {
    Admin: {
      username: 'Admin',
      entity: {
        position: createPosition(2, 64, 0)
      }
    },
    Griefer: {
      username: 'Griefer',
      entity: {
        position: createPosition(11, 64, 10)
      }
    }
  };
  Object.defineProperty(bot, 'chatMessages', {
    get() {
      return chatMessages;
    }
  });
  return bot;
}

test('BlockBreakFeature logs and alerts trusted players', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multibot-block-break-'));
  const logger = createLogger();
  const bot = createBot();
  const feature = new BlockBreakFeature({
    logger,
    paths: {
      accountDir: tempDir
    },
    config: {
      enabled: true,
      alertTrustedPlayers: ['Admin'],
      logToConsole: true,
      logToFile: true,
      logFilePath: './block-break.log',
      monitoredBlocks: ['stone']
    }
  });

  feature.attach(bot);
  bot.emit('blockBreakProgressObserved', {
    name: 'stone',
    position: createPosition(10, 64, 10)
  }, 2, {
    username: 'Griefer'
  });
  bot.emit('blockUpdate', {
    name: 'stone',
    position: createPosition(12, 64, 10)
  }, {
    name: 'air',
    position: createPosition(12, 64, 10)
  });
  feature.stop();

  const logFilePath = path.join(tempDir, 'block-break.log');
  const logText = fs.readFileSync(logFilePath, 'utf8');

  assert.equal(bot.chatMessages.length, 2);
  assert.match(bot.chatMessages[0], /\/tell Admin/);
  assert.match(logText, /正在破坏 stone/);
  assert.match(logText, /方块 stone 被破坏/);
  assert.ok(logger.entries.length >= 2);
});

test('BlockBreakFeature ignores creative players when configured', () => {
  const logger = createLogger();
  const bot = createBot();
  bot.players.Builder = {
    username: 'Builder',
    gamemode: 1,
    entity: {
      position: createPosition(10, 64, 10)
    }
  };
  const feature = new BlockBreakFeature({
    logger,
    config: {
      enabled: true,
      excludeCreativeMode: true,
      alertTrustedPlayers: ['Admin'],
      logToConsole: true,
      logToFile: false,
      monitoredBlocks: ['stone']
    }
  });

  feature.attach(bot);
  bot.emit('blockBreakProgressObserved', {
    name: 'stone',
    position: createPosition(10, 64, 10)
  }, 1, {
    username: 'Builder'
  });
  feature.stop();

  assert.equal(bot.chatMessages.length, 0);
  assert.equal(logger.entries.length, 0);
});

test('BlockBreakFeature only subscribes to blockUpdate when enabled', () => {
  const disabledBot = createBot();
  const disabled = new BlockBreakFeature({
    logger: createLogger(),
    config: {
      enabled: false,
      logToConsole: true,
      logToFile: false
    }
  });
  disabled.attach(disabledBot);
  assert.equal(disabledBot.listenerCount('blockUpdate'), 0);
  assert.equal(disabledBot.listenerCount('blockBreakProgressObserved'), 1);
  assert.equal(disabledBot.listenerCount('blockBreakProgressEnd'), 1);
  disabled.stop();

  const enabledBot = createBot();
  const enabled = new BlockBreakFeature({
    logger: createLogger(),
    config: {
      enabled: true,
      logToConsole: true,
      logToFile: false
    }
  });
  enabled.attach(enabledBot);
  assert.equal(enabledBot.listenerCount('blockUpdate'), 1);
  enabled.stop();
  assert.equal(enabledBot.listenerCount('blockUpdate'), 0);
});
