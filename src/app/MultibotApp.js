const path = require('path');
const dns = require('dns');
const net = require('net');
const { loadMasterConfig } = require('../config/loadMasterConfig');
const { SessionService } = require('../session/SessionService');
const { EventStream } = require('../control/EventStream');
const { HttpApiServer } = require('../control/HttpApiServer');
const { BotManager } = require('../runtime/BotManager');
const { InstanceService } = require('../config/InstanceService');
const { applyProtocolGuardHotfix } = require('../legacy/assn/protocol-guard-hotfix');
const { MemoryLogService } = require('../logging/MemoryLogService');
const { AggregateLogService } = require('../logging/AggregateLogService');
const { ApiAccessLogService } = require('../logging/ApiAccessLogService');
const { InstanceLifecycleLogService, LIFECYCLE_EVENTS } = require('../logging/InstanceLifecycleLogService');

const MULTIBOT_VERSION = 'V26.3.6-OpenAuth';

class MultibotApp {
  constructor(options = {}) {
    this.appRoot = options.appRoot || path.resolve(options.repoRoot || process.cwd(), 'tests', 'MULTIBOT');
    this.repoRoot = options.repoRoot;
    this.configPath = options.configPath;
    this.masterConfig = null;
    this.eventStream = null;
    this.sessionService = null;
    this.botManager = null;
    this.instanceService = null;
    this.httpApiServer = null;
    this.memoryLogService = null;
    this.aggregateLogService = null;
    this.apiAccessLogService = null;
    this.lifecycleLogService = null;
    this.exceptionGuardsInstalled = false;
    this.uncaughtExceptionCount = 0;
    this.uncaughtExceptionWindowStartedAt = 0;
  }

  installGlobalExceptionGuards() {
    if (this.exceptionGuardsInstalled) return;
    this.exceptionGuardsInstalled = true;

    process.on('uncaughtException', (error) => {
      const now = Date.now();
      if (now - this.uncaughtExceptionWindowStartedAt > 60000) {
        this.uncaughtExceptionWindowStartedAt = now;
        this.uncaughtExceptionCount = 0;
      }
      this.uncaughtExceptionCount += 1;

      console.error('[MULTIBOT] uncaughtException:', error && error.stack ? error.stack : error);

      if (this.lifecycleLogService) {
        try {
          this.lifecycleLogService.record(LIFECYCLE_EVENTS.PROCESS_CRASH, { detail: error });
        } catch (recordError) {
          console.error('[MULTIBOT] failed to record crash lifecycle entry:', recordError && recordError.stack ? recordError.stack : recordError);
        }
      }

      if (this.uncaughtExceptionCount >= 3) {
        console.error('[MULTIBOT] 60 秒内连续 3 次未捕获异常，退出进程以避免无限重启循环');
        process.exit(1);
      }

      // 全局异常无法定位具体 bot（如 minecraft-protocol 解析错误），
      // 统一让所有活跃 bot 走正常断线重连，避免整个进程崩溃退出。
      void this.restartActiveBotsAfterCrash('uncaught_exception');
    });

    process.on('unhandledRejection', (reason) => {
      console.error('[MULTIBOT] unhandledRejection:', reason && reason.stack ? reason.stack : reason);

      if (this.lifecycleLogService) {
        try {
          this.lifecycleLogService.record(LIFECYCLE_EVENTS.PROCESS_UNHANDLED_REJECTION, { detail: reason });
        } catch (recordError) {
          console.error('[MULTIBOT] failed to record rejection lifecycle entry:', recordError && recordError.stack ? recordError.stack : recordError);
        }
      }
    });
  }

  async restartActiveBotsAfterCrash(reason) {
    if (!this.botManager || !this.botManager.runtimes) return;

    for (const botId of this.botManager.runtimes.keys()) {
      const runtime = this.botManager.runtimes.get(botId);
      if (!runtime || runtime.state === 'stopped') continue;

      try {
        await this.botManager.restartBot(botId, reason);
      } catch (error) {
        console.error(`[MULTIBOT] crash 后重启 bot ${botId} 失败:`, error && error.stack ? error.stack : error);
      }
    }
  }

  applyNetworkDefaults() {
    if (typeof dns.setDefaultResultOrder === 'function') {
      try {
        dns.setDefaultResultOrder('ipv4first');
      } catch (error) {
        console.warn('[MULTIBOT] failed to set ipv4first:', error.message);
      }
    }

    if (typeof net.setDefaultAutoSelectFamily === 'function') {
      try {
        net.setDefaultAutoSelectFamily(false);
      } catch (error) {
        console.warn('[MULTIBOT] failed to disable autoSelectFamily:', error.message);
      }
    }
  }

  async start() {
    console.log(`MULTIBOT ${MULTIBOT_VERSION}`);
    this.installGlobalExceptionGuards();
    this.applyNetworkDefaults();

    this.masterConfig = loadMasterConfig({
      configPath: this.configPath,
      repoRoot: this.repoRoot,
      appRoot: this.appRoot
    });
    applyProtocolGuardHotfix(this.masterConfig.protocolGuard);
    this.eventStream = new EventStream({
      maxClients: this.masterConfig.api.maxSseClients
    });
    this.sessionService = new SessionService(path.join(this.appRoot, 'sessions'));
    this.aggregateLogService = new AggregateLogService({
      appRoot: this.appRoot,
      config: this.masterConfig.aggregateLogging
    });
    this.lifecycleLogService = new InstanceLifecycleLogService({
      appRoot: this.appRoot,
      config: this.masterConfig.diagnostics ? this.masterConfig.diagnostics.lifecycleLogger : null
    });
    this.botManager = new BotManager({
      masterConfig: this.masterConfig,
      eventStream: this.eventStream,
      sessionService: this.sessionService,
      aggregateLogService: this.aggregateLogService,
      lifecycleLogService: this.lifecycleLogService,
      consoleConnectorConfig: this.masterConfig.consoleConnector,
      diagnosticsConfig: this.masterConfig.diagnostics
    });
    this.memoryLogService = new MemoryLogService({
      appRoot: this.appRoot,
      botManager: this.botManager,
      config: this.masterConfig.diagnostics ? this.masterConfig.diagnostics.memoryLogger : null
    });
    this.apiAccessLogService = new ApiAccessLogService({
      appRoot: this.appRoot,
      config: this.masterConfig.diagnostics ? this.masterConfig.diagnostics.apiAccessLogger : null
    });
    this.instanceService = new InstanceService({
      masterConfig: this.masterConfig,
      botManager: this.botManager
    });
    this.httpApiServer = new HttpApiServer({
      apiConfig: this.masterConfig.api,
      botManager: this.botManager,
      eventStream: this.eventStream,
      instanceService: this.instanceService,
      accessLogService: this.apiAccessLogService,
      consoleConnectorConfig: this.masterConfig.consoleConnector
    });

    await this.httpApiServer.start();
    await this.botManager.start();
    this.aggregateLogService.start();
    this.memoryLogService.start();

    console.log(
      `[MULTIBOT] API listening on http://${this.masterConfig.api.host}:${this.masterConfig.api.port}`
    );
  }

  async stop(reason = 'shutdown') {
    try {
      if (this.httpApiServer) {
        await this.httpApiServer.stop();
      }

      if (this.botManager) {
        await this.botManager.stop(reason);
      }
    } finally {
      if (this.aggregateLogService) {
        this.aggregateLogService.stop(reason);
      }

      if (this.memoryLogService) {
        this.memoryLogService.stop(reason);
      }
    }
  }
}

module.exports = {
  MultibotApp
};
