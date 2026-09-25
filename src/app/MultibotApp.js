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
const { EventThresholdTracker } = require('../notifications/EventThresholdTracker');
const { summarizeError } = require('../util/redact');

const MULTIBOT_VERSION = 'V26.4.25-BarkNotification';

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
    this.uncaughtTracker = null;
  }

  getNotificationEventConfig(type) {
    const events = this.masterConfig && this.masterConfig.notifications
      ? this.masterConfig.notifications.events
      : null;
    const raw = events && events[type] ? events[type] : {};
    return raw && typeof raw === 'object' ? raw : {};
  }

  // A2: 未捕获异常(进程未退出, 已让 bots 走重连)在窗口内达到阈值才推, 避免单次瞬时异常打扰
  trackUncaughtException(error) {
    try {
      const notifier = this.botManager ? this.botManager.barkNotifier : null;
      if (!notifier || typeof notifier.notifyEvent !== 'function') return;
      if (typeof notifier.isEnabled === 'function' && !notifier.isEnabled()) return;

      const config = this.getNotificationEventConfig('uncaughtException');
      if (config.enabled === false) return;

      const threshold = Number(config.threshold) > 0 ? Number(config.threshold) : 3;
      const windowMs = Number(config.windowMs) > 0 ? Number(config.windowMs) : 3600000;

      if (!this.uncaughtTracker) {
        this.uncaughtTracker = new EventThresholdTracker({ threshold, windowMs });
      }

      const { count, exceeded } = this.uncaughtTracker.record();
      if (!exceeded) return;

      void Promise.resolve(notifier.notifyEvent({
        type: 'uncaughtException',
        key: 'process:uncaught',
        severity: 'active',
        title: 'MULTIBOT Downdetector',
        body: `近 ${Math.max(1, Math.round(windowMs / 60000))} 分钟未捕获异常 ${count} 次, 最近一次: ${summarizeError(error)}`,
        label: 'backend'
      })).catch(() => null);
    } catch (notifyError) {
      // 通知失败不得影响全局异常处理
    }
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

      this.trackUncaughtException(error);

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
      consoleConnectorConfig: this.masterConfig.consoleConnector,
      barkNotifier: this.botManager.barkNotifier || null
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
  MultibotApp,
  MULTIBOT_VERSION
};
