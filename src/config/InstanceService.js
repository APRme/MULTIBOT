const fs = require('fs');
const path = require('path');
const { resolveBotPaths } = require('./resolveBotPaths');
const { readJsonFile, buildDiscoveredBotConfig } = require('./loadMasterConfig');

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function createHttpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function sanitizeSegment(value, label) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) {
    throw createHttpError(400, `${label} is required`);
  }

  if (
    text.includes('/') ||
    text.includes('\\') ||
    text === '.' ||
    text === '..' ||
    path.basename(text) !== text
  ) {
    throw createHttpError(400, `${label} is invalid`);
  }

  return text;
}

function deepMerge(baseValue, overrideValue) {
  if (!isPlainObject(baseValue)) {
    return isPlainObject(overrideValue) ? { ...overrideValue } : overrideValue;
  }

  const output = { ...baseValue };
  if (!isPlainObject(overrideValue)) {
    return output;
  }

  for (const [key, value] of Object.entries(overrideValue)) {
    if (isPlainObject(value) && isPlainObject(output[key])) {
      output[key] = deepMerge(output[key], value);
      continue;
    }

    output[key] = value;
  }

  return output;
}

function writeJsonFile(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    fs.renameSync(temporaryPath, filePath);
  } finally {
    if (fs.existsSync(temporaryPath)) {
      fs.unlinkSync(temporaryPath);
    }
  }
}

function captureFile(filePath) {
  return {
    filePath,
    existed: Boolean(filePath && fs.existsSync(filePath)),
    content: filePath && fs.existsSync(filePath) ? fs.readFileSync(filePath) : null
  };
}

function restoreFile(snapshot) {
  if (!snapshot || !snapshot.filePath) return;
  if (!snapshot.existed) {
    if (fs.existsSync(snapshot.filePath)) fs.unlinkSync(snapshot.filePath);
    return;
  }

  fs.mkdirSync(path.dirname(snapshot.filePath), { recursive: true });
  const temporaryPath = `${snapshot.filePath}.${process.pid}.${Date.now()}.restore`;
  try {
    fs.writeFileSync(temporaryPath, snapshot.content);
    fs.renameSync(temporaryPath, snapshot.filePath);
  } finally {
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
  }
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

class InstanceService {
  constructor(options = {}) {
    this.masterConfig = options.masterConfig;
    this.botManager = options.botManager;
  }

  getBotsRoot() {
    const appRoot = this.masterConfig.appRoot || path.join(this.masterConfig.repoRoot, 'tests', 'MULTIBOT');
    const botsRoot = this.masterConfig.discovery && typeof this.masterConfig.discovery.botsRoot === 'string'
      ? this.masterConfig.discovery.botsRoot
      : './BOTS';

    return path.resolve(appRoot, botsRoot);
  }

  getPaths(serverDir, botDir) {
    return resolveBotPaths({
      repoRoot: this.masterConfig.repoRoot,
      appRoot: this.masterConfig.appRoot,
      serverDirName: sanitizeSegment(serverDir, 'serverDir'),
      botDirName: sanitizeSegment(botDir, 'botDir')
    });
  }

  ensureBotDirExists(paths) {
    if (!fs.existsSync(paths.botDir)) {
      throw createHttpError(404, `instance not found: ${paths.serverDirName}/${paths.botDirName}`);
    }
  }

  getServerDirectories() {
    const botsRoot = this.getBotsRoot();
    if (!fs.existsSync(botsRoot)) {
      return [];
    }

    return fs.readdirSync(botsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));
  }

  getBotDirectories(serverDirName) {
    const serverPath = path.join(this.getBotsRoot(), serverDirName);
    if (!fs.existsSync(serverPath)) {
      return [];
    }

    return fs.readdirSync(serverPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));
  }

  buildInstanceResponse(botConfig, options = {}) {
    const { includeFiles = false } = options;
    const runtime = this.botManager && typeof this.botManager.getBotByInstance === 'function'
      ? this.botManager.getBotByInstance(botConfig.serverDir, botConfig.botDir)
      : null;
    const runtimeDetails = runtime ? runtime.getDetails() : null;
    const response = {
      id: botConfig.id,
      serverDir: botConfig.serverDir,
      botDir: botConfig.botDir,
      sourceType: botConfig.paths.sourceType,
      enabled: botConfig.enabled,
      autoStart: botConfig.autoStart,
      host: botConfig.host,
      port: botConfig.port,
      username: botConfig.username,
      state: runtimeDetails ? runtimeDetails.state : 'unloaded',
      paths: {
        botDir: botConfig.paths.botDir,
        botConfigPath: botConfig.paths.legacyConfigPath,
        defaultBotConfigPath: botConfig.paths.defaultLegacyConfigPath,
        serverConfigPath: botConfig.paths.serverConfigPath,
        whitelistPath: botConfig.paths.whitelistPath,
        authCacheDir: botConfig.paths.authCacheDir
      },
      bot: runtimeDetails
    };

    if (includeFiles) {
      response.serverConfig = readJsonFile(botConfig.paths.serverConfigPath, {});
      response.defaultBotConfig = readJsonFile(botConfig.paths.defaultLegacyConfigPath, {});
      response.botConfig = readJsonFile(botConfig.paths.legacyConfigPath, {});
      response.legacyConfig = botConfig.legacyConfig;
    }

    return response;
  }

  buildBotConfig(serverDir, botDir) {
    return buildDiscoveredBotConfig({
      repoRoot: this.masterConfig.repoRoot,
      appRoot: this.masterConfig.appRoot,
      defaults: this.masterConfig.defaults,
      serverDirName: serverDir,
      botDirName: botDir
    });
  }

  listInstances() {
    const instances = [];

    for (const serverDirName of this.getServerDirectories()) {
      for (const botDirName of this.getBotDirectories(serverDirName)) {
        const botConfig = this.buildBotConfig(serverDirName, botDirName);
        instances.push(this.buildInstanceResponse(botConfig));
      }
    }

    return instances;
  }

  getInstance(serverDir, botDir) {
    const paths = this.getPaths(serverDir, botDir);
    this.ensureBotDirExists(paths);

    const botConfig = this.buildBotConfig(paths.serverDirName, paths.botDirName);
    return this.buildInstanceResponse(botConfig, { includeFiles: true });
  }

  async syncBotConfig(botConfig, options = {}) {
    if (!this.botManager || typeof this.botManager.addOrReplaceBotConfig !== 'function') {
      return null;
    }

    return this.botManager.addOrReplaceBotConfig(botConfig, options);
  }

  async syncServerDirectory(serverDirName, options = {}) {
    const affectedBotIds = [];

    for (const botDirName of this.getBotDirectories(serverDirName)) {
      const botConfig = this.buildBotConfig(serverDirName, botDirName);
      await this.syncBotConfig(botConfig, options);
      affectedBotIds.push(botConfig.id);
    }

    return affectedBotIds;
  }

  async restoreRuntimeConfigs(configs) {
    for (const entry of Array.isArray(configs) ? configs : []) {
      try {
        await this.syncBotConfig(entry.config, {
          reason: 'config_rollback',
          inheritRunning: true,
          start: entry.shouldRun === true
        });
      } catch (error) {
        // Preserve the original operation error; rollback is best effort.
      }
    }
  }

  async createInstance(payload = {}) {
    const serverDirName = sanitizeSegment(payload.serverDir, 'serverDir');
    const botDirName = sanitizeSegment(payload.botDir, 'botDir');
    const paths = this.getPaths(serverDirName, botDirName);
    const hadExistingBots = this.getBotDirectories(serverDirName).length > 0;

    if (fs.existsSync(paths.botDir)) {
      throw createHttpError(409, `instance already exists: ${serverDirName}/${botDirName}`);
    }

    const serverConfig = isPlainObject(payload.server) ? payload.server : {};
    const botConfig = isPlainObject(payload.bot) ? payload.bot : {};
    const hasDefaultBotConfig = hasOwn(payload, 'defaultBotConfig');
    if (hasDefaultBotConfig && !isPlainObject(payload.defaultBotConfig)) {
      throw createHttpError(400, 'defaultBotConfig must be an object');
    }
    const defaultBotConfig = hasDefaultBotConfig ? payload.defaultBotConfig : null;
    const serverExists = fs.existsSync(paths.serverDir);
    const serverConfigExists = fs.existsSync(paths.serverConfigPath);
    const snapshots = [captureFile(paths.serverConfigPath), captureFile(paths.legacyConfigPath)];
    if (hasDefaultBotConfig) snapshots.push(captureFile(paths.defaultLegacyConfigPath));
    const previousRuntimeConfigs = this.getBotDirectories(serverDirName).map((name) => {
      const config = this.buildBotConfig(serverDirName, name);
      const runtime = this.botManager && this.botManager.getBotByInstance(serverDirName, name);
      return { config, shouldRun: Boolean(runtime && runtime.desiredRunning === true) };
    });

    if (!serverExists && !Object.keys(serverConfig).length) {
      throw createHttpError(400, 'server config is required when creating a new serverDir');
    }

    if (!serverConfigExists && !Object.keys(serverConfig).length) {
      throw createHttpError(400, 'server config is required when server.json does not exist');
    }

    if (!String(botConfig.username || botConfig.email || '').trim()) {
      throw createHttpError(400, 'bot.username or bot.email is required');
    }

    try {
      fs.mkdirSync(paths.botDir, { recursive: true });

      const nextServerConfig = serverConfigExists
        ? deepMerge(readJsonFile(paths.serverConfigPath, {}), serverConfig)
        : { ...serverConfig };
      writeJsonFile(paths.serverConfigPath, nextServerConfig);
      if (hasDefaultBotConfig) writeJsonFile(paths.defaultLegacyConfigPath, defaultBotConfig);
      writeJsonFile(paths.legacyConfigPath, botConfig);

      const builtBotConfig = this.buildBotConfig(serverDirName, botDirName);
      if (hasDefaultBotConfig && hadExistingBots) {
        await this.syncServerDirectory(serverDirName, {
          reason: 'instance_default_bot_update',
          inheritRunning: true
        });

        if (this.botManager) {
          const runtime = this.botManager.getBotByInstance(serverDirName, botDirName);
          if (runtime && runtime.config.enabled !== false && runtime.state === 'stopped'
            && (payload.start === true || builtBotConfig.autoStart === true)) {
            await runtime.start();
          }
        }
      } else {
        await this.syncBotConfig(builtBotConfig, {
          reason: 'instance_create',
          respectAutoStart: true,
          start: payload.start === true
        });
      }

      return this.getInstance(serverDirName, botDirName);
    } catch (error) {
      for (const snapshot of snapshots) restoreFile(snapshot);
      if (fs.existsSync(paths.botDir)) {
        fs.rmSync(paths.botDir, { recursive: true, force: true });
      }
      await this.restoreRuntimeConfigs(previousRuntimeConfigs);
      throw error;
    }
  }

  async updateInstance(serverDir, botDir, payload = {}) {
    const paths = this.getPaths(serverDir, botDir);
    this.ensureBotDirExists(paths);

    const replaceFiles = payload.replace === true;
    const hasServerField = hasOwn(payload, 'server');
    const hasBotField = hasOwn(payload, 'bot');
    const serverPatch = isPlainObject(payload.server) ? payload.server : {};
    const botPatch = isPlainObject(payload.bot) ? payload.bot : {};
    const hasDefaultBotConfig = hasOwn(payload, 'defaultBotConfig');
    if (hasDefaultBotConfig && !isPlainObject(payload.defaultBotConfig)) {
      throw createHttpError(400, 'defaultBotConfig must be an object');
    }
    const defaultBotConfig = hasDefaultBotConfig ? payload.defaultBotConfig : null;
    const hasServerPatch = hasServerField && (replaceFiles || Object.keys(serverPatch).length > 0);
    const hasBotPatch = hasBotField && (replaceFiles || Object.keys(botPatch).length > 0);
    const snapshots = [];
    if (hasServerPatch) snapshots.push(captureFile(paths.serverConfigPath));
    if (hasBotPatch) snapshots.push(captureFile(paths.legacyConfigPath));
    if (hasDefaultBotConfig) snapshots.push(captureFile(paths.defaultLegacyConfigPath));
    const previousRuntimeConfigs = this.getBotDirectories(paths.serverDirName).map((name) => {
      const config = this.buildBotConfig(paths.serverDirName, name);
      const runtime = this.botManager && this.botManager.getBotByInstance(paths.serverDirName, name);
      return { config, shouldRun: Boolean(runtime && runtime.desiredRunning === true) };
    });

    if (!hasServerPatch && !hasBotPatch && !hasDefaultBotConfig && payload.start !== true) {
      return {
        instance: this.getInstance(paths.serverDirName, paths.botDirName),
        affectedBotIds: []
      };
    }

    try {
      if (hasServerPatch) {
        const nextServerConfig = replaceFiles ? { ...serverPatch }
          : deepMerge(readJsonFile(paths.serverConfigPath, {}), serverPatch);
        writeJsonFile(paths.serverConfigPath, nextServerConfig);
      }
      if (hasBotPatch) {
        const nextBotConfig = replaceFiles ? { ...botPatch }
          : deepMerge(readJsonFile(paths.legacyConfigPath, {}), botPatch);
        writeJsonFile(paths.legacyConfigPath, nextBotConfig);
      }
      if (hasDefaultBotConfig) writeJsonFile(paths.defaultLegacyConfigPath, defaultBotConfig);

      let affectedBotIds;
      if (hasServerPatch || hasDefaultBotConfig) {
        affectedBotIds = await this.syncServerDirectory(paths.serverDirName, {
          reason: hasServerPatch ? 'instance_server_update' : 'instance_default_bot_update',
          inheritRunning: true
        });
      } else {
        const builtBotConfig = this.buildBotConfig(paths.serverDirName, paths.botDirName);
        await this.syncBotConfig(builtBotConfig, { reason: 'instance_update', inheritRunning: true });
        affectedBotIds = [builtBotConfig.id];
      }

      if (payload.start === true && this.botManager) {
        const runtime = this.botManager.getBotByInstance(paths.serverDirName, paths.botDirName);
        if (runtime && runtime.config.enabled !== false && runtime.state === 'stopped') await runtime.start();
      }

      return { instance: this.getInstance(paths.serverDirName, paths.botDirName), affectedBotIds };
    } catch (error) {
      for (const snapshot of snapshots) restoreFile(snapshot);
      await this.restoreRuntimeConfigs(previousRuntimeConfigs);
      throw error;
    }
  }

  async deleteInstance(serverDir, botDir) {
    const paths = this.getPaths(serverDir, botDir);
    const existing = this.getInstance(paths.serverDirName, paths.botDirName);

    if (this.botManager && typeof this.botManager.removeBotByInstance === 'function') {
      await this.botManager.removeBotByInstance(paths.serverDirName, paths.botDirName, 'instance_delete');
    }

    fs.rmSync(paths.botDir, { recursive: true, force: true });

    return {
      deleted: true,
      serverPreserved: true,
      id: existing.id,
      serverDir: paths.serverDirName,
      botDir: paths.botDirName
    };
  }
}

module.exports = {
  InstanceService
};
