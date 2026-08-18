const fs = require('fs');
const net = require('net');
const path = require('path');
const { resolveBotPaths } = require('./resolveBotPaths');
const { loadLegacyBotConfig } = require('./loadLegacyBotConfig');

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readJsonFile(filePath, fallbackValue = {}) {
  if (!filePath || !fs.existsSync(filePath)) {
    return fallbackValue;
  }

  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!String(raw).trim()) {
      return fallbackValue;
    }
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`failed to parse json: ${filePath} ${error.message}`);
  }
}

function pickDefined(target, key, value) {
  if (value !== undefined) {
    target[key] = value;
  }
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

function normalizePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizePositiveNumber(value, fallback) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeNonNegativeInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function normalizeAllowedOrigins(value) {
  if (!Array.isArray(value)) {
    return [
      'http://127.0.0.1:18081',
      'http://localhost:18081'
    ];
  }

  const output = [];
  const seen = new Set();
  for (const entry of value) {
    const text = typeof entry === 'string' ? entry.trim() : '';
    if (!text) continue;

    let origin;
    try {
      const parsed = new URL(text);
      if (!['http:', 'https:'].includes(parsed.protocol)
        || (parsed.origin !== text && `${parsed.origin}/` !== text)) {
        throw new Error('origin must not include a path');
      }
      origin = parsed.origin;
    } catch (error) {
      throw new Error(`invalid api.allowedOrigins entry: ${text}`);
    }

    if (!seen.has(origin)) {
      seen.add(origin);
      output.push(origin);
    }
  }

  return output;
}

function normalizeTeleportPromptMatcherList(value, label, options = {}) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  if (value.length > 20) {
    throw new Error(`${label} must contain at most 20 rules`);
  }

  return value.map((entry, index) => {
    const source = typeof entry === 'string' ? entry.trim() : '';
    if (!source || source.length > 500) {
      throw new Error(`${label}[${index}] must be a non-empty regex up to 500 characters`);
    }
    if (!source.startsWith('^') || !source.endsWith('$')) {
      throw new Error(`${label}[${index}] must be anchored with ^ and $`);
    }
    if (options.requireSender === true && !source.includes('(?<sender>')) {
      throw new Error(`${label}[${index}] must include a named sender capture`);
    }

    try {
      new RegExp(source, 'i');
    } catch (error) {
      throw new Error(`${label}[${index}] is invalid: ${error.message}`);
    }
    return source;
  });
}

function normalizeTeleportPromptMatchers(value) {
  if (value !== undefined && !isPlainObject(value)) {
    throw new Error('server.teleportPromptMatchers must be an object');
  }
  const source = isPlainObject(value) ? value : {};
  return {
    stripLines: normalizeTeleportPromptMatcherList(
      source.stripLines,
      'server.teleportPromptMatchers.stripLines'
    ),
    tpa: normalizeTeleportPromptMatcherList(
      source.tpa,
      'server.teleportPromptMatchers.tpa',
      { requireSender: true }
    ),
    tpahere: normalizeTeleportPromptMatcherList(
      source.tpahere,
      'server.teleportPromptMatchers.tpahere',
      { requireSender: true }
    )
  };
}

const OPEN_AUTH_CONNECTION_FIELDS = ['host', 'port', 'auth', 'version'];
const DEFAULT_OPEN_AUTH_CONFIG = Object.freeze({
  enabled: false,
  requestTimeoutMs: 4500
});

function normalizeOpenAuthTimeout(value) {
  if (value === undefined) {
    return DEFAULT_OPEN_AUTH_CONFIG.requestTimeoutMs;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1000 || parsed > 5000) {
    throw new Error('server.openAuth.requestTimeoutMs must be an integer from 1000 to 5000');
  }
  return parsed;
}

function normalizeOpenAuthConfig(value, serverConnectionOverrides = {}) {
  if (value !== undefined && !isPlainObject(value)) {
    throw new Error('server.openAuth must be an object');
  }

  const source = isPlainObject(value) ? value : {};
  const normalized = {
    enabled: source.enabled === true,
    requestTimeoutMs: normalizeOpenAuthTimeout(source.requestTimeoutMs)
  };

  if (!normalized.enabled) {
    return normalized;
  }

  const connection = isPlainObject(serverConnectionOverrides)
    ? serverConnectionOverrides
    : {};
  const missingField = OPEN_AUTH_CONNECTION_FIELDS.find((fieldName) => {
    return connection[fieldName] === undefined || connection[fieldName] === null;
  });
  if (missingField) {
    throw new Error(`server.openAuth requires server connection field: ${missingField}`);
  }

  const host = typeof connection.host === 'string' ? connection.host.trim() : '';
  if (!host) {
    throw new Error('server.openAuth requires a non-empty server host');
  }
  if (
    /[\s\\/?#@%]/.test(host) ||
    host.includes('://') ||
    (host.includes(':') && net.isIP(host) !== 6)
  ) {
    throw new Error('server.openAuth host must be a hostname or IP address, not a URL');
  }

  const port = Number(connection.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('server.openAuth requires a valid server port');
  }

  if (connection.auth !== 'microsoft') {
    throw new Error('server.openAuth requires server auth to be microsoft');
  }

  if (connection.version !== '1.21.11') {
    throw new Error('server.openAuth requires server version 1.21.11');
  }

  return normalized;
}

function normalizeRestartDelaySchedule(value) {
  if (value === undefined) {
    return null;
  }

  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('server.restartDelayScheduleMs must be a non-empty array of non-negative integers');
  }

  const output = [];
  for (const entry of value) {
    if (!Number.isInteger(entry) || entry < 0) {
      throw new Error('server.restartDelayScheduleMs must be a non-empty array of non-negative integers');
    }
    output.push(entry);
  }

  return output;
}

function normalizeRestartDelayScheduleRepeatLast(value) {
  if (value === undefined) {
    return true;
  }

  if (typeof value !== 'boolean') {
    throw new Error('server.restartDelayScheduleRepeatLast must be a boolean');
  }

  return value;
}

function normalizeServerRestartSchedule(serverConfig) {
  const source = isPlainObject(serverConfig) ? serverConfig : {};
  return {
    restartDelayScheduleMs: normalizeRestartDelaySchedule(source.restartDelayScheduleMs),
    restartDelayScheduleRepeatLast: normalizeRestartDelayScheduleRepeatLast(
      source.restartDelayScheduleRepeatLast
    )
  };
}

function lockOpenAuthConnectionFields(baseOverrides, serverConnectionOverrides, openAuth) {
  if (!openAuth || openAuth.enabled !== true) {
    return baseOverrides;
  }

  const locked = { ...baseOverrides };
  for (const fieldName of OPEN_AUTH_CONNECTION_FIELDS) {
    locked[fieldName] = fieldName === 'host'
      ? String(serverConnectionOverrides[fieldName]).trim()
      : serverConnectionOverrides[fieldName];
  }
  return locked;
}

function normalizeProtocolGuardConfig(rawConfig) {
  const source = isPlainObject(rawConfig) ? rawConfig : {};

  return {
    enabled: source.enabled !== false,
    ignoreMalformedNbtArrayPackets: source.ignoreMalformedNbtArrayPackets !== false,
    burstLimit: normalizePositiveInteger(source.burstLimit, 20),
    burstWindowMs: normalizePositiveInteger(source.burstWindowMs, 60000),
    logParseErrors: source.logParseErrors !== false
  };
}

function normalizeDiagnosticsConfig(rawConfig) {
  const source = isPlainObject(rawConfig) ? rawConfig : {};
  const memoryLoggerSource = isPlainObject(source.memoryLogger) ? source.memoryLogger : {};
  const memoryDetailsSource = isPlainObject(source.memoryDetails) ? source.memoryDetails : {};
  const apiAccessLoggerSource = isPlainObject(source.apiAccessLogger) ? source.apiAccessLogger : {};
  const lifecycleLoggerSource = isPlainObject(source.lifecycleLogger) ? source.lifecycleLogger : {};
  const filePath = typeof memoryLoggerSource.filePath === 'string' && memoryLoggerSource.filePath.trim()
    ? memoryLoggerSource.filePath.trim()
    : './logs/memory-monitor.log';
  const apiAccessFilePath = typeof apiAccessLoggerSource.filePath === 'string' && apiAccessLoggerSource.filePath.trim()
    ? apiAccessLoggerSource.filePath.trim()
    : './logs/api-access.log';
  const lifecycleFilePath = typeof lifecycleLoggerSource.filePath === 'string' && lifecycleLoggerSource.filePath.trim()
    ? lifecycleLoggerSource.filePath.trim()
    : './logs/lifecycle.log';

  return {
    memoryLogger: {
      enabled: memoryLoggerSource.enabled === true,
      intervalMs: normalizePositiveInteger(memoryLoggerSource.intervalMs, 10000),
      filePath
    },
    memoryDetails: {
      enabled: memoryDetailsSource.enabled === true
    },
    apiAccessLogger: {
      enabled: apiAccessLoggerSource.enabled !== false,
      filePath: apiAccessFilePath,
      logToConsole: apiAccessLoggerSource.logToConsole === true,
      includeHeaders: apiAccessLoggerSource.includeHeaders !== false,
      includeBodyPreview: apiAccessLoggerSource.includeBodyPreview === true
    },
    lifecycleLogger: {
      enabled: lifecycleLoggerSource.enabled !== false,
      filePath: lifecycleFilePath,
      logToConsole: lifecycleLoggerSource.logToConsole === true
    }
  };
}

function normalizeAggregateLoggingConfig(rawConfig) {
  const source = isPlainObject(rawConfig) ? rawConfig : {};

  return {
    enabled: source.enabled === true,
    chat: source.chat !== false,
    playerList: source.playerList !== false,
    chatBatchWindowMs: normalizePositiveInteger(source.chatBatchWindowMs, 100),
    playerListIntervalMinutes: normalizePositiveNumber(source.playerListIntervalMinutes, 1)
  };
}

function normalizeConsoleConnectorConfig(rawConfig) {
  const source = isPlainObject(rawConfig) ? rawConfig : {};

  return {
    historyLimit: normalizePositiveInteger(source.historyLimit, 300)
  };
}

function extractRuntimeOverrides(source) {
  const output = {};
  const safeSource = isPlainObject(source) ? source : {};
  const connection = isPlainObject(safeSource.connection) ? safeSource.connection : {};

  const fieldNames = [
    'id',
    'enabled',
    'autoStart',
    'host',
    'port',
    'auth',
    'version',
    'username',
    'email',
    'viewDistance',
    'disableChatSigning',
    'checkTimeoutInterval',
    'restartOnDisconnect',
    'restartDelayMs',
    'restartJitterMs'
  ];

  for (const fieldName of fieldNames) {
    pickDefined(output, fieldName, safeSource[fieldName]);
  }

  for (const fieldName of fieldNames) {
    pickDefined(output, fieldName, connection[fieldName]);
  }

  return output;
}

function readMergedBotSourceConfig(paths) {
  const sharedBotConfig = readJsonFile(paths.defaultLegacyConfigPath, {});
  const botConfig = readJsonFile(paths.legacyConfigPath, {});
  return deepMerge(sharedBotConfig, botConfig);
}

function buildBotConfig(options = {}) {
  const {
    repoRoot,
    appRoot,
    defaults,
    botOverrides,
    paths,
    legacyConfig,
    teleportPromptMatchers,
    openAuth,
    serverDirName,
    botDirName
  } = options;
  const merged = {
    ...defaults,
    ...botOverrides
  };

  const id = String(merged.id || `${serverDirName || 'legacy'}__${botDirName || paths.accountDirName}`).trim();
  if (!id) {
    throw new Error('bot id is required');
  }

  return {
    id,
    enabled: merged.enabled !== false,
    autoStart: merged.autoStart === true,
    accountDir: paths.accountDirName,
    serverDir: serverDirName || null,
    botDir: botDirName || paths.accountDirName,
    host: merged.host,
    port: Number.parseInt(merged.port, 10) || 25565,
    auth: merged.auth || 'microsoft',
    version: merged.version || false,
    username: merged.username || merged.email,
    email: merged.email || merged.username,
    viewDistance: merged.viewDistance || 'tiny',
    disableChatSigning: merged.disableChatSigning !== false,
    checkTimeoutInterval: normalizePositiveInteger(merged.checkTimeoutInterval, 30000),
    restartOnDisconnect: merged.restartOnDisconnect !== false,
    restartDelayMs: normalizeNonNegativeInteger(merged.restartDelayMs, 60000),
    restartJitterMs: normalizeNonNegativeInteger(merged.restartJitterMs, 120000),
    restartDelayScheduleMs: options.restartDelayScheduleMs === undefined
      ? null
      : options.restartDelayScheduleMs,
    restartDelayScheduleRepeatLast: options.restartDelayScheduleRepeatLast !== false,
    teleportPromptMatchers: normalizeTeleportPromptMatchers(teleportPromptMatchers),
    openAuth: isPlainObject(openAuth)
      ? {
        enabled: openAuth.enabled === true,
        requestTimeoutMs: normalizeOpenAuthTimeout(openAuth.requestTimeoutMs)
      }
      : { ...DEFAULT_OPEN_AUTH_CONFIG },
    paths,
    legacyConfig
  };
}

function loadExplicitBots(options = {}) {
  const { rawBots, repoRoot, appRoot, defaults } = options;
  const bots = Array.isArray(rawBots) ? rawBots : [];

  return bots.map((botConfig, index) => {
    if (!botConfig || typeof botConfig !== 'object') {
      throw new Error(`bots[${index}] must be an object`);
    }

    const accountDir = String(botConfig.accountDir || '').trim();
    const serverDirName = String(botConfig.serverDir || '').trim();
    const botDirName = String(botConfig.botDir || '').trim();
    let paths;

    if (accountDir) {
      paths = resolveBotPaths({
        repoRoot,
        appRoot,
        accountDirName: accountDir
      });
    } else if (serverDirName && botDirName) {
      paths = resolveBotPaths({
        repoRoot,
        appRoot,
        serverDirName,
        botDirName
      });
    } else {
      throw new Error(`bots[${index}] requires accountDir or serverDir+botDir`);
    }

    const serverConfig = paths.serverConfigPath ? readJsonFile(paths.serverConfigPath, {}) : {};
    const serverOverrides = extractRuntimeOverrides(serverConfig);
    const openAuth = normalizeOpenAuthConfig(serverConfig.openAuth, serverOverrides);
    const restartSchedule = normalizeServerRestartSchedule(serverConfig);
    const effectiveBotOverrides = lockOpenAuthConnectionFields(
      botConfig,
      serverOverrides,
      openAuth
    );

    return buildBotConfig({
      repoRoot,
      appRoot,
      defaults,
      botOverrides: effectiveBotOverrides,
      paths,
      legacyConfig: loadLegacyBotConfig(paths.legacyConfigPath, {
        inheritedConfigPath: paths.defaultLegacyConfigPath
      }),
      teleportPromptMatchers: serverConfig.teleportPromptMatchers,
      openAuth,
      restartDelayScheduleMs: restartSchedule.restartDelayScheduleMs,
      restartDelayScheduleRepeatLast: restartSchedule.restartDelayScheduleRepeatLast,
      serverDirName,
      botDirName
    });
  });
}

function discoverBots(options = {}) {
  const { repoRoot, appRoot, defaults, discoveryConfig } = options;
  const safeDiscoveryConfig = isPlainObject(discoveryConfig) ? discoveryConfig : {};
  if (safeDiscoveryConfig.enabled === false) {
    return [];
  }

  const botsRoot = path.resolve(appRoot || path.join(repoRoot, 'tests', 'MULTIBOT'), safeDiscoveryConfig.botsRoot || './BOTS');
  if (!fs.existsSync(botsRoot)) {
    return [];
  }

  const serverDirs = fs.readdirSync(botsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory());
  const discoveredBots = [];

  for (const serverEntry of serverDirs) {
    const serverDirName = serverEntry.name;
    const serverDir = path.join(botsRoot, serverDirName);
    const serverConfig = readJsonFile(path.join(serverDir, 'server.json'), {});
    const serverOverrides = extractRuntimeOverrides(serverConfig);
    const openAuth = normalizeOpenAuthConfig(serverConfig.openAuth, serverOverrides);
    const restartSchedule = normalizeServerRestartSchedule(serverConfig);

    const botDirs = fs.readdirSync(serverDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory());

    for (const botEntry of botDirs) {
      const botDirName = botEntry.name;
      const paths = resolveBotPaths({
        repoRoot,
        appRoot,
        serverDirName,
        botDirName
      });
      const mergedBotConfig = readMergedBotSourceConfig(paths);
      const botOverrides = extractRuntimeOverrides(mergedBotConfig);
      const legacyConfig = loadLegacyBotConfig(paths.legacyConfigPath, {
        inheritedConfigPath: paths.defaultLegacyConfigPath
      });

      discoveredBots.push(buildBotConfig({
        repoRoot,
        appRoot,
        defaults,
        botOverrides: lockOpenAuthConnectionFields(
          {
            ...serverOverrides,
            ...botOverrides
          },
          serverOverrides,
          openAuth
        ),
        paths,
        legacyConfig,
        teleportPromptMatchers: serverConfig.teleportPromptMatchers,
        openAuth,
        restartDelayScheduleMs: restartSchedule.restartDelayScheduleMs,
        restartDelayScheduleRepeatLast: restartSchedule.restartDelayScheduleRepeatLast,
        serverDirName,
        botDirName
      }));
    }
  }

  return discoveredBots;
}

function buildDiscoveredBotConfig(options = {}) {
  const { repoRoot, appRoot, defaults, serverDirName, botDirName } = options;
  const paths = resolveBotPaths({
    repoRoot,
    appRoot,
    serverDirName,
    botDirName
  });
  const serverConfig = readJsonFile(paths.serverConfigPath, {});
  const serverOverrides = extractRuntimeOverrides(serverConfig);
  const openAuth = normalizeOpenAuthConfig(serverConfig.openAuth, serverOverrides);
  const restartSchedule = normalizeServerRestartSchedule(serverConfig);
  const mergedBotConfig = readMergedBotSourceConfig(paths);
  const botOverrides = extractRuntimeOverrides(mergedBotConfig);
  const legacyConfig = loadLegacyBotConfig(paths.legacyConfigPath, {
    inheritedConfigPath: paths.defaultLegacyConfigPath
  });

  return buildBotConfig({
    repoRoot,
    appRoot,
    defaults,
    botOverrides: lockOpenAuthConnectionFields(
      {
        ...serverOverrides,
        ...botOverrides
      },
      serverOverrides,
      openAuth
    ),
    paths,
    legacyConfig,
    teleportPromptMatchers: serverConfig.teleportPromptMatchers,
    openAuth,
    restartDelayScheduleMs: restartSchedule.restartDelayScheduleMs,
    restartDelayScheduleRepeatLast: restartSchedule.restartDelayScheduleRepeatLast,
    serverDirName,
    botDirName
  });
}

function loadMasterConfig(options = {}) {
  const { configPath, repoRoot, appRoot } = options;
  if (!configPath) throw new Error('configPath is required');
  if (!repoRoot) throw new Error('repoRoot is required');

  if (!fs.existsSync(configPath)) {
    throw new Error(`config file not found: ${configPath}`);
  }

  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const defaults = raw.defaults && typeof raw.defaults === 'object' ? raw.defaults : {};
  const api = raw.api && typeof raw.api === 'object' ? raw.api : {};
  const protocolGuard = normalizeProtocolGuardConfig(raw.protocolGuard);
  const diagnostics = normalizeDiagnosticsConfig(raw.diagnostics);
  const aggregateLogging = normalizeAggregateLoggingConfig(raw.aggregateLogging);
  const consoleConnector = normalizeConsoleConnectorConfig(raw.consoleConnector);
  const explicitBots = loadExplicitBots({
    rawBots: Array.isArray(raw.bots) ? raw.bots : [],
    repoRoot,
    appRoot,
    defaults
  });
  const discoveredBots = discoverBots({
    repoRoot,
    appRoot,
    defaults,
    discoveryConfig: raw.discovery
  });

  if (!api.token || typeof api.token !== 'string') {
    throw new Error('api.token is required');
  }

  const combinedBots = [...explicitBots, ...discoveredBots];
  const seenIds = new Set();
  for (const bot of combinedBots) {
    if (seenIds.has(bot.id)) {
      throw new Error(`duplicate bot id: ${bot.id}`);
    }
    seenIds.add(bot.id);
  }

  return {
    configPath,
    repoRoot,
    appRoot,
    api: {
      host: api.host || '127.0.0.1',
      port: Number.parseInt(api.port, 10) || 18080,
      token: api.token,
      allowedOrigins: normalizeAllowedOrigins(api.allowedOrigins),
      bodyLimitBytes: normalizePositiveInteger(api.bodyLimitBytes, 1024 * 1024),
      maxSseClients: normalizePositiveInteger(api.maxSseClients, 32)
    },
    discovery: isPlainObject(raw.discovery)
      ? { ...raw.discovery }
      : {},
    protocolGuard,
    diagnostics,
    aggregateLogging,
    consoleConnector,
    defaults,
    bots: combinedBots
  };
}

module.exports = {
  loadMasterConfig,
  normalizeProtocolGuardConfig,
  normalizeDiagnosticsConfig,
  normalizeAggregateLoggingConfig,
  normalizeConsoleConnectorConfig,
  normalizeAllowedOrigins,
  normalizeTeleportPromptMatchers,
  normalizeOpenAuthConfig,
  normalizeRestartDelaySchedule,
  normalizeRestartDelayScheduleRepeatLast,
  normalizeServerRestartSchedule,
  readJsonFile,
  extractRuntimeOverrides,
  buildBotConfig,
  discoverBots,
  buildDiscoveredBotConfig
};
