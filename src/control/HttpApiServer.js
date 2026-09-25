const http = require('http');
const { EventThresholdTracker } = require('../notifications/EventThresholdTracker');

const MAX_TRACKED_AUTH_FAILURE_IPS = 500;
const MAX_CLIENT_IP_LENGTH = 45;
const IPV4_PATTERN = /^\d{1,3}(\.\d{1,3}){3}$/;
const IPV4_PORT_SUFFIX_PATTERN = /:\d{1,5}$/;
const IPV6_PATTERN = /^[0-9a-fA-F:.]{2,45}$/;

class HttpApiServer {
  constructor(options = {}) {
    this.apiConfig = options.apiConfig || {};
    this.botManager = options.botManager;
    this.eventStream = options.eventStream;
    this.instanceService = options.instanceService || null;
    this.accessLogService = options.accessLogService || null;
    this.consoleConnectorConfig = options.consoleConnectorConfig || {};
    this.barkNotifier = options.barkNotifier || null;
    this.authFailureTrackers = new Map();
    this.server = null;
  }

  async start() {
    if (this.server) return;

    this.server = http.createServer((req, res) => {
      const accessContext = this.createAccessContext(req, res);
      void this.handleRequest(req, res, accessContext).catch((error) => {
        this.markError(accessContext, error);
        const statusCode = this.getStatusCode(error);
        this.markOutcome(
          accessContext,
          statusCode === 400 && error && error.message === 'invalid json body'
            ? 'invalid_json'
            : 'handler_error'
        );
        if (error && error.closeConnection) {
          res.setHeader('Connection', 'close');
        }
        this.json(res, this.getStatusCode(error), {
          error: error && error.message ? error.message : String(error)
        });
      });
    });
    this.server.on('clientError', (error, socket) => {
      if (this.accessLogService && typeof this.accessLogService.logClientError === 'function') {
        this.accessLogService.logClientError(error, socket);
      }

      if (!socket) {
        return;
      }

      if (socket.writable) {
        socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
        return;
      }

      socket.destroy();
    });

    await new Promise((resolve) => {
      this.server.listen(this.apiConfig.port, this.apiConfig.host, resolve);
    });
  }

  async stop() {
    if (!this.server) return;
    await new Promise((resolve) => this.server.close(resolve));
    this.server = null;
  }

  getNotificationEventConfig(type) {
    const events = this.botManager
      && this.botManager.masterConfig
      && this.botManager.masterConfig.notifications
      ? this.botManager.masterConfig.notifications.events
      : null;
    const raw = events && events[type] ? events[type] : {};
    return raw && typeof raw === 'object' ? raw : {};
  }

  // 取客户端 IP: nginx 反代时 socket.remoteAddress 恒为 127.0.0.1, 优先用 X-Forwarded-For 首段。
  // 该头是客户端可伪造的, 且会被写进推送正文与去重 key, 因此: 只保留 IP 字符集并截断长度,
  // **剥掉 IPv4 的端口**(否则攻击者每次换个端口就能让每个 key 的计数恒为 1, 阈值永远到不了 = 告警失效),
  // 不像 IP 的一律归入 unknown(避免用假值刷出大量不同 key 或撑爆正文)。
  // 仅用于告警分组(不是访问控制), 因此被伪造也只影响分组; 换 IP 规避无法防(除非只信 socket 或校验代理链)。
  getClientIp(req) {
    const forwarded = req && req.headers ? req.headers['x-forwarded-for'] : null;
    const raw = typeof forwarded === 'string' && forwarded.trim()
      ? forwarded.split(',')[0]
      : ((req && req.socket && req.socket.remoteAddress) || '');

    const cleaned = String(raw)
      .trim()
      .slice(0, MAX_CLIENT_IP_LENGTH)
      .replace(/[^0-9a-fA-F:.]/g, '');
    const withoutPort = cleaned.replace(IPV4_PORT_SUFFIX_PATTERN, '');

    if (IPV4_PATTERN.test(withoutPort)) {
      return withoutPort;
    }
    if ((cleaned.match(/:/g) || []).length >= 2 && IPV6_PATTERN.test(cleaned)) {
      return cleaned;
    }
    return 'unknown';
  }

  // F1: 同一来源认证失败达到阈值 -> 推送(可能是爆破); 单次失败不打扰
  trackAuthFailure(req) {
    try {
      const notifier = this.barkNotifier;
      if (!notifier || typeof notifier.notifyEvent !== 'function') return;
      if (typeof notifier.isEnabled === 'function' && !notifier.isEnabled()) return;

      const config = this.getNotificationEventConfig('apiAuthFailure');
      if (config.enabled === false) return;

      const threshold = Number(config.threshold) > 0 ? Number(config.threshold) : 10;
      const windowMs = Number(config.windowMs) > 0 ? Number(config.windowMs) : 600000;
      const ip = this.getClientIp(req);

      let tracker = this.authFailureTrackers.get(ip);
      if (!tracker) {
        if (this.authFailureTrackers.size >= MAX_TRACKED_AUTH_FAILURE_IPS) {
          this.authFailureTrackers.clear();
        }
        tracker = new EventThresholdTracker({ threshold, windowMs });
        this.authFailureTrackers.set(ip, tracker);
      }

      const { count, exceeded } = tracker.record();
      if (!exceeded) return;

      void Promise.resolve(notifier.notifyEvent({
        type: 'apiAuthFailure',
        key: `api:auth-fail:${ip}`,
        severity: 'critical',
        title: 'MULTIBOT Downdetector',
        body: `控制端口 API 认证失败 ${count} 次/${Math.max(1, Math.round(windowMs / 60000))} 分钟, 来源 ${ip}`,
        label: 'api'
      })).catch(() => null);
    } catch (error) {
      // 通知不得影响请求处理
    }
  }

  getHistoryLimit() {
    return Number.parseInt(this.consoleConnectorConfig.historyLimit, 10) > 0
      ? Number.parseInt(this.consoleConnectorConfig.historyLimit, 10)
      : 300;
  }

  getSessionInfo() {
    return this.eventStream && typeof this.eventStream.getSessionInfo === 'function'
      ? this.eventStream.getSessionInfo()
      : { sessionId: null, startedAt: null };
  }

  createEventsBootstrapPayload() {
    const historyLimit = this.getHistoryLimit();
    const sessionInfo = this.getSessionInfo();
    const bots = this.botManager && typeof this.botManager.listBots === 'function'
      ? this.botManager.listBots()
      : [];
    const logsByBotId = {};

    for (const bot of Array.isArray(bots) ? bots : []) {
      if (!bot || !bot.id || !this.botManager || typeof this.botManager.getBotDetails !== 'function') {
        continue;
      }

      const details = this.botManager.getBotDetails(bot.id);
      const logs = Array.isArray(details && details.logs)
        ? details.logs.slice(-historyLimit)
        : [];
      if (logs.length > 0) {
        logsByBotId[bot.id] = logs;
      }
    }

    return {
      backendSessionId: sessionInfo.sessionId,
      backendStartedAt: sessionInfo.startedAt,
      historyLimit,
      bots,
      logsByBotId
    };
  }

  async handleRequest(req, res, accessContext = null) {
    const originAllowed = this.isOriginAllowed(req);
    if (!originAllowed) {
      this.markOutcome(accessContext, 'forbidden_origin');
      this.json(res, 403, { error: 'origin_not_allowed' });
      return;
    }

    this.applyCors(req, res);

    if (req.method === 'OPTIONS') {
      this.markRoute(accessContext, 'OPTIONS *');
      this.markOutcome(accessContext, 'preflight');
      res.writeHead(204);
      res.end();
      return;
    }

    if (!this.isAuthorized(req)) {
      this.markOutcome(accessContext, 'unauthorized');
      this.trackAuthFailure(req);
      this.json(res, 401, { error: 'unauthorized' });
      return;
    }

    let url;
    try {
      url = new URL(req.url || '/', 'http://127.0.0.1');
    } catch (error) {
      const parseError = new Error('invalid request url');
      parseError.statusCode = 400;
      throw parseError;
    }
    const pathname = url.pathname;

    if (req.method === 'GET' && pathname === '/api/events') {
      this.markRoute(accessContext, 'GET /api/events');
      if (!this.canAcceptEventStreamClient()) {
        this.markOutcome(accessContext, 'sse_limit');
        this.json(res, 429, { error: 'too many event stream clients' });
        return;
      }
      this.markOutcome(accessContext, 'event_stream');
      this.eventStream.addClient(req, res, {
        bootstrapEvents: [{
          event: 'bootstrap',
          data: this.createEventsBootstrapPayload()
        }],
        heartbeatMs: 15000
      });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/bots') {
      this.markRoute(accessContext, 'GET /api/bots');
      const bots = this.botManager.listBots();
      this.markOutcome(accessContext, 'success');
      this.json(res, 200, { bots });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/diagnostics/memory') {
      this.markRoute(accessContext, 'GET /api/diagnostics/memory');
      if (!this.botManager || typeof this.botManager.getMemoryDiagnostics !== 'function') {
        this.markOutcome(accessContext, 'diagnostics_unavailable');
        this.json(res, 503, { error: 'diagnostics unavailable' });
        return;
      }
      if (
        typeof this.botManager.isMemoryDetailsEnabled === 'function'
        && !this.botManager.isMemoryDetailsEnabled()
      ) {
        this.markOutcome(accessContext, 'diagnostics_disabled');
        this.json(res, 503, { error: 'memory diagnostics disabled' });
        return;
      }

      const diagnostics = this.botManager.getMemoryDiagnostics();
      this.markOutcome(accessContext, 'success');
      this.json(res, 200, diagnostics);
      return;
    }

    if (pathname === '/api/instances') {
      if (req.method === 'GET') {
        this.markRoute(accessContext, 'GET /api/instances');
        const instances = this.instanceService.listInstances();
        this.markOutcome(accessContext, 'success');
        this.json(res, 200, { instances });
        return;
      }

      if (req.method === 'POST') {
        this.markRoute(accessContext, 'POST /api/instances');
        const body = await this.readJsonBody(req, accessContext);
        const instance = await this.instanceService.createInstance(body);
        this.markOutcome(accessContext, 'success');
        this.json(res, 201, { instance });
        return;
      }

      this.markRoute(accessContext, '* /api/instances');
      this.markOutcome(accessContext, 'method_not_allowed');
      this.json(res, 405, { error: 'method not allowed' });
      return;
    }

    const instanceMatch = pathname.match(/^\/api\/instances\/([^/]+)\/([^/]+)$/);
    if (instanceMatch) {
      const serverDir = this.decodePathSegment(instanceMatch[1]);
      const botDir = this.decodePathSegment(instanceMatch[2]);

      if (req.method === 'GET') {
        this.markRoute(accessContext, 'GET /api/instances/:serverDir/:botDir');
        const instance = this.instanceService.getInstance(serverDir, botDir);
        this.markOutcome(accessContext, 'success');
        this.json(res, 200, { instance });
        return;
      }

      if (req.method === 'PUT' || req.method === 'PATCH') {
        this.markRoute(accessContext, 'PUT|PATCH /api/instances/:serverDir/:botDir');
        const body = await this.readJsonBody(req, accessContext);
        const result = await this.instanceService.updateInstance(serverDir, botDir, body);
        this.markOutcome(accessContext, 'success');
        this.json(res, 200, result);
        return;
      }

      if (req.method === 'DELETE') {
        this.markRoute(accessContext, 'DELETE /api/instances/:serverDir/:botDir');
        const result = await this.instanceService.deleteInstance(serverDir, botDir);
        this.markOutcome(accessContext, 'success');
        this.json(res, 200, result);
        return;
      }

      this.markRoute(accessContext, '* /api/instances/:serverDir/:botDir');
      this.markOutcome(accessContext, 'method_not_allowed');
      this.json(res, 405, { error: 'method not allowed' });
      return;
    }

    const match = pathname.match(/^\/api\/bots\/([^/]+)(?:\/([^/]+))?$/);
    if (!match) {
      this.markOutcome(accessContext, 'not_found');
      this.json(res, 404, { error: 'not found' });
      return;
    }

    const botId = this.decodePathSegment(match[1]);
    const action = match[2] || null;

    if (req.method === 'GET' && !action) {
      this.markRoute(accessContext, 'GET /api/bots/:id');
      const bot = this.botManager.getBotDetails(botId);
      if (!bot) {
        this.markOutcome(accessContext, 'bot_not_found');
        this.json(res, 404, { error: 'bot not found' });
        return;
      }
      this.markOutcome(accessContext, 'success');
      this.json(res, 200, { bot });
      return;
    }

    if (req.method === 'GET' && action === 'inventory') {
      this.markRoute(accessContext, 'GET /api/bots/:id/inventory');
      const runtime = this.botManager.getBot(botId);
      if (!runtime) {
        this.markOutcome(accessContext, 'bot_not_found');
        this.json(res, 404, { error: 'bot not found' });
        return;
      }

      const window = typeof runtime.getWindowSnapshot === 'function'
        ? runtime.getWindowSnapshot()
        : null;
      this.markOutcome(accessContext, 'success');
      this.json(res, 200, { botId, window });
      return;
    }

    if (req.method === 'GET' && action === 'console-stream') {
      this.markRoute(accessContext, 'GET /api/bots/:id/console-stream');
      const bot = this.botManager.getBotDetails(botId);
      if (!bot) {
        this.markOutcome(accessContext, 'bot_not_found');
        this.json(res, 404, { error: 'bot not found' });
        return;
      }

      const historyLimit = this.getHistoryLimit();
      const logs = Array.isArray(bot.logs)
        ? bot.logs.slice(-historyLimit)
        : [];
      const sessionInfo = this.getSessionInfo();

      if (!this.canAcceptEventStreamClient()) {
        this.markOutcome(accessContext, 'sse_limit');
        this.json(res, 429, { error: 'too many event stream clients' });
        return;
      }

      this.markOutcome(accessContext, 'event_stream');
      this.eventStream.addClient(req, res, {
        eventFilter(event, data) {
          if (event === 'log') {
            return Boolean(data && data.botId === botId);
          }

          if (event === 'botStatus') {
            return Boolean(data && data.id === botId);
          }

          if (event === 'inventory') {
            return Boolean(data && data.botId === botId);
          }

          return false;
        },
        bootstrapEvents: [{
          event: 'bootstrap',
          data: {
            backendSessionId: sessionInfo.sessionId,
            backendStartedAt: sessionInfo.startedAt,
            historyLimit,
            bot,
            logs
          }
        }],
        heartbeatMs: 15000
      });
      return;
    }

    if (req.method !== 'POST') {
      this.markRoute(accessContext, '* /api/bots/:id/:action');
      this.markOutcome(accessContext, 'method_not_allowed');
      this.json(res, 405, { error: 'method not allowed' });
      return;
    }

    if (action === 'close-window') {
      this.markRoute(accessContext, 'POST /api/bots/:id/close-window');
      const runtime = this.botManager.getBot(botId);
      if (!runtime) {
        this.markOutcome(accessContext, 'bot_not_found');
        this.json(res, 404, { error: 'bot not found' });
        return;
      }

      const result = typeof runtime.closeWindow === 'function'
        ? await runtime.closeWindow()
        : { ok: true };
      this.markOutcome(accessContext, 'success');
      this.json(res, 200, result);
      return;
    }

    if (action === 'start') {
      this.markRoute(accessContext, 'POST /api/bots/:id/start');
      const bot = await this.botManager.startBot(botId);
      this.markOutcome(accessContext, 'success');
      this.json(res, 200, { bot });
      return;
    }

    if (action === 'stop') {
      this.markRoute(accessContext, 'POST /api/bots/:id/stop');
      const bot = await this.botManager.stopBot(botId, 'api_stop');
      this.markOutcome(accessContext, 'success');
      this.json(res, 200, { bot });
      return;
    }

    if (action === 'restart') {
      this.markRoute(accessContext, 'POST /api/bots/:id/restart');
      const bot = await this.botManager.restartBot(botId, 'api_restart');
      this.markOutcome(accessContext, 'success');
      this.json(res, 200, { bot });
      return;
    }

    if (action === 'command') {
      this.markRoute(accessContext, 'POST /api/bots/:id/command');
      const body = await this.readJsonBody(req, accessContext);
      if (typeof body.input === 'string') {
        const result = await this.botManager.executeConsoleInput(botId, body.input, {
          source: body.source || 'console',
          sender: body.sender || 'panel',
          commandPrefix: body.commandPrefix
        });
        this.markOutcome(accessContext, 'success');
        this.json(res, 200, result);
        return;
      }

      const command = body.command;
      if (!command || typeof command !== 'string') {
        this.markOutcome(accessContext, 'invalid_request');
        this.json(res, 400, { error: 'command or input is required' });
        return;
      }

      const result = await this.botManager.executeCommand(botId, command, {
        source: body.source || 'http',
        sender: body.sender || 'api'
      });
      this.markOutcome(accessContext, 'success');
      this.json(res, 200, result);
      return;
    }

    this.markRoute(accessContext, 'POST /api/bots/:id/:action');
    this.markOutcome(accessContext, 'not_found');
    this.json(res, 404, { error: 'not found' });
  }

  isAuthorized(req) {
    const header = req.headers.authorization || '';
    return header === `Bearer ${this.apiConfig.token}`;
  }

  isOriginAllowed(req) {
    const origin = req && req.headers ? req.headers.origin : null;
    if (!origin) return true;
    const allowedOrigins = Array.isArray(this.apiConfig.allowedOrigins)
      ? this.apiConfig.allowedOrigins
      : [];
    return allowedOrigins.includes(origin);
  }

  canAcceptEventStreamClient() {
    return !this.eventStream
      || typeof this.eventStream.canAcceptClient !== 'function'
      || this.eventStream.canAcceptClient();
  }

  applyCors(req, res) {
    const origin = req && req.headers ? req.headers.origin : null;
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  }

  decodePathSegment(value) {
    try {
      return decodeURIComponent(value);
    } catch (error) {
      const parseError = new Error('invalid url encoding');
      parseError.statusCode = 400;
      throw parseError;
    }
  }

  json(res, statusCode, payload) {
    if (res.writableEnded) return;
    res.writeHead(statusCode, {
      'Content-Type': 'application/json; charset=utf-8'
    });
    res.end(JSON.stringify(payload));
  }

  getStatusCode(error) {
    if (error && Number.isInteger(error.statusCode)) {
      return error.statusCode;
    }

    if (error && typeof error.message === 'string' && error.message.includes('bot not found')) {
      return 404;
    }

    return 500;
  }

  async readJsonBody(req, accessContext = null) {
    const bodyLimit = Number.parseInt(this.apiConfig.bodyLimitBytes, 10) > 0
      ? Number.parseInt(this.apiConfig.bodyLimitBytes, 10)
      : 1024 * 1024;
    const declaredLength = Number.parseInt(req.headers['content-length'], 10);
    if (Number.isFinite(declaredLength) && declaredLength > bodyLimit) {
      req.resume();
      const error = new Error('request body too large');
      error.statusCode = 413;
      error.closeConnection = true;
      throw error;
    }

    const chunks = [];
    let totalBytes = 0;
    for await (const chunk of req) {
      totalBytes += Buffer.byteLength(chunk);
      if (totalBytes > bodyLimit) {
        req.resume();
        const error = new Error('request body too large');
        error.statusCode = 413;
        error.closeConnection = true;
        throw error;
      }
      chunks.push(chunk);
    }

    const raw = Buffer.concat(chunks).toString('utf8').trim();
    this.markRequestBody(accessContext, raw);
    if (!raw) return {};
    try {
      return JSON.parse(raw);
    } catch (error) {
      this.markParseErrorBody(accessContext, raw);
      const parseError = new Error('invalid json body');
      parseError.statusCode = 400;
      throw parseError;
    }
  }

  createAccessContext(req, res) {
    if (!this.accessLogService || typeof this.accessLogService.createRequestContext !== 'function') {
      return null;
    }

    const context = this.accessLogService.createRequestContext(req, this.apiConfig.token);
    let logged = false;
    const finalize = (eventName) => {
      if (logged) {
        return;
      }

      logged = true;
      this.accessLogService.logRequest(context, res, eventName);
    };

    res.once('finish', () => finalize('finish'));
    res.once('close', () => finalize('close'));
    return context;
  }

  markRoute(accessContext, route) {
    if (this.accessLogService && accessContext && typeof this.accessLogService.markRoute === 'function') {
      this.accessLogService.markRoute(accessContext, route);
    }
  }

  markOutcome(accessContext, outcome, note = null) {
    if (this.accessLogService && accessContext && typeof this.accessLogService.markOutcome === 'function') {
      this.accessLogService.markOutcome(accessContext, outcome, note);
    }
  }

  markRequestBody(accessContext, rawBody) {
    if (this.accessLogService && accessContext && typeof this.accessLogService.markRequestBody === 'function') {
      this.accessLogService.markRequestBody(accessContext, rawBody);
    }
  }

  markParseErrorBody(accessContext, rawBody) {
    if (this.accessLogService && accessContext && typeof this.accessLogService.markParseErrorBody === 'function') {
      this.accessLogService.markParseErrorBody(accessContext, rawBody);
    }
  }

  markError(accessContext, error) {
    if (this.accessLogService && accessContext && typeof this.accessLogService.markError === 'function') {
      this.accessLogService.markError(accessContext, error);
    }
  }
}

module.exports = {
  HttpApiServer
};
