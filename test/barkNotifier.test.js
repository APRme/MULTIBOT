const test = require('node:test');
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
