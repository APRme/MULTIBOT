const path = require('path');

// rulesFile 是相对于 WareHouse/<serverDir>/ 的 POSIX 风格路径。
function validateWarehouseRulesFile(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    return { ok: false, error: 'warehouse.rulesFile 必须是非空相对路径' };
  }

  const rulesFile = value.trim();
  if (rulesFile.includes('\\')) {
    return { ok: false, error: 'warehouse.rulesFile 必须使用 / 作为路径分隔符' };
  }
  if (
    path.posix.isAbsolute(rulesFile)
    || path.win32.isAbsolute(rulesFile)
    || /^[A-Za-z]:/.test(rulesFile)
  ) {
    return { ok: false, error: 'warehouse.rulesFile 不能是绝对路径' };
  }

  const segments = rulesFile.split('/');
  if (segments.some((segment) => segment === '..')) {
    return { ok: false, error: 'warehouse.rulesFile 不能包含 .. 路径段' };
  }

  return { ok: true, rulesFile };
}

function resolveWarehousePaths(warehouseServerDir, rulesFile) {
  if (typeof warehouseServerDir !== 'string' || warehouseServerDir.trim() === '') {
    return { ok: false, error: '仓库服务器目录未配置' };
  }

  const validation = validateWarehouseRulesFile(rulesFile);
  if (!validation.ok) {
    return validation;
  }

  const rootDir = path.resolve(warehouseServerDir);
  const rulesPath = path.resolve(rootDir, ...validation.rulesFile.split('/'));
  const relativeRulesPath = path.relative(rootDir, rulesPath);
  if (
    relativeRulesPath === '..'
    || relativeRulesPath.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativeRulesPath)
  ) {
    return { ok: false, error: 'warehouse.rulesFile 必须位于仓库服务器目录内' };
  }

  return {
    ok: true,
    rootDir,
    rulesFile: validation.rulesFile,
    rulesPath,
    dataDir: path.dirname(rulesPath)
  };
}

module.exports = {
  validateWarehouseRulesFile,
  resolveWarehousePaths
};
