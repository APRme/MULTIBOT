const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { MemoryLogService, normalizeIntervalMs, toMb } = require('../src/logging/MemoryLogService');

test('MemoryLogService writes JSONL samples with bot state summary', () => {
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'multibot-memory-log-'));
  const service = new MemoryLogService({
    appRoot,
    config: {
      enabled: true,
      filePath: './logs/custom-memory.log',
      intervalMs: 5000
    },
    botManager: {
      listBots() {
        return [
          { id: 'alpha', state: 'online', desiredRunning: true },
          { id: 'beta', state: 'starting', desiredRunning: false }
        ];
      },
      isMemoryDetailsEnabled() {
        return true;
      },
      getBotDiagnostics() {
        return [
          {
            id: 'alpha',
            state: 'online',
            desiredRunning: true,
            hasBot: true,
            worldColumns: 42,
            entities: 7,
            players: 3,
            pathfinderLoaded: true,
            physicsEnabled: true,
            client: {
              ended: false,
              state: 'play',
              socketDestroyed: false
            },
            chunkPackets: {
              total: {
                mapChunk: 50,
                unloadChunk: 8,
                updateLight: 49,
                chunkBatchStart: 2,
                chunkBatchFinished: 2
              },
              currentConnection: {
                mapChunk: 10,
                unloadChunk: 1,
                updateLight: 9,
                chunkBatchStart: 1,
                chunkBatchFinished: 1
              }
            },
            endedBotRefs: [
              {
                id: 'alpha',
                reason: 'end',
                endedAt: '2026-04-24T14:59:00.000Z',
                columnsAtEnd: 42,
                alive: {
                  bot: true,
                  world: true,
                  columns: true,
                  entities: true,
                  players: true,
                  client: true
                }
              }
            ]
          },
          {
            id: 'beta',
            state: 'starting',
            desiredRunning: false,
            hasBot: false,
            worldColumns: 0,
            entities: 0,
            players: 0,
            pathfinderLoaded: false,
            physicsEnabled: null,
            client: null,
            chunkPackets: null
          }
        ];
      }
    },
    memoryUsageProvider() {
      return {
        rss: 128 * 1024 * 1024,
        heapTotal: 64 * 1024 * 1024,
        heapUsed: 32 * 1024 * 1024,
        external: 8 * 1024 * 1024,
        arrayBuffers: 2 * 1024 * 1024
      };
    },
    timestampProvider() {
      return '2026-04-24T15:00:00.000Z';
    },
    pidProvider() {
      return 24680;
    }
  });

  const sample = service.appendSample('manual');
  const filePath = path.join(appRoot, 'logs', 'custom-memory.log');
  const lines = fs.readFileSync(filePath, 'utf8').trim().split(/\r?\n/);
  const parsed = JSON.parse(lines[0]);

  assert.equal(sample.rssMB, 128);
  assert.equal(parsed.timestamp, '2026-04-24T15:00:00.000Z');
  assert.equal(parsed.trigger, 'manual');
  assert.equal(parsed.pid, 24680);
  assert.equal(parsed.totalBots, 2);
  assert.equal(parsed.desiredRunningCount, 1);
  assert.deepEqual(parsed.stateCounts, {
    online: 1,
    starting: 1
  });
  assert.deepEqual(parsed.botStates, ['alpha:online', 'beta:starting']);
  assert.deepEqual(parsed.desiredRunningIds, ['alpha']);
  assert.deepEqual(parsed.diagnosticTotals, {
    worldColumns: 42,
    entities: 7,
    players: 3,
    liveBotObjects: 1,
    pathfinderLoaded: 1
  });
  assert.equal(parsed.botMemory[0].id, 'alpha');
  assert.equal(parsed.botMemory[0].worldColumns, 42);
  assert.equal(parsed.botMemory[0].chunkPackets.total.mapChunk, 50);
  assert.equal(parsed.botMemory[1].id, 'beta');
  assert.equal(parsed.botMemory[1].hasBot, false);
  assert.equal(parsed.endedBotRefs.length, 1);
  assert.equal(parsed.endedBotRefs[0].id, 'alpha');
  assert.equal(parsed.endedBotRefs[0].alive.columns, true);
});

test('MemoryLogService omits bot diagnostics when memory details are disabled', () => {
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'multibot-memory-log-disabled-'));
  let diagnosticsCalled = false;
  const service = new MemoryLogService({
    appRoot,
    config: {
      enabled: true
    },
    botManager: {
      listBots() {
        return [
          { id: 'alpha', state: 'online', desiredRunning: true }
        ];
      },
      isMemoryDetailsEnabled() {
        return false;
      },
      getBotDiagnostics() {
        diagnosticsCalled = true;
        return [];
      }
    },
    memoryUsageProvider() {
      return {};
    },
    timestampProvider() {
      return '2026-04-24T15:05:00.000Z';
    }
  });

  const sample = service.buildSample('manual');

  assert.equal(diagnosticsCalled, false);
  assert.deepEqual(sample.botStates, ['alpha:online']);
  assert.deepEqual(sample.diagnosticTotals, {
    worldColumns: 0,
    entities: 0,
    players: 0,
    liveBotObjects: 0,
    pathfinderLoaded: 0
  });
  assert.deepEqual(sample.endedBotRefs, []);
  assert.deepEqual(sample.botMemory, []);
});

test('MemoryLogService start and stop emit boundary samples when enabled', async () => {
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'multibot-memory-log-start-'));
  const service = new MemoryLogService({
    appRoot,
    config: {
      enabled: true,
      intervalMs: 1000
    },
    botManager: {
      listBots() {
        return [];
      }
    },
    timestampProvider() {
      return '2026-04-24T15:10:00.000Z';
    }
  });

  service.start();
  service.stop('manual_stop');

  const filePath = path.join(appRoot, 'logs', 'memory-monitor.log');
  const lines = fs.readFileSync(filePath, 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line));

  assert.equal(lines[0].trigger, 'start');
  assert.equal(lines[1].trigger, 'stop:manual_stop');
});

test('MemoryLogService helpers normalize sizes and interval', () => {
  assert.equal(toMb(10 * 1024 * 1024), 10);
  assert.equal(toMb(undefined), 0);
  assert.equal(normalizeIntervalMs(500, 10000), 10000);
  assert.equal(normalizeIntervalMs(15000, 10000), 15000);
});
