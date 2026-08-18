const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const EventEmitter = require('events');
const { MonitoringFeature } = require('../src/features/monitoring/MonitoringFeature');

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
    info(...parts) {
      entries.push({ level: 'info', message: parts.join(' ') });
    },
    warn(...parts) {
      entries.push({ level: 'warn', message: parts.join(' ') });
    },
    error(...parts) {
      entries.push({ level: 'error', message: parts.join(' ') });
    },
    get entries() {
      return entries;
    }
  };
}

function createBot(entities = {}) {
  const bot = new EventEmitter();
  const chats = [];
  bot.entity = {
    uuid: 'bot-uuid',
    position: createPosition(0, 64, 0)
  };
  bot.entities = {
    self: bot.entity,
    ...entities
  };
  bot.chat = (message) => {
    chats.push(message);
  };
  Object.defineProperty(bot, 'chatMessages', {
    get() {
      return chats;
    }
  });
  return bot;
}

test('MonitoringFeature reports new matching entities and persists uuids', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multibot-monitoring-'));
  const logger = createLogger();
  const foundEntitiesPath = path.join(tempDir, 'found.txt');
  const bot = createBot({
    trader: {
      uuid: 'uuid-trader',
      type: 'mob',
      name: 'wandering_trader',
      displayName: '流浪商人',
      health: 20,
      position: createPosition(3, 64, 4)
    },
    zombie: {
      uuid: 'uuid-zombie',
      type: 'mob',
      name: 'zombie',
      health: 20,
      position: createPosition(4, 64, 5)
    }
  });
  const feature = new MonitoringFeature({
    logger,
    paths: { foundEntitiesPath },
    config: {
      enabled: true,
      intervalSeconds: 10,
      targetTypes: ['minecraft:wandering_trader']
    }
  });

  feature.attach(bot);
  bot.emit('spawn');
  feature.stop();

  const fileText = fs.readFileSync(foundEntitiesPath, 'utf8');
  assert.deepEqual(bot.chatMessages, ['实体刷新: wandering_trader 坐标: X=3.0 Y=64.0 Z=4.0']);
  assert.match(fileText, /uuid-trader/);
  assert.doesNotMatch(fileText, /uuid-zombie/);
  assert.ok(logger.entries.some((entry) => entry.message.includes('发现新实体 wandering_trader')));
});

test('MonitoringFeature dedupes found.txt and skips already reported uuids', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multibot-monitoring-dedupe-'));
  const logger = createLogger();
  const foundEntitiesPath = path.join(tempDir, 'found.txt');
  fs.writeFileSync(foundEntitiesPath, 'uuid-known\nuuid-known\n', 'utf8');

  const bot = createBot({
    known: {
      uuid: 'uuid-known',
      type: 'mob',
      name: 'wandering_trader',
      health: 20,
      position: createPosition(2, 64, 2)
    },
    fresh: {
      uuid: 'uuid-fresh',
      type: 'mob',
      name: 'trader_llama',
      health: 20,
      position: createPosition(5, 64, 5)
    }
  });
  const feature = new MonitoringFeature({
    logger,
    paths: { foundEntitiesPath },
    config: {
      enabled: true,
      intervalSeconds: 10,
      targetTypes: ['minecraft:wandering_trader', 'minecraft:trader_llama']
    }
  });

  feature.attach(bot);
  bot.emit('spawn');
  feature.stop();

  const fileLines = fs.readFileSync(foundEntitiesPath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean);

  assert.deepEqual(bot.chatMessages, ['实体刷新: trader_llama 坐标: X=5.0 Y=64.0 Z=5.0']);
  assert.deepEqual(fileLines.sort(), ['uuid-fresh', 'uuid-known']);
  assert.ok(logger.entries.some((entry) => entry.level === 'warn' && entry.message.includes('deduped found.txt')));
});
