const net = require('net');
const fs = require('fs');
const path = require('path');
const mineflayer = require('mineflayer');
const { CommandContext } = require('../command/CommandContext');
const { CommandDispatcher } = require('../command/CommandDispatcher');
const { BotLogger } = require('../logging/BotLogger');
const { createAuthCacheFactory } = require('../session/createAuthCacheFactory');
const {
  OpenAuthClient,
  isLoopbackAddress,
  resolveLocalProxyHost
} = require('../session/OpenAuthClient');
const { runWithConsoleCapture } = require('../logging/ConsoleCapture');
const { RestartPolicy } = require('./RestartPolicy');
const { LIFECYCLE_EVENTS } = require('../logging/InstanceLifecycleLogService');
const { LockFeature } = require('../features/lock/LockFeature');
const { TeleportFeature } = require('../features/teleport/TeleportFeature');
const { TrustedPlayersStore } = require('../features/trustedPlayers/TrustedPlayersStore');
const { InventoryFeature } = require('../features/inventory/InventoryFeature');
const { ScriptFeature } = require('../features/script/ScriptFeature');
const { RecorderFeature } = require('../features/recording/RecorderFeature');
const { ChatFeature } = require('../features/chat/ChatFeature');
const { MovementFeature } = require('../features/movement/MovementFeature');
const { RideFeature } = require('../features/ride/RideFeature');
const { FishFeature } = require('../features/fish/FishFeature');
const { VaultFeature } = require('../features/vault/VaultFeature');
const { AttackFeature } = require('../features/attack/AttackFeature');
const { EntityInteractFeature } = require('../features/entityInteract/EntityInteractFeature');
const { BlockUseFeature } = require('../features/blockUse/BlockUseFeature');
const { BlockBreakFeature } = require('../features/blockBreak/BlockBreakFeature');
const { DigFeature } = require('../features/dig/DigFeature');
const { MonitoringFeature } = require('../features/monitoring/MonitoringFeature');
const { ActivityLogFeature } = require('../features/activityLog/ActivityLogFeature');
const { CplaceFeature } = require('../features/cplace/CplaceFeature');
const { EatFeature } = require('../features/eat/EatFeature');
const { AutoEatController } = require('../features/eat/AutoEatController');
const { TreeFarmFeature } = require('../features/treefarm/TreeFarmFeature');
const { WindowFeature } = require('../features/window/WindowFeature');
const { isIgnorableMalformedNbtArrayError } = require('../legacy/assn/protocol-guard-hotfix');
const { EventThresholdTracker } = require('../notifications/EventThresholdTracker');
const { getTimestamp } = require('../util/time');

const OPEN_AUTH_REQUEST_WATCHDOG_MS = 10000;

// 协议保护吞掉解析异常后, 多久收不到包就判定会话失联并重连(可用 protocolGuard.desyncSilenceMs 覆盖, 0 关闭)
const DEFAULT_DESYNC_SILENCE_MS = 8000;

// 空 lastSeen 窗口上报用的 checksum: 原版 LastSeenMessages.Update.IGNORE_CHECKSUM = 0,
// verifyChecksum() 里 `checksum == 0 || checksum == computeChecksum()` —— 0 表示"跳过校验",
// 因此无论服务端窗口内容如何, 这个值都被接受(比空集合的 1 更稳)。
const IGNORED_LAST_SEEN_CHECKSUM = 0;

// 取该协议版本聊天包的"已读确认窗口"字段(1.21.5+ 才有 acknowledged/checksum)。
// 返回 { ackBytes, offsetField }: offsetField 是该包里表示 offset 的字段名
// (chat_message 叫 offset, chat_command_signed 叫 messageCount)。
function getChatWindowPacketShape(version) {
  try {
    const data = require('minecraft-data')(version);
    const types = data && data.protocol && data.protocol.play && data.protocol.play.toServer
      && data.protocol.play.toServer.types;
    if (!types) return null;

    const readShape = (packetName, offsetField) => {
      // 注: minecraft-data 的 types 里键名带 packet_ 前缀, 运行时包名不带
      const packet = types[`packet_${packetName}`] || types[packetName];
      if (!Array.isArray(packet) || !Array.isArray(packet[1])) return null;
      const fields = new Map(packet[1].map((field) => [field.name, field.type]));
      if (!fields.has('acknowledged') || !fields.has('checksum') || !fields.has(offsetField)) return null;
      const acknowledgedType = fields.get('acknowledged');
      const ackBytes = Array.isArray(acknowledgedType) && acknowledgedType[1] && Number.isInteger(acknowledgedType[1].count)
        ? acknowledgedType[1].count
        : 3;
      return { offsetField, ackBytes };
    };

    return {
      chat_message: readShape('chat_message', 'offset'),
      chat_command_signed: readShape('chat_command_signed', 'messageCount')
    };
  } catch (error) {
    return null;
  }
}

function normalizeUnsignedPlayerChatPacket(packet, options = {}) {
  if (!packet || packet.signature != null || packet.unsignedChatContent) {
    return false;
  }

  const text = typeof packet.plainMessage === 'string' ? packet.plainMessage : '';
  packet.unsignedChatContent = options.useNbtComponents === true
    ? {
        type: 'compound',
        value: {
          text: {
            type: 'string',
            value: text
          }
        }
      }
    : JSON.stringify({ text });
  return true;
}

function normalizeFailureMessage(value) {
  const text = typeof value === 'string'
    ? value
    : value && value.message
      ? value.message
      : value == null
        ? ''
        : String(value);

  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function getOpenAuthErrorCode(error, fallback = 'OPENAUTH_STARTUP_FAILED') {
  const code = error && typeof error.code === 'string' ? error.code.trim() : '';
  return code || fallback;
}

function flattenMessageParts(value, output = []) {
  if (value == null) {
    return output;
  }

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    output.push(String(value));
    return output;
  }

  if (Array.isArray(value)) {
    value.forEach((entry) => flattenMessageParts(entry, output));
    return output;
  }

  if (typeof value === 'object') {
    if (value.text !== undefined) {
      flattenMessageParts(value.text, output);
    }

    if (value.translate !== undefined) {
      flattenMessageParts(value.translate, output);
    }

    if (value.value !== undefined) {
      flattenMessageParts(value.value, output);
    }

    if (value.extra !== undefined) {
      flattenMessageParts(value.extra, output);
    }
  }

  return output;
}

function normalizeDisconnectReason(reason) {
  const direct = normalizeFailureMessage(reason);
  if (direct) {
    return direct;
  }

  const flattened = flattenMessageParts(reason)
    .map((part) => normalizeFailureMessage(part))
    .filter(Boolean)
    .join(' ');

  return flattened || 'unknown disconnect';
}

function stripMinecraftFormatting(text) {
  return String(text || '').replace(/§[0-9a-fk-or]/gi, '');
}

const BACKEND_UNAVAILABLE_FRAGMENTS = [
  'could not connect to the backend server!',
  'an error occurred while connecting to the backend server:'
];

// 需要"故障->恢复"配对的事件 key 前缀(key 完整形式为 <prefix>:<botId>)
const BARK_BOT_EVENT_KEY_PREFIXES = [
  'auth:device-code',
  'auth:permanent',
  'auth:refresh-token',
  'auth:invalid-session',
  'auth:rejected',
  'bot:exhausted',
  'bot:stuck'
];

// refresh_token 失效/需要交互登录(prismarine-auth / msal 常见文案) -> 需要人工重新登录。
// 注意: 裸 "refresh token" 太宽(临时的刷新网络失败也会带这句), 必须与"永久性"词同时出现才算,
// 否则会把可自愈的抖动误报成"凭据已失效, 需要人工重新登录"。
const REFRESH_TOKEN_INVALID_FRAGMENTS = [
  'invalid_grant',
  'aadsts'
];

const REFRESH_TOKEN_CONTEXT_FRAGMENTS = ['refresh token'];
const REFRESH_TOKEN_PERMANENT_FRAGMENTS = [
  'expired',
  'invalid',
  'revoked',
  'not found',
  'no longer valid'
];

function isRefreshTokenInvalidError(lowerMessage) {
  if (REFRESH_TOKEN_INVALID_FRAGMENTS.some((fragment) => lowerMessage.includes(fragment))) {
    return true;
  }

  return REFRESH_TOKEN_CONTEXT_FRAGMENTS.some((fragment) => lowerMessage.includes(fragment))
    && REFRESH_TOKEN_PERMANENT_FRAGMENTS.some((fragment) => lowerMessage.includes(fragment));
}

// 账号被拒/被封(认证层) -> 重连无用, 需要人工处理
const AUTH_REJECTED_FRAGMENTS = [
  'you are banned',
  'banned',
  'account has been',
  'invalid credentials',
  'authentication failed'
];

function normalizeDisconnectText(value) {
  const parts = [];
  flattenMessageParts(value, parts);
  return stripMinecraftFormatting(parts.join(''))
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function classifyDisconnectReason(value) {
  const normalized = String(normalizeDisconnectText(value) || '').toLowerCase();
  if (!normalized) {
    return null;
  }

  for (const fragment of BACKEND_UNAVAILABLE_FRAGMENTS) {
    if (normalized.includes(fragment)) {
      return 'backend_unavailable';
    }
  }

  return null;
}

const DISCONNECT_CLASS_RANK = {
  unknown: 0,
  ordinary_disconnect: 1,
  backend_unavailable: 2
};

function mergeDisconnectClass(current, incoming) {
  const currentRank = DISCONNECT_CLASS_RANK[current] !== undefined
    ? DISCONNECT_CLASS_RANK[current]
    : 0;
  const incomingRank = DISCONNECT_CLASS_RANK[incoming] !== undefined
    ? DISCONNECT_CLASS_RANK[incoming]
    : 0;
  return incomingRank >= currentRank ? incoming : current;
}

const RESOURCE_PACK_RESULTS = {
  SUCCESSFULLY_LOADED: 0,
  DECLINED: 1,
  FAILED_DOWNLOAD: 2,
  ACCEPTED: 3
};

function stringifyResourcePackValue(value) {
  if (typeof value === 'string') {
    return value;
  }

  if (value && typeof value.toString === 'function') {
    const text = value.toString();
    return text && text !== '[object Object]' ? text : '';
  }

  return '';
}

function isLikelyUrl(value) {
  return typeof value === 'string' && /^https?:\/\//i.test(value);
}

function isLikelyUuid(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function isLikelyHash(value) {
  return typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value);
}

function resolveResourcePackOfferTarget(primary, secondary) {
  const values = [
    stringifyResourcePackValue(primary),
    stringifyResourcePackValue(secondary)
  ].filter(Boolean);

  return values.find((value) => isLikelyUrl(value))
    || values.find((value) => isLikelyUuid(value))
    || values.find((value) => isLikelyHash(value))
    || values[0]
    || 'unknown';
}

function resolveResourcePackResponseTarget(primary, secondary) {
  const values = [
    stringifyResourcePackValue(primary),
    stringifyResourcePackValue(secondary)
  ].filter(Boolean);

  const uuid = values.find((value) => isLikelyUuid(value));
  if (uuid) {
    return { kind: 'uuid', value: uuid };
  }

  const hash = values.find((value) => isLikelyHash(value));
  if (hash) {
    return { kind: 'hash', value: hash };
  }

  return { kind: 'none', value: null };
}

function normalizeCapabilitiesConfig(legacyConfig = {}) {
  const capabilities = legacyConfig && typeof legacyConfig === 'object'
    ? legacyConfig.capabilities || {}
    : {};

  return {
    entityHandling: capabilities.entityHandling !== false,
    terrainHandling: capabilities.terrainHandling !== false,
    inventoryHandling: capabilities.inventoryHandling !== false
  };
}

function createPacketDiagnostics() {
  return {
    mapChunk: 0,
    unloadChunk: 0,
    updateLight: 0,
    chunkBatchStart: 0,
    chunkBatchFinished: 0
  };
}

function countObjectKeys(value) {
  if (!value || typeof value !== 'object') {
    return 0;
  }

  return Object.keys(value).length;
}

function createWeakRef(value) {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) {
    return null;
  }

  if (typeof WeakRef !== 'function') {
    return null;
  }

  return new WeakRef(value);
}

function isWeakRefAlive(ref) {
  return Boolean(ref && typeof ref.deref === 'function' && ref.deref());
}

function derefWeakRef(ref) {
  return ref && typeof ref.deref === 'function' ? ref.deref() : null;
}

function removeEventListener(target, eventName, handler) {
  if (!target || !eventName || !handler) {
    return;
  }

  if (typeof target.off === 'function') {
    target.off(eventName, handler);
    return;
  }

  if (typeof target.removeListener === 'function') {
    target.removeListener(eventName, handler);
  }
}

function clearObjectEntries(value) {
  if (!value || typeof value !== 'object') {
    return 0;
  }

  const keys = Object.keys(value);
  for (const key of keys) {
    delete value[key];
  }

  return keys.length;
}

class BotRuntime {
  constructor(options = {}) {
    this.config = options.config;
    this.eventStream = options.eventStream;
    this.sessionService = options.sessionService;
    this.broadcastService = options.broadcastService || null;
    this.aggregateLogService = options.aggregateLogService || null;
    this.lifecycleLogService = options.lifecycleLogService || null;
    this.chatConsoleCoordinator = options.chatConsoleCoordinator || null;
    this.protocolGuardConfig = options.protocolGuardConfig || {};
    this.diagnosticsConfig = options.diagnosticsConfig || {};
    this.logger = new BotLogger({
      botId: this.config.id,
      eventStream: this.eventStream,
      bufferSize: Math.max(1, Number.parseInt(options.loggerBufferSize, 10) || 500)
    });
    this.restartPolicy = new RestartPolicy(this.config, options.restartPolicyOptions || {});
    this.openAuthResolver = typeof options.openAuthResolver === 'function'
      ? options.openAuthResolver
      : resolveLocalProxyHost;
    this.openAuthClientFactory = typeof options.openAuthClientFactory === 'function'
      ? options.openAuthClientFactory
      : (clientOptions) => new OpenAuthClient(clientOptions);
    this.socketConnect = typeof options.socketConnect === 'function'
      ? options.socketConnect
      : net.connect;
    this.openAuthClient = null;
    this.openAuthProxyEndpoint = null;
    this.openAuthRequestSeen = false;
    this.openAuthRequestMissingRetryEligible = false;
    this.openAuthPermanentFailure = false;
    this.openAuthRequestWatchdogTimer = null;
    this.invalidSessionTracker = null;
    this.bot = null;
    this.state = 'stopped';
    this.desiredRunning = false;
    this.startupWarningTimer = null;
    this.lastClientForCleanup = null;
    this.startupWarningDelayMs = Number.isFinite(Number(this.config.startupTimeoutMs))
      ? Math.max(1000, Number(this.config.startupTimeoutMs))
      : 30000;
    this.restartTimer = null;
    this.runtimeListenerDisposers = [];
    this.pendingRestartReason = null;
    this.pendingRestartDelayOverrideMs = null;
    this.pendingRestartDelayMs = null;
    this.pendingRestartScheduledAt = null;
    this.restartAttempt = 0;
    this.restartScheduleExhausted = false;
    this.connectionEpoch = 0;
    this.lastDisconnectClass = 'unknown';
    this.lastNormalizedDisconnectReason = null;
    this.legacyAutoRestartTimer = null;
    this.legacyAutoRestartMinutes = Number.parseFloat(this.config.legacyConfig?.autoRestart) || 0;
    this.legacyAutoRestartScheduledAt = null;
    this.spawnCount = 0;
    this.lastSpawnAt = null;
    this.lastEndAt = null;
    // 本次运行尝试(期望运行)的起点: 巡检器判定"卡住"时取它与最近一次活动中较晚者为基准,
    // 避免手动长时间停止后重新启动时被拿历史时间戳误判为长期卡死。
    this.expectedRunningSince = null;
    this.lastError = null;
    this.lastKick = null;
    this.lastFailure = null;
    this.lastFailureAt = null;
    this.pendingAuthState = null;
    this.capabilities = normalizeCapabilitiesConfig(this.config.legacyConfig);
    this.physicsStandbyEnabled = this.config.legacyConfig?.behavior?.physicsStandby === true;
    this.latencyMs = null;
    this.pendingPingId = null;
    this.pingTimer = null;
    this.pingResolve = null;
    this.lastKnownPosition = null;
    // 交互包(block_place/use_item)共用的 sequence 计数器: 两个特性各自计数会导致服务端看到乱序
    this.interactionSequence = 0;
    this.lastKnownYaw = null;
    this.lastKnownPitch = null;
    this.barkNotifier = options.barkNotifier || null;
    this.lastBarkAuthNotifyAt = 0;
    this.decompressorErrorGuarded = new WeakSet();
    this.desyncWatchdogTimer = null;
    this.desyncWatchdogEpoch = null;
    this.protocolErrorLogPath = options.protocolErrorLogPath || null; // 由 BotManager 指向 <appRoot>/logs/protocol-errors.log; 为空时回退 <cwd>/logs
    this.lastOutgoingChatAt = null; // 观测用: 最近一次外发聊天包时间戳(不记录任何聊天内容)
    this.lastOutgoingChatIsCommand = false;
    this.lastOutgoingChatPacket = null;
    this.chatSendCount = 0;
    this.lastEndReason = null;
    this.diagnostics = {
      connectionCount: 0,
      currentConnectionStartedAt: null,
      currentConnectionEndedAt: null,
      totalChunkPackets: createPacketDiagnostics(),
      currentChunkPackets: createPacketDiagnostics(),
      lastPacketAt: {},
      maxWorldColumns: 0,
      maxWorldColumnsAt: null,
      endedBotRefs: []
    };

    this.lockFeature = new LockFeature({
      logger: this.logger,
      lockHistoryPath: this.config.paths.lockHistoryPath,
      onExpire: (lock, reason) => this.handleLockExpired(lock, reason)
    });
    this.pendingLockExpireCommand = null;
    this.lockFeature.start();

    this.trustedPlayersStore = new TrustedPlayersStore({
      logger: this.logger,
      config: this.config.legacyConfig,
      paths: this.config.paths
    });
    this.teleportFeature = new TeleportFeature({
      logger: this.logger,
      config: this.config.legacyConfig,
      paths: this.config.paths,
      lockFeature: this.lockFeature,
      trustedPlayersStore: this.trustedPlayersStore
    });
    this.inventoryFeature = new InventoryFeature({
      logger: this.logger,
      paths: this.config.paths
    });
    this.windowFeature = new WindowFeature({
      logger: this.logger,
      eventStream: this.eventStream,
      botId: this.config.id
    });
    this.movementFeature = new MovementFeature({
      logger: this.logger,
      setPhysicsEnabled: (enabled) => this.applyPhysicsStandby(enabled)
    });
    this.rideFeature = new RideFeature({
      logger: this.logger,
      setPhysicsEnabled: (enabled) => this.applyPhysicsStandby(enabled),
      // 轻量模式没有 bot.entity, 用协议层 position 包记录的坐标做距离判断
      getSelfPosition: () => this.lastKnownPosition
    });
    this.fishFeature = new FishFeature({
      logger: this.logger,
      autoStartEnabled: this.config.legacyConfig.fish === true,
      autoStartDelayMs: 10000,
      createAutoContext: () => this.createCommandContext({ source: 'auto' })
    });
    this.vaultFeature = new VaultFeature({
      logger: this.logger,
      paths: this.config.paths
    });
    this.attackFeature = new AttackFeature({
      logger: this.logger,
      config: this.config.legacyConfig.attack
    });
    this.entityInteractFeature = new EntityInteractFeature({
      logger: this.logger
    });
    this.blockUseFeature = new BlockUseFeature({
      logger: this.logger
    });
    this.digFeature = new DigFeature({
      logger: this.logger
    });
    this.blockBreakFeature = new BlockBreakFeature({
      logger: this.logger,
      config: this.config.legacyConfig.blockBreakDetection,
      paths: this.config.paths
    });
    this.monitoringFeature = new MonitoringFeature({
      logger: this.logger,
      config: this.config.legacyConfig.monitoring,
      paths: this.config.paths
    });
    this.activityLogFeature = new ActivityLogFeature({
      logger: this.logger,
      config: this.config.legacyConfig.logging,
      paths: this.config.paths,
      aggregateLogService: this.aggregateLogService,
      runtimeInfo: {
        botId: this.config.id,
        username: this.config.username,
        serverDir: this.config.serverDir,
        sourceType: this.config.paths ? this.config.paths.sourceType : null
      }
    });
    this.cplaceFeature = new CplaceFeature({
      logger: this.logger,
      paths: this.config.paths
    });
    this.eatFeature = new EatFeature({
      logger: this.logger,
      inventoryFeature: this.inventoryFeature,
      fishFeature: this.fishFeature,
      // 轻量模式没有 bot.entity, 用服务端 position 包里记下的朝向(弧度)
      getRotation: () => ({ yaw: this.lastKnownYaw, pitch: this.lastKnownPitch }),
      getSequence: () => this.nextInteractionSequence()
    });
    this.treeFarmFeature = new TreeFarmFeature({
      logger: this.logger,
      getSequence: () => this.nextInteractionSequence()
    });

    this.scriptFeature = new ScriptFeature({
      logger: this.logger,
      paths: this.config.paths,
      schedulerConfig: this.config.legacyConfig.ScriptScheduler,
      createAutoContext: () => this.createCommandContext({ source: 'auto' })
    });
    this.recorderFeature = new RecorderFeature({
      logger: this.logger,
      paths: this.config.paths,
      config: this.config.legacyConfig.recording,
      botConfig: this.config,
      capabilities: this.capabilities
    });
    this.chatFeature = new ChatFeature({
      runtime: this,
      logger: this.logger,
      chatConsoleCoordinator: this.chatConsoleCoordinator,
      teleportFeature: this.teleportFeature,
      teleportPromptMatchers: this.config.teleportPromptMatchers,
      whisperMatchers: this.config.whisperMatchers,
      trustedPlayers: this.config.legacyConfig.trustedPlayers,
      trustedPlayersStore: this.trustedPlayersStore,
      activityLogFeature: this.activityLogFeature
    });
    this.commandDispatcher = new CommandDispatcher({
      runtime: this,
      logger: this.logger,
      lockFeature: this.lockFeature,
      inventoryFeature: this.inventoryFeature,
      movementFeature: this.movementFeature,
      rideFeature: this.rideFeature,
      fishFeature: this.fishFeature,
      vaultFeature: this.vaultFeature,
      attackFeature: this.attackFeature,
      entityInteractFeature: this.entityInteractFeature,
      blockUseFeature: this.blockUseFeature,
      digFeature: this.digFeature,
      cplaceFeature: this.cplaceFeature,
      scriptFeature: this.scriptFeature,
      recorderFeature: this.recorderFeature,
      teleportFeature: this.teleportFeature,
      eatFeature: this.eatFeature,
      treeFarmFeature: this.treeFarmFeature,
      windowFeature: this.windowFeature
    });
    this.scriptFeature.setExecuteCommand(async (content, context) => this.executeCommand(content, context));

    // 自动进食: 配置来自实例 config.json / 服务器 default.config.json(经既有合并链)
    this.autoEatController = new AutoEatController({
      logger: this.logger,
      config: this.config.legacyConfig.autoEat,
      eatFeature: this.eatFeature,
      inventoryFeature: this.inventoryFeature,
      fishFeature: this.fishFeature,
      attackFeature: this.attackFeature,
      digFeature: this.digFeature
    });
    this.eatFeature.autoEatController = this.autoEatController;
  }

  nextInteractionSequence() {
    this.interactionSequence = (this.interactionSequence + 1) % 32767;
    return this.interactionSequence;
  }

  getCapabilities() {
    return {
      entityHandling: this.capabilities.entityHandling !== false,
      terrainHandling: this.capabilities.terrainHandling !== false,
      inventoryHandling: this.capabilities.inventoryHandling !== false
    };
  }

  isEntityHandlingEnabled() {
    return this.getCapabilities().entityHandling;
  }

  isTerrainHandlingEnabled() {
    return this.getCapabilities().terrainHandling;
  }

  isInventoryHandlingEnabled() {
    return this.getCapabilities().inventoryHandling;
  }

  // 轻量模式：entityHandling 与 terrainHandling 同时为 false 时，
  // mineflayer 只加载 chat/game 插件（不处理区块/实体/物理），
  // 类似 MCC 的 EntityHandling/TerrainAndMovements 关闭语义。
  isLightweightMode() {
    return !this.isEntityHandlingEnabled() && !this.isTerrainHandlingEnabled();
  }

  isMemoryDetailsEnabled() {
    return this.diagnosticsConfig?.memoryDetails?.enabled === true;
  }

  shouldAttachRideFeature() {
    return this.isEntityHandlingEnabled() && this.isTerrainHandlingEnabled();
  }

  shouldAttachBlockBreakFeature() {
    return this.isEntityHandlingEnabled() && this.isTerrainHandlingEnabled();
  }

  logCapabilitySkip(featureName, detail) {
    const suffix = detail ? ` ${detail}` : '';
    this.logger.info(`[CAP] skip ${featureName}${suffix}`);
  }

  applyPhysicsStandby(enabled) {
    if (!this.physicsStandbyEnabled || !this.bot) {
      return;
    }

    this.bot.physicsEnabled = enabled === true;
  }

  handleBotReady() {
    if (this.state === 'online') {
      return;
    }
    this.clearStartupWarningTimer();
    if (this.isOpenAuthEnabled() && !this.openAuthRequestSeen) {
      if (this.pendingRestartReason) return;
      this.stopForOpenAuthFailure('OPENAUTH_REQUEST_MISSING');
      return;
    }
    this.clearOpenAuthRequestWatchdog();
    this.pendingRestartReason = null;
    this.pendingRestartDelayOverrideMs = null;
    this.pendingRestartDelayMs = null;
    this.pendingRestartScheduledAt = null;
    this.clearFailureState();
    this.state = 'online';
    this.applyPhysicsStandby(false);
    this.spawnCount += 1;
    this.restartAttempt = 0;
    this.restartScheduleExhausted = false;
    this.lastSpawnAt = getTimestamp();
    this.logger.info('[BOT] spawn');
    this.recordLifecycle(LIFECYCLE_EVENTS.BOT_SPAWN, { detail: this.lastSpawnAt });
    this.notifyBarkRecoveryForOnline();
    this.fishFeature.handleSpawn();
    this.scriptFeature.onSpawn();
    this.scheduleLegacyAutoRestart();
    this.publishStatus();

    // 锁在离线期间到期: 恢复在线后补执行一次预设命令(如 /home)
    this.flushPendingLockExpireCommand();
  }

  // 锁自然到期(计时器/重启恢复发现已过期)后: 1)按预设执行命令(behavior.lockAfterExpireCommand,
  // 默认 /home; lock.autoExecAfterExpire 可覆盖: false=本次不执行, true=全局为空时回退 /home);
  // 2)私聊锁定人通知到期及执行情况(仅到期那一刻 bot 在线时发一次; 掉线错过不补发;
  // 面板锁 owner=CONSOLE 无游戏内目标, 不发)。手动 unlock 不触发。
  handleLockExpired(lock, reason) {
    let command = null;
    if (!(lock && lock.autoExecAfterExpire === false)) {
      const configured = this.config?.legacyConfig?.behavior?.lockAfterExpireCommand;
      let candidate = typeof configured === 'string' ? configured.trim() : '';
      if (lock && lock.autoExecAfterExpire === true && !candidate) {
        candidate = '/home';
      }
      command = candidate || null;
    }

    if (command) {
      if (this.state === 'online' && this.bot && typeof this.bot.chat === 'function') {
        this.pendingLockExpireCommand = null;
        try {
          this.bot.chat(command);
          this.logger.info(`[LOCK] after expire executed command=${command} owner=${lock.owner} reason=${reason}`);
        } catch (error) {
          this.logger.error(`[LOCK] after expire command failed: ${error.message}`);
        }
      } else {
        this.pendingLockExpireCommand = command;
        this.logger.info(`[LOCK] after expire command pending (bot offline) command=${command}`);
      }
    } else {
      this.logger.info(`[LOCK] after expire skipped owner=${lock && lock.owner} reason=${reason}`);
    }

    this.notifyLockOwnerExpired(lock, command ? '已执行' : '未执行', command);
  }

  // 到期通知: 仅 bot 在线时向锁定人私聊一次(与命令回复同渠道 /minecraft:w); 掉线错过不补发;
  // 面板锁(owner=CONSOLE)与未锁定对象不发。
  notifyLockOwnerExpired(lock, statusText, command) {
    if (!lock || !lock.owner || lock.owner === 'CONSOLE') {
      return;
    }
    if (this.state !== 'online' || !this.bot || typeof this.bot.chat !== 'function') {
      return;
    }

    const reasonText = lock.reason ? `原因: ${lock.reason}` : '';
    const execText = statusText === '已执行' && command
      ? `预设命令已执行: ${command}`
      : '预设命令未执行';
    const message = `锁已到期${reasonText ? `(${reasonText})` : ''}，${execText}`;

    try {
      this.bot.chat(`/minecraft:w ${lock.owner} ${message}`);
      this.logger.info(`[LOCK] expire notify owner=${lock.owner} message=${message}`);
    } catch (error) {
      this.logger.error(`[LOCK] expire notify failed owner=${lock.owner}: ${error.message}`);
    }
  }

  flushPendingLockExpireCommand() {
    if (!this.pendingLockExpireCommand) {
      return;
    }

    const command = this.pendingLockExpireCommand;
    this.pendingLockExpireCommand = null;
    if (this.bot && typeof this.bot.chat === 'function') {
      try {
        this.bot.chat(command);
        this.logger.info(`[LOCK] pending after-expire command executed command=${command}`);
      } catch (error) {
        this.logger.error(`[LOCK] pending after-expire command failed: ${error.message}`);
      }
    }
  }

  handlePingResponse(packet) {
    if (this.pendingPingId === null || !packet) {
      return;
    }

    const id = Number(packet.id);
    if (id === this.pendingPingId) {
      this.latencyMs = Date.now() - this.pendingPingId;
      this.pendingPingId = null;
      if (typeof this.pingResolve === 'function') {
        const resolve = this.pingResolve;
        this.pingResolve = null;
        resolve(this.latencyMs);
      }
    }
  }

  clearPingTimer() {
    if (this.pingResolve) {
      const resolve = this.pingResolve;
      this.pingResolve = null;
      resolve(null);
    }
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }

    this.pendingPingId = null;
  }

  handleMsaCode(response) {
    if (!response) return;
    this.logger.capture('info', '[msa] First time signing in. Please authenticate now:');
    if (response.message) {
      this.logger.capture('info', response.message);
    }
    if (this.pendingAuthState) {
      this.pendingAuthState.deviceCodeIssued = true;
    }
    this.notifyBarkEvent({
      type: 'deviceCode',
      key: `auth:device-code:${this.config.id}`,
      severity: 'critical',
      body: `${this.config.id} 需要设备码登录(Microsoft), 请查看控制台并尽快完成认证 @ ${this.config.host}`
    });
  }

  handleResourcePack(bot, urlOrUuid, hashOrUuid) {
    const shouldEnable = this.config?.legacyConfig?.behavior?.enableResourcePack === true;
    const identifier = resolveResourcePackOfferTarget(urlOrUuid, hashOrUuid);
    const responseTarget = resolveResourcePackResponseTarget(urlOrUuid, hashOrUuid);

    this.logger.info(`[BOT] resource pack offered enabled=${shouldEnable} target=${identifier || 'unknown'}`);

    if (!bot || !bot._client || typeof bot._client.write !== 'function') {
      this.logger.warn('[BOT] resource pack handler unavailable');
      return;
    }

    try {
      if (shouldEnable) {
        this.writeResourcePackResponse(bot, responseTarget, RESOURCE_PACK_RESULTS.ACCEPTED);
        this.writeResourcePackResponse(bot, responseTarget, RESOURCE_PACK_RESULTS.SUCCESSFULLY_LOADED);
        this.logger.info(`[BOT] resource pack accepted kind=${responseTarget.kind}`);
        return;
      }

      this.writeResourcePackResponse(bot, responseTarget, RESOURCE_PACK_RESULTS.DECLINED);
      this.logger.info(`[BOT] resource pack denied kind=${responseTarget.kind}`);
      return;
    } catch (error) {
      this.logger.error('[BOT] resource pack negotiation failed', error);
      return;
    }
  }

  writeResourcePackResponse(bot, target, result) {
    const payload = { result };

    if (target && target.kind === 'uuid' && target.value) {
      payload.uuid = target.value;
    } else if (target && target.kind === 'hash' && target.value) {
      payload.hash = target.value;
    }

    bot._client.write('resource_pack_receive', payload);
  }

  loadCachedSession() {
    if (
      !this.config.email ||
      !this.sessionService ||
      typeof this.sessionService.load !== 'function'
    ) {
      return null;
    }

    return this.sessionService.load(this.config.email) || null;
  }

  isOpenAuthEnabled() {
    return this.config.openAuth && this.config.openAuth.enabled === true;
  }

  isReconnectClassReason(reason) {
    return reason === 'disconnect' ||
      reason === 'backend_unavailable' ||
      reason === 'openauth_request_missing';
  }

  canOrdinaryDisconnect() {
    return !this.isOpenAuthEnabled() || this.openAuthRequestSeen || this.state === 'online';
  }

  recordDisconnectClass(epoch, klass, reasonText) {
    if (epoch !== undefined && epoch !== this.connectionEpoch) {
      return;
    }

    const merged = mergeDisconnectClass(this.lastDisconnectClass, klass);
    this.lastDisconnectClass = merged;
    if (typeof reasonText === 'string' && reasonText.length > 0) {
      this.lastNormalizedDisconnectReason = reasonText;
    }
  }

  createMineflayerOptions(session = null, openAuthEndpoint = null) {
    const options = {
      host: this.config.host,
      port: this.config.port,
      username: this.config.username,
      auth: this.config.auth,
      version: this.config.version,
      viewDistance: this.config.viewDistance,
      disableChatSigning: this.config.disableChatSigning !== false,
      checkTimeoutInterval: this.config.checkTimeoutInterval,
      profilesFolder: createAuthCacheFactory({
        primaryDir: this.config?.paths?.authCacheDir,
        fallbackDir: this.config?.paths?.fallbackAuthCacheDir,
        primaryUsername: this.config?.email
      }),
      session,
      onMsaCode: (response) => {
        this.handleMsaCode(response);
      }
    };

    if (this.isLightweightMode()) {
      // 只加载 chat/game/health/settings/resource_pack/team 插件：不处理区块/实体/物理（MCC 式轻量挂机）
      // health: 血量/饱食度（update_health）；settings: client_information；
      // resource_pack: 服务器配置资源包时需回应 add_resource_pack，否则卡在 configuration 阶段；
      // team: 记分板队伍（teams/scoreboard_team 小包，不涉及区块/实体），用于还原聊天里的"称号/组织"前缀
      options.loadInternalPlugins = false;
      options.plugins = { chat: true, game: true, health: true, settings: true, resource_pack: true, team: true };
    }

    if (this.isOpenAuthEnabled()) {
      if (!openAuthEndpoint || !openAuthEndpoint.address || !openAuthEndpoint.family) {
        const error = new Error('OPENAUTH_PROXY_ENDPOINT_MISSING');
        error.code = 'OPENAUTH_PROXY_ENDPOINT_MISSING';
        throw error;
      }

      options.connect = (client) => {
        const socket = this.socketConnect({
          host: openAuthEndpoint.address,
          port: this.config.port,
          family: openAuthEndpoint.family
        });
        client.setSocket(socket);
      };
    }

    return options;
  }

  clearOpenAuthRequestWatchdog() {
    if (!this.openAuthRequestWatchdogTimer) return;
    clearTimeout(this.openAuthRequestWatchdogTimer);
    this.openAuthRequestWatchdogTimer = null;
  }

  disposeOpenAuthClient() {
    this.clearOpenAuthRequestWatchdog();
    const openAuthClient = this.openAuthClient;
    this.openAuthClient = null;
    if (openAuthClient && typeof openAuthClient.dispose === 'function') {
      try {
        openAuthClient.dispose();
      } catch (error) {
      }
    }
  }

  markOpenAuthRequestSeen() {
    this.openAuthRequestSeen = true;
    this.clearOpenAuthRequestWatchdog();
  }

  handleOpenAuthRequestWatchdogTimeout(client, options = {}) {
    if (
      this.openAuthRequestSeen ||
      this.openAuthPermanentFailure ||
      this.pendingRestartReason ||
      this.bot?._client !== client
    ) {
      return;
    }

    if (
      this.openAuthRequestMissingRetryEligible &&
      this.restartPolicy.shouldRestart()
    ) {
      this.lastError = 'OpenAuth OPENAUTH_REQUEST_MISSING';
      this.refreshFailureState();
      this.publishStatus();
      this.logger.warn('[AUTH][OpenAuth] request missing during scheduled reconnect; retrying');

      if (options.quit === false) {
        this.desiredRunning = true;
        this.pendingRestartReason = 'openauth_request_missing';
        this.pendingRestartDelayOverrideMs = null;
      } else {
        this.requestRestart('openauth_request_missing');
      }
      return;
    }

    this.stopForOpenAuthFailure('OPENAUTH_REQUEST_MISSING', options);
  }

  startOpenAuthRequestWatchdog(client) {
    this.clearOpenAuthRequestWatchdog();
    if (!this.isOpenAuthEnabled() || !client) return;

    const schedule = () => {
      if (
        this.openAuthRequestSeen ||
        this.openAuthPermanentFailure ||
        this.pendingRestartReason ||
        this.bot?._client !== client
      ) {
        return;
      }
      if (!isLoopbackAddress(client.socket && client.socket.remoteAddress)) {
        this.stopForOpenAuthFailure('PROXY_NOT_LOOPBACK');
        return;
      }

      this.openAuthRequestWatchdogTimer = setTimeout(() => {
        this.openAuthRequestWatchdogTimer = null;
        if (
          this.openAuthRequestSeen ||
          this.openAuthPermanentFailure ||
          this.pendingRestartReason ||
          this.bot?._client !== client
        ) {
          return;
        }
        this.handleOpenAuthRequestWatchdogTimeout(client);
      }, OPEN_AUTH_REQUEST_WATCHDOG_MS);
      if (this.openAuthRequestWatchdogTimer && typeof this.openAuthRequestWatchdogTimer.unref === 'function') {
        this.openAuthRequestWatchdogTimer.unref();
      }
    };

    if (client.socket && client.socket.remoteAddress) {
      schedule();
    } else {
      this.addRuntimeListener(client, 'connect', schedule, { once: true });
    }
  }

  stopForOpenAuthFailure(code, options = {}) {
    if (this.openAuthPermanentFailure) return;
    this.openAuthPermanentFailure = true;
    this.desiredRunning = false;
    this.clearRestartTimer();
    this.clearOpenAuthRequestWatchdog();
    this.lastError = `OpenAuth ${code}`;
    this.refreshFailureState();
    this.logger.error(`[AUTH][OpenAuth] stopped code=${code}`);
    this.notifyBarkEvent({
      type: 'openAuthPermanentFailure',
      key: `auth:permanent:${this.config.id}`,
      severity: 'critical',
      body: `${this.config.id} OpenAuth 永久失败 code=${code}, 已停止重连, 需要人工处理 @ ${this.config.host}`
    });

    if (!this.bot) {
      this.state = 'stopped';
      this.publishStatus();
      return;
    }

    this.publishStatus();
    if (options.quit === false) return;
    const bot = this.bot;
    setImmediate(() => {
      if (this.bot !== bot || typeof bot.quit !== 'function') return;
      try {
        bot.quit(`openauth_${String(code).toLowerCase()}`);
      } catch (error) {
      }
    });
  }

  handleOpenAuthFailure(details, sourceClient) {
    if (
      !sourceClient ||
      this.openAuthClient !== sourceClient ||
      this.openAuthPermanentFailure
    ) return;
    this.markOpenAuthRequestSeen();
    const failure = details && typeof details === 'object' ? details : {};
    const code = typeof failure.code === 'string' ? failure.code : 'INTERNAL_ERROR';
    this.lastError = `OpenAuth ${code}`;
    this.refreshFailureState();
    this.publishStatus();

    if (failure.sessionInvalid === true) {
      if (
        this.config.email &&
        this.sessionService &&
        typeof this.sessionService.delete === 'function'
      ) {
        this.sessionService.delete(this.config.email);
      }
      this.trackInvalidSessionRetry();
      this.requestRestart('invalid_session_retry', 1000);
      return;
    }

    if (failure.retryClass === 'transient') {
      this.requestRestart('openauth_retryable_error', this.restartPolicy.getDelayMs());
      return;
    }

    if (failure.retryClass !== 'none') {
      this.stopForOpenAuthFailure(code);
    }
  }

  createCommandContext(options = {}) {
    const source = options.source || 'http';
    const sender = options.sender || null;

    return new CommandContext({
      source,
      sender,
      label: sender || source,
      replyFn: (entry) => {
        if (source === 'whisper' && sender && this.bot) {
          // 私聊回复使用 /minecraft:w（插件服中 /w 常被插件命令占用，
          // 命名空间命令强制走原版私聊；本地原版服不支持属环境差异）
          // 私聊回复命令可经 server.json 的 whisperCommands 覆盖(插件服可能改掉 /minecraft:w)
          const whisperCommands = this.config.whisperCommands || {};
          const command = entry.mode === 'whisper'
            ? (whisperCommands.reply || '/minecraft:w')
            : (whisperCommands.error || '/tell');
          this.bot.chat(`${command} ${sender} ${entry.message}`);
        }

        this.logger.info(`[REPLY][${source}${sender ? `:${sender}` : ''}] ${entry.message}`);
      }
    });
  }

  addRuntimeListener(target, eventName, handler, options = {}) {
    if (!target || typeof target.on !== 'function' || typeof handler !== 'function') {
      return;
    }

    const once = options.once === true;
    if (options.prepend === true && once && typeof target.prependOnceListener === 'function') {
      target.prependOnceListener(eventName, handler);
    } else if (options.prepend === true && typeof target.prependListener === 'function') {
      target.prependListener(eventName, handler);
    } else if (once && typeof target.once === 'function') {
      target.once(eventName, handler);
    } else {
      target.on(eventName, handler);
    }

    this.runtimeListenerDisposers.push(() => {
      removeEventListener(target, eventName, handler);
    });
  }

  detachRuntimeListeners() {
    const disposers = this.runtimeListenerDisposers.splice(0);
    for (const dispose of disposers) {
      try {
        dispose();
      } catch (error) {
      }
    }
  }

  attachUnsignedPlayerChatGuard(bot) {
    const client = bot && bot._client;
    if (!client) return;

    const useNbtComponents = typeof bot.supportFeature === 'function' &&
      bot.supportFeature('chatPacketsUseNbtComponents') === true;
    this.addRuntimeListener(
      client,
      'player_chat',
      (packet) => normalizeUnsignedPlayerChatPacket(packet, { useNbtComponents }),
      { prepend: true }
    );
  }

  // 无签名密钥(disableChatSigning 生效)时, 上游 minecraft-protocol 仍按自己的 lastSeen 追踪状态
  // 上报"已读确认窗口(offset/acknowledged/checksum)"。服务端 LastSeenMessagesValidator 会严格校验,
  // 且**位图必须与服务端窗口逐位对齐**(服务端把新消息追加在尾部, 上游却把新消息插在 index 0),
  // 一旦服务端真的追踪过签名消息(正版客户端发言 → addPending), 客户端置 1 的那些位在服务端就是 null:
  //   ValidationException: Last seen update acknowledged unknown or previously ignored message at index N
  //   => disconnect(chat_validation_failed)  [ServerGamePacketListenerImpl: Failed to validate message acknowledgements]
  // 原版校验器的语义(1.21.11 LastSeenMessagesValidator / LastSeenMessages.Update):
  //   - trackedMessages 初始化即预填 lastSeenCount(20) 个 null => offset=0 恒合法
  //   - 位图全 0 时, 每条目要么是 null 要么是 pending, 只会被置 null, 永不抛错
  //     (只有"曾确认过的条目被忽略"才抛错, 而我们从不确定任何消息)
  //   - checksum 支持 0 = IGNORE_CHECKSUM, 显式跳过校验
  // 因此无密钥场景统一上报"恒定空更新", 与服务端窗口彻底解耦。
  // 注意: 有密钥时保持上游行为不变(那条路径的窗口语义需要真正维护)。
  attachUnsignedChatWindowGuard(bot) {
    const client = bot && bot._client;
    if (!client || typeof client.write !== 'function') return;

    const shape = getChatWindowPacketShape(bot.version);
    if (!shape || (!shape.chat_message && !shape.chat_command_signed)) return;

    // 是否"有意禁用签名"(后端默认 true, 见 createMineflayerOptions)。
    // 注意: 不能用 !client.profileKeys 来判断 —— 实测禁用签名时该字段仍可能存在,
    // 会放行上游"新消息插在 index 0"的错位窗口(offset=23/位图 20 位/checksum=182),
    // 服务端校验失败后表现为 chat_validation_failed 踢出或直接静默断开连接。
    const signingDisabled = this.config.disableChatSigning !== false;
    this.unsignedChatWindowOverrideLogged = false;

    // 清空上游追踪器: 保证我们这一侧永远不会"确认"任何消息(否则会与服务端窗口叠加出错)
    if (client._lastSeenMessages) {
      if (Array.isArray(client._lastSeenMessages)) {
        client._lastSeenMessages.length = 0;
      }
      if (typeof client._lastSeenMessages === 'object') {
        client._lastSeenMessages.pending = 0;
      }
    }

    // 服务端窗口 = 20 个固定槽 + 逐条追加的"带签名消息"。既然我们从不确定任何消息,
    // 就不该让追加部分无限增长(否则服务端侧每条签名消息都会留一个永不回收的条目),
    // 因此按"我们看到的签名消息条数"做保守修剪: 只推进到还剩 40 条, 留足余量,
    // 即使本地多计也不会超过服务端的 maxOffset 而触发校验失败。
    let signedPending = 0;
    this.addRuntimeListener(client, 'player_chat', (packet) => {
      if (packet && packet.signature) {
        signedPending += 1;
      }
    });

    const originalWrite = client.write.bind(client);

    // 观测用: 在 write 层记录每一次外发聊天包(覆盖面板/whisper/命令等所有路径, 不只 bot.chat),
    // 只记包名与窗口字段(offset/位图置位数/checksum), 不记消息内容。
    const chatPacketKinds = {
      chat_message: 'chat',
      chat_command: 'command',
      chat_command_signed: 'command'
    };

    client.write = (name, params) => {
      const kind = chatPacketKinds[name];
      if (kind) {
        this.chatSendCount += 1;
        this.lastOutgoingChatAt = Date.now();
        this.lastOutgoingChatIsCommand = kind === 'command';

        const acknowledged = params && Buffer.isBuffer(params.acknowledged) ? params.acknowledged : null;
        let ackBits = 0;
        if (acknowledged) {
          for (const byte of acknowledged) {
            for (let bit = 0; bit < 8; bit += 1) {
              if (byte & (1 << bit)) ackBits += 1;
            }
          }
        }

        const packetShape = shape[name];
        const offsetField = packetShape ? packetShape.offsetField : null;
        const offsetValue = offsetField && params ? params[offsetField] : undefined;
        this.lastOutgoingChatPacket = `${name}(offset=${offsetValue} ackBits=${ackBits} checksum=${params ? params.checksum : undefined})`;
      }

      const packetShape = shape[name];
      // 签名被禁用的场景一律由我们上报"恒定空窗口"; 只有"启用签名且确有密钥"时才交给上游维护
      if (packetShape && params && typeof params === 'object' && (signingDisabled || !client.profileKeys)) {
        const upstreamOffset = Number(params[packetShape.offsetField]) || 0;
        const upstreamAck = Buffer.isBuffer(params.acknowledged) ? params.acknowledged : null;
        const upstreamHadWindow = upstreamOffset > 0 || (upstreamAck && upstreamAck.some((byte) => byte !== 0));
        if (upstreamHadWindow && !this.unsignedChatWindowOverrideLogged) {
          this.unsignedChatWindowOverrideLogged = true;
          this.logger.warn('[PROTOCOL] 检测到上游发出了非空 lastSeen 窗口, 已按 disableChatSigning 归一为空更新(offset=0/位图全 0/checksum=0), 避免服务端校验失败');
        }

        const offset = Math.max(0, signedPending - 40);
        if (offset > 0) {
          signedPending -= offset;
        }
        params[packetShape.offsetField] = offset;
        params.acknowledged = Buffer.alloc(packetShape.ackBytes, 0);
        params.checksum = IGNORED_LAST_SEEN_CHECKSUM;
      }

      return originalWrite(name, params);
    };

    this.runtimeListenerDisposers.push(() => {
      client.write = originalWrite;
    });
  }

  attachRuntimeDiagnostics(bot) {
    if (!this.isMemoryDetailsEnabled()) {
      return;
    }

    this.diagnostics.connectionCount += 1;
    this.diagnostics.currentConnectionStartedAt = getTimestamp();
    this.diagnostics.currentConnectionEndedAt = null;
    this.diagnostics.currentChunkPackets = createPacketDiagnostics();
    this.refreshWorldColumnDiagnostics();

    const registerPacketCounter = (packetName, fieldName) => {
      if (!bot || !bot._client || typeof bot._client.on !== 'function') {
        return;
      }

      this.addRuntimeListener(bot._client, packetName, () => {
        this.diagnostics.totalChunkPackets[fieldName] += 1;
        this.diagnostics.currentChunkPackets[fieldName] += 1;
        this.diagnostics.lastPacketAt[fieldName] = getTimestamp();
        this.refreshWorldColumnDiagnostics();
      });
    };

    registerPacketCounter('map_chunk', 'mapChunk');
    registerPacketCounter('unload_chunk', 'unloadChunk');
    registerPacketCounter('update_light', 'updateLight');
    registerPacketCounter('chunk_batch_start', 'chunkBatchStart');
    registerPacketCounter('chunk_batch_finished', 'chunkBatchFinished');
  }

  // 轻量模式(bot 不加载区块)下: 服务器按客户端回报速率(chunk_batch_received)推送区块,
  // 收到 chunk_batch_finished 即回最低速率(chunkBatchReplyChunksPerTick, 服务端下限 0.01 区块/tick),
  // 让服务器尽量少推区块/相关实体数据。配置为 0 或缺失有效值时跳过(不回包)。
  // minecraft-protocol 解压流(compression.js)的 error 没有默认监听, 一旦 zlib 头校验失败/
  // varint 读空会直接 uncaughtException 拖垮整个进程。这里在 decompressor 上挂 error 监听:
  // 记日志 + 落盘 protocol-errors.log + 仅断开该 bot 走正常重连。
  ensureDecompressorErrorGuard(bot) {
    const client = bot && bot._client;
    if (!client || typeof client.on !== 'function') {
      return;
    }

    const guard = (decompressor) => {
      if (!decompressor || typeof decompressor.on !== 'function' || this.decompressorErrorGuarded.has(decompressor)) {
        return;
      }
      this.decompressorErrorGuarded.add(decompressor);
      this.addRuntimeListener(decompressor, 'error', (error) => this.handleDecompressorError(bot, error));
    };

    guard(client.decompressor);

    // 压缩阈值在登录阶段(收 set_compression)后才创建 decompressor, state 切换后补挂
    this.addRuntimeListener(client, 'state', () => {
      setImmediate(() => {
        if (client.decompressor) {
          guard(client.decompressor);
        }
      });
    });
  }

  handleDecompressorError(bot, error) {
    const errorCode = error && typeof error.code === 'string'
      ? error.code
      : (error && error.errno !== undefined ? `errno=${error.errno}` : 'unknown');
    const message = error && error.message ? error.message : String(error);
    const line = `${getTimestamp()} [${this.config.id}] decompressor error code=${errorCode} message=${message}`;

    this.logger.error('[PROTOCOL] decompressor error', message, `code=${errorCode}`);
    this.appendProtocolErrorLog(line);

    // 协议流已损坏, 继续收数据只会连环错: 仅终止本连接, 由断线重连策略拉起, 不影响其他 bot
    try {
      if (this.bot && typeof this.bot.quit === 'function') {
        this.bot.quit('protocol_decompressor_error');
      } else if (bot && bot._client && typeof bot._client.end === 'function') {
        bot._client.end('protocol_decompressor_error');
      }
    } catch (closeError) {
      this.logger.warn('[PROTOCOL] failed to close broken connection', closeError && closeError.message);
    }
  }

  // 协议保护会把"物品堆/组件 NBT 解析异常"这类包吞掉(只发 malformed_packet_ignored, 不报错不重连)。
  // 单包被丢弃通常无害, 但实测出现过: 吞掉之后连接再也收不到任何包, 一直拖到 35s 保活超时 + 30s 收尾。
  // 这里补两件事:
  //   1) 归类成一行精简日志(不再把整段 protodef 栈当正文), 并落盘 protocol-errors.log
  //   2) 静默看门狗: 从吞包起若 desyncSilenceMs 内没收到任何包, 判定会话已失联, 主动断开本连接由重连策略拉起
  attachProtocolParseGuard(bot) {
    const client = bot && bot._client;
    if (!client || typeof client.on !== 'function') return;

    const deserializer = client.deserializer;
    if (deserializer && typeof deserializer.on === 'function') {
      this.addRuntimeListener(deserializer, 'malformed_packet_ignored', (info) => {
        this.handleIgnoredMalformedPacket(bot, info);
      });

      // 未能吞掉的解析异常(突发超限/不可归类/半包): 错误会抛给上层, 连接可能就此静默卡死,
      // 因此这里也要布置看门狗, 否则只能等 mineflayer 的 35s 保活超时
      this.addRuntimeListener(deserializer, 'packet_parse_error', (info) => {
        this.handleUnswallowedParseError(bot, info);
      });
    }

    // 只要还有包进来就说明连接活着 => 撤销看门狗
    this.addRuntimeListener(client, 'packet', () => {
      this.clearDesyncWatchdog();
    });

    this.runtimeListenerDisposers.push(() => {
      this.clearDesyncWatchdog();
    });
  }

  handleIgnoredMalformedPacket(bot, info) {
    const detail = info && typeof info === 'object' ? info : {};
    const errorMessage = String(detail.errorMessage || '').split('\n')[0].slice(0, 200);
    const summary = `packetId=${detail.packetId} chunk=${detail.chunkLength}B 已忽略第 ${detail.ignoredCount}/${detail.burstLimit} 个(${detail.burstWindowMs}ms 窗口) ${errorMessage}`;

    if (this.protocolGuardConfig.logParseErrors !== false) {
      this.logger.warn(`[PROTOCOL] 解析异常已忽略(协议保护): ${summary}`);
    }

    this.appendProtocolErrorLog(`${getTimestamp()} [${this.config.id}] parse error ignored ${summary}`);
    this.armDesyncWatchdog(bot, summary);
  }

  // 协议保护没能吞掉的解析异常(突发超限/不可归类/半包): 错误已抛给上层, 实测上层不会立刻断开,
  // 连接会静默卡死直到 35s 保活超时。这里补上同一套静默看门狗, 让失联在 desyncSilenceMs 内被发现。
  handleUnswallowedParseError(bot, info) {
    const detail = info && typeof info === 'object' ? info : {};
    const reason = String(detail.reason || 'unclassified');
    const errorMessage = String(detail.errorMessage || '').split('\n')[0].slice(0, 200);
    const summary = `packetId=${detail.packetId} chunk=${detail.chunkLength}B reason=${reason} 未吞包(交给上层处理) ${errorMessage}`;

    if (this.protocolGuardConfig.logParseErrors !== false) {
      this.logger.warn(`[PROTOCOL] 解析异常未能吞掉(${reason}), 已布置失联看门狗: ${summary}`);
    }

    this.appendProtocolErrorLog(`${getTimestamp()} [${this.config.id}] parse error unswallowed ${summary}`);
    this.armDesyncWatchdog(bot, summary);
  }

  armDesyncWatchdog(bot, summary) {
    const configured = this.protocolGuardConfig.desyncSilenceMs;
    // 未配置时用内置默认(运行时的 protocolGuardConfig 可能是未归一化的原始对象); 显式 0 表示关闭
    const silenceMs = configured === 0
      ? 0
      : (Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_DESYNC_SILENCE_MS);
    if (silenceMs <= 0) {
      return;
    }

    this.clearDesyncWatchdog();
    this.desyncWatchdogTimer = setTimeout(() => {
      this.desyncWatchdogTimer = null;
      if (this.connectionEpoch !== this.desyncWatchdogEpoch) {
        return;
      }

      const line = `${getTimestamp()} [${this.config.id}] protocol desync: 解析异常后 ${silenceMs}ms 内无任何数据, 主动断开重连 (${summary})`;
      this.logger.warn(`[PROTOCOL] 解析异常后 ${silenceMs}ms 内无任何数据, 判定会话已失联: 断开本连接重连`);
      this.appendProtocolErrorLog(line);

      // 只终止本连接, 由现有断线重连策略拉起; 不影响其他 bot
      try {
        const target = (bot && typeof bot.quit === 'function') ? bot : this.bot;
        if (target && typeof target.quit === 'function') {
          target.quit('protocol_desync');
        } else if (bot && bot._client && typeof bot._client.end === 'function') {
          bot._client.end('protocol_desync');
        }
      } catch (closeError) {
        this.logger.warn('[PROTOCOL] failed to close broken connection', closeError && closeError.message);
      }
    }, silenceMs);

    this.desyncWatchdogEpoch = this.connectionEpoch;
    if (typeof this.desyncWatchdogTimer.unref === 'function') {
      this.desyncWatchdogTimer.unref();
    }
  }

  clearDesyncWatchdog() {
    if (this.desyncWatchdogTimer) {
      clearTimeout(this.desyncWatchdogTimer);
      this.desyncWatchdogTimer = null;
    }
  }

  appendProtocolErrorLog(line) {
    const filePath = this.protocolErrorLogPath || path.join(process.cwd(), 'logs', 'protocol-errors.log');
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.appendFileSync(filePath, `${line}\n`, 'utf8');
    } catch (error) {
      // 落盘失败不影响主流程
    }
  }

  attachChunkBatchReply(bot) {
    const client = bot && bot._client;
    if (!client || typeof client.on !== 'function' || typeof client.write !== 'function') {
      return;
    }

    const chunksPerTick = this.config?.chunkBatchReplyChunksPerTick;
    if (typeof chunksPerTick !== 'number' || chunksPerTick <= 0) {
      return;
    }

//     this.logger.info(`[BOT] chunk batch reply armed chunksPerTick=${chunksPerTick} (lightweight)`);

    this.addRuntimeListener(client, 'chunk_batch_finished', () => {
      client.write('chunk_batch_received', {
        chunksPerTick
      });
    });
  }

  // 轻量模式专属背包核心: 零实体依赖(自维护 window0 背包与服务器打开的窗口),
  // 让复用 inv/chest 命令的特性在无 mineflayer inventory 插件时也能工作。
  attachLightInventoryCore(bot) {
    const client = bot && bot._client;
    if (!client || typeof client.on !== 'function' || typeof client.write !== 'function') {
      return;
    }

    try {
      const { attachLightInventory } = require('../features/inventory/lightInventoryCore');
      attachLightInventory(bot, {
        addListener: (target, event, handler) => this.addRuntimeListener(target, event, handler),
        logger: this.logger
      });
    } catch (error) {
      this.logger.error('[BOT] lightweight inventory core attach failed', error);
      this.logCapabilitySkip('inventory', 'because lightweight inventory core attach failed');
    }
  }

  // 轻量模式(无实体插件)下记录协议层位置/朝向, 并确认服务端传送。
  // 传送确认是必须的: 服务端在等待确认期间(awaitingPositionFromClient 非空)会静默丢弃
  // useItemOn/useItem, 表现为"服务器 tp 过 bot 之后, 进食/树场等交互彻底失效"。
  attachLightweightPositionTracking(bot) {
    if (!bot || !bot._client) return;

    this.addRuntimeListener(bot._client, 'position', (packet) => {
      // 轻量模式没有物理插件: 必须自己确认服务端传送, 否则服务端会一直等待确认,
      // 并把随后的 useItemOn/useItem(进食、树场等交互)全部静默丢弃。
      // 完整模式由 mineflayer 物理插件负责(同样写 teleport_confirm), 这里不重复处理。
      if (packet && packet.teleportId !== undefined && packet.teleportId !== null) {
        try {
          bot._client.write('teleport_confirm', { teleportId: packet.teleportId });
          if (!this.lightweightTeleportAckLogged) {
            this.lightweightTeleportAckLogged = true;
//             if (this.logger) this.logger.info('[BOT] 轻量模式已开始确认服务端传送(teleport_confirm)');
          }
        } catch (error) {
          if (this.logger) this.logger.warn(`[BOT] 轻量模式确认传送失败: ${error.message}`);
        }
      }

      if (packet && Number.isFinite(packet.x)) {
        this.lastKnownPosition = {
          x: packet.x,
          y: packet.y,
          z: packet.z
        };
      }

      // 协议里的 yaw/pitch 是角度, 这里统一存成弧度(与 mineflayer 的 bot.entity 一致)
      if (packet && Number.isFinite(packet.yaw)) {
        this.lastKnownYaw = packet.yaw * (Math.PI / 180);
      }
      if (packet && Number.isFinite(packet.pitch)) {
        this.lastKnownPitch = packet.pitch * (Math.PI / 180);
      }
    });
  }

  // 轻量模式的特性装配: 零实体/零地形依赖的部分(自身背包 + 服务器主动打开的窗口 + 进食)。
  // 服务器的菜单/箱子经 open_window 下发, 只需要窗口相关的几个小包, 因此轻量模式也能
  // 与普通模式一样查看/点击/关闭(面板展示、chest 命令、close-window 接口全部复用 WindowFeature)。
  // 进食走自建 use_item + 轻量背包核心的窗口点击, 因此轻量模式同样可用(需 inventoryHandling)。
  // 仍不支持的: 走位(movement)、对着方块开箱子/实体交互(需要地形与实体数据)。
  attachLightweightFeatures(bot) {
    if (!this.isInventoryHandlingEnabled()) {
      this.logCapabilitySkip('inventory/window/movement/eat', 'because lightweight mode (no entity/terrain)');
      return;
    }

    this.attachLightInventoryCore(bot);
    this.inventoryFeature.attach(bot);
    this.windowFeature.attach(bot);
    // 轻量模式同样要 attach 进食特性(否则 eat/autoeat 会报 "eat feature not attached")
    this.eatFeature.attach(bot);
    // 轻量模式也支持进食与自动进食(靠轻量背包核心的窗口点击 + 自建 use_item)
    this.autoEatController.attach(bot);
//     this.logCapabilitySkip('movement/block-container', 'because lightweight mode (no entity/terrain)');
  }

  refreshWorldColumnDiagnostics() {
    const count = this.getWorldColumnCount();
    if (count > this.diagnostics.maxWorldColumns) {
      this.diagnostics.maxWorldColumns = count;
      this.diagnostics.maxWorldColumnsAt = getTimestamp();
    }
    return count;
  }

  getWorldColumnCount() {
    return countObjectKeys(this.bot?.world?.async?.columns);
  }

  rememberEndedBotForDiagnostics(bot, reason = 'end') {
    if (!this.isMemoryDetailsEnabled() || !bot) {
      return;
    }

    const world = bot.world || null;
    const columns = world?.async?.columns || null;
    const entry = {
      id: this.config.id,
      username: this.config.username,
      reason,
      endedAt: this.lastEndAt || getTimestamp(),
      connectionCount: this.diagnostics.connectionCount,
      currentConnectionStartedAt: this.diagnostics.currentConnectionStartedAt,
      columnsAtEnd: countObjectKeys(columns),
      entitiesAtEnd: countObjectKeys(bot.entities),
      playersAtEnd: countObjectKeys(bot.players),
      weakRefs: {
        bot: createWeakRef(bot),
        world: createWeakRef(world),
        columns: createWeakRef(columns),
        entities: createWeakRef(bot.entities),
        players: createWeakRef(bot.players),
        client: createWeakRef(bot._client)
      }
    };

    this.diagnostics.endedBotRefs.push(entry);
    if (this.diagnostics.endedBotRefs.length > 20) {
      this.diagnostics.endedBotRefs.splice(0, this.diagnostics.endedBotRefs.length - 20);
    }
  }

  releaseEndedBotLargeCaches(bot) {
    if (!bot || typeof bot !== 'object') {
      return null;
    }

    const released = {
      worldColumns: clearObjectEntries(bot.world?.async?.columns),
      entities: clearObjectEntries(bot.entities),
      players: clearObjectEntries(bot.players)
    };

    if (bot.world && bot.world.sync) {
      released.syncWorldColumns = clearObjectEntries(bot.world.sync.columns);
    }

    if (this.logger && (released.worldColumns || released.entities || released.players || released.syncWorldColumns)) {
      this.logger.info(
        `[BOT] released ended caches columns=${released.worldColumns} entities=${released.entities} players=${released.players} syncColumns=${released.syncWorldColumns || 0}`
      );
    }

    return released;
  }

  getEndedBotRefDiagnostics() {
    if (!this.isMemoryDetailsEnabled()) {
      return [];
    }

    return this.diagnostics.endedBotRefs.map((entry) => {
      const refs = entry.weakRefs || {};
      const bot = derefWeakRef(refs.bot);
      const world = derefWeakRef(refs.world);
      const columns = derefWeakRef(refs.columns);
      const entities = derefWeakRef(refs.entities);
      const players = derefWeakRef(refs.players);
      const client = derefWeakRef(refs.client);
      return {
        id: entry.id,
        username: entry.username,
        reason: entry.reason,
        endedAt: entry.endedAt,
        connectionCount: entry.connectionCount,
        currentConnectionStartedAt: entry.currentConnectionStartedAt,
        columnsAtEnd: entry.columnsAtEnd,
        entitiesAtEnd: entry.entitiesAtEnd,
        playersAtEnd: entry.playersAtEnd,
        alive: {
          bot: Boolean(bot),
          world: Boolean(world),
          columns: Boolean(columns),
          entities: Boolean(entities),
          players: Boolean(players),
          client: Boolean(client)
        },
        retained: {
          columns: countObjectKeys(columns),
          entities: countObjectKeys(entities),
          players: countObjectKeys(players)
        }
      };
    });
  }

  getRuntimeDiagnostics() {
    const bot = this.bot;
    const client = bot && bot._client ? bot._client : null;
    const worldColumns = this.refreshWorldColumnDiagnostics();
    const socket = client && client.socket ? client.socket : null;

    return {
      id: this.config.id,
      username: this.config.username,
      state: this.state,
      desiredRunning: this.desiredRunning,
      expectedRunningSince: this.expectedRunningSince,
      hasBot: Boolean(bot),
      capabilities: this.getCapabilities(),
      worldColumns,
      entities: countObjectKeys(bot?.entities),
      players: countObjectKeys(bot?.players),
      pathfinderLoaded: Boolean(bot?.pathfinder),
      physicsEnabled: bot ? bot.physicsEnabled !== false : null,
      client: client
        ? {
            ended: client.ended === true,
            state: client.state || null,
            socketDestroyed: socket ? socket.destroyed === true : null,
            bytesRead: socket && Number.isFinite(socket.bytesRead) ? socket.bytesRead : null,
            bytesWritten: socket && Number.isFinite(socket.bytesWritten) ? socket.bytesWritten : null
          }
        : null,
      chunkPackets: {
        total: { ...this.diagnostics.totalChunkPackets },
        currentConnection: { ...this.diagnostics.currentChunkPackets },
        connectionCount: this.diagnostics.connectionCount,
        currentConnectionStartedAt: this.diagnostics.currentConnectionStartedAt,
        currentConnectionEndedAt: this.diagnostics.currentConnectionEndedAt,
        lastPacketAt: { ...this.diagnostics.lastPacketAt },
        maxWorldColumns: this.diagnostics.maxWorldColumns,
        maxWorldColumnsAt: this.diagnostics.maxWorldColumnsAt
      },
      endedBotRefs: this.getEndedBotRefDiagnostics()
    };
  }

  async start(options = {}) {
    const source = options && options.source === 'scheduled_restart'
      ? 'scheduled_restart'
      : 'manual';
    if (this.state === 'starting' || this.state === 'online') {
      return this.getDetails();
    }

    if (!this.config.host || !this.config.username) {
      throw new Error(`bot ${this.config.id} missing host or username`);
    }

    this.desiredRunning = true;
    this.expectedRunningSince = getTimestamp();
    this.pendingRestartReason = null;
    this.pendingRestartDelayOverrideMs = null;
    this.pendingRestartDelayMs = null;
    this.pendingRestartScheduledAt = null;
    this.connectionEpoch += 1;
    const epoch = this.connectionEpoch;
    this.lastDisconnectClass = 'unknown';
    this.lastNormalizedDisconnectReason = null;
    if (source === 'manual') {
      this.restartAttempt = 0;
      this.restartScheduleExhausted = false;
    }
    this.clearRestartTimer();
    this.clearStartupWarningTimer();
    this.clearLegacyAutoRestartTimer();
    this.clearPingTimer();
    this.detachRuntimeListeners();
    this.disposeOpenAuthClient();
    this.openAuthProxyEndpoint = null;
    this.openAuthRequestSeen = false;
    this.openAuthRequestMissingRetryEligible = source === 'scheduled_restart' && this.spawnCount > 0;
    this.openAuthPermanentFailure = false;
    await this.forceDestroyStaleSockets();

    this.state = 'starting';
    this.recordLifecycle(LIFECYCLE_EVENTS.BOT_START, {
      detail: `host=${this.config.host} port=${this.config.port} auth=${this.config.auth}`
    });
    this.logger.info(
      `[BOT] connecting host=${this.config.host} port=${this.config.port} username=${this.config.username} auth=${this.config.auth}`
    );
    this.logger.info(
      `[CAP] entityHandling=${this.isEntityHandlingEnabled()} terrainHandling=${this.isTerrainHandlingEnabled()} inventoryHandling=${this.isInventoryHandlingEnabled()} viewDistance=${this.config.viewDistance} chunkBatchReply=${this.config.chunkBatchReplyChunksPerTick}`
    );
    this.publishStatus();

    let openAuthEndpoint = null;
    if (this.isOpenAuthEnabled()) {
      try {
        openAuthEndpoint = await this.openAuthResolver(this.config.host);
        if (!this.desiredRunning || this.state !== 'starting') {
          return this.getDetails();
        }
        this.openAuthProxyEndpoint = openAuthEndpoint;
        this.logger.info('[AUTH][OpenAuth] local proxy address validated');
      } catch (error) {
        const code = getOpenAuthErrorCode(error, 'OPENAUTH_PROXY_RESOLUTION_FAILED');
        this.stopForOpenAuthFailure(code, { quit: false });
        this.logger.error(`[BOT] startup failed code=${code}`);
        throw error;
      }
    }

    const authState = {
      usedCachedSession: false,
      deviceCodeIssued: false
    };
    this.pendingAuthState = authState;
    let bot;
    let createdBot;
    let openAuthClient;
    try {
      bot = runWithConsoleCapture(this.logger, () => {
        const session = this.loadCachedSession();
        authState.usedCachedSession = Boolean(session);
        createdBot = mineflayer.createBot(this.createMineflayerOptions(session, openAuthEndpoint));

        if (this.isOpenAuthEnabled()) {
          openAuthClient = this.openAuthClientFactory({
            config: {
              timeoutMs: this.config.openAuth.requestTimeoutMs
            },
            logger: this.logger,
            onRequest: () => {
              if (this.openAuthClient === openAuthClient) this.markOpenAuthRequestSeen();
            },
            onSuccess: () => {
              if (this.openAuthClient === openAuthClient) this.markOpenAuthRequestSeen();
            },
            onFailure: (details) => {
              this.handleOpenAuthFailure(details, openAuthClient);
            }
          });
          if (!openAuthClient || typeof openAuthClient.attach !== 'function') {
            const error = new Error('OPENAUTH_CLIENT_INVALID');
            error.code = 'OPENAUTH_CLIENT_INVALID';
            throw error;
          }
          this.openAuthClient = openAuthClient;
          openAuthClient.attach(createdBot._client);
        }

        return createdBot;
      });
    } catch (error) {
      this.pendingAuthState = null;
      this.clearStartupWarningTimer();
      this.disposeOpenAuthClient();
      if (createdBot && typeof createdBot.quit === 'function') {
        try {
          createdBot.quit('openauth_startup_failed');
        } catch (quitError) {
        }
      }
      this.lastError = normalizeFailureMessage(error);
      this.recordLifecycle(LIFECYCLE_EVENTS.BOT_START_FAILED, { reason: this.lastError });
      this.refreshFailureState();
      this.state = 'stopped';
      if (this.isOpenAuthEnabled() && error && typeof error.code === 'string') {
        this.stopForOpenAuthFailure(getOpenAuthErrorCode(error), { quit: false });
      }
      this.logger.error('[BOT] startup failed', error);
      this.publishStatus();

      // 同步启动失败(createBot 抛错): 若仍希望运行且非 OpenAuth 永久失败,
      // 按配置延迟走自动重连, 避免 desiredRunning=true 但 state='stopped' 卡死等手动
      if (this.desiredRunning && !this.openAuthPermanentFailure) {
        this.requestRestart('retryable_error', this.restartPolicy.getDelayMs());
      }

      throw error;
    }
    this.bot = bot;
    this.lastClientForCleanup = bot && bot._client ? bot._client : null;
    this.attachUnsignedPlayerChatGuard(bot);
    this.attachUnsignedChatWindowGuard(bot);
    this.attachRuntimeDiagnostics(bot);
    this.scheduleStartupWarning(bot);
    if (this.isOpenAuthEnabled() && bot._client) {
      this.startOpenAuthRequestWatchdog(bot._client);
    }

    if (bot._client) {
      this.addRuntimeListener(bot._client, 'session', (newSession) => {
        const authStateSnapshot = this.pendingAuthState;
        if (
          this.config.email &&
          this.sessionService &&
          typeof this.sessionService.save === 'function'
        ) {
          const saved = this.sessionService.save(this.config.email, newSession);
          if (saved && authStateSnapshot && authStateSnapshot.usedCachedSession !== true) {
            this.logger.info(`[AUTH] 会话已更新并保存 email=${this.config.email}`);
          }
        }

        if (this.config.auth === 'microsoft' && authStateSnapshot) {
          if (authStateSnapshot.usedCachedSession) {
            this.logger.info(`[AUTH] 已使用缓存会话登录 email=${this.config.email || this.config.username}`);
          } else if (authStateSnapshot.deviceCodeIssued) {
            this.logger.info('[msa] Signed in with Microsoft');
          } else {
            this.logger.info('[AUTH] Microsoft 登录成功');
          }
        }

        this.pendingAuthState = null;
      });

      this.addRuntimeListener(bot._client, 'ping_response', (packet) => {
        this.handlePingResponse(packet);
      });

      // 轻量模式（无实体插件）下通过协议层位置同步包记录坐标，供 getpos 使用
      if (this.isLightweightMode()) {
        this.attachLightweightPositionTracking(bot);

        // 服务器按客户端回报速率(chunk_batch_received)推送区块; 轻量 bot 不加载区块,
        // 回最低速率让服务器尽量少推。注意完整模式由 blocks 插件回包, 仅轻量模式注册避免双写。
        this.attachChunkBatchReply(bot);
      }
      // 诊断：打印 configuration 阶段收到的包名（diagnostics.configurationPacketLog 开启时）
      if (this.diagnosticsConfig?.configurationPacketLog === true && bot._client) {
        this.addRuntimeListener(bot._client, 'packet', (data, meta) => {
          if (bot._client.state === 'configuration' && meta && meta.name) {
            this.logger.info(`[CFG-DEBUG] ${meta.name}`);
          }
        });
      }

      // 协议保护吞掉解析异常后(见 protocol-guard-hotfix), 连接可能进入"收不到包"的假死:
      // 这里做归类日志 + 静默看门狗, 超时即主动重连, 不必等 35s 保活 + 30s 收尾
      this.attachProtocolParseGuard(bot);

      // 解压流(zlib/varint)错误在 minecraft-protocol 无监听会直接 uncaught 崩进程:
      // 接住 -> 记日志+落盘 -> 仅断开该 bot 重连
      this.ensureDecompressorErrorGuard(bot);

      this.addRuntimeListener(bot._client, 'disconnect', (packet) => {
        if (epoch !== this.connectionEpoch) {
          return;
        }

        const reason = normalizeDisconnectText(packet && packet.reason ? packet.reason : packet);
        const matchedClass = classifyDisconnectReason(reason);
        const disconnectClass = matchedClass
          || (this.canOrdinaryDisconnect() ? 'ordinary_disconnect' : 'unknown');
        this.recordDisconnectClass(epoch, disconnectClass, reason);
        if (reason) {
          this.lastError = reason;
          this.refreshFailureState();
          this.logger.error('[BOT] disconnect', reason);
          this.publishStatus();
        }
      });
    }

    this.teleportFeature.attach(bot);
    this.activityLogFeature.attach(bot);
    if (this.isLightweightMode()) {
      this.attachLightweightFeatures(bot);
      // 轻量模式也能 ride: 靠协议层 spawn_entity/entity_destroy 维护的极简实体索引
      this.rideFeature.attachLightweight(bot);
    // 树场只依赖 _client 与坐标(不依赖实体/地形/背包), 轻量模式同样可用
    this.treeFarmFeature.attach(bot);
    } else {
      this.inventoryFeature.attach(bot);
      this.windowFeature.attach(bot);
      this.movementFeature.attach(bot);
      this.eatFeature.attach(bot);
      this.autoEatController.attach(bot);
      this.treeFarmFeature.attach(bot);
    }

    if (this.isEntityHandlingEnabled()) {
      this.attackFeature.attach(bot);
      this.entityInteractFeature.attach(bot);
      this.fishFeature.attach(bot);
      this.monitoringFeature.attach(bot);
    } else {
      if (this.config.legacyConfig.attack?.autoAttack === true) {
        this.logCapabilitySkip('autoAttack', 'because entityHandling=false');
      }
      if (this.config.legacyConfig.fish === true) {
        this.logCapabilitySkip('fish auto start', 'because entityHandling=false');
      }
      if (this.config.legacyConfig.monitoring?.enabled === true) {
        this.logCapabilitySkip('monitoring', 'because entityHandling=false');
      }
    }

    if (this.isTerrainHandlingEnabled()) {
      this.vaultFeature.attach(bot);
      this.blockUseFeature.attach(bot);
      this.digFeature.attach(bot);
      this.cplaceFeature.attach(bot);
    }

    if (this.shouldAttachRideFeature()) {
      this.rideFeature.attach(bot);
    }

    if (this.shouldAttachBlockBreakFeature()) {
      this.blockBreakFeature.attach(bot);
    } else if (this.config.legacyConfig.blockBreakDetection?.enabled === true) {
      const reason = this.isEntityHandlingEnabled()
        ? 'because terrainHandling=false'
        : this.isTerrainHandlingEnabled()
          ? 'because entityHandling=false'
          : 'because entityHandling=false terrainHandling=false';
      this.logCapabilitySkip('blockBreakDetection', reason);
    }

    this.recorderFeature.attach(bot);
    this.chatFeature.attach(bot);
    this.trustedPlayersStore.start();
    this.teleportFeature.start();
    this.addRuntimeListener(bot, 'resourcePack', (urlOrUuid, hashOrUuid) => {
      this.handleResourcePack(bot, urlOrUuid, hashOrUuid);
    });

    // 轻量模式（无实体/地形插件）不会触发 spawn，改用 login（进入 play）作为就绪信号
    const botReadyEvent = this.isLightweightMode() ? 'login' : 'spawn';
    this.addRuntimeListener(bot, botReadyEvent, () => {
      this.handleBotReady();
    }, { once: true });

    // login 可能在监听注册前已触发（快速重连/登录缓存）——若已在 play 就直接就绪，避免 startup timeout
    if (this.isLightweightMode() && bot._client && bot._client.state === 'play' && this.state !== 'online') {
      setImmediate(() => {
        if (this.state !== 'online' && bot === this.bot) {
          this.handleBotReady();
        }
      });
    }

    this.addRuntimeListener(bot, 'kicked', (reason) => {
      if (epoch !== this.connectionEpoch) {
        return;
      }

      this.clearStartupWarningTimer();
      const reasonText = normalizeDisconnectText(reason);
      const matchedClass = classifyDisconnectReason(reasonText);
      const disconnectClass = matchedClass
        || (this.canOrdinaryDisconnect() ? 'ordinary_disconnect' : 'unknown');
      this.recordDisconnectClass(epoch, disconnectClass, reasonText);
      this.lastKick = reasonText;
      this.refreshFailureState();
      this.logger.warn('[BOT] kicked', reasonText);
      this.recordLifecycle(LIFECYCLE_EVENTS.BOT_KICKED, { reason: reasonText, detail: disconnectClass });
      this.publishStatus();
    });

    this.addRuntimeListener(bot, 'error', (error) => {
      this.handleError(error);
    });

    // 观测用: 只记录"最近一次发言"的时间与类型(是否 / 命令), 不记录内容;
    // 用于判断"说话即断"类现象, 并把 mineflayer 的 end reason 带进日志与 lifecycle
    if (typeof bot.chat === 'function') {
      const originalChat = bot.chat.bind(bot);
      bot.chat = (message) => {
        this.lastOutgoingChatAt = Date.now();
        this.lastOutgoingChatIsCommand = typeof message === 'string' && message.startsWith('/');
        return originalChat(message);
      };
    }

    this.addRuntimeListener(bot, 'end', (reason) => {
      void this.handleEnd(epoch, reason);
    });

    return this.getDetails();
  }

  async stop(reason = 'manual_stop') {
    this.desiredRunning = false;
    this.expectedRunningSince = null;
    this.pendingRestartReason = null;
    this.pendingRestartDelayMs = null;
    this.restartAttempt = 0;
    this.restartScheduleExhausted = false;
    this.clearRestartTimer();
    this.clearStartupWarningTimer();
    this.clearLegacyAutoRestartTimer();
    this.clearPingTimer();
    this.disposeOpenAuthClient();
    this.recordLifecycle(LIFECYCLE_EVENTS.BOT_STOP, { reason });

    if (!this.bot) {
      this.detachRuntimeListeners();
      this.detachFeaturesFromBot();
      this.clearStartupWarningTimer();
      await this.forceDestroyStaleSockets();
      this.state = 'stopped';
      this.publishStatus();
      return this.getDetails();
    }

    const bot = this.bot;
    this.state = 'stopping';
    this.publishStatus();

    await this.recorderFeature.shutdown(reason);

    await new Promise((resolve) => {
      let resolved = false;
      const finish = () => {
        if (resolved) return;
        resolved = true;
        resolve();
      };

      bot.once('end', finish);
      setTimeout(finish, 5000);
      try {
        bot.quit(reason);
      } catch (error) {
        finish();
      }
    });

    await this.forceDestroyStaleSockets();
    await this.finalizeEndedBot(bot, reason);
    return this.getDetails();
  }

  // 强制销毁残留 client 的底层 socket。
  // 覆盖两类情况:卡在认证/握手阶段从未触发 error/end 的连接,以及 stop 时
  // quit 失效或 this.bot 已为空导致连接未被关闭的残留。销毁后代理会释放玩家名,
  // 避免重启时出现 "already connected to this proxy"。
  async forceDestroyStaleSockets() {
    const currentClient = this.bot && this.bot._client ? this.bot._client : null;
    const clients = [];
    if (currentClient) {
      clients.push(currentClient);
    }
    if (this.lastClientForCleanup && this.lastClientForCleanup !== currentClient) {
      clients.push(this.lastClientForCleanup);
    }
    this.lastClientForCleanup = null;

    for (const client of clients) {
      if (!client || !client.socket || client.socket.destroyed) {
        continue;
      }
      try {
        client.socket.destroy();
        this.logger.warn('[BOT] force-destroyed leftover socket during stop');
      } catch (error) {
        this.logger.warn('[BOT] failed to force-destroy leftover socket', error);
      }
    }
  }

  async restart(reason = 'manual_restart') {
    await this.stop(reason);
    this.desiredRunning = true;
    return this.start();
  }

  recordLifecycle(event, options = {}) {
    const service = this.lifecycleLogService;
    if (!service || typeof service.record !== 'function') {
      return false;
    }

    return service.record(event, {
      botId: this.config ? this.config.id : null,
      serverDir: this.config ? this.config.serverDir : null,
      ...options
    });
  }

  getWindowSnapshot() {
    if (this.windowFeature && typeof this.windowFeature.getCurrentSnapshot === 'function') {
      const snapshot = this.windowFeature.getCurrentSnapshot();
      if (snapshot) {
        return snapshot;
      }
    }

    // 轻量模式(无 windowFeature/无容器): 回退到自身背包(window0)快照, 供面板物品栏展示
    if (this.bot && this.bot.inventory) {
      const { buildWindowSnapshot } = require('../features/window/WindowSnapshot');
      return buildWindowSnapshot(this.bot.inventory);
    }

    return null;
  }

  async closeWindow() {
    if (!this.windowFeature || typeof this.windowFeature.closeWindow !== 'function') {
      return { ok: true, closed: false };
    }

    return this.windowFeature.closeWindow();
  }

  // 原版语义点击(命令/HTTP 面板/脚本共用): 见 src/features/window/WindowClick.js
  clickWindowSlot(options = {}) {
    if (!this.windowFeature || typeof this.windowFeature.clickSlot !== 'function') {
      throw new Error('窗口模块未初始化(轻量模式需要 inventoryHandling=true)');
    }

    return this.windowFeature.clickSlot(options);
  }

  detachFeaturesFromBot() {
    const features = [
      this.scriptFeature,
      this.attackFeature,
      this.entityInteractFeature,
      this.blockUseFeature,
      this.digFeature,
      this.blockBreakFeature,
      this.monitoringFeature,
      this.activityLogFeature,
      this.inventoryFeature,
      this.windowFeature,
      this.cplaceFeature,
      this.fishFeature,
      this.rideFeature,
      this.movementFeature,
      this.eatFeature,
      this.autoEatController,
      this.treeFarmFeature,
      this.trustedPlayersStore,
      this.teleportFeature,
      this.chatFeature,
      this.vaultFeature
    ];

    for (const feature of features) {
      try {
        if (feature && typeof feature.detach === 'function') {
          feature.detach();
        } else if (feature && typeof feature.stop === 'function') {
          feature.stop();
        }
      } catch (error) {
      }
    }

    if (this.recorderFeature && typeof this.recorderFeature.detach === 'function') {
      try {
        this.recorderFeature.detach();
      } catch (error) {
      }
    }

    if (this.scriptFeature && typeof this.scriptFeature.clearSchedulerTimers === 'function') {
      this.scriptFeature.clearSchedulerTimers();
    }
  }

  async finalizeEndedBot(endedBot, reason = 'end', options = {}) {
    // 走到这里就意味着"这条连接已经结束"。handleEnd 里的连接结束时刻写入可能因
    // epoch 不匹配(迟到的 end 事件)或 'end' 未在 stop 的等待窗口内触发而缺失,
    // 一旦缺失, 巡检器/D 类事件就会拿更早的 lastSpawnAt 当基准, 把正常重启误报成长期卡死。
    // 因此在这里兜底补写, 且只允许时间前进(防止迟到的 finalize 把较新的值改旧)。
    const endedAt = typeof options.endedAt === 'string' && options.endedAt
      ? options.endedAt
      : getTimestamp();
    const endedAtMs = Date.parse(endedAt);
    const currentEndedAtMs = Date.parse(this.lastEndAt || '');
    if (Number.isFinite(endedAtMs) && (!Number.isFinite(currentEndedAtMs) || endedAtMs >= currentEndedAtMs)) {
      this.lastEndAt = endedAt;
      this.diagnostics.currentConnectionEndedAt = endedAt;
    }

    this.clearPingTimer();
    this.disposeOpenAuthClient();
    this.detachRuntimeListeners();
    this.detachFeaturesFromBot();
    this.releaseEndedBotLargeCaches(endedBot);

    if (this.bot === endedBot) {
      this.bot = null;
    }

    if (options.publishStopped !== false) {
      this.state = 'stopped';
      this.publishStatus();
    }
  }

  // 把 mineflayer 传进来的 end reason 归一成一行可读文本(踢出包里可能是 JSON 组件)
  describeEndReason(reason) {
    if (reason === undefined || reason === null || reason === '') {
      return 'unknown';
    }

    let text;
    if (typeof reason === 'string') {
      text = reason;
    } else {
      try {
        text = JSON.stringify(reason);
      } catch (error) {
        text = String(reason);
      }
    }

    const trimmed = String(text).replace(/\s+/g, ' ').trim();
    return trimmed.length > 180 ? `${trimmed.slice(0, 180)}...` : trimmed;
  }

  // 连接时长 + 距最近一次发言的时间(只有时间戳/类型, 没有内容)
  describeEndContext() {
    const startedAtMs = Date.parse(this.diagnostics.currentConnectionStartedAt || '');
    const uptimeText = Number.isFinite(startedAtMs)
      ? ` uptime=${Math.max(0, Math.round((Date.now() - startedAtMs) / 1000))}s`
      : '';

    if (!Number.isFinite(this.lastOutgoingChatAt)) {
      return `${uptimeText} sinceLastChat=none chatSends=${this.chatSendCount}`;
    }

    const sinceChatMs = Math.max(0, Date.now() - this.lastOutgoingChatAt);
    const kind = this.lastOutgoingChatIsCommand ? 'command' : 'chat';
    const packetText = this.lastOutgoingChatPacket ? ` lastChatPacket=${this.lastOutgoingChatPacket}` : '';
    return `${uptimeText} sinceLastChat=${(sinceChatMs / 1000).toFixed(1)}s(${kind}) chatSends=${this.chatSendCount}${packetText}`;
  }

  async handleEnd(epoch, endReason) {
    if (epoch !== undefined && epoch !== this.connectionEpoch) {
      return;
    }

    this.clearStartupWarningTimer();
    this.clearOpenAuthRequestWatchdog();
    const wasStarting = this.state === 'starting';
    const endedAt = getTimestamp();
    const endReasonText = this.describeEndReason(endReason);
    const endContext = this.describeEndContext();
    this.lastEndReason = endReasonText;
    this.lastEndAt = endedAt;
    this.diagnostics.currentConnectionEndedAt = endedAt;
    const endedBot = this.bot;
    this.rememberEndedBotForDiagnostics(endedBot, 'end');
    if (wasStarting && !this.lastFailure) {
      this.lastFailure = 'connection ended before spawn';
      this.lastFailureAt = this.lastEndAt;
    }
    const backendUnavailable = this.lastDisconnectClass === 'backend_unavailable';
    if (
      this.isOpenAuthEnabled() &&
      this.desiredRunning &&
      !backendUnavailable &&
      !this.openAuthRequestSeen &&
      !this.openAuthPermanentFailure &&
      !this.pendingRestartReason
    ) {
      this.handleOpenAuthRequestWatchdogTimeout(endedBot?._client, { quit: false });
    }
    this.logger.warn(`[BOT] end reason=${endReasonText}${endContext}`);
    const disconnectReason = this.pendingRestartReason
      || (backendUnavailable ? 'backend_unavailable' : 'disconnect');
    this.recordLifecycle(LIFECYCLE_EVENTS.BOT_DISCONNECT, {
      reason: disconnectReason,
      detail: `endReason=${endReasonText}${endContext}`
    });
    this.clearLegacyAutoRestartTimer();
    await this.finalizeEndedBot(endedBot, 'end', { publishStopped: false, endedAt });

    if (this.desiredRunning && this.restartPolicy.shouldRestart()) {
      const delayMs = this.pendingRestartDelayOverrideMs;
      let reason = this.pendingRestartReason;
      if (!reason) {
        reason = backendUnavailable ? 'backend_unavailable' : 'disconnect';
      }
      this.scheduleRestart(reason, delayMs);
      return;
    }

    this.state = 'stopped';
    this.publishStatus();
  }

  handleError(error) {
    this.clearStartupWarningTimer();
    if (isIgnorableMalformedNbtArrayError(error)) {
      if (this.protocolGuardConfig.logParseErrors !== false) {
        this.logger.warn('[BOT] ignored malformed packet', error && error.message ? error.message : error);
      }
      return;
    }

    const message = normalizeFailureMessage(error);
    const lower = String(message).toLowerCase();
    this.lastError = message;
    this.refreshFailureState();
    this.logger.error('[BOT] error', error);
    this.publishStatus();

    if (
      lower.includes('forbiddenoperationexception') &&
      this.config.email &&
      this.sessionService &&
      typeof this.sessionService.delete === 'function'
    ) {
      const deleted = this.sessionService.delete(this.config.email);
      this.logger.warn(
        `[AUTH] cached session rejected; scheduling credential refresh sessionDeleted=${deleted === true}`
      );
      this.trackInvalidSessionRetry();
      this.requestRestart('invalid_session_retry', 1000);
      return;
    }

    if (
      lower.includes('failed to obtain profile data') ||
      lower.includes('does the account own minecraft')
    ) {
      this.requestRestart('retryable_error', this.restartPolicy.getDelayMs());
      return;
    }

    // Xbox/Mojang 限流: token 仍有效, 保留 auth-cache 不删 session, 按配置延迟自动重连
    if (
      lower.includes('too many requests') ||
      lower.includes('rate limit') ||
      lower.includes('/authentication/login_with_xbox')
    ) {
      this.requestRestart('retryable_error', this.restartPolicy.getDelayMs());
      return;
    }

    // prismarine-auth 登录阶段 Xbox token 403: 缓存里的 device/title token 本地未过期,
    // 但由旧 EC 密钥获取(每次认证都会新生成密钥), 复用后与当前 ProofKey 不匹配 -> 每次
    // 重取 title token 都被拒。清 xbl 缓存后按退避策略重试, 下一次认证会用当前密钥重取。
    // 判据必须精准(四条件), 避免误伤其他来源的 403。
    const errorStack = error && typeof error.stack === 'string' ? error.stack : '';
    if (
      this.state === 'starting' &&
      lower.includes('403') &&
      lower.includes('forbidden') &&
      errorStack.includes('prismarine-auth') &&
      /XboxTokenManager\./.test(errorStack)
    ) {
      this.resetAuthCache('xbl');
      this.logger.warn('[AUTH] reset xbl cache after prismarine-auth xbox 403; scheduling retry');
      this.notifyBarkAuth403();
      this.requestRestart('auth_cache_reset', this.restartPolicy.getDelayMs());
      return;
    }

    // refresh_token 失效 / 需要交互登录: 自动重连解决不了, 必须人工重新登录(只通知, 不改重启行为)
    if (isRefreshTokenInvalidError(lower)) {
      this.notifyBarkEvent({
        type: 'refreshTokenInvalid',
        key: `auth:refresh-token:${this.config.id}`,
        severity: 'critical',
        body: `${this.config.id} 登录凭据已失效(refresh token), 需要人工重新登录 @ ${this.config.host}`
      });
      return;
    }

    // 账号被拒/被封(认证层): 重连无用(只通知, 不改重启行为)
    if (AUTH_REJECTED_FRAGMENTS.some((fragment) => lower.includes(fragment))) {
      this.notifyBarkEvent({
        type: 'authRejected',
        key: `auth:rejected:${this.config.id}`,
        severity: 'critical',
        body: `${this.config.id} 账号被服务器/认证服务拒绝, 需要人工确认 @ ${this.config.host}`
      });
    }
  }

  // 事件推送统一入口: 全部吞掉异常, 绝不影响 bot 生命周期
  notifyBarkEvent({ type, key, severity = 'active', body } = {}) {
    try {
      if (!this.barkNotifier || typeof this.barkNotifier.notifyEvent !== 'function') {
        return null;
      }
      if (typeof this.barkNotifier.isEnabled === 'function' && !this.barkNotifier.isEnabled()) {
        return null;
      }

      const promise = this.barkNotifier.notifyEvent({
        type,
        key: key || `${type}:${this.config.id}`,
        severity,
        title: 'MULTIBOT Downdetector',
        body,
        label: this.config.id
      });

      return promise && typeof promise.catch === 'function' ? promise.catch(() => null) : promise;
    } catch (error) {
      return null;
    }
  }

  // 恢复在线后, 把本 bot 所有挂起的事件一并清掉: 只推一条"已恢复", 其余只清状态
  notifyBarkRecoveryForOnline() {
    try {
      if (!this.barkNotifier || typeof this.barkNotifier.notifyRecovery !== 'function') {
        return null;
      }

      const id = this.config.id;
      const pendingKeys = BARK_BOT_EVENT_KEY_PREFIXES
        .map((prefix) => `${prefix}:${id}`)
        .filter((key) => typeof this.barkNotifier.hasPendingFailure === 'function'
          && this.barkNotifier.hasPendingFailure(key));

      if (pendingKeys.length === 0) {
        return null;
      }

      const promise = this.barkNotifier.notifyRecovery({
        type: 'botRecovered',
        key: pendingKeys[0],
        severity: 'active',
        title: 'MULTIBOT Downdetector',
        body: `${id} 已恢复在线 @ ${this.config.host}`,
        label: id
      });

      const cleanup = () => {
        pendingKeys.slice(1).forEach((key) => {
          if (typeof this.barkNotifier.markEventResolved === 'function') {
            this.barkNotifier.markEventResolved(key);
          } else if (typeof this.barkNotifier.clearEventState === 'function') {
            this.barkNotifier.clearEventState(key);
          }
        });
        return null;
      };

      return promise && typeof promise.then === 'function'
        ? promise.then(cleanup).catch(() => null)
        : null;
    } catch (error) {
      return null;
    }
  }

  getNotificationEventConfig(type) {
    if (this.barkNotifier && typeof this.barkNotifier.getEventConfig === 'function') {
      return this.barkNotifier.getEventConfig(type);
    }
    return { enabled: false, cooldownMs: 0 };
  }

  // invalid_session 失效计数: 用滑动/整窗计数而不是"连续次数"——因为每次失效后都会重启,
  // 只要登录成功就会走 handleBotReady, 连续计数永远清零, 阈值不可达(评审指出)。
  // 语义: 窗口内失效 >= threshold 次即报警(抖动本身就是要处理的问题, 不因中间上线而豁免)。
  trackInvalidSessionRetry() {
    const eventConfig = this.getNotificationEventConfig('invalidSession');
    const threshold = Number(eventConfig.threshold) > 0 ? Number(eventConfig.threshold) : 3;
    const windowMs = Number(eventConfig.windowMs) > 0 ? Number(eventConfig.windowMs) : 3600000;

    if (!this.invalidSessionTracker) {
      this.invalidSessionTracker = new EventThresholdTracker({ threshold, windowMs });
    }

    const { count, exceeded } = this.invalidSessionTracker.record();
    if (exceeded) {
      const windowMinutes = Math.max(1, Math.round(windowMs / 60000));
      this.notifyBarkEvent({
        type: 'invalidSession',
        key: `auth:invalid-session:${this.config.id}`,
        severity: 'critical',
        body: `${this.config.id} ${windowMinutes} 分钟内登录会话失效 ${count} 次, 需要人工重新登录 @ ${this.config.host}`
      });
    }

    return count;
  }

  // 403 自愈时推送手机提醒(标题 MULTIBOT Downdetector); 同一 bot 在冷却期内只推一次,
  // 其余情况只写日志。推送内容不含任何凭据(device_key 等由脚本自行读取)。
  notifyBarkAuth403() {
    if (
      !this.barkNotifier
      || typeof this.barkNotifier.notify !== 'function'
      || typeof this.barkNotifier.isEnabled !== 'function'
      || !this.barkNotifier.isEnabled()
    ) {
      return;
    }

    const now = Date.now();
    const cooldownMs = typeof this.barkNotifier.getCooldownMs === 'function'
      ? this.barkNotifier.getCooldownMs()
      : 600000;
    if (this.lastBarkAuthNotifyAt && now - this.lastBarkAuthNotifyAt < cooldownMs) {
      this.logger.info(`[NOTIFY] bark 403 push skipped (cooldown) bot=${this.config.id}`);
      return;
    }
    this.lastBarkAuthNotifyAt = now;

    const account = this.config.email || this.config.username || 'unknown';
    const body = `${this.config.id} (${account}) @ ${this.config.host} 认证403, 已清 xbl 缓存并安排重试`;

    this.barkNotifier.notify({ title: 'MULTIBOT Downdetector', body, label: this.config.id })
      .then((result) => {
        const ok = result && result.ok === true;
        const reason = !ok && result && result.reason ? ` reason=${result.reason}` : '';
        this.logger.info(`[NOTIFY] bark 403 push ${ok ? 'ok' : 'fail'}${reason} bot=${this.config.id}`);
      })
      .catch(() => {
        this.logger.warn(`[NOTIFY] bark 403 push error bot=${this.config.id}`);
      });
  }

  // 重置指定 prismarine-auth 缓存(如 'xbl'): reset() 将缓存内容写为空对象 {},
  // 不删除/不移动文件; 保留 msa/live 缓存以便 refresh_token 静默刷新(无需设备码)。
  // 注: DualFileCache 的写盘是同步完成(fs.writeFileSync), 故无需 await。
  resetAuthCache(cacheName) {
    try {
      const factory = createAuthCacheFactory({
        primaryDir: this.config?.paths?.authCacheDir,
        fallbackDir: this.config?.paths?.fallbackAuthCacheDir,
        primaryUsername: this.config?.email
      });
      const cache = factory({ cacheName, username: this.config?.username });
      if (!cache || typeof cache.reset !== 'function') {
        this.logger.warn(`[AUTH] reset auth cache skipped (unavailable) name=${cacheName}`);
        return false;
      }

      cache.reset();
      this.logger.warn(`[AUTH] auth cache reset name=${cacheName}`);
      return true;
    } catch (error) {
      this.logger.warn(
        `[AUTH] reset auth cache failed name=${cacheName}: ${error && error.message ? error.message : error}`
      );
      return false;
    }
  }

  requestRestart(reason, delayMs) {
    this.desiredRunning = true;
    this.pendingRestartReason = reason;
    this.pendingRestartDelayOverrideMs = delayMs;

    if (!this.bot) {
      this.scheduleRestart(reason, delayMs);
      return;
    }

    try {
      this.bot.quit(reason);
    } catch (error) {
      this.scheduleRestart(reason, delayMs);
    }
  }

  clearRestartTimer() {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    this.pendingRestartDelayOverrideMs = null;
    this.pendingRestartDelayMs = null;
    this.pendingRestartScheduledAt = null;
  }

  clearStartupWarningTimer() {
    if (!this.startupWarningTimer) {
      return;
    }

    clearTimeout(this.startupWarningTimer);
    this.startupWarningTimer = null;
  }

  clearLegacyAutoRestartTimer() {
    if (this.legacyAutoRestartTimer) {
      clearTimeout(this.legacyAutoRestartTimer);
      this.legacyAutoRestartTimer = null;
    }

    this.legacyAutoRestartScheduledAt = null;
  }

  scheduleLegacyAutoRestart() {
    this.clearLegacyAutoRestartTimer();

    if (!Number.isFinite(this.legacyAutoRestartMinutes) || this.legacyAutoRestartMinutes <= 0) {
      return;
    }

    const delayMs = this.legacyAutoRestartMinutes * 60 * 1000;
    this.legacyAutoRestartScheduledAt = getTimestamp(new Date(Date.now() + delayMs));
    this.legacyAutoRestartTimer = setTimeout(() => {
      this.legacyAutoRestartTimer = null;
      this.legacyAutoRestartScheduledAt = null;
      void this.restart('legacy_auto_restart').catch((error) => {
        this.logger.error('[BOT] legacy auto restart failed', error);
      });
    }, delayMs);

    this.logger.info(`[BOT] legacy auto restart scheduled minutes=${this.legacyAutoRestartMinutes}`);
  }

  scheduleStartupWarning(bot) {
    this.clearStartupWarningTimer();

    if (!bot || this.startupWarningDelayMs <= 0) {
      return;
    }

    this.startupWarningTimer = setTimeout(() => {
      this.startupWarningTimer = null;

      if (this.bot !== bot || this.state !== 'starting') {
        return;
      }

      this.lastError = `startup timeout after ${this.startupWarningDelayMs}ms before spawn`;
      this.refreshFailureState();
      const protocolState = bot && bot._client ? bot._client.state : 'unknown';
      this.logger.error(
        `[BOT] startup timeout host=${this.config.host} port=${this.config.port} afterMs=${this.startupWarningDelayMs} state=${protocolState}`
      );
      this.publishStatus();

      // 认证/握手阶段挂起(如微软认证网络失败)时,错误不会触发 bot 的 error/end 事件,
      // 启动会永久卡在 starting。这里主动断开,走与普通断线相同的 end → scheduleRestart 链路。
      // openAuth 流程等待用户扫码可能超过超时,不能打断,故跳过。
      if (this.desiredRunning && !this.isOpenAuthEnabled()) {
        try {
          if (bot && typeof bot.quit === 'function') {
            bot.quit('startup_timeout');
            return;
          }
        } catch (quitError) {
        }
        this.requestRestart('disconnect');
      }
    }, this.startupWarningDelayMs);
  }

  scheduleRestart(reason, delayMs) {
    if (this.restartTimer) {
      return;
    }

    const useReconnectPolicy = this.isReconnectClassReason(reason);
    const schedule = this.restartPolicy.buildRestartSchedule(reason, {
      attempt: this.restartAttempt,
      overrideDelayMs: delayMs,
      useReconnectPolicy
    });

    if (schedule.exhausted === true) {
      this.restartScheduleExhausted = true;
      this.desiredRunning = false;
      this.clearRestartTimer();
      this.state = 'stopped';
      this.logger.warn(
        `[BOT] reconnect attempts exhausted reason=${reason} attempts=${this.restartAttempt}`
      );
      this.publishStatus();
      this.notifyBarkEvent({
        type: 'restartExhausted',
        key: `bot:exhausted:${this.config.id}`,
        severity: 'critical',
        body: `${this.config.id} 自动重连已用尽(attempts=${this.restartAttempt} reason=${reason}), 已停止重连 @ ${this.config.host}`
      });
      return;
    }

    const scheduleConfigured = useReconnectPolicy && schedule.scheduleConfigured === true;
    if (scheduleConfigured) {
      this.restartAttempt += 1;
    }

    this.state = 'waiting_restart';
    this.pendingRestartReason = reason;
    this.pendingRestartDelayOverrideMs = null;
    this.pendingRestartDelayMs = schedule.totalDelayMs;
    this.pendingRestartScheduledAt = getTimestamp(new Date(Date.now() + schedule.totalDelayMs));
    this.publishStatus();
    this.recordLifecycle(LIFECYCLE_EVENTS.BOT_RESTART_SCHEDULED, {
      reason,
      detail: `delayMs=${schedule.totalDelayMs}`
    });
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.pendingRestartReason = null;
      this.pendingRestartDelayOverrideMs = null;
      this.pendingRestartDelayMs = null;
      this.pendingRestartScheduledAt = null;
      void this.start({ source: 'scheduled_restart' }).catch((error) => {
        this.logger.error('[BOT] restart failed', error);
      });
    }, schedule.totalDelayMs);

    const failureDetail = this.lastFailure ? ` detail=${this.lastFailure}` : '';
    const attemptText = scheduleConfigured ? ` attempt=${this.restartAttempt}` : '';
    this.logger.warn(
      `[BOT] scheduled restart reason=${reason}${attemptText} baseDelayMs=${schedule.baseDelayMs} jitterMs=${schedule.jitterMs} totalDelayMs=${schedule.totalDelayMs}${failureDetail}`
    );
  }

  clearFailureState() {
    this.lastError = null;
    this.lastKick = null;
    this.lastFailure = null;
    this.lastFailureAt = null;
  }

  refreshFailureState() {
    const parts = [];
    const lastKick = normalizeFailureMessage(this.lastKick);
    const lastError = normalizeFailureMessage(this.lastError);

    if (lastKick) {
      parts.push(`kick: ${lastKick}`);
    }

    if (lastError && lastError !== lastKick) {
      parts.push(`error: ${lastError}`);
    }

    this.lastFailure = parts.length > 0 ? parts.join(' | ') : null;
    this.lastFailureAt = this.lastFailure ? getTimestamp() : null;
  }

  async executeCommand(content, context) {
    try {
      return await this.commandDispatcher.dispatch(content, context);
    } catch (error) {
      this.logger.error('[COMMAND] execution failed', error);
      if (context && typeof context.replyError === 'function') {
        context.replyError(`命令执行失败: ${error.message}`);
      }
      return true;
    }
  }

  sendChat(message) {
    if (!this.bot) {
      throw new Error('bot not connected');
    }
    this.bot.chat(message);
  }

  broadcastSend(message) {
    if (this.broadcastService && typeof this.broadcastService.broadcastSend === 'function') {
      return this.broadcastService.broadcastSend(message, this.config.id);
    }

    this.sendChat(message);
    return [this.config.id];
  }

  // 同服务器在线 bot 锁状态摘要(whisper lockstatus 用): 有广播服务则聚合与自身同
  // serverDir 的在线 bot, 否则仅返回自身。
  getGlobalLockStatus() {
    if (this.broadcastService && typeof this.broadcastService.collectLockStatuses === 'function') {
      const collected = this.broadcastService.collectLockStatuses(this.config.serverDir || null);
      if (collected.length > 0) {
        return collected;
      }
    }

    if (this.state !== 'online') {
      return [];
    }

    return [{
      botId: this.config.id,
      username: this.config.username || this.config.id,
      state: this.state,
      serverDir: this.config.serverDir || null,
      lock: this.lockFeature.getTeleportLockStatus()
    }];
  }

  async broadcastCommand(command, options = {}) {
    if (this.broadcastService && typeof this.broadcastService.broadcastCommand === 'function') {
      return this.broadcastService.broadcastCommand(command, {
        ...options,
        sourceBotId: this.config.id
      });
    }
    const context = this.createCommandContext({
      source: 'broadcast',
      sender: options.sender || this.config.id
    });
    await this.executeCommand(command, context);

    const messages = typeof context.getMessages === 'function' ? context.getMessages() : [];
    const failureEntry = messages.find((entry) => {
      const message = String(entry && entry.message ? entry.message : '');
      return entry && (entry.mode === 'tell' || /失败|未找到|无法解析|请先关闭|用法:|未知命令/.test(message));
    });

    return {
      command: String(command || '').trim(),
      successBotIds: failureEntry ? [] : [this.config.id],
      failed: failureEntry ? [{ botId: this.config.id, error: failureEntry.message }] : [],
      skippedBotIds: []
    };
  }

  async changeSlot(slotNumber) {
    if (!this.bot) {
      throw new Error('bot not connected');
    }
    await this.bot.setQuickBarSlot(slotNumber - 1);
  }

  stopAllActions() {
    if (this.bot) {
      [
        'forward',
        'back',
        'left',
        'right',
        'jump',
        'sneak',
        'sprint'
      ].forEach((state) => this.bot.setControlState(state, false));

      if (this.bot.pathfinder && typeof this.bot.pathfinder.stop === 'function') {
        try {
          if (this.bot.entity) {
            this.bot.pathfinder.stop();
          }
        } catch (error) {
        }
      }
    }

    this.fishFeature.stop();
    this.rideFeature.stop();
    this.autoEatController.stop();
    this.treeFarmFeature.stop();
    this.movementFeature.stop();
    this.digFeature.stop();
    this.blockUseFeature.stop();
    this.cplaceFeature.stop();
  }

  getHealthText() {
    if (!this.bot) {
      return '机器人尚未连接';
    }

    // health 由 health 插件维护（update_health 包），不依赖实体/地形处理
    const health = Number.isFinite(this.bot.health) ? this.bot.health : '?';
    const food = Number.isFinite(this.bot.food) ? this.bot.food : '?';
    const oxygen = Number.isFinite(this.bot.oxygenLevel) ? this.bot.oxygenLevel : '?';
    return `血量=${health} 饱食度=${food} 氧气=${oxygen}`;
  }

  getPositionText() {
    if (!this.bot) {
      return '机器人尚未连接';
    }
    if (!this.bot.entity) {
      if (this.isLightweightMode()) {
        // 轻量模式无实体：使用协议层位置同步包记录的坐标
        if (this.lastKnownPosition) {
          const p = this.lastKnownPosition;
          return `位置: ${p.x.toFixed(2)} ${p.y.toFixed(2)} ${p.z.toFixed(2)}`;
        }
        return '实体处理已禁用，位置数据暂不可用';
      }
      return '机器人尚未生成';
    }

    const pos = this.bot.entity.position;
    return `位置: ${pos.x.toFixed(2)} ${pos.y.toFixed(2)} ${pos.z.toFixed(2)}`;
  }

  getPingText() {
    if (!this.bot) {
      return '机器人尚未连接';
    }

    if (Number.isFinite(this.latencyMs)) {
      return `Ping: ${this.latencyMs}ms`;
    }

    const me = this.bot.player || (this.bot.players && this.bot.players[this.bot.username]);
    const ping = me && Number.isFinite(me.ping) ? me.ping : null;
    return ping === null ? '暂无延迟数据' : `Ping: ${ping}ms`;
  }

  async measurePing(timeoutMs = 3000) {
    const notConnected = '机器人尚未连接';

    if (!this.bot || !this.bot._client) {
      return { ok: false, text: notConnected };
    }
    if (this.bot._client.state !== 'play') {
      return { ok: false, text: notConnected };
    }

    const id = Date.now();
    this.pendingPingId = id;

    const measured = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), Math.max(200, Number(timeoutMs) || 3000));
      this.pingResolve = (ms) => {
        clearTimeout(timer);
        resolve(ms);
      };
      try {
        this.bot._client.write('ping_request', { id: BigInt(id) });
      } catch (error) {
        clearTimeout(timer);
        resolve(null);
      }
    });

    if (this.pingResolve) {
      this.pingResolve = null;
    }

    if (measured !== null) {
      this.latencyMs = measured;
      return { ok: true, text: `Ping: ${measured}ms` };
    }

    if (this.pendingPingId === id) {
      this.pendingPingId = null;
    }

    if (Number.isFinite(this.latencyMs)) {
      return { ok: true, text: `Ping: ${this.latencyMs}ms（缓存）` };
    }

    return { ok: true, text: '暂无延迟数据' };
  }

  getEntityListText() {
    if (!this.isEntityHandlingEnabled()) {
      return '该实例已禁用实体处理，无法查看实体列表';
    }

    if (!this.bot || !this.bot.entity) {
      return '机器人尚未生成';
    }

    const entities = Object.values(this.bot.entities || {})
      .filter((entity) => entity && entity !== this.bot.entity)
      .map((entity) => ({
        name: entity.username || entity.displayName || entity.name || `entity:${entity.id}`,
        type: entity.type,
        distance: this.bot.entity.position.distanceTo(entity.position)
      }))
      .sort((left, right) => left.distance - right.distance)
      .slice(0, 20);

    if (entities.length === 0) {
      return '附近没有可见实体';
    }

    return `附近实体: ${entities.map((entity) => `${entity.name}[${entity.type}](${entity.distance.toFixed(1)})`).join(', ')}`;
  }

  getActionState() {
    const movementState = this.movementFeature.getState ? this.movementFeature.getState() : {};
    const fishState = this.fishFeature.getState ? this.fishFeature.getState() : {};
    const rideState = this.rideFeature.getState ? this.rideFeature.getState() : {};
    const digState = this.digFeature.getState ? this.digFeature.getState() : {};
    const scriptState = this.scriptFeature.getState ? this.scriptFeature.getState() : {};
    const autoEatState = this.autoEatController && this.autoEatController.getState ? this.autoEatController.getState() : {};
    const treeFarmState = this.treeFarmFeature && this.treeFarmFeature.getState ? this.treeFarmFeature.getState() : {};

    return {
      fishing: fishState.isFishing === true,
      riding: rideState.isRiding === true,
      circling: movementState.isCircling === true,
      sneaking: movementState.isSneaking === true,
      digging: digState.isDigging === true,
      areaDigging: digState.isAreaDigging === true,
      scriptRunning: scriptState.isRunning === true,
      autoEatEnabled: autoEatState.enabled === true,
      autoEating: autoEatState.eating === true,
      treeFarming: treeFarmState.isRunning === true
    };
  }

  getRestartState() {
    const schedule = this.restartPolicy.getScheduleMs();
    return {
      disconnectPolicyEnabled: this.config.restartOnDisconnect !== false,
      disconnectDelayMs: this.restartPolicy.getBaseDelayMs(),
      disconnectJitterMs: this.restartPolicy.getDisconnectJitterMs(),
      legacyAutoRestartMinutes: this.legacyAutoRestartMinutes,
      legacyAutoRestartScheduledAt: this.legacyAutoRestartScheduledAt,
      pendingRestartReason: this.pendingRestartReason,
      pendingRestartDelayMs: this.pendingRestartDelayMs,
      pendingRestartScheduledAt: this.pendingRestartScheduledAt,
      restartAttempt: this.restartAttempt,
      restartScheduleLength: Array.isArray(schedule) ? schedule.length : 0,
      restartScheduleRepeatLast: this.restartPolicy.getScheduleRepeatLast(),
      restartScheduleExhausted: this.restartScheduleExhausted === true
    };
  }

  getSummary() {
    return {
      id: this.config.id,
      serverDir: this.config.serverDir || null,
      botDir: this.config.botDir || null,
      username: this.config.username,
      host: this.config.host,
      port: this.config.port,
      state: this.state,
      desiredRunning: this.desiredRunning,
      spawnCount: this.spawnCount,
      lastSpawnAt: this.lastSpawnAt,
      lastEndAt: this.lastEndAt,
      expectedRunningSince: this.expectedRunningSince,
      lastError: this.lastError,
      lastKick: this.lastKick,
      lastFailure: this.lastFailure,
      lastFailureAt: this.lastFailureAt,
      lock: this.lockFeature.getTeleportLockStatus(),
      capabilities: this.getCapabilities(),
      actions: this.getActionState(),
      restart: this.getRestartState()
    };
  }

  getDetails() {
    return {
      ...this.getSummary(),
      recorderStatus: this.recorderFeature.getStatusText(),
      logs: this.logger.getRecent()
    };
  }

  publishStatus() {
    if (!this.eventStream) return;
    this.eventStream.publish('botStatus', this.getSummary());
  }
}

module.exports = {
  BotRuntime,
  normalizeUnsignedPlayerChatPacket,
  normalizeDisconnectText,
  classifyDisconnectReason,
  mergeDisconnectClass
};
