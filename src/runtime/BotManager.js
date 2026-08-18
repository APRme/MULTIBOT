const { BotRuntime } = require('./BotRuntime');
const { BroadcastService } = require('../control/BroadcastService');
const { ChatConsoleCoordinator } = require('../logging/ChatConsoleCoordinator');

const DEFAULT_CONSOLE_COMMAND_PREFIX = '/';

function toMb(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) {
    return 0;
  }

  return Math.round((numeric / (1024 * 1024)) * 100) / 100;
}

function normalizeConsoleCommandPrefix(prefix) {
  return typeof prefix === 'string' && prefix.length === 1
    ? prefix
    : DEFAULT_CONSOLE_COMMAND_PREFIX;
}

class BotManager {
  constructor(options = {}) {
    this.masterConfig = options.masterConfig;
    this.eventStream = options.eventStream;
    this.sessionService = options.sessionService;
    this.aggregateLogService = options.aggregateLogService || null;
    this.lifecycleLogService = options.lifecycleLogService || null;
    this.consoleConnectorConfig = options.consoleConnectorConfig || null;
    this.diagnosticsConfig = options.diagnosticsConfig || this.masterConfig?.diagnostics || {};
    this.runtimes = new Map();
    this.runtimesByInstance = new Map();
    this.broadcastService = new BroadcastService();
    this.chatConsoleCoordinator = new ChatConsoleCoordinator();

    for (const botConfig of this.masterConfig.bots) {
      this.registerRuntime(this.createRuntime(botConfig));
    }
  }

  createBotNotFoundError(id) {
    const error = new Error(`bot not found: ${id}`);
    error.statusCode = 404;
    return error;
  }

  createConflictError(message) {
    const error = new Error(message);
    error.statusCode = 409;
    return error;
  }

  createDiagnosticsDisabledError() {
    const error = new Error('memory diagnostics disabled');
    error.statusCode = 503;
    return error;
  }

  isMemoryDetailsEnabled() {
    return this.diagnosticsConfig?.memoryDetails?.enabled === true;
  }

  getInstanceKey(serverDir, botDir) {
    const server = typeof serverDir === 'string' ? serverDir.trim() : '';
    const bot = typeof botDir === 'string' ? botDir.trim() : '';
    if (server && bot) {
      return `${server}/${bot}`;
    }

    return null;
  }

  getInstanceKeyFromConfig(config) {
    if (!config) return null;
    return this.getInstanceKey(config.serverDir, config.botDir);
  }

  createRuntime(botConfig) {
    return new BotRuntime({
      config: botConfig,
      eventStream: this.eventStream,
      sessionService: this.sessionService,
      broadcastService: this.broadcastService,
      aggregateLogService: this.aggregateLogService,
      lifecycleLogService: this.lifecycleLogService,
      chatConsoleCoordinator: this.chatConsoleCoordinator,
      protocolGuardConfig: this.masterConfig ? this.masterConfig.protocolGuard : null,
      diagnosticsConfig: this.diagnosticsConfig,
      loggerBufferSize: Math.max(500, Number.parseInt(this.consoleConnectorConfig?.historyLimit, 10) || 0)
    });
  }

  registerRuntime(runtime) {
    const botId = runtime && runtime.config ? runtime.config.id : null;
    if (!botId) {
      throw new Error('runtime config.id is required');
    }

    if (this.runtimes.has(botId)) {
      throw this.createConflictError(`duplicate bot id: ${botId}`);
    }

    const instanceKey = this.getInstanceKeyFromConfig(runtime.config);
    if (instanceKey && this.runtimesByInstance.has(instanceKey)) {
      throw this.createConflictError(`duplicate instance key: ${instanceKey}`);
    }

    this.runtimes.set(botId, runtime);
    if (instanceKey) {
      this.runtimesByInstance.set(instanceKey, runtime);
    }
    this.broadcastService.registerRuntime(runtime);
  }

  unregisterRuntime(runtimeOrId) {
    const runtime = typeof runtimeOrId === 'string'
      ? this.runtimes.get(runtimeOrId)
      : runtimeOrId;

    if (!runtime || !runtime.config) {
      return;
    }

    this.runtimes.delete(runtime.config.id);
    const instanceKey = this.getInstanceKeyFromConfig(runtime.config);
    if (instanceKey) {
      this.runtimesByInstance.delete(instanceKey);
    }
    this.broadcastService.unregisterRuntime(runtime.config.id);
  }

  upsertMasterConfigBot(botConfig) {
    const nextBots = [];
    const nextInstanceKey = this.getInstanceKeyFromConfig(botConfig);

    for (const existingConfig of this.masterConfig.bots) {
      const existingInstanceKey = this.getInstanceKeyFromConfig(existingConfig);
      if (existingConfig.id === botConfig.id) {
        continue;
      }
      if (nextInstanceKey && existingInstanceKey === nextInstanceKey) {
        continue;
      }

      nextBots.push(existingConfig);
    }

    nextBots.push(botConfig);
    this.masterConfig.bots = nextBots;
  }

  removeMasterConfigBotByInstance(serverDir, botDir) {
    const instanceKey = this.getInstanceKey(serverDir, botDir);
    this.masterConfig.bots = this.masterConfig.bots.filter((botConfig) => {
      return this.getInstanceKeyFromConfig(botConfig) !== instanceKey;
    });
  }

  async start() {
    for (const botConfig of this.masterConfig.bots) {
      if (botConfig.enabled !== false && botConfig.autoStart === true) {
        await this.startBot(botConfig.id);
      }
    }
  }

  async stop(reason = 'shutdown') {
    for (const runtime of this.runtimes.values()) {
      await runtime.stop(reason);
    }

    if (this.chatConsoleCoordinator && typeof this.chatConsoleCoordinator.stop === 'function') {
      this.chatConsoleCoordinator.stop();
    }
  }

  getBot(id) {
    return this.runtimes.get(id) || null;
  }

  getBotByInstance(serverDir, botDir) {
    return this.runtimesByInstance.get(this.getInstanceKey(serverDir, botDir)) || null;
  }

  listBots() {
    return Array.from(this.runtimes.values()).map((runtime) => runtime.getSummary());
  }

  getBotDiagnostics() {
    if (!this.isMemoryDetailsEnabled()) {
      return [];
    }

    return Array.from(this.runtimes.values()).map((runtime) => {
      if (runtime && typeof runtime.getRuntimeDiagnostics === 'function') {
        return runtime.getRuntimeDiagnostics();
      }

      const summary = runtime && typeof runtime.getSummary === 'function'
        ? runtime.getSummary()
        : {};
      return {
        id: summary.id || runtime?.config?.id || 'unknown',
        state: summary.state || 'unknown',
        desiredRunning: summary.desiredRunning === true,
        hasBot: Boolean(runtime?.bot),
        worldColumns: 0,
        entities: 0,
        players: 0,
        pathfinderLoaded: false,
        client: null,
        chunkPackets: null
      };
    });
  }

  getMemoryDiagnostics() {
    if (!this.isMemoryDetailsEnabled()) {
      throw this.createDiagnosticsDisabledError();
    }

    const memoryUsage = process.memoryUsage();
    const botMemory = this.getBotDiagnostics();
    const endedBotRefs = botMemory.flatMap((bot) => {
      return Array.isArray(bot.endedBotRefs) ? bot.endedBotRefs : [];
    });
    const totals = botMemory.reduce((accumulator, bot) => {
      accumulator.worldColumns += Number.isFinite(bot.worldColumns) ? bot.worldColumns : 0;
      accumulator.entities += Number.isFinite(bot.entities) ? bot.entities : 0;
      accumulator.players += Number.isFinite(bot.players) ? bot.players : 0;
      if (bot.hasBot) accumulator.liveBotObjects += 1;
      if (bot.pathfinderLoaded) accumulator.pathfinderLoaded += 1;
      return accumulator;
    }, {
      worldColumns: 0,
      entities: 0,
      players: 0,
      liveBotObjects: 0,
      pathfinderLoaded: 0
    });

    return {
      timestamp: new Date().toISOString(),
      pid: process.pid,
      memory: {
        rssMB: toMb(memoryUsage.rss),
        heapTotalMB: toMb(memoryUsage.heapTotal),
        heapUsedMB: toMb(memoryUsage.heapUsed),
        externalMB: toMb(memoryUsage.external),
        arrayBuffersMB: toMb(memoryUsage.arrayBuffers)
      },
      totals,
      endedBotRefs,
      botMemory
    };
  }

  getBotDetails(id) {
    const runtime = this.getBot(id);
    if (!runtime) return null;
    return runtime.getDetails();
  }

  async startBot(id) {
    const runtime = this.getBot(id);
    if (!runtime) throw this.createBotNotFoundError(id);
    return runtime.start();
  }

  async stopBot(id, reason = 'manual_stop') {
    const runtime = this.getBot(id);
    if (!runtime) throw this.createBotNotFoundError(id);
    return runtime.stop(reason);
  }

  async restartBot(id, reason = 'manual_restart') {
    const runtime = this.getBot(id);
    if (!runtime) throw this.createBotNotFoundError(id);
    return runtime.restart(reason);
  }

  async executeCommand(id, command, options = {}) {
    const runtime = this.getBot(id);
    if (!runtime) throw this.createBotNotFoundError(id);

    const context = runtime.createCommandContext({
      source: options.source || 'http',
      sender: options.sender || 'api'
    });
    const handled = await runtime.executeCommand(command, context);

    return {
      handled,
      messages: context.getMessages(),
      bot: runtime.getDetails()
    };
  }

  async executeConsoleInput(id, input, options = {}) {
    const runtime = this.getBot(id);
    if (!runtime) throw this.createBotNotFoundError(id);

    const source = options.source || 'console';
    const sender = options.sender || 'panel';
    const commandPrefix = normalizeConsoleCommandPrefix(options.commandPrefix);
    const rawInput = typeof input === 'string' ? input : '';
    const trimmedInput = rawInput.trim();
    const context = runtime.createCommandContext({ source, sender });

    if (trimmedInput === 'exit' || trimmedInput === `${commandPrefix}exit`) {
      context.replyInfo('正在停止该实例...');
      const bot = await this.stopBot(id, 'console_exit');
      return {
        handled: true,
        messages: context.getMessages(),
        bot,
        inputMode: 'exit'
      };
    }

    if (rawInput.startsWith(commandPrefix)) {
      const commandContent = rawInput.slice(commandPrefix.length);
      const handled = await runtime.executeCommand(commandContent, context);

      if (!handled) {
        runtime.sendChat(rawInput);
      }

      return {
        handled,
        messages: handled ? context.getMessages() : [],
        bot: runtime.getDetails(),
        inputMode: handled ? 'command' : 'chat_fallback'
      };
    }

    runtime.sendChat(rawInput);
    return {
      handled: false,
      messages: [],
      bot: runtime.getDetails(),
      inputMode: 'chat'
    };
  }

  async addOrReplaceBotConfig(botConfig, options = {}) {
    const instanceKey = this.getInstanceKeyFromConfig(botConfig);
    const existingByInstance = instanceKey ? this.runtimesByInstance.get(instanceKey) : null;
    const existingById = this.runtimes.get(botConfig.id) || null;

    if (existingById && existingById !== existingByInstance) {
      throw this.createConflictError(`duplicate bot id: ${botConfig.id}`);
    }

    let shouldStart = options.start === true;
    let previousDesiredRunning = false;

    if (existingByInstance) {
      previousDesiredRunning = existingByInstance.desiredRunning === true;
      await existingByInstance.stop(options.reason || 'bot_reconfigure');
      this.unregisterRuntime(existingByInstance);
    }

    this.upsertMasterConfigBot(botConfig);

    const runtime = this.createRuntime(botConfig);
    this.registerRuntime(runtime);

    if (options.inheritRunning === true && previousDesiredRunning) {
      shouldStart = true;
    }

    if (options.respectAutoStart === true && botConfig.enabled !== false && botConfig.autoStart === true) {
      shouldStart = true;
    }

    if (shouldStart && botConfig.enabled !== false) {
      await runtime.start();
    }

    return runtime.getDetails();
  }

  async removeBotByInstance(serverDir, botDir, reason = 'bot_remove') {
    const runtime = this.getBotByInstance(serverDir, botDir);
    if (runtime) {
      await runtime.stop(reason);
      this.unregisterRuntime(runtime);
    }

    this.removeMasterConfigBotByInstance(serverDir, botDir);
    return runtime ? runtime.getDetails() : null;
  }
}

module.exports = {
  BotManager
};
