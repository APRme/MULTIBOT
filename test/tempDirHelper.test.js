const test = require('node:test');
require('./helpers/tempDir');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  makeTempDir,
  getTestTempRoot,
  TEST_TEMP_ROOT,
  SYSTEM_TEMP_ROOT,
  redirectEnabled
} = require('./helpers/tempDir');

// 这些断言是"测试不再污染系统 %TEMP%"的契约: 一旦有人改坏 helper, 这里会直接红
test('tempDir helper redirects os.tmpdir() into the workspace scratch area', () => {
  assert.equal(redirectEnabled, true, '工作区可写时应启用重定向');
  assert.equal(getTestTempRoot(), TEST_TEMP_ROOT);
  assert.equal(os.tmpdir(), TEST_TEMP_ROOT, 'os.tmpdir() 必须指向工作区内的测试暂存区');

  const repoRoot = path.resolve(__dirname, '..');
  assert.equal(TEST_TEMP_ROOT.startsWith(repoRoot), true, '测试暂存区必须位于工作区内');
  assert.equal(TEST_TEMP_ROOT.includes(`${path.sep}.temp${path.sep}test-run`), true);
  assert.notEqual(SYSTEM_TEMP_ROOT, TEST_TEMP_ROOT, '系统默认临时目录不应等于测试暂存区');
});

test('legacy mkdtempSync(os.tmpdir()) call sites land in the workspace scratch area', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multibot-contract-'));
  assert.equal(path.dirname(dir), TEST_TEMP_ROOT);
  assert.equal(fs.statSync(dir).isDirectory(), true);
});

test('makeTempDir creates unique directories under the test temp root', () => {
  const first = makeTempDir('multibot-helper-');
  const second = makeTempDir('multibot-helper-');

  assert.notEqual(first, second);
  assert.equal(path.dirname(first), TEST_TEMP_ROOT);
  assert.equal(path.dirname(second), TEST_TEMP_ROOT);
  assert.equal(path.basename(first).startsWith('multibot-helper-'), true);
  assert.equal(fs.statSync(first).isDirectory(), true);
});
