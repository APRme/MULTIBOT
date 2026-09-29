const test = require('node:test');
require('./helpers/tempDir'); // 测试临时目录统一重定向到工作区 .temp/test-run/
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { NotificationWatcher } = require('../src/runtime/NotificationWatcher');

function createNotifierStub(options = {}) {
  const events = [];
  const recoveries = [];
  const pending = new Set();

  return {
    events,
    recoveries,
    pending,
    isEnabled: () => options.enabled !== false,
    isEventsEnabled: () => options.eventsEnabled !== false,
    getEventsConfig: () => Object.assign({}, options.eventsConfig || {}),
    getEventConfig: (type) => Object.assign(
      { enabled: true, cooldownMs: 0 },
      options.overrides && options.overrides[type] ? options.overrides[type] : {}
    ),
    notifyEvent(payload) {
      events.push(payload);
      pending.add(payload.key);
      return Promise.resolve({ sent: true, ok: true, reason: null, folded: 0, suppressed: 0 });
    },
    notifyRecovery(payload) {
      recoveries.push(payload);
      pending.delete(payload.key);
      return Promise.resolve({ sent: true, reason: null, durationMs: 1 });
    },
    hasPendingFailure: (key) => pending.has(key),
    clearEventState: (key) => pending.delete(key)
  };
}

function createWatcher(options = {}) {
  const notifier = options.notifier || createNotifierStub(options.notifierOptions || {});
  const runtimes = new Map();
  (options.runtimes || []).forEach((runtime) => runtimes.set(runtime.config.id, runtime));

  const watcher = new NotificationWatcher({
    botManager: { runtimes },
    notifier,
    appRoot: options.appRoot || process.cwd(),
    now: options.now
  });

  return { watcher, notifier, runtimes };
}

function createRuntime(overrides = {}) {
  const config = Object.assign({ id: 'alpha', host: '127.0.0.1', port: 25565 }, overrides.config || {});
  return Object.assign({
    config,
    state: 'online',
    desiredRunning: true,
    openAuthPermanentFailure: false,
    restartScheduleExhausted: false,
    restartTimer: null,
    lastSpawnAt: null,
    lastEndAt: null,
    lastFailureAt: null,
    pendingRestartScheduledAt: null,
    lastError: null,
    lastFailure: null
  }, overrides.runtime || {});
}

test('NotificationWatcher stays silent while the server has an online bot', () => {
  const { watcher, notifier } = createWatcher({
    runtimes: [
      createRuntime({ config: { id: 'alpha' } }),
      createRuntime({ config: { id: 'beta' } })
    ]
  });

  watcher.checkServersOffline();

  assert.equal(notifier.events.length, 0);
  assert.equal(notifier.recoveries.length, 0);
});

test('NotificationWatcher reports an all-offline server only after offlineMs', async () => {
  let clock = 1000000;
  const offlineRuntime = () => createRuntime({
    config: { id: 'alpha', host: 'mc.example.com', port: 25565 },
    runtime: { state: 'waiting_restart' }
  });

  const { watcher, notifier } = createWatcher({
    now: () => clock,
    runtimes: [
      offlineRuntime(),
      createRuntime({ config: { id: 'beta', host: 'mc.example.com', port: 25565 }, runtime: { state: 'stopped' } })
    ],
    notifierOptions: { overrides: { serverAllOffline: { offlineMs: 120000, minBots: 2, enabled: true } } }
  });

  watcher.checkServersOffline();
  assert.equal(notifier.events.length, 0, '刚开始离线不推');

  clock += 60000;
  watcher.checkServersOffline();
  assert.equal(notifier.events.length, 0, '不足 offlineMs 不推');

  clock += 120000;
  watcher.checkServersOffline();
  assert.equal(notifier.events.length, 1);
  assert.equal(notifier.events[0].type, 'serverAllOffline');
  assert.equal(notifier.events[0].key, 'server:offline:mc.example.com:25565');
  assert.equal(notifier.events[0].severity, 'critical');
  assert.match(notifier.events[0].body, /2 个 bot 全部离线/);
});

test('NotificationWatcher ignores single-bot servers for the all-offline event', () => {
  let clock = 1000000;
  const { watcher, notifier } = createWatcher({
    now: () => clock,
    runtimes: [createRuntime({ runtime: { state: 'stopped' } })],
    notifierOptions: { overrides: { serverAllOffline: { offlineMs: 1000, minBots: 2, enabled: true } } }
  });

  clock += 600000;
  watcher.checkServersOffline();
  assert.equal(notifier.events.length, 0);
});

test('NotificationWatcher reports server recovery once a bot is back online', async () => {
  let clock = 1000000;
  const alpha = createRuntime({ config: { id: 'alpha' }, runtime: { state: 'stopped' } });
  const beta = createRuntime({ config: { id: 'beta' }, runtime: { state: 'stopped' } });

  const { watcher, notifier } = createWatcher({
    now: () => clock,
    runtimes: [alpha, beta],
    notifierOptions: { overrides: { serverAllOffline: { offlineMs: 1000, minBots: 2, enabled: true } } }
  });

  clock += 60000;
  watcher.checkServersOffline();
  assert.equal(notifier.events.length, 0, '首次观察只记录起点');

  clock += 60000;
  watcher.checkServersOffline();
  assert.equal(notifier.events.length, 1);

  alpha.state = 'online';
  watcher.checkServersOffline();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(notifier.recoveries.length, 1);
  assert.equal(notifier.recoveries[0].key, 'server:offline:127.0.0.1:25565');
  assert.match(notifier.recoveries[0].body, /已恢复/);
});

test('NotificationWatcher reports a bot stuck without restart activity for 30 minutes', () => {
  const now = 1000000000000;
  const stuck = createRuntime({
    config: { id: 'APR_m' },
    runtime: {
      state: 'starting',
      lastSpawnAt: new Date(now - 3600000).toISOString(),
      lastError: 'createBot failed'
    }
  });

  const { watcher, notifier } = createWatcher({
    now: () => now,
    runtimes: [stuck],
    notifierOptions: { overrides: { botStuck: { stuckMs: 1800000, enabled: true } } }
  });

  watcher.checkStuckBots();

  assert.equal(notifier.events.length, 1);
  assert.equal(notifier.events[0].type, 'botStuck');
  assert.equal(notifier.events[0].key, 'bot:stuck:APR_m');
  assert.equal(notifier.events[0].severity, 'critical');
  assert.match(notifier.events[0].body, /state=starting/);
  assert.match(notifier.events[0].body, /createBot failed/);
  assert.match(notifier.events[0].body, /已 60 分钟未上线/, '文案按最近一次活动时间算, 不按首次观察');
});

test('NotificationWatcher tick interval comes from events config with a 10s floor', () => {
  const fromConfig = createWatcher({
    runtimes: [],
    notifierOptions: { eventsConfig: { checkIntervalMs: 30000 } }
  });
  assert.equal(fromConfig.watcher.checkIntervalMs, 30000);

  const floored = createWatcher({
    runtimes: [],
    notifierOptions: { eventsConfig: { checkIntervalMs: 1000 } }
  });
  assert.equal(floored.watcher.checkIntervalMs, 10000, '过小的值被下限保护');

  const fallback = createWatcher({ runtimes: [] });
  assert.equal(fallback.watcher.checkIntervalMs, 60000);
});

test('NotificationWatcher does not report stuck bots that are online, stopped or scheduled', () => {
  const now = 1000000000000;
  const old = new Date(now - 7200000).toISOString();
  const { watcher, notifier } = createWatcher({
    now: () => now,
    runtimes: [
      createRuntime({ config: { id: 'online-bot' }, runtime: { state: 'online', lastSpawnAt: old } }),
      createRuntime({ config: { id: 'intentional-stop' }, runtime: { state: 'stopped', desiredRunning: false, lastSpawnAt: old } }),
      createRuntime({ config: { id: 'exhausted' }, runtime: { state: 'stopped', restartScheduleExhausted: true, lastSpawnAt: old } }),
      createRuntime({ config: { id: 'permanent-auth' }, runtime: { state: 'stopped', openAuthPermanentFailure: true, lastSpawnAt: old } }),
      createRuntime({ config: { id: 'scheduled' }, runtime: { state: 'waiting_restart', restartTimer: {}, lastSpawnAt: old } }),
      createRuntime({ config: { id: 'recent' }, runtime: { state: 'starting', lastSpawnAt: new Date(now - 60000).toISOString() } })
    ],
    notifierOptions: { overrides: { botStuck: { stuckMs: 1800000, enabled: true } } }
  });

  watcher.checkStuckBots();
  assert.equal(notifier.events.length, 0);
});

test('NotificationWatcher clears the stuck state once the bot comes back online', () => {
  const now = 1000000000000;
  const stuck = createRuntime({
    config: { id: 'alpha' },
    runtime: { state: 'starting', lastSpawnAt: new Date(now - 3600000).toISOString() }
  });

  const { watcher, notifier } = createWatcher({
    now: () => now,
    runtimes: [stuck],
    notifierOptions: { overrides: { botStuck: { stuckMs: 1800000, enabled: true } } }
  });

  watcher.checkStuckBots();
  assert.equal(notifier.events.length, 1);
  assert.equal(watcher.stuckSince.has('alpha'), true);

  stuck.state = 'online';
  watcher.checkStuckBots();
  assert.equal(watcher.stuckSince.has('alpha'), false);
  assert.equal(notifier.events.length, 1, '恢复由 BotRuntime 处理, 巡检器只清状态');
});

test('NotificationWatcher reports oversized log files once per scan interval', () => {
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'multibot-watcher-logs-'));
  fs.mkdirSync(path.join(appRoot, 'logs'), { recursive: true });
  const bigLog = path.join(appRoot, 'logs', 'memory-monitor.log');
  fs.writeFileSync(bigLog, Buffer.alloc(2048));
  fs.writeFileSync(path.join(appRoot, 'logs', 'small.log'), 'tiny');

  let clock = 1000000;
  const { watcher, notifier } = createWatcher({
    appRoot,
    now: () => clock,
    runtimes: [],
    notifierOptions: { overrides: { logFileTooLarge: { maxBytes: 1024, checkIntervalMs: 3600000, enabled: true } } }
  });

  watcher.checkLogSizes();
  assert.equal(notifier.events.length, 1);
  assert.equal(notifier.events[0].type, 'logFileTooLarge');
  assert.equal(notifier.events[0].key, 'disk:log:memory-monitor.log');
  assert.equal(notifier.events[0].severity, 'active');
  assert.match(notifier.events[0].body, /已 0MB|已 1MB/);

  clock += 60000;
  watcher.checkLogSizes();
  assert.equal(notifier.events.length, 1, '扫描间隔内不重复扫描');

  clock += 3600000;
  watcher.checkLogSizes();
  assert.equal(notifier.events.length, 2);

  fs.writeFileSync(path.join(appRoot, 'logs', 'small.log'), 'tiny');
});

test('NotificationWatcher tick is a no-op when notifications are disabled', () => {
  const { watcher, notifier } = createWatcher({
    runtimes: [createRuntime({ runtime: { state: 'stopped' } })],
    notifierOptions: { enabled: false, overrides: { botStuck: { stuckMs: 1, enabled: true } } }
  });

  watcher.tick();
  assert.equal(notifier.events.length, 0);
});

test('NotificationWatcher start and stop manage the tick timer', () => {
  const { watcher } = createWatcher({ runtimes: [] });

  watcher.start();
  const timer = watcher.tickTimer;
  assert.ok(timer);
  watcher.start();
  assert.equal(watcher.tickTimer, timer, '重复 start 不重复创建定时器');

  watcher.stop();
  assert.equal(watcher.tickTimer, null);
  assert.equal(watcher.serverOfflineSince.size, 0);
  assert.equal(watcher.stuckSince.size, 0);
});
