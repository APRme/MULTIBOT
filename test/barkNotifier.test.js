const test = require('node:test');
require('./helpers/tempDir'); // 测试临时目录统一重定向到工作区 .temp/test-run/
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { BarkNotifier } = require('../src/notifications/bark/BarkNotifier');

function makeFakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
  };
  return child;
}

function createNotifier(config, hooks = {}) {
  const calls = [];
  const child = hooks.child || makeFakeChild();
  const appRoot = hooks.appRoot || fs.mkdtempSync(path.join(os.tmpdir(), 'multibot-bark-'));
  const notifier = new BarkNotifier({
    config,
    appRoot,
    platform: hooks.platform || 'win32',
    retryDelayMs: hooks.retryDelayMs,
    spawnFn: (command, args, options) => {
      calls.push({ command, args, options });
      if (typeof hooks.spawnResults === 'function') {
        return hooks.spawnResults(calls.length);
      }
      return child;
    }
  });
  return { notifier, calls, child, appRoot };
}

function readBarkLog(appRoot, logPath = './logs/bark.log') {
  const filePath = path.isAbsolute(logPath) ? logPath : path.join(appRoot, logPath);
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
}

// 硬性约束(AGENTS.md): .ps1 必须是 UTF-8 with BOM, 否则 Windows PowerShell 5.1 会按 ANSI
// 解码含中文的脚本并报解析错误(如 MissingArrayIndexExpression)。编辑后务必保持该断言通过。
test('bark-push.ps1 is stored as UTF-8 with BOM exactly once', () => {
  const scriptPath = path.join(__dirname, '..', 'src', 'notifications', 'bark', 'bark-push.ps1');
  const bytes = fs.readFileSync(scriptPath);

  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'bark-push.ps1 缺少 UTF-8 BOM');
  assert.notDeepEqual([...bytes.subarray(3, 6)], [0xef, 0xbb, 0xbf], 'bark-push.ps1 出现重复 BOM');
  assert.equal(bytes.subarray(3).includes(0x00), false, 'bark-push.ps1 含 NUL 字节(编码已损坏)');
});

test('BarkNotifier does not spawn when disabled', async () => {
  const { notifier, calls, appRoot } = createNotifier({ enabled: false });
  assert.equal(notifier.isEnabled(), false);
  const result = await notifier.notify({ title: 't', body: 'b', label: 'alpha' });
  assert.deepEqual(result, { ok: false, reason: 'disabled', elapsedMs: 0 });
  assert.equal(calls.length, 0);
  assert.equal(readBarkLog(appRoot), '');
});

test('BarkNotifier skips on non-windows platform', async () => {
  const { notifier, calls } = createNotifier({ enabled: true }, { platform: 'linux' });
  const result = await notifier.notify({ title: 't', body: 'b', label: 'alpha' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'non-windows');
  assert.equal(calls.length, 0);
});

test('BarkNotifier spawns powershell with resolved paths and logs OK line', async () => {
  const { notifier, calls, child, appRoot } = createNotifier({
    enabled: true,
    scriptPath: './src/notifications/bark/bark-push.ps1',
    envPath: './.env',
    group: 'mc',
    timeoutMs: 5000
  });

  const pending = notifier.notify({ title: 'MULTIBOT Downdetector', body: 'alpha 认证403', label: 'alpha' });
  await new Promise((resolve) => setImmediate(resolve));
  child.stdout.emit('data', '[OK/https] sound= crypto= code=200 success elapsed=0.5s');
  child.emit('close', 0);
  const result = await pending;

  assert.equal(result.ok, true);
  assert.equal(result.reason, null);
  assert.ok(Number.isInteger(result.elapsedMs));

  const args = calls[0].args;
  assert.equal(calls[0].command, 'powershell.exe');
  assert.equal(args[args.indexOf('-File') + 1], path.resolve(appRoot, './src/notifications/bark/bark-push.ps1'));
  assert.equal(args[args.indexOf('-EnvPath') + 1], path.resolve(appRoot, './.env'));
  assert.equal(args[args.indexOf('-Title') + 1], 'MULTIBOT Downdetector');
  assert.equal(args[args.indexOf('-Body') + 1], 'alpha 认证403');
  assert.equal(args[args.indexOf('-Group') + 1], 'mc');
  assert.equal(calls[0].options.windowsHide, true);

  const log = readBarkLog(appRoot);
  assert.match(log, /\[OK\] label=alpha elapsed=\d+ms/);
});

test('BarkNotifier parses desensitized failure reason and writes bark.log', async () => {
  const { notifier, child, appRoot } = createNotifier({ enabled: true, timeoutMs: 5000 });
  const pending = notifier.notify({ title: 't', body: 'b', label: 'APR_m' });
  await new Promise((resolve) => setImmediate(resolve));
  child.stdout.emit('data', '[FAIL] reason=timeout elapsed=20.0s sound= crypto=');
  child.emit('close', 0);
  const result = await pending;

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'timeout');
  assert.match(readBarkLog(appRoot), /\[FAIL\] label=APR_m reason=timeout elapsed=\d+ms/);
});

test('BarkNotifier falls back to unknown reason when script gives none', async () => {
  const { notifier, child, appRoot } = createNotifier({ enabled: true, timeoutMs: 5000 });
  const pending = notifier.notify({ title: 't', body: 'b', label: 'beta' });
  await new Promise((resolve) => setImmediate(resolve));
  child.stdout.emit('data', '[FAIL] something broke');
  child.emit('close', 0);
  const result = await pending;

  assert.equal(result.reason, 'unknown');
  assert.match(readBarkLog(appRoot), /reason=unknown/);
});

test('BarkNotifier kills child and records wrapper-timeout', async () => {
  const { notifier, child, appRoot } = createNotifier({ enabled: true, timeoutMs: 10 });
  const result = await notifier.notify({ title: 't', body: 'b', label: 'gamma' });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'wrapper-timeout');
  assert.equal(child.killed, true);
  assert.match(readBarkLog(appRoot), /reason=wrapper-timeout/);
});

test('BarkNotifier honors custom logPath', async () => {
  const { notifier, child, appRoot } = createNotifier({
    enabled: true,
    timeoutMs: 5000,
    logPath: './custom/bark-custom.log'
  });
  const pending = notifier.notify({ title: 't', body: 'b', label: 'delta' });
  await new Promise((resolve) => setImmediate(resolve));
  child.stdout.emit('data', '[OK/https] code=200');
  child.emit('close', 0);
  await pending;

  assert.match(readBarkLog(appRoot, './custom/bark-custom.log'), /\[OK\] label=delta/);
  assert.equal(readBarkLog(appRoot, './logs/bark.log'), '');
});

test('BarkNotifier suppresses notification attempts below the threshold', () => {
  const notifier = new BarkNotifier({ config: { enabled: true }, appRoot: process.cwd() });
  assert.equal(notifier.getMaxEventStates(), 2000);

  const custom = new BarkNotifier({ config: { enabled: true, events: { maxEventStates: 5 } }, appRoot: process.cwd() });
  assert.equal(custom.getMaxEventStates(), 5);
});

test('BarkNotifier caps event state growth and drops the least recently active keys', () => {
  let clock = 1000000;
  const notifier = new BarkNotifier({
    config: { enabled: true, events: { maxEventStates: 3 } },
    appRoot: process.cwd(),
    now: () => clock
  });

  notifier.getEventState('oldest').lastAttemptAt = clock;
  clock += 1000;
  notifier.getEventState('middle').lastAttemptAt = clock;
  clock += 1000;
  notifier.getEventState('newest').lastAttemptAt = clock;

  clock += 1000;
  notifier.getEventState('brand-new');

  assert.equal(notifier.eventStates.size, 3, '插入后不超过上限');
  assert.equal(notifier.eventStates.has('oldest'), false, '最久未活动的被丢弃');
  assert.equal(notifier.eventStates.has('brand-new'), true);
});

test('BarkNotifier prunes event states idle for more than 24 hours', () => {
  let clock = 1000000;
  const notifier = new BarkNotifier({
    config: { enabled: true, events: { maxEventStates: 100 } },
    appRoot: process.cwd(),
    now: () => clock
  });

  notifier.getEventState('stale').lastAttemptAt = clock;
  notifier.getEventState('fresh').lastAttemptAt = clock;

  clock += 25 * 3600000;
  const dropped = notifier.pruneEventStates();

  assert.equal(dropped, 2);
  assert.equal(notifier.eventStates.size, 0);
});

test('BarkNotifier throttles [SKIP] lines by time and count', async () => {
  const clock = { value: 1000000 };
  const { notifier, children, appRoot } = createEventNotifier();
  notifier.now = () => clock.value;

  const first = notifier.notifyEvent({ type: 'botStuck', key: 'bot:stuck:alpha', body: '卡住', label: 'alpha' });
  await new Promise((resolve) => setImmediate(resolve));
  completeAttempt(children[0], '[OK/https] code=200');
  await first;

  // 高频(时钟不动): 25 次抑制只写第一行, 避免"每 10 次一行"在请求路径上疯狂同步写盘
  for (let i = 0; i < 25; i += 1) {
    const suppressed = await notifier.notifyEvent({ type: 'botStuck', key: 'bot:stuck:alpha', body: '卡住', label: 'alpha' });
    assert.equal(suppressed.reason, 'cooldown');
  }
  let skipLines = readBarkLog(appRoot).split('\n').filter((line) => line.includes('[SKIP]'));
  assert.equal(skipLines.length, 1, '同一分钟内只留第一行');
  assert.match(skipLines[0], /suppressed=1$/);

  // 低频(每跳间隔 1 分钟, 次数到 10 的整数倍): 才会继续留痕
  for (let i = 0; i < 9; i += 1) {
    clock.value += 60000;
    await notifier.notifyEvent({ type: 'botStuck', key: 'bot:stuck:alpha', body: '卡住', label: 'alpha' });
  }
  skipLines = readBarkLog(appRoot).split('\n').filter((line) => line.includes('[SKIP]'));
  assert.equal(skipLines.length, 2, '第 30 次抑制(时间已过 60s 且次数为 10 的整数倍)留一行');
  assert.match(skipLines[1], /suppressed=30$/);
});

test('BarkNotifier.notifyRecovery keeps the cooldown clock so re-alerts are throttled', async () => {
  let clock = 1000000;
  const { notifier, children, appRoot } = createEventNotifier({}, {
    spawnResults: () => {
      const child = makeFakeChild();
      children.push(child);
      return child;
    }
  });
  notifier.now = () => clock;

  const failure = notifier.notifyEvent({ type: 'botStuck', key: 'bot:stuck:alpha', body: '卡住', label: 'alpha' });
  await new Promise((resolve) => setImmediate(resolve));
  completeAttempt(children[0], '[OK/https] code=200');
  await failure;

  const recovery = notifier.notifyRecovery({ type: 'botStuck', key: 'bot:stuck:alpha', body: '已恢复', label: 'alpha' });
  await new Promise((resolve) => setImmediate(resolve));
  completeAttempt(children[1], '[OK/https] code=200');
  assert.equal((await recovery).sent, true);

  // 恢复后同一 key 的故障状态已清(可以再报警/再配对恢复), 但冷却时钟保留 -> 冷却期内不重复告警
  const tooSoon = await notifier.notifyEvent({ type: 'botStuck', key: 'bot:stuck:alpha', body: '又卡住', label: 'alpha' });
  assert.equal(tooSoon.sent, false);
  assert.equal(tooSoon.reason, 'cooldown');

  clock += 1800000;
  const afterCooldown = notifier.notifyEvent({ type: 'botStuck', key: 'bot:stuck:alpha', body: '又卡住', label: 'alpha' });
  await new Promise((resolve) => setImmediate(resolve));
  completeAttempt(children[2], '[OK/https] code=200');
  assert.equal((await afterCooldown).sent, true);
  assert.match(readBarkLog(appRoot), /key=bot:stuck:alpha recovery/);
});

test('BarkNotifier event state pruning keeps the injected event state working', async () => {
  const notifier = new BarkNotifier({
    config: { enabled: true, events: { maxEventStates: 2, botStuck: { cooldownMs: 0 } } },
    appRoot: process.cwd(),
    spawnFn: () => makeFakeChild(),
    platform: 'linux'
  });

  notifier.getEventState('a');
  notifier.getEventState('b');
  notifier.getEventState('c');

  assert.equal(notifier.eventStates.size, 2);
});

test('BarkNotifier getCooldownMs falls back to default and honors zero', () => {
  const defaults = createNotifier({ enabled: true }).notifier;
  assert.equal(defaults.getCooldownMs(), 600000);

  const zero = createNotifier({ enabled: true, cooldownMs: 0 }).notifier;
  assert.equal(zero.getCooldownMs(), 0);

  const custom = createNotifier({ enabled: true, cooldownMs: 1000 }).notifier;
  assert.equal(custom.getCooldownMs(), 1000);
});

test('BarkNotifier does not retry when retryOnce is not enabled', async () => {
  const children = [];
  const { notifier, calls, appRoot } = createNotifier(
    { enabled: true, timeoutMs: 5000 },
    {
      retryDelayMs: 1,
      spawnResults: () => {
        const child = makeFakeChild();
        children.push(child);
        return child;
      }
    }
  );

  const pending = notifier.notify({ title: 't', body: 'b', label: 'alpha' });
  await new Promise((resolve) => setImmediate(resolve));
  children[0].stdout.emit('data', '[FAIL] reason=timeout elapsed=20.0s');
  children[0].emit('close', 0);
  const result = await pending;

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'timeout');
  assert.equal(calls.length, 1);
  assert.equal(notifier.getMaxAttempts(), 1);
  const lines = readBarkLog(appRoot).trim().split('\n');
  assert.equal(lines.length, 1);
  assert.match(lines[0], /\[FAIL\] label=alpha reason=timeout elapsed=\d+ms$/);
});

test('BarkNotifier retryOnce resends once after a failure and records both attempts', async () => {
  const children = [];
  const logs = [];
  const { notifier, calls, appRoot } = createNotifier(
    { enabled: true, timeoutMs: 5000, retryOnce: true },
    {
      retryDelayMs: 1,
      spawnResults: () => {
        const child = makeFakeChild();
        children.push(child);
        return child;
      }
    }
  );
  notifier.logger = {
    info: (message) => logs.push(message),
    warn: (message) => logs.push(message)
  };

  assert.equal(notifier.getMaxAttempts(), 2);

  const pending = notifier.notify({ title: 't', body: 'b', label: 'APR_m' });
  await new Promise((resolve) => setImmediate(resolve));
  children[0].stdout.emit('data', '[FAIL] reason=timeout elapsed=20.0s');
  children[0].emit('close', 0);

  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(calls.length, 2);
  children[1].stdout.emit('data', '[OK/https] code=200 success elapsed=0.5s');
  children[1].emit('close', 0);
  const result = await pending;

  assert.equal(result.ok, true);
  assert.equal(result.reason, null);
  assert.ok(logs.some((message) => message.includes('[NOTIFY] bark push retry scheduled attempt=2/2 reason=timeout')));

  const lines = readBarkLog(appRoot).trim().split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /\[FAIL\] label=APR_m reason=timeout elapsed=\d+ms attempt=1\/2$/);
  assert.match(lines[1], /\[OK\] label=APR_m elapsed=\d+ms attempt=2\/2$/);
});

test('BarkNotifier retryOnce reports the last failure when both attempts fail', async () => {
  const children = [];
  const { notifier, calls, appRoot } = createNotifier(
    { enabled: true, timeoutMs: 5000, retryOnce: true },
    {
      retryDelayMs: 1,
      spawnResults: () => {
        const child = makeFakeChild();
        children.push(child);
        return child;
      }
    }
  );

  const pending = notifier.notify({ title: 't', body: 'b', label: 'beta' });
  await new Promise((resolve) => setImmediate(resolve));
  children[0].stdout.emit('data', '[FAIL] reason=tls-fail elapsed=3.5s');
  children[0].emit('close', 0);

  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(calls.length, 2);
  children[1].stdout.emit('data', '[FAIL] reason=timeout elapsed=20.0s');
  children[1].emit('close', 0);
  const result = await pending;

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'timeout');

  const lines = readBarkLog(appRoot).trim().split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /\[FAIL\] label=beta reason=tls-fail elapsed=\d+ms attempt=1\/2$/);
  assert.match(lines[1], /\[FAIL\] label=beta reason=timeout elapsed=\d+ms attempt=2\/2$/);
});

test('BarkNotifier retryOnce still spawns only once when the first attempt succeeds', async () => {
  const children = [];
  const { notifier, calls, appRoot } = createNotifier(
    { enabled: true, timeoutMs: 5000, retryOnce: true },
    {
      retryDelayMs: 1,
      spawnResults: () => {
        const child = makeFakeChild();
        children.push(child);
        return child;
      }
    }
  );

  const pending = notifier.notify({ title: 't', body: 'b', label: 'gamma' });
  await new Promise((resolve) => setImmediate(resolve));
  children[0].stdout.emit('data', '[OK/https] code=200');
  children[0].emit('close', 0);
  const result = await pending;

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.match(readBarkLog(appRoot), /\[OK\] label=gamma elapsed=\d+ms attempt=1\/2/);
});

test('BarkNotifier retryOnce does not spawn at all when disabled', async () => {
  const { notifier, calls, appRoot } = createNotifier({ enabled: false, retryOnce: true });
  const result = await notifier.notify({ title: 't', body: 'b', label: 'alpha' });

  assert.deepEqual(result, { ok: false, reason: 'disabled', elapsedMs: 0 });
  assert.equal(calls.length, 0);
  assert.equal(readBarkLog(appRoot), '');
});

function createEventNotifier(config = {}, hooks = {}) {
  const children = [];
  const logs = [];
  const created = createNotifier(Object.assign({ enabled: true, timeoutMs: 5000 }, config), Object.assign({
    spawnResults: () => {
      const child = makeFakeChild();
      children.push(child);
      return child;
    }
  }, hooks));
  created.notifier.logger = {
    info: (message) => logs.push(message),
    warn: (message) => logs.push(message)
  };
  created.children = children;
  created.logs = logs;
  return created;
}

function completeAttempt(child, output) {
  child.stdout.emit('data', output);
  child.emit('close', 0);
}

test('BarkNotifier.notifyEvent pushes on first occurrence and records key in bark.log', async () => {
  const { notifier, children, appRoot } = createEventNotifier({});
  const pending = notifier.notifyEvent({
    type: 'restartExhausted',
    key: 'bot:exhausted:APR_m',
    severity: 'critical',
    title: 'MULTIBOT Downdetector',
    body: 'APR_m 重连耗尽',
    label: 'APR_m'
  });
  await new Promise((resolve) => setImmediate(resolve));
  completeAttempt(children[0], '[OK/https] code=200');
  const result = await pending;

  assert.equal(result.sent, true);
  assert.equal(result.ok, true);
  assert.equal(result.folded, 0);

  assert.match(readBarkLog(appRoot), /\[OK\] label=APR_m elapsed=\d+ms key=bot:exhausted:APR_m/);
});

test('BarkNotifier.notifyEvent maps severity to Bark level', async () => {
  const { notifier, calls, children } = createEventNotifier({});

  const critical = notifier.notifyEvent({ type: 'deviceCode', key: 'auth:device-code:alpha', severity: 'critical', body: 'b', label: 'alpha' });
  await new Promise((resolve) => setImmediate(resolve));
  completeAttempt(children[0], '[OK/https] code=200');
  await critical;
  assert.equal(calls[0].args[calls[0].args.indexOf('-Level') + 1], 'timeSensitive');

  const passive = notifier.notifyEvent({ type: 'logFileTooLarge', key: 'disk:log:x', severity: 'passive', body: 'b', label: 'backend' });
  await new Promise((resolve) => setImmediate(resolve));
  completeAttempt(children[1], '[OK/https] code=200');
  await passive;
  assert.equal(calls[1].args[calls[1].args.indexOf('-Level') + 1], 'passive');
});

test('BarkNotifier.notifyEvent folds repeated occurrences during cooldown', async () => {
  let clock = 1000000;
  const { notifier, children, calls, appRoot } = createEventNotifier({}, { now: () => clock });
  notifier.now = () => clock;

  const first = notifier.notifyEvent({ type: 'botStuck', key: 'bot:stuck:alpha', body: '卡住', label: 'alpha' });
  await new Promise((resolve) => setImmediate(resolve));
  completeAttempt(children[0], '[OK/https] code=200');
  await first;

  const second = await notifier.notifyEvent({ type: 'botStuck', key: 'bot:stuck:alpha', body: '卡住', label: 'alpha' });
  assert.equal(second.sent, false);
  assert.equal(second.reason, 'cooldown');
  assert.equal(second.suppressed, 1);
  assert.equal(calls.length, 1);

  clock += 1800000;
  const third = notifier.notifyEvent({ type: 'botStuck', key: 'bot:stuck:alpha', body: '卡住', label: 'alpha' });
  await new Promise((resolve) => setImmediate(resolve));
  completeAttempt(children[1], '[OK/https] code=200');
  const thirdResult = await third;

  assert.equal(thirdResult.sent, true);
  assert.equal(thirdResult.folded, 1);
  assert.equal(calls[calls.length - 1].args[calls[calls.length - 1].args.indexOf('-Body') + 1], '卡住（此前 30 分钟内折叠 1 次）');
  assert.match(readBarkLog(appRoot), /\[SKIP\] key=bot:stuck:alpha type=botStuck reason=cooldown suppressed=1/);
});

test('BarkNotifier.notifyEvent honors the global hourly rate limit', async () => {
  let clock = 5000000;
  const { notifier, children, appRoot } = createEventNotifier({ events: { maxPerHour: 2 } });
  notifier.now = () => clock;

  for (let i = 0; i < 2; i += 1) {
    const pending = notifier.notifyEvent({ type: 'authRejected', key: `auth:rejected:bot${i}`, body: 'b', label: `bot${i}` });
    await new Promise((resolve) => setImmediate(resolve));
    completeAttempt(children[i], '[OK/https] code=200');
    const result = await pending;
    assert.equal(result.sent, true);
  }

  const limited = await notifier.notifyEvent({ type: 'authRejected', key: 'auth:rejected:bot2', body: 'b', label: 'bot2' });
  assert.equal(limited.sent, false);
  assert.equal(limited.reason, 'rate-limit');
  assert.match(readBarkLog(appRoot), /\[SKIP\] key=auth:rejected:bot2 type=authRejected reason=rate-limit suppressed=1/);

  clock += 3600000;
  const afterWindow = notifier.notifyEvent({ type: 'authRejected', key: 'auth:rejected:bot3', body: 'b', label: 'bot3' });
  await new Promise((resolve) => setImmediate(resolve));
  completeAttempt(children[2], '[OK/https] code=200');
  assert.equal((await afterWindow).sent, true);
});

test('BarkNotifier skips disabled events and disabled event layer', async () => {
  const disabledEvent = createEventNotifier({ events: { authRejected: { enabled: false } } });
  const result = await disabledEvent.notifier.notifyEvent({ type: 'authRejected', key: 'k', body: 'b', label: 'alpha' });
  assert.equal(result.sent, false);
  assert.equal(result.reason, 'event-disabled');
  assert.equal(disabledEvent.calls.length, 0);

  const disabledLayer = createEventNotifier({ events: { enabled: false } });
  const layerResult = await disabledLayer.notifier.notifyEvent({ type: 'authRejected', key: 'k', body: 'b', label: 'alpha' });
  assert.equal(layerResult.sent, false);
  assert.equal(layerResult.reason, 'events-disabled');
});

test('BarkNotifier.notifyEvent supports explicit cooldown override per event config', async () => {
  let clock = 1000;
  const { notifier, children } = createEventNotifier({ events: { deviceCode: { cooldownMs: 0 } } });
  notifier.now = () => clock;

  for (let i = 0; i < 2; i += 1) {
    const pending = notifier.notifyEvent({ type: 'deviceCode', key: 'auth:device-code:alpha', body: 'b', label: 'alpha' });
    await new Promise((resolve) => setImmediate(resolve));
    completeAttempt(children[i], '[OK/https] code=200');
    const result = await pending;
    assert.equal(result.sent, true, `attempt ${i + 1} should send with cooldownMs=0`);
    clock += 1;
  }
});

test('BarkNotifier.notifyRecovery only sends after a delivered failure and includes duration', async () => {
  let clock = 100000;
  const { notifier, children, calls, appRoot } = createEventNotifier({});
  notifier.now = () => clock;

  const noPending = await notifier.notifyRecovery({ type: 'botStuck', key: 'bot:stuck:alpha', body: '已恢复', label: 'alpha' });
  assert.equal(noPending.sent, false);
  assert.equal(noPending.reason, 'no-pending-failure');
  assert.equal(calls.length, 0);

  const failure = notifier.notifyEvent({ type: 'botStuck', key: 'bot:stuck:alpha', body: '卡住', label: 'alpha' });
  await new Promise((resolve) => setImmediate(resolve));
  completeAttempt(children[0], '[OK/https] code=200');
  await failure;

  clock += 192000;
  const pending = notifier.notifyRecovery({ type: 'botStuck', key: 'bot:stuck:alpha', body: 'alpha 已恢复上线', label: 'alpha' });
  await new Promise((resolve) => setImmediate(resolve));
  completeAttempt(children[1], '[OK/https] code=200');
  const recovery = await pending;

  assert.equal(recovery.sent, true);
  assert.equal(recovery.durationMs, 192000);
  assert.equal(calls[1].args[calls[1].args.indexOf('-Body') + 1], 'alpha 已恢复上线（持续 3m 12s）');
  assert.match(readBarkLog(appRoot), /\[OK\] label=alpha elapsed=\d+ms key=bot:stuck:alpha recovery/);

  const repeat = await notifier.notifyRecovery({ type: 'botStuck', key: 'bot:stuck:alpha', body: '已恢复', label: 'alpha' });
  assert.equal(repeat.sent, false);
  assert.equal(repeat.reason, 'no-pending-failure');
});

test('BarkNotifier records push-failing alert after consecutive failures and recovery push', async () => {
  const { notifier, children, logs, appRoot } = createEventNotifier({ events: { pushFailing: { threshold: 2 } } });

  for (let i = 0; i < 2; i += 1) {
    const pending = notifier.notify({ title: 't', body: 'b', label: 'push-failing-probe' });
    await new Promise((resolve) => setImmediate(resolve));
    completeAttempt(children[i], '[FAIL] reason=timeout elapsed=20.0s');
    await pending;
  }

  assert.equal(notifier.consecutiveFailures, 2);
  assert.equal(notifier.pushFailingAlerted, true);
  assert.match(readBarkLog(appRoot), /\[ALERT\] key=push-failing consecutive=2 reason=timeout/);
  assert.ok(logs.some((message) => message.includes('bark push failing consecutively count=2')));

  const ok = notifier.notify({ title: 't', body: 'b', label: 'push-failing-probe' });
  await new Promise((resolve) => setImmediate(resolve));
  completeAttempt(children[2], '[OK/https] code=200');
  await ok;
  await new Promise((resolve) => setImmediate(resolve));
  completeAttempt(children[3], '[OK/https] code=200');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(notifier.consecutiveFailures, 0);
  assert.equal(notifier.pushFailingAlerted, false);
  assert.match(readBarkLog(appRoot), /\[RECOVER\] key=push-failing consecutive=2 restored/);
});
