const fs = require('fs');

// 默认不信任任何玩家：公开占位名会被他人改名冒充，真实名单必须在
// 实例 config.json / default.config.json 或 trustedPlayersFile 中显式指定。
const DEFAULT_TRUSTED_PLAYERS = [];

function normalizePlayerName(value) {
  return String(value || '').trim();
}

function mergePlayerLists(...lists) {
  const output = [];
  const seen = new Set();

  for (const list of lists) {
    if (!Array.isArray(list)) continue;

    for (const value of list) {
      const name = normalizePlayerName(value);
      if (!name) continue;

      const key = name.toLowerCase();
      if (seen.has(key)) continue;

      seen.add(key);
      output.push(name);
    }
  }

  return output;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function getDefaultScriptSchedulerTaskConfig() {
  return {
    Task_Name: '',
    Trigger_On_First_Login: false,
    Trigger_On_Login: false,
    Trigger_On_Login_Delay_Seconds: 0,
    Trigger_On_Times: {
      Enable: false,
      Times: []
    },
    Trigger_On_Interval: {
      Enable: false,
      MinTime: 1,
      MaxTime: 1,
      Unit: 'seconds'
    },
    Action: ''
  };
}

function getDefaultScriptSchedulerConfig() {
  return {
    Enabled: false,
    TaskList: []
  };
}

function normalizeSchedulerTimeString(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!/^\d{1,2}:\d{2}:\d{2}$/.test(text)) return null;

  const [hours, minutes, seconds] = text.split(':').map((part) => Number.parseInt(part, 10));
  if (
    Number.isNaN(hours) || Number.isNaN(minutes) || Number.isNaN(seconds) ||
    hours < 0 || hours > 23 ||
    minutes < 0 || minutes > 59 ||
    seconds < 0 || seconds > 59
  ) {
    return null;
  }

  return [
    String(hours).padStart(2, '0'),
    String(minutes).padStart(2, '0'),
    String(seconds).padStart(2, '0')
  ].join(':');
}

function normalizeNonNegativeNumber(value, fallbackValue) {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallbackValue;
  return parsed;
}

function normalizeBoolean(value, fallbackValue) {
  if (value === true) return true;
  if (value === false) return false;
  return fallbackValue;
}

function normalizeInteger(value, fallbackValue) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : fallbackValue;
}

function normalizeWarehouseConfig(warehouseConfig, defaultConfig) {
  const safe = isPlainObject(warehouseConfig) ? warehouseConfig : {};

  return {
    enabled: normalizeBoolean(safe.enabled, defaultConfig.enabled),
    rulesFile: typeof safe.rulesFile === 'string' && safe.rulesFile.trim()
      ? safe.rulesFile.trim()
      : defaultConfig.rulesFile
  };
}

function normalizeSchedulerIntervalUnit(value) {
  const normalizedValue = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (['second', 'seconds', 'sec', 'secs', 's'].includes(normalizedValue)) return 'seconds';
  if (['hour', 'hours', 'hr', 'hrs', 'h'].includes(normalizedValue)) return 'hours';
  return 'seconds';
}

function normalizeScriptSchedulerTaskConfig(taskConfig, index) {
  const defaultTaskConfig = getDefaultScriptSchedulerTaskConfig();
  const safeTaskConfig = isPlainObject(taskConfig) ? taskConfig : {};
  const mergedTaskConfig = {
    ...defaultTaskConfig,
    ...safeTaskConfig,
    Trigger_On_Times: {
      ...defaultTaskConfig.Trigger_On_Times,
      ...(isPlainObject(safeTaskConfig.Trigger_On_Times) ? safeTaskConfig.Trigger_On_Times : {})
    },
    Trigger_On_Interval: {
      ...defaultTaskConfig.Trigger_On_Interval,
      ...(isPlainObject(safeTaskConfig.Trigger_On_Interval) ? safeTaskConfig.Trigger_On_Interval : {})
    }
  };

  mergedTaskConfig.Task_Name = typeof mergedTaskConfig.Task_Name === 'string' && mergedTaskConfig.Task_Name.trim()
    ? mergedTaskConfig.Task_Name.trim()
    : `Task ${index + 1}`;
  mergedTaskConfig.Action = typeof mergedTaskConfig.Action === 'string'
    ? mergedTaskConfig.Action.trim()
    : '';
  mergedTaskConfig.Trigger_On_First_Login = mergedTaskConfig.Trigger_On_First_Login === true;
  mergedTaskConfig.Trigger_On_Login = mergedTaskConfig.Trigger_On_Login === true;
  mergedTaskConfig.Trigger_On_Login_Delay_Seconds = normalizeNonNegativeNumber(
    mergedTaskConfig.Trigger_On_Login_Delay_Seconds,
    defaultTaskConfig.Trigger_On_Login_Delay_Seconds
  );
  mergedTaskConfig.Trigger_On_Times.Enable = mergedTaskConfig.Trigger_On_Times.Enable === true;
  mergedTaskConfig.Trigger_On_Interval.Enable = mergedTaskConfig.Trigger_On_Interval.Enable === true;
  mergedTaskConfig.Trigger_On_Interval.Unit = normalizeSchedulerIntervalUnit(
    mergedTaskConfig.Trigger_On_Interval.Unit
  );

  const normalizedTimes = Array.isArray(mergedTaskConfig.Trigger_On_Times.Times)
    ? mergedTaskConfig.Trigger_On_Times.Times.map(normalizeSchedulerTimeString).filter(Boolean)
    : [];

  mergedTaskConfig.Trigger_On_Times.Times = Array.from(new Set(normalizedTimes));

  const minTime = normalizeNonNegativeNumber(
    mergedTaskConfig.Trigger_On_Interval.MinTime,
    defaultTaskConfig.Trigger_On_Interval.MinTime
  );
  const maxTime = normalizeNonNegativeNumber(
    mergedTaskConfig.Trigger_On_Interval.MaxTime,
    minTime
  );

  mergedTaskConfig.Trigger_On_Interval.MinTime = Math.min(minTime, maxTime);
  mergedTaskConfig.Trigger_On_Interval.MaxTime = Math.max(minTime, maxTime);

  return mergedTaskConfig;
}

function normalizeScriptSchedulerConfig(schedulerConfig) {
  const defaultSchedulerConfig = getDefaultScriptSchedulerConfig();
  const safeSchedulerConfig = isPlainObject(schedulerConfig) ? schedulerConfig : {};

  return {
    ...defaultSchedulerConfig,
    ...safeSchedulerConfig,
    Enabled: safeSchedulerConfig.Enabled === true,
    TaskList: Array.isArray(safeSchedulerConfig.TaskList)
      ? safeSchedulerConfig.TaskList.map((taskConfig, index) => normalizeScriptSchedulerTaskConfig(taskConfig, index))
      : []
  };
}

function getDefaultLegacyConfig() {
  return {
    trustedPlayers: DEFAULT_TRUSTED_PLAYERS.slice(),
    trustedPlayersMergeParent: false,
    trustedPlayersFile: null,
    autoRestart: 0,
    teleport: {
      mode: 'whitelist',
      whitelistFile: 'whitelist.txt'
    },
    logging: {
      logToFile: true,
      logFilePath: './assn_chat.log',
      logPlayerList: true,
      playerListPath: './assn_playerList.log',
      playerListIntervalMinutes: 1
    },
    behavior: {
      enableSpawnActions: false,
      whitelistReloadMinutes: 30,
      enableResourcePack: false
    },
    capabilities: {
      entityHandling: true,
      terrainHandling: true
    },
    display: {
      consoleUseAnsi: false
    },
    fish: false,
    ScriptScheduler: getDefaultScriptSchedulerConfig(),
    attack: {
      autoAttack: false,
      attackRange: 3,
      attackInterval: 2000,
      targetFilter: {
        excludePlayers: false,
        excludeItems: true,
        targetTypes: []
      }
    },
    blockBreakDetection: {
      enabled: false,
      alertTrustedPlayers: [],
      excludeCreativeMode: true,
      logToConsole: true,
      logToFile: false,
      logFilePath: './block-break.log',
      monitoredBlocks: []
    },
    monitoring: {
      enabled: false,
      intervalSeconds: 10,
      targetTypes: [
        'minecraft:wandering_trader',
        'minecraft:trader_llama'
      ]
    },
    recording: {
      enabled: false,
      bootstrapWindowTicks: 20,
      bootstrapTimeoutMs: 5000,
      includeWorldSnapshot: true,
      includeMinimalLocalPlayer: true,
      debug: false,
      debugLogFileEnabled: false,
      debugLogFilePath: './flashback_debug.log',
      debugChunkCapture: false,
      debugChunkCaptureLimit: 20,
      entityScope: 'all_visible',
      equipmentScope: 'all_with_equipment',
      includeTimeUpdates: true,
      includeWeatherState: true,
      includeDifficulty: true,
      includeSpawnPosition: true,
      includeWorldBorder: true,
      includeBlockEntityUpdates: true,
      includeLaterChunkLoads: true,
      includeParticles: true,
      includeCollectAnimation: true,
      includeHurtAnimation: true,
      includeBossBar: true,
      includeScoreboard: true,
      includeTabListHeaderFooter: true,
      includeMapData: true,
      chunkDurationTicks: 6000,
      archiveRotationEnabled: true,
      archiveNominalMinutes: 60,
      archiveOverlapMinutes: 5,
      recoverPendingArchivesOnStart: true,
      shutdownExportTimeoutMs: 60000,
      enableChunkCache: true,
      continueAcrossDimensions: true,
      debugDroppedPackets: false
    },
    warehouse: {
      enabled: false,
      rulesFile: 'rules.json'
    }
  };
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

function readRawLegacyConfig(filePath, warningLabel = 'legacy config') {
  if (!filePath || !fs.existsSync(filePath)) {
    return {};
  }

  try {
    const rawText = fs.readFileSync(filePath, 'utf8');
    if (!String(rawText).trim()) {
      return {};
    }

    const parsed = JSON.parse(rawText);
    return isPlainObject(parsed) ? parsed : {};
  } catch (error) {
    console.warn(`[MULTIBOT] failed to load ${warningLabel}: ${filePath} ${error.message}`);
    return {};
  }
}

function normalizeLegacyConfig(rawConfig, defaultConfig = getDefaultLegacyConfig()) {
  return {
    ...defaultConfig,
    ...rawConfig,
    trustedPlayersMergeParent: normalizeBoolean(
      rawConfig.trustedPlayersMergeParent,
      defaultConfig.trustedPlayersMergeParent
    ),
    autoRestart: normalizeNonNegativeNumber(rawConfig.autoRestart, defaultConfig.autoRestart),
    teleport: {
      ...defaultConfig.teleport,
      ...(isPlainObject(rawConfig.teleport) ? rawConfig.teleport : {})
    },
    logging: {
      ...defaultConfig.logging,
      ...(isPlainObject(rawConfig.logging) ? rawConfig.logging : {})
    },
    behavior: {
      ...defaultConfig.behavior,
      ...(isPlainObject(rawConfig.behavior) ? rawConfig.behavior : {})
    },
    capabilities: {
      ...defaultConfig.capabilities,
      ...(isPlainObject(rawConfig.capabilities) ? rawConfig.capabilities : {}),
      entityHandling: normalizeBoolean(
        rawConfig.capabilities?.entityHandling,
        defaultConfig.capabilities.entityHandling
      ),
      terrainHandling: normalizeBoolean(
        rawConfig.capabilities?.terrainHandling,
        defaultConfig.capabilities.terrainHandling
      )
    },
    display: {
      ...defaultConfig.display,
      ...(isPlainObject(rawConfig.display) ? rawConfig.display : {})
    },
    fish: rawConfig.fish !== undefined ? rawConfig.fish === true : defaultConfig.fish,
    ScriptScheduler: normalizeScriptSchedulerConfig(rawConfig.ScriptScheduler),
    attack: {
      ...defaultConfig.attack,
      ...(isPlainObject(rawConfig.attack) ? rawConfig.attack : {}),
      targetFilter: {
        ...defaultConfig.attack.targetFilter,
        ...(isPlainObject(rawConfig.attack?.targetFilter) ? rawConfig.attack.targetFilter : {})
      }
    },
    blockBreakDetection: {
      ...defaultConfig.blockBreakDetection,
      ...(isPlainObject(rawConfig.blockBreakDetection) ? rawConfig.blockBreakDetection : {})
    },
    monitoring: {
      ...defaultConfig.monitoring,
      ...(isPlainObject(rawConfig.monitoring) ? rawConfig.monitoring : {})
    },
    recording: {
      ...defaultConfig.recording,
      ...(isPlainObject(rawConfig.recording) ? rawConfig.recording : {})
    },
    warehouse: normalizeWarehouseConfig(rawConfig.warehouse, defaultConfig.warehouse)
  };
}

function loadLegacyBotConfig(legacyConfigPath, options = {}) {
  const defaultConfig = getDefaultLegacyConfig();
  const inheritedRawConfig = readRawLegacyConfig(options.inheritedConfigPath, 'default legacy config');
  const instanceRawConfig = readRawLegacyConfig(legacyConfigPath, 'legacy config');
  const mergedRawConfig = deepMerge(inheritedRawConfig, instanceRawConfig);

  if (
    mergedRawConfig.trustedPlayersMergeParent === true &&
    (Array.isArray(inheritedRawConfig.trustedPlayers) || Array.isArray(instanceRawConfig.trustedPlayers))
  ) {
    mergedRawConfig.trustedPlayers = mergePlayerLists(
      inheritedRawConfig.trustedPlayers,
      instanceRawConfig.trustedPlayers
    );
  }

  return normalizeLegacyConfig(mergedRawConfig, defaultConfig);
}

module.exports = {
  loadLegacyBotConfig,
  getDefaultLegacyConfig
};
