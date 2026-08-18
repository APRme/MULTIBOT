const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

// 仓库数据存储层:基于 Node 内置 node:sqlite 的同步封装。
// 表结构:
//   containers — 登记箱(由 rules.json 加载注册,含暂存箱标记与盘点时间)
//   items      — 各箱当前内容(校准/搬运后事务替换)
//   tasks      — 分拣/校准/盘点/取出任务队列(排队/取消/断点恢复)
class WarehouseStore {
  constructor(options = {}) {
    this.dbPath = options.dbPath || ':memory:';
    this.logger = options.logger || null;
    this.db = null;
    this.open();
  }

  open() {
    if (this.dbPath !== ':memory:') {
      const dir = path.dirname(this.dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }

    this.db = new DatabaseSync(this.dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.migrate();
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS containers (
        id INTEGER PRIMARY KEY,
        x INTEGER NOT NULL,
        y INTEGER NOT NULL,
        z INTEGER NOT NULL,
        type TEXT,
        name TEXT,
        slot_count INTEGER,
        is_inbox INTEGER DEFAULT 0,
        calibrated_at INTEGER,
        last_audited_at INTEGER,
        UNIQUE (x, y, z)
      );

      CREATE TABLE IF NOT EXISTS items (
        id INTEGER PRIMARY KEY,
        container_id INTEGER NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
        slot INTEGER NOT NULL,
        item_name TEXT NOT NULL,
        display_name TEXT,
        count INTEGER NOT NULL,
        metadata INTEGER DEFAULT 0,
        durability_used INTEGER,
        max_durability INTEGER,
        stack_identity TEXT,
        UNIQUE (container_id, slot)
      );

      CREATE INDEX IF NOT EXISTS idx_items_name ON items (item_name);
      CREATE INDEX IF NOT EXISTS idx_items_container ON items (container_id);

      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY,
        bot_id TEXT,
        type TEXT NOT NULL,
        payload TEXT,
        status TEXT DEFAULT 'queued',
        progress TEXT,
        error TEXT,
        created_at INTEGER,
        updated_at INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks (status, bot_id);
    `);

    const itemColumns = this.db.prepare('PRAGMA table_info(items)').all();
    if (!itemColumns.some((column) => column.name === 'stack_identity')) {
      this.db.exec('ALTER TABLE items ADD COLUMN stack_identity TEXT;');
    }
  }

  close() {
    if (this.db) {
      try {
        this.db.close();
      } catch (error) {
        // ignore close errors
      }
      this.db = null;
    }
  }

  // 同步事务:fn 抛错则整体回滚。
  transaction(fn) {
    this.db.exec('BEGIN');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  // ---------- containers ----------

  // 按坐标登记/更新一个容器。返回容器 id。
  upsertContainer({ x, y, z, type = null, name = null, slotCount = null, isInbox = false, calibratedAt = null, lastAuditedAt = null }) {
    const existing = this.getContainer(x, y, z);
    if (existing) {
      this.db.prepare(`
        UPDATE containers SET type = ?, name = ?, slot_count = ?, is_inbox = ?, calibrated_at = ?, last_audited_at = ?
        WHERE id = ?
      `).run(
        type,
        name,
        slotCount,
        isInbox ? 1 : 0,
        calibratedAt,
        lastAuditedAt,
        existing.id
      );
      return existing.id;
    }

    const result = this.db.prepare(`
      INSERT INTO containers (x, y, z, type, name, slot_count, is_inbox, calibrated_at, last_audited_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      x,
      y,
      z,
      type,
      name,
      slotCount,
      isInbox ? 1 : 0,
      calibratedAt,
      lastAuditedAt
    );
    return Number(result.lastInsertRowid);
  }

  getContainer(x, y, z) {
    return this.db.prepare('SELECT * FROM containers WHERE x = ? AND y = ? AND z = ?').get(x, y, z) || null;
  }

  getContainerById(id) {
    return this.db.prepare('SELECT * FROM containers WHERE id = ?').get(id) || null;
  }

  listContainers() {
    return this.db.prepare('SELECT * FROM containers ORDER BY id').all();
  }

  // 删除登记箱及其物品记录(业务数据操作,调用方负责与规则表一致性)。
  removeContainer(id) {
    this.db.prepare('DELETE FROM containers WHERE id = ?').run(id);
  }

  updateContainerMeta(id, fields) {
    const allowed = ['type', 'name', 'slot_count', 'is_inbox', 'calibrated_at', 'last_audited_at'];
    const sets = [];
    const values = [];
    for (const key of allowed) {
      if (fields[key] !== undefined) {
        sets.push(`${key} = ?`);
        values.push(typeof fields[key] === 'boolean' ? (fields[key] ? 1 : 0) : fields[key]);
      }
    }
    if (sets.length === 0) {
      return;
    }
    values.push(id);
    this.db.prepare(`UPDATE containers SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }

  // ---------- items ----------

  // 事务替换某容器的全部物品记录(items 为 WindowSnapshot 序列化字段数组)。
  replaceContainerItems(containerId, items) {
    return this.transaction(() => {
      this.db.prepare('DELETE FROM items WHERE container_id = ?').run(containerId);
      const insert = this.db.prepare(`
        INSERT INTO items (
          container_id, slot, item_name, display_name, count, metadata,
          durability_used, max_durability, stack_identity
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const item of items || []) {
        insert.run(
          containerId,
          item.slot,
          item.item_name,
          item.display_name || null,
          item.count,
          item.metadata || 0,
          item.durability_used !== undefined ? item.durability_used : null,
          item.max_durability !== undefined ? item.max_durability : null,
          typeof item.stack_identity === 'string' ? item.stack_identity : null
        );
      }
      return items ? items.length : 0;
    });
  }

  getItemsByContainer(containerId) {
    return this.db.prepare('SELECT * FROM items WHERE container_id = ? ORDER BY slot').all(containerId);
  }

  // 按物品名(规范化 minecraft:xxx)跨容器查询。
  queryItemsByName(itemName) {
    return this.db.prepare(`
      SELECT i.*, c.x, c.y, c.z, c.name AS container_name
      FROM items i JOIN containers c ON c.id = i.container_id
      WHERE i.item_name = ?
      ORDER BY c.id, i.slot
    `).all(itemName);
  }

  // 跨容器总量汇总:[{ itemName, total, containerCount }]
  summarize() {
    return this.db.prepare(`
      SELECT item_name AS itemName, SUM(count) AS total, COUNT(DISTINCT container_id) AS containerCount
      FROM items
      GROUP BY item_name
      ORDER BY itemName
    `).all();
  }

  // 指定物品总量。
  countItem(itemName) {
    const row = this.db.prepare('SELECT COALESCE(SUM(count), 0) AS total FROM items WHERE item_name = ?').get(itemName);
    return row ? Number(row.total) : 0;
  }

  // ---------- tasks ----------

  createTask({ botId = null, type, payload = null }) {
    const now = Date.now();
    const result = this.db.prepare(`
      INSERT INTO tasks (bot_id, type, payload, status, progress, error, created_at, updated_at)
      VALUES (?, ?, ?, 'queued', NULL, NULL, ?, ?)
    `).run(botId, type, payload ? JSON.stringify(payload) : null, now, now);
    return Number(result.lastInsertRowid);
  }

  getTask(id) {
    return this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) || null;
  }

  // status 过滤:不传返回全部;支持数组。
  listTasks({ status = null, botId = null } = {}) {
    const clauses = [];
    const values = [];
    if (status !== null && status !== undefined) {
      const statuses = Array.isArray(status) ? status : [status];
      clauses.push(`status IN (${statuses.map(() => '?').join(', ')})`);
      values.push(...statuses);
    }
    if (botId !== null && botId !== undefined) {
      clauses.push('bot_id = ?');
      values.push(botId);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.db.prepare(`SELECT * FROM tasks ${where} ORDER BY id`).all(...values);
  }

  updateTask(id, { status = null, progress = null, error = null, botId = null } = {}) {
    const sets = ['updated_at = ?'];
    const values = [Date.now()];
    if (status !== null && status !== undefined) {
      sets.push('status = ?');
      values.push(status);
    }
    if (progress !== null && progress !== undefined) {
      sets.push('progress = ?');
      values.push(typeof progress === 'string' ? progress : JSON.stringify(progress));
    }
    if (error !== null && error !== undefined) {
      sets.push('error = ?');
      values.push(error);
    }
    if (botId !== null && botId !== undefined) {
      sets.push('bot_id = ?');
      values.push(botId);
    }
    values.push(id);
    this.db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }

  // 各状态任务计数(面板用)。
  countTasksByStatus() {
    const rows = this.db.prepare('SELECT status, COUNT(*) AS count FROM tasks GROUP BY status').all();
    const result = {};
    for (const row of rows) {
      result[row.status] = Number(row.count);
    }
    return result;
  }
}

module.exports = {
  WarehouseStore
};
