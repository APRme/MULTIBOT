const test = require('node:test');
const assert = require('node:assert/strict');
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
  const notifier = new BarkNotifier({
    config,
    appRoot: hooks.appRoot || 'C:\\multibot',
    platform: hooks.platform || 'win32',
    spawnFn: (command, args, options) => {
      calls.push({ command, args, options });
      return child;
    }
  });
  return { notifier, calls, child };
}

test('BarkNotifier does not spawn when disabled', async () => {
  const { notifier, calls } = createNotifier({ enabled: false });
  assert.equal(notifier.isEnabled(), false);
  assert.equal(await notifier.notify({ title: 't', body: 'b' }), false);
  assert.equal(calls.length, 0);
});

test('BarkNotifier skips on non-windows platform', async () => {
  const { notifier, calls } = createNotifier({ enabled: true }, { platform: 'linux' });
  assert.equal(await notifier.notify({ title: 't', body: 'b' }), false);
  assert.equal(calls.length, 0);
});

test('BarkNotifier spawns powershell with resolved paths and reports ok on [OK/', async () => {
  const appRoot = 'C:\\multibot';
  const { notifier, calls, child } = createNotifier({
    enabled: true,
    scriptPath: './src/notifications/bark/bark-push.ps1',
    envPath: './.env',
    group: 'mc',
    timeoutMs: 5000
  }, { appRoot });

  const pending = notifier.notify({ title: 'MULTIBOT Downdetector', body: 'alpha 认证403' });
  await new Promise((resolve) => setImmediate(resolve));
  child.stdout.emit('data', '[OK/https] sound= crypto= code=200 success');
  child.emit('close', 0);
  assert.equal(await pending, true);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'powershell.exe');
  const args = calls[0].args;
  assert.equal(args[args.indexOf('-File') + 1], path.resolve(appRoot, './src/notifications/bark/bark-push.ps1'));
  assert.equal(args[args.indexOf('-EnvPath') + 1], path.resolve(appRoot, './.env'));
  assert.equal(args[args.indexOf('-Title') + 1], 'MULTIBOT Downdetector');
  assert.equal(args[args.indexOf('-Body') + 1], 'alpha 认证403');
  assert.equal(args[args.indexOf('-Group') + 1], 'mc');
  assert.equal(calls[0].options.windowsHide, true);
});

test('BarkNotifier reports failure on [FAIL] output', async () => {
  const { notifier, child } = createNotifier({ enabled: true, timeoutMs: 5000 });
  const pending = notifier.notify({ title: 't', body: 'b' });
  await new Promise((resolve) => setImmediate(resolve));
  child.stdout.emit('data', '[FAIL]     sound= crypto= ');
  child.emit('close', 0);
  assert.equal(await pending, false);
});

test('BarkNotifier kills child and resolves false on timeout', async () => {
  const { notifier, child } = createNotifier({ enabled: true, timeoutMs: 10 });
  const pending = notifier.notify({ title: 't', body: 'b' });
  assert.equal(await pending, false);
  assert.equal(child.killed, true);
});

test('BarkNotifier getCooldownMs falls back to default and honors zero', () => {
  const defaults = createNotifier({ enabled: true }).notifier;
  assert.equal(defaults.getCooldownMs(), 600000);

  const zero = createNotifier({ enabled: true, cooldownMs: 0 }).notifier;
  assert.equal(zero.getCooldownMs(), 0);

  const custom = createNotifier({ enabled: true, cooldownMs: 1000 }).notifier;
  assert.equal(custom.getCooldownMs(), 1000);
});
