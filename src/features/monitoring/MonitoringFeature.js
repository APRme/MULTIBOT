const fs = require('fs');
const path = require('path');

function normalizeEntityIdentifier(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return '';
  return text.startsWith('minecraft:') ? text.slice('minecraft:'.length) : text;
}

class MonitoringFeature {
  constructor(options = {}) {
    this.logger = options.logger;
    this.config = options.config || {};
    this.paths = options.paths || {};
    this.bot = null;
    this.listeners = [];
    this.reportedEntities = new Set();
    this.monitoringInterval = null;
  }

  attach(bot) {
    this.stop();
    this.bot = bot;

    if (!this.isEnabled()) return;

    this.loadReportedUUIDs();

    const onSpawn = () => {
      this.startMonitoring();
    };

    bot.on('spawn', onSpawn);
    this.listeners.push({ eventName: 'spawn', handler: onSpawn });

    if (bot.entity) {
      this.startMonitoring();
    }
  }

  stop() {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
    }

    if (this.bot) {
      for (const listener of this.listeners) {
        this.bot.removeListener(listener.eventName, listener.handler);
      }
    }

    this.listeners = [];
    this.reportedEntities.clear();
    this.bot = null;
  }

  isEnabled() {
    return this.config.enabled === true;
  }

  getIntervalMs() {
    const seconds = Number.parseFloat(this.config.intervalSeconds);
    const safeSeconds = Number.isFinite(seconds) && seconds > 0 ? seconds : 10;
    return safeSeconds * 1000;
  }

  getFoundEntitiesPath() {
    return this.paths.foundEntitiesPath || path.resolve(this.paths.accountDir || process.cwd(), 'found.txt');
  }

  getTargetTypes() {
    return Array.isArray(this.config.targetTypes)
      ? this.config.targetTypes.map(normalizeEntityIdentifier).filter(Boolean)
      : [];
  }

  log(message, level = 'info') {
    if (this.logger && typeof this.logger[level] === 'function') {
      this.logger[level](`[MONITORING] ${message}`);
    }
  }

  readUuidFile() {
    const filePath = this.getFoundEntitiesPath();
    if (!fs.existsSync(filePath)) {
      return [];
    }

    const content = fs.readFileSync(filePath, 'utf8');
    return content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  }

  writeUniqueUuidFile(uuids) {
    const filePath = this.getFoundEntitiesPath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const uniqueUuids = Array.from(new Set(uuids.filter(Boolean)));
    const suffix = uniqueUuids.length > 0 ? '\n' : '';
    fs.writeFileSync(filePath, uniqueUuids.join('\n') + suffix, 'utf8');
  }

  loadReportedUUIDs() {
    try {
      const uuids = this.readUuidFile();
      const uniqueUuids = Array.from(new Set(uuids));

      if (uniqueUuids.length < uuids.length) {
        this.writeUniqueUuidFile(uniqueUuids);
        this.log(`deduped found.txt removed=${uuids.length - uniqueUuids.length}`, 'warn');
      }

      uniqueUuids.forEach((uuid) => this.reportedEntities.add(uuid));
    } catch (error) {
      this.log(`failed to load found.txt ${error.message}`, 'error');
    }
  }

  syncReportedUUIDs() {
    try {
      const uuids = this.readUuidFile();
      const uniqueUuids = Array.from(new Set(uuids));

      if (uniqueUuids.length < uuids.length) {
        this.writeUniqueUuidFile(uniqueUuids);
      }

      uniqueUuids.forEach((uuid) => this.reportedEntities.add(uuid));
    } catch (error) {
      this.log(`failed to sync found.txt ${error.message}`, 'error');
    }
  }

  appendReportedUUID(uuid) {
    if (!uuid) return;

    const filePath = this.getFoundEntitiesPath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    if (fs.existsSync(filePath)) {
      const existingUuids = this.readUuidFile();
      if (existingUuids.includes(uuid)) {
        return;
      }
    }

    fs.appendFileSync(filePath, `${uuid}\n`, 'utf8');
  }

  isMonitoredEntity(entity) {
    if (!this.bot || !this.bot.entity || !entity || entity === this.bot.entity) return false;

    const targetTypes = this.getTargetTypes();
    if (!targetTypes.length) {
      return entity.type === 'mob';
    }

    const identifiers = [
      normalizeEntityIdentifier(entity.name),
      normalizeEntityIdentifier(entity.displayName),
      normalizeEntityIdentifier(entity.type)
    ].filter(Boolean);

    return targetTypes.some((targetType) => identifiers.includes(targetType));
  }

  getEntitySummary(entity) {
    const name = entity.name || entity.displayName || '未知';
    const pos = entity.position || { x: 0, y: 0, z: 0 };
    const distance = this.bot && this.bot.entity && entity.position
      ? this.bot.entity.position.distanceTo(entity.position).toFixed(1)
      : '0.0';
    const health = entity.health !== undefined
      ? Number(entity.health).toFixed(1)
      : '未知';

    return {
      name,
      positionText: `X=${Number(pos.x).toFixed(1)} Y=${Number(pos.y).toFixed(1)} Z=${Number(pos.z).toFixed(1)}`,
      distanceText: `${distance} 格`,
      healthText: String(health),
      uuid: entity.uuid || ''
    };
  }

  reportEntity(entity) {
    const summary = this.getEntitySummary(entity);
    this.log(
      `发现新实体 ${summary.name} pos=${summary.positionText} distance=${summary.distanceText} health=${summary.healthText} uuid=${summary.uuid}`
    );

    this.reportedEntities.add(summary.uuid);
    this.appendReportedUUID(summary.uuid);
    this.syncReportedUUIDs();

    if (this.bot && typeof this.bot.chat === 'function') {
      this.bot.chat(`实体刷新: ${summary.name} 坐标: ${summary.positionText}`);
    }
  }

  scanMonitoredEntities() {
    if (!this.bot || !this.bot.entity) return;

    this.syncReportedUUIDs();

    const entities = Object.values(this.bot.entities || {});
    for (const entity of entities) {
      if (!this.isMonitoredEntity(entity)) continue;
      if (!entity.uuid || this.reportedEntities.has(entity.uuid)) continue;
      this.reportEntity(entity);
    }
  }

  startMonitoring() {
    if (!this.bot || !this.bot.entity || !this.isEnabled()) return;

    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
    }

    this.scanMonitoredEntities();
    this.monitoringInterval = setInterval(() => {
      this.scanMonitoredEntities();
    }, this.getIntervalMs());

    this.log(`started intervalMs=${this.getIntervalMs()}`);
  }
}

module.exports = {
  MonitoringFeature
};
