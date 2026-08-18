const path = require('path');
const { WarehouseStore } = require('./WarehouseStore');

// 仓库级共享的 WarehouseStore 注册表:同一仓库下所有 bot 共用一个数据库连接。
const storesByWarehouseDir = new Map();

function getStoreForWarehouse(warehouseDir, options = {}) {
  const key = path.resolve(warehouseDir);
  if (!storesByWarehouseDir.has(key)) {
    storesByWarehouseDir.set(key, new WarehouseStore({
      dbPath: path.join(key, 'warehouse.db'),
      logger: options.logger || null
    }));
  }
  return storesByWarehouseDir.get(key);
}

// 应用退出或测试收尾时调用,释放全部连接。
function closeAllStores() {
  for (const store of storesByWarehouseDir.values()) {
    try {
      store.close();
    } catch (error) {
      // ignore close errors
    }
  }
  storesByWarehouseDir.clear();
}

module.exports = {
  getStoreForWarehouse,
  closeAllStores
};
