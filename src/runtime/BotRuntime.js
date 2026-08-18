const net = require('net');
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
const { WindowFeature } = require('../features/window/WindowFeature');
const { WarehouseFeature } = require('../warehouse/WarehouseFeature');
const { isIgnorableMalformedNbtArrayError } = require('../legacy/assn/protocol-guard-hotfix');

const OPEN_AUTH_REQUEST_WATCHDOG_MS = 10000;

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
    terrainHandling: capabilities.terrainHandling !== false
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
    this.lastError = null;
    this.lastKick = null;
    this.lastFailure = null;
    this.lastFailureAt = null;
    this.pendingAuthState = null;
    this.capabilities = normalizeCapabilitiesConfig(this.config.legacyConfig);
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
      lockHistoryPath: this.config.paths.lockHistoryPath
    });
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
      logger: this.logger
    });
    this.rideFeature = new RideFeature({
      logger: this.logger
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
    this.warehouseFeature = new WarehouseFeature({
      logger: this.logger,
      config: this.config.legacyConfig.warehouse,
      paths: this.config.paths,
      movementFeature: this.movementFeature,
      blockUseFeature: this.blockUseFeature,
      windowFeature: this.windowFeature,
      eventStream: this.eventStream,
      botId: this.config.id
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
      fishFeature: this.fishFeature
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
      windowFeature: this.windowFeature,
      warehouseFeature: this.warehouseFeature
    });
    this.scriptFeature.setExecuteCommand(async (content, context) => this.executeCommand(content, context));
  }

  getCapabilities() {
    return {
      entityHandling: this.capabilities.entityHandling !== false,
      terrainHandling: this.capabilities.terrainHandling !== false
    };
  }

  isEntityHandlingEnabled() {
    return this.getCapabilities().entityHandling;
  }

  isTerrainHandlingEnabled() {
    return this.getCapabilities().terrainHandling;
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

  handleMsaCode(response) {
    if (!response) return;
    this.logger.capture('info', '[msa] First time signing in. Please authenticate now:');
    if (response.message) {
      this.logger.capture('info', response.message);
    }
    if (this.pendingAuthState) {
      this.pendingAuthState.deviceCodeIssued = true;
    }
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
          const command = entry.mode === 'whisper' ? '/minecraft:w' : '/tell';
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

  attachRuntimeDiagnostics(bot) {
    if (!this.isMemoryDetailsEnabled()) {
      return;
    }

    this.diagnostics.connectionCount += 1;
    this.diagnostics.currentConnectionStartedAt = new Date().toISOString();
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
        this.diagnostics.lastPacketAt[fieldName] = new Date().toISOString();
        this.refreshWorldColumnDiagnostics();
      });
    };

    registerPacketCounter('map_chunk', 'mapChunk');
    registerPacketCounter('unload_chunk', 'unloadChunk');
    registerPacketCounter('update_light', 'updateLight');
    registerPacketCounter('chunk_batch_start', 'chunkBatchStart');
    registerPacketCounter('chunk_batch_finished', 'chunkBatchFinished');
  }

  refreshWorldColumnDiagnostics() {
    const count = this.getWorldColumnCount();
    if (count > this.diagnostics.maxWorldColumns) {
      this.diagnostics.maxWorldColumns = count;
      this.diagnostics.maxWorldColumnsAt = new Date().toISOString();
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
      endedAt: this.lastEndAt || new Date().toISOString(),
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
            socketDestroyed: socket ? socket.destroyed === true : null
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
      `[CAP] entityHandling=${this.isEntityHandlingEnabled()} terrainHandling=${this.isTerrainHandlingEnabled()}`
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
      throw error;
    }
    this.bot = bot;
    this.lastClientForCleanup = bot && bot._client ? bot._client : null;
    this.attachUnsignedPlayerChatGuard(bot);
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

      if (bot._client.deserializer) {
        this.addRuntimeListener(bot._client.deserializer, 'malformed_packet_ignored', (info) => {
          if (this.protocolGuardConfig.logParseErrors !== false) {
            this.logger.warn('[PROTOCOL]', info);
          }
        });
      }

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
    this.inventoryFeature.attach(bot);
    this.windowFeature.attach(bot);
    this.movementFeature.attach(bot);
    this.activityLogFeature.attach(bot);
    this.eatFeature.attach(bot);

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
      if (this.config.legacyConfig.warehouse?.enabled === true) {
        this.warehouseFeature.attach(bot);
      }
    } else if (this.config.legacyConfig.warehouse?.enabled === true) {
      this.logCapabilitySkip('warehouse', 'because terrainHandling=false');
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

    this.addRuntimeListener(bot, 'spawn', () => {
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
      this.spawnCount += 1;
      this.restartAttempt = 0;
      this.restartScheduleExhausted = false;
      this.lastSpawnAt = new Date().toISOString();
      this.logger.info('[BOT] spawn');
      this.recordLifecycle(LIFECYCLE_EVENTS.BOT_SPAWN, { detail: this.lastSpawnAt });
      this.fishFeature.handleSpawn();
      this.scriptFeature.onSpawn();
      this.scheduleLegacyAutoRestart();
      this.publishStatus();
    }, { once: true });

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

    this.addRuntimeListener(bot, 'end', () => {
      void this.handleEnd(epoch);
    });

    return this.getDetails();
  }

  async stop(reason = 'manual_stop') {
    this.desiredRunning = false;
    this.pendingRestartReason = null;
    this.pendingRestartDelayMs = null;
    this.restartAttempt = 0;
    this.restartScheduleExhausted = false;
    this.clearRestartTimer();
    this.clearStartupWarningTimer();
    this.clearLegacyAutoRestartTimer();
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
    if (!this.windowFeature || typeof this.windowFeature.getCurrentSnapshot !== 'function') {
      return null;
    }

    return this.windowFeature.getCurrentSnapshot();
  }

  async closeWindow() {
    if (!this.windowFeature || typeof this.windowFeature.closeWindow !== 'function') {
      return { ok: true, closed: false };
    }

    return this.windowFeature.closeWindow();
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
      this.trustedPlayersStore,
      this.teleportFeature,
      this.chatFeature,
      this.vaultFeature,
      this.warehouseFeature
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

  async handleEnd(epoch) {
    if (epoch !== undefined && epoch !== this.connectionEpoch) {
      return;
    }

    this.clearStartupWarningTimer();
    this.clearOpenAuthRequestWatchdog();
    const wasStarting = this.state === 'starting';
    this.lastEndAt = new Date().toISOString();
    this.diagnostics.currentConnectionEndedAt = this.lastEndAt;
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
    this.logger.warn('[BOT] end');
    const disconnectReason = this.pendingRestartReason
      || (backendUnavailable ? 'backend_unavailable' : 'disconnect');
    this.recordLifecycle(LIFECYCLE_EVENTS.BOT_DISCONNECT, { reason: disconnectReason });
    this.clearLegacyAutoRestartTimer();
    await this.finalizeEndedBot(endedBot, 'end', { publishStopped: false });

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
      this.requestRestart('invalid_session_retry', 1000);
      return;
    }

    if (
      lower.includes('failed to obtain profile data') ||
      lower.includes('does the account own minecraft')
    ) {
      this.requestRestart('retryable_error', this.restartPolicy.getDelayMs());
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
    this.legacyAutoRestartScheduledAt = new Date(Date.now() + delayMs).toISOString();
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
    this.pendingRestartScheduledAt = new Date(Date.now() + schedule.totalDelayMs).toISOString();
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
    this.lastFailureAt = this.lastFailure ? new Date().toISOString() : null;
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
    this.movementFeature.stop();
    this.digFeature.stop();
    this.blockUseFeature.stop();
    this.cplaceFeature.stop();
  }

  getHealthText() {
    if (!this.bot || !this.bot.entity) {
      return '机器人尚未生成';
    }

    return `血量=${this.bot.health} 饱食度=${this.bot.food} 氧气=${this.bot.oxygenLevel}`;
  }

  getPositionText() {
    if (!this.bot || !this.bot.entity) {
      return '机器人尚未生成';
    }

    const pos = this.bot.entity.position;
    return `位置: ${pos.x.toFixed(2)} ${pos.y.toFixed(2)} ${pos.z.toFixed(2)}`;
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

    return {
      fishing: fishState.isFishing === true,
      riding: rideState.isRiding === true,
      circling: movementState.isCircling === true,
      sneaking: movementState.isSneaking === true,
      digging: digState.isDigging === true,
      areaDigging: digState.isAreaDigging === true,
      scriptRunning: scriptState.isRunning === true
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
