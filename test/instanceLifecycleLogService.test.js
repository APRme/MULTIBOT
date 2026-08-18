const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  InstanceLifecycleLogService,
  LIFECYCLE_EVENTS
} = require('../src/logging/InstanceLifecycleLogService');

function createTempAppRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'multibot-lifecycle-log-'));
}

test('InstanceLifecycleLogService enabled by default and writes JSON lines', () => {
  const appRoot = createTempAppRoot();
  const service = new InstanceLifecycleLogService({ appRoot });

  assert.equal(service.isEnabled(), true);
  assert.equal(service.filePath, path.join(appRoot, 'logs', 'lifecycle.log'));

  const written = service.record(LIFECYCLE_EVENTS.BOT_SPAWN, {
    botId: 'example_bot',
    serverDir: 'my_server',
    reason: null,
    detail: 'spawned'
  });

  assert.equal(written, true);

  const lines = fs.readFileSync(service.filePath, 'utf8').trim().split(/\r?\n/);
  assert.equal(lines.length, 1);

  const entry = JSON.parse(lines[0]);
  assert.equal(entry.type, 'instance_lifecycle');
  assert.equal(entry.event, 'bot_spawn');
  assert.equal(entry.botId, 'example_bot');
  assert.equal(entry.serverDir, 'my_server');
  assert.equal(entry.detail, 'spawned');
  assert.ok(typeof entry.timestamp === 'string' && entry.timestamp.length > 0);
});

test('InstanceLifecycleLogService disabled does not write files', () => {
  const appRoot = createTempAppRoot();
  const service = new InstanceLifecycleLogService({
    appRoot,
    config: { enabled: false }
  });

  assert.equal(service.isEnabled(), false);
  assert.equal(service.record(LIFECYCLE_EVENTS.BOT_DISCONNECT, { botId: 'example_bot' }), false);
  assert.equal(fs.existsSync(service.filePath), false);
});

test('InstanceLifecycleLogService resolves custom relative filePath under appRoot', () => {
  const appRoot = createTempAppRoot();
  const service = new InstanceLifecycleLogService({
    appRoot,
    config: { filePath: './logs/custom-lifecycle.log' }
  });

  assert.equal(service.filePath, path.join(appRoot, 'logs', 'custom-lifecycle.log'));
});

test('InstanceLifecycleLogService serializes Error detail as stack', () => {
  const appRoot = createTempAppRoot();
  const service = new InstanceLifecycleLogService({ appRoot });

  const error = new Error('boom');
  service.record(LIFECYCLE_EVENTS.PROCESS_CRASH, { detail: error });

  const entry = JSON.parse(fs.readFileSync(service.filePath, 'utf8').trim());
  assert.match(entry.detail, /^Error: boom/);
  assert.match(entry.detail, /at /);
});
