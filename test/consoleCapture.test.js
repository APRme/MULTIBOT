const test = require('node:test');
const assert = require('node:assert/strict');
const { runWithConsoleCapture, shouldCaptureMessage } = require('../src/logging/ConsoleCapture');

test('ConsoleCapture routes uncategorized console output to the active bot logger', () => {
  const entries = [];
  const logger = {
    capture(level, message) {
      entries.push({ level, message });
    }
  };

  runWithConsoleCapture(logger, () => {
    console.info('[msa] Signed in with Microsoft');
    console.log('[MULTIBOT][alpha][INFO] [BOT] spawn');
  });

  assert.deepEqual(entries, [
    {
      level: 'info',
      message: '[msa] Signed in with Microsoft'
    }
  ]);
});

test('ConsoleCapture ignores internal prefixed messages only', () => {
  assert.equal(shouldCaptureMessage('[MULTIBOT][alpha][INFO] [BOT] spawn'), false);
  assert.equal(shouldCaptureMessage('[MULTIBOT_PANEL] listening on http://127.0.0.1:18888'), false);
  assert.equal(shouldCaptureMessage('[会话管理器] 加载缓存: alpha@example.com'), true);
});
