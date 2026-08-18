const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { resolveBotPaths } = require('../src/config/resolveBotPaths');
const { validateWarehouseRulesFile, resolveWarehousePaths } = require('../src/warehouse/paths');

test('warehouse rulesFile accepts POSIX-style relative paths', () => {
  assert.deepEqual(validateWarehouseRulesFile('wh1/rules.json'), {
    ok: true,
    rulesFile: 'wh1/rules.json'
  });
});

test('warehouse rulesFile rejects backslashes, absolute paths, and traversal', () => {
  for (const rulesFile of [
    'wh1\\rules.json',
    '../rules.json',
    'wh1/../rules.json',
    '/tmp/rules.json',
    'C:/warehouse/rules.json'
  ]) {
    assert.equal(validateWarehouseRulesFile(rulesFile).ok, false, rulesFile);
  }
});

test('resolveWarehousePaths keeps rules and database inside one warehouse directory', () => {
  const warehouseServerDir = path.resolve('C:/MULTIBOT/WareHouse/EDEN');
  const result = resolveWarehousePaths(warehouseServerDir, 'wh1/rules.json');

  assert.equal(result.ok, true);
  assert.equal(result.rulesPath, path.join(warehouseServerDir, 'wh1', 'rules.json'));
  assert.equal(result.dataDir, path.join(warehouseServerDir, 'wh1'));
});

test('resolveBotPaths exposes the server warehouse root outside BOTS', () => {
  const appRoot = path.resolve('C:/MULTIBOT');
  const paths = resolveBotPaths({
    repoRoot: path.resolve('C:/repo'),
    appRoot,
    serverDirName: 'EDEN',
    botDirName: 'BotA'
  });

  assert.equal(paths.serverDir, path.join(appRoot, 'BOTS', 'EDEN'));
  assert.equal(paths.warehouseRoot, path.join(appRoot, 'WareHouse'));
  assert.equal(paths.warehouseServerDir, path.join(appRoot, 'WareHouse', 'EDEN'));
});
