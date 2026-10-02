const test = require('node:test');
require('./helpers/tempDir'); // 测试临时目录统一重定向到工作区 .temp/test-run/
const assert = require('node:assert/strict');
const { MultibotApp, isRecorderOriginError } = require('../src/app/MultibotApp');

function createApp(overrides = {}) {
  const app = new MultibotApp({ appRoot: overrides.appRoot || process.cwd() });
  app.lifecycleLogService = null;
  app.botManager = overrides.botManager || null;
  return app;
}

// installGlobalExceptionGuards 会往 process 上挂监听器: 只摘掉本次新增的那一个, 不动测试运行器自己的
function captureGuard(app, event = 'uncaughtException') {
  const before = new Set(process.listeners(event));
  app.installGlobalExceptionGuards();
  const added = process.listeners(event).filter((listener) => !before.has(listener));
  assert.equal(added.length, 1, `应恰好新增一个 ${event} 监听器`);
  return {
    handler: added[0],
    dispose() {
      added.forEach((listener) => process.removeListener(event, listener));
    }
  };
}

async function withSilentConsole(run) {
  const originalError = console.error;
  console.error = () => {};
  try {
    return await run();
  } finally {
    console.error = originalError;
  }
}

test('isRecorderOriginError only flags recorder/yazl export failures', () => {
  const recorderError = new Error('ENOENT: no such file or directory, open ...');
  recorderError.stack = 'Error: ENOENT\n    at Object.<anonymous> (D:\\mineflayer\\MULTIBOT\\flashback-recorder\\ZipExporter.js:1:1)';
  assert.equal(isRecorderOriginError(recorderError), true);

  const tagged = Object.assign(new Error('export failed'), { code: 'FLASHBACK_RECORDER_ERROR' });
  assert.equal(isRecorderOriginError(tagged), true);

  const protocolError = new Error('partial packet');
  protocolError.stack = 'Error: partial packet\n    at Parser.parse (D:\\mineflayer\\node_modules\\minecraft-protocol\\src\\transforms\\parser.js:1:1)';
  assert.equal(isRecorderOriginError(protocolError), false);
  assert.equal(isRecorderOriginError(null), false);
  assert.equal(isRecorderOriginError({}), false);
});

test('recorder-origin crashes do not restart the bots', async () => {
  const app = createApp();
  const restarts = [];
  app.restartActiveBotsAfterCrash = async (reason) => { restarts.push(reason); };

  const guard = captureGuard(app);
  try {
    await withSilentConsole(async () => {
      const recorderError = new Error('file data stream has unexpected number of bytes');
      recorderError.stack = 'Error: file data stream has unexpected number of bytes\n    at ByteCounter (D:\\mineflayer\\node_modules\\yazl\\index.js:187:99)\n    at pumpFileDataReadStream (D:\\mineflayer\\MULTIBOT\\flashback-recorder\\ZipExporter.js:1:1)';
      guard.handler(recorderError);
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(restarts, [], '录像异常不应触发全量重启');

      guard.handler(new Error('minecraft-protocol 解析错误'));
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(restarts, ['uncaught_exception'], '非录像异常仍应走全量重启');
    });
  } finally {
    guard.dispose();
  }
});

test('three crashes in the window trigger a graceful shutdown before exiting', async () => {
  const app = createApp();
  const stopReasons = [];
  const exitCodes = [];
  app.stop = async (reason) => { stopReasons.push(reason); };
  app.restartActiveBotsAfterCrash = async () => {};

  const originalExit = process.exit;
  process.exit = (code) => { exitCodes.push(code); };
  const guard = captureGuard(app);
  try {
    await withSilentConsole(async () => {
      guard.handler(new Error('crash 1'));
      guard.handler(new Error('crash 2'));
      // 第 3 次: 命中阈值 => 先优雅关闭再退出, 且不再走全量重启分支
      const restarts = [];
      app.restartActiveBotsAfterCrash = async (reason) => { restarts.push(reason); };
      guard.handler(new Error('crash 3'));
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.deepEqual(stopReasons, ['uncaught_exception'], '退出前必须优雅关闭');
      assert.deepEqual(exitCodes, [1], '关闭后退出码为 1');
      assert.deepEqual(restarts, [], '第 3 次不应再走全量重启');
      assert.equal(app.shutdownInProgress, true);
    });
  } finally {
    guard.dispose();
    process.exit = originalExit;
  }
});
