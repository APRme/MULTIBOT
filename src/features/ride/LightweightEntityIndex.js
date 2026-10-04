// 轻量模式(不加载 entities 插件)下的极简实体索引。
// 只记录 UUID / 网络实体 id / 类型 / 坐标, 供 "ride <uuid>" 这类按实体 id 交互的命令使用。
// 数据来源(均为协议包, 与是否加载实体插件无关):
//   login            -> 自己的玩家实体 id
//   spawn_entity     -> entityId + objectUUID + type + 坐标
//   entity_destroy   -> 删除
//   entity_teleport  -> 位置刷新
//   rel_entity_move  -> 相对位移(dX/dY/dZ 定点数, 需按版本选缩放)
const DELTA_SCALE_FALLBACK = 32;

function normalizeUuid(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim().toLowerCase().replace(/-/g, '');
}

class LightweightEntityIndex {
  constructor(options = {}) {
    this.logger = options.logger || null;
    this.typeIds = Array.isArray(options.typeIds) && options.typeIds.length > 0
      ? new Set(options.typeIds.map((id) => Number(id)))
      : null;
    this.maxEntries = Number.isInteger(options.maxEntries) && options.maxEntries > 0
      ? options.maxEntries
      : 64;
    this.onIndexed = null;
    this.byId = new Map();
    this.byUuid = new Map();
    this.selfEntityId = null;
    this.listeners = [];
    this.deltaScale = null;
    this.client = null;
  }

  // 供报错/日志使用: 当前索引概况(便于判断"是索引为空还是 UUID 不匹配")
  summary(limit = 5) {
    if (this.byId.size === 0) {
      return '已索引 0 个可骑乘实体';
    }

    const parts = [];
    for (const entity of this.byId.values()) {
      parts.push(`${(entity.uuid || 'n/a').slice(0, 8)}(id=${entity.id})`);
      if (parts.length >= limit) break;
    }

    const suffix = this.byId.size > parts.length ? ` 等 ${this.byId.size} 个` : '';
    return `已索引 ${this.byId.size} 个可骑乘实体: ${parts.join(', ')}${suffix}`;
  }

  attach(client, options = {}) {
    this.detach();
    if (!client || typeof client.on !== 'function') return false;

    this.client = client;
    this.deltaScale = this.resolveDeltaScale(options.bot);

    this.addListener(client, 'login', (packet) => {
      const entityId = packet && Number.isFinite(packet.entityId) ? packet.entityId : null;
      if (entityId !== null) {
        this.selfEntityId = entityId;
      }
    });

    this.addListener(client, 'spawn_entity', (packet) => this.handleSpawn(packet));
    this.addListener(client, 'entity_destroy', (packet) => this.handleDestroy(packet));
    this.addListener(client, 'entity_teleport', (packet) => this.handleTeleport(packet));
    this.addListener(client, 'rel_entity_move', (packet) => this.handleRelMove(packet));

    return true;
  }

  detach() {
    for (const listener of this.listeners) {
      if (listener.target && typeof listener.target.removeListener === 'function') {
        listener.target.removeListener(listener.eventName, listener.handler);
      }
    }
    this.listeners = [];
    this.clear();
    this.selfEntityId = null;
    this.client = null;
  }

  clear() {
    this.byId.clear();
    this.byUuid.clear();
  }

  get size() {
    return this.byId.size;
  }

  addListener(target, eventName, handler) {
    target.on(eventName, handler);
    this.listeners.push({ target, eventName, handler });
  }

  // 定点位移缩放: 新版本是 1/4096, 旧版本是 1/32; 无法判定时放弃相对位移跟踪(宁可不更新, 也不用错坐标)
  resolveDeltaScale(bot) {
    try {
      if (bot && typeof bot.supportFeature === 'function') {
        if (bot.supportFeature('fixedPointDelta128')) return 128 * 32;
        if (bot.supportFeature('fixedPointDelta')) return 32;
      }
    } catch (error) {
      return null;
    }
    return null;
  }

  isWantedType(type) {
    if (!this.typeIds) return true;
    return this.typeIds.has(Number(type));
  }

  handleSpawn(packet) {
    if (!packet || !Number.isFinite(packet.entityId)) return;
    if (!this.isWantedType(packet.type)) return;

    const entity = {
      id: packet.entityId,
      type: Number(packet.type),
      uuid: normalizeUuid(packet.objectUUID),
      x: Number(packet.x),
      y: Number(packet.y),
      z: Number(packet.z),
      updatedAt: Date.now()
    };

    const previous = this.byId.get(entity.id);
    if (previous && previous.uuid && this.byUuid.get(previous.uuid) === previous) {
      this.byUuid.delete(previous.uuid);
    }

    this.byId.set(entity.id, entity);
    if (entity.uuid) {
      this.byUuid.set(entity.uuid, entity);
    }

    this.pruneIfNeeded();
  }

  handleDestroy(packet) {
    const ids = packet && Array.isArray(packet.entityIds) ? packet.entityIds : [];
    for (const id of ids) {
      this.removeById(id);
    }
  }

  handleTeleport(packet) {
    if (!packet || !Number.isFinite(packet.entityId)) return;
    const entity = this.byId.get(packet.entityId);
    if (!entity) return;
    entity.x = Number(packet.x);
    entity.y = Number(packet.y);
    entity.z = Number(packet.z);
    entity.updatedAt = Date.now();
  }

  handleRelMove(packet) {
    const scale = this.deltaScale || DELTA_SCALE_FALLBACK;
    if (!this.deltaScale || !packet || !Number.isFinite(packet.entityId)) return;
    const entity = this.byId.get(packet.entityId);
    if (!entity) return;
    entity.x += (Number(packet.dX) || 0) / scale;
    entity.y += (Number(packet.dY) || 0) / scale;
    entity.z += (Number(packet.dZ) || 0) / scale;
    entity.updatedAt = Date.now();
  }

  removeById(entityId) {
    const entity = this.byId.get(entityId);
    if (!entity) return;
    this.byId.delete(entityId);
    if (entity.uuid && this.byUuid.get(entity.uuid) === entity) {
      this.byUuid.delete(entity.uuid);
    }
  }

  pruneIfNeeded() {
    while (this.byId.size > this.maxEntries) {
      let oldestId = null;
      let oldestAt = Infinity;
      for (const [id, entity] of this.byId) {
        if (entity.updatedAt < oldestAt) {
          oldestAt = entity.updatedAt;
          oldestId = id;
        }
      }
      if (oldestId === null) return;
      this.removeById(oldestId);
    }
  }

  getById(entityId) {
    return this.byId.get(entityId) || null;
  }

  findByUuid(uuid) {
    const key = normalizeUuid(uuid);
    if (!key) return null;
    return this.byUuid.get(key) || null;
  }

  // 距离最近的一个(仅按当前已知坐标; 位置可能滞后于实体真实位置)
  nearest(position) {
    if (!position || !Number.isFinite(position.x)) {
      return this.byId.size === 1 ? this.byId.values().next().value : null;
    }

    let best = null;
    let bestDistance = Infinity;
    for (const entity of this.byId.values()) {
      const dx = entity.x - position.x;
      const dy = entity.y - position.y;
      const dz = entity.z - position.z;
      const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = entity;
      }
    }

    return best ? { ...best, distance: bestDistance } : null;
  }

  describe(entity) {
    if (!entity) return '未知实体';
    const shortUuid = entity.uuid ? entity.uuid.slice(0, 8) : 'n/a';
    return `id=${entity.id} uuid=${shortUuid} type=${entity.type}`;
  }
}

module.exports = {
  LightweightEntityIndex,
  normalizeUuid
};
