const http = require('http');
const https = require('https');

function normalizeBaseUrl(value) {
  const text = String(value || '').trim();
  if (!text) {
    throw new Error('apiBase is required');
  }

  return text.endsWith('/') ? text : `${text}/`;
}

function buildUrl(apiBase, relativePath) {
  return new URL(relativePath.replace(/^\//, ''), normalizeBaseUrl(apiBase)).toString();
}

function buildRequestHeaders(token, extraHeaders = {}) {
  return {
    Authorization: `Bearer ${token}`,
    ...extraHeaders
  };
}

function getTransport(url) {
  return url.protocol === 'https:' ? https : http;
}

function parseJsonSafe(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (error) {
    return null;
  }
}

function formatRequestError(error) {
  if (!error) return 'unknown error';
  if (error.body && typeof error.body.error === 'string') {
    return error.body.error;
  }
  if (error.statusCode === 401) {
    return '未授权，请检查 token';
  }
  if (error.statusCode === 404) {
    return '找不到目标实例';
  }
  return error.message || String(error);
}

function requestJson(options = {}) {
  const {
    url,
    method = 'GET',
    token,
    body = null,
    headers = {}
  } = options;

  const requestUrl = new URL(url);
  const payload = body === null ? null : JSON.stringify(body);
  const transport = getTransport(requestUrl);

  return new Promise((resolve, reject) => {
    const req = transport.request(requestUrl, {
      method,
      headers: buildRequestHeaders(token, {
        'Content-Type': 'application/json',
        ...headers
      })
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        const parsed = parseJsonSafe(text);
        const result = {
          statusCode: res.statusCode || 0,
          headers: res.headers,
          body: parsed
        };

        if ((res.statusCode || 0) >= 400) {
          const error = new Error(
            parsed && typeof parsed.error === 'string'
              ? parsed.error
              : `request failed status=${res.statusCode || 0}`
          );
          error.statusCode = res.statusCode || 0;
          error.body = parsed;
          reject(error);
          return;
        }

        resolve(result);
      });
    });

    req.on('error', reject);

    if (payload !== null) {
      req.write(payload);
    }

    req.end();
  });
}

function parseSseBlock(block) {
  const lines = String(block || '').split('\n');
  let eventName = 'message';
  const dataLines = [];

  for (const rawLine of lines) {
    const line = String(rawLine || '');
    if (!line) continue;
    if (line.startsWith(':')) continue;

    const separatorIndex = line.indexOf(':');
    const field = separatorIndex === -1 ? line : line.slice(0, separatorIndex);
    const value = separatorIndex === -1
      ? ''
      : line.slice(separatorIndex + 1).replace(/^ /, '');

    if (field === 'event') {
      eventName = value || 'message';
      continue;
    }

    if (field === 'data') {
      dataLines.push(value);
    }
  }

  if (!dataLines.length) {
    return null;
  }

  const rawData = dataLines.join('\n');
  return {
    event: eventName,
    data: parseJsonSafe(rawData) ?? rawData
  };
}

function openSseStream(options = {}) {
  const {
    url,
    token,
    onEvent,
    onDisconnect
  } = options;

  const requestUrl = new URL(url);
  const transport = getTransport(requestUrl);

  return new Promise((resolve, reject) => {
    let closedByClient = false;
    let disconnectHandled = false;
    let buffer = '';
    let response = null;

    const emitDisconnect = (error) => {
      if (closedByClient || disconnectHandled) {
        return;
      }

      disconnectHandled = true;
      if (typeof onDisconnect === 'function') {
        onDisconnect(error || new Error('sse connection closed'));
      }
    };

    const request = transport.request(requestUrl, {
      method: 'GET',
      headers: buildRequestHeaders(token, {
        Accept: 'text/event-stream'
      })
    }, (res) => {
      response = res;

      if ((res.statusCode || 0) !== 200) {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          const parsed = parseJsonSafe(text);
          const error = new Error(
            parsed && typeof parsed.error === 'string'
              ? parsed.error
              : `stream failed status=${res.statusCode || 0}`
          );
          error.statusCode = res.statusCode || 0;
          error.body = parsed;
          reject(error);
        });
        return;
      }

      res.setEncoding('utf8');
      resolve({
        close() {
          closedByClient = true;
          try {
            request.destroy();
          } catch (error) {
          }
          try {
            res.destroy();
          } catch (error) {
          }
        }
      });

      res.on('data', (chunk) => {
        buffer += String(chunk || '').replace(/\r/g, '');

        let separatorIndex = buffer.indexOf('\n\n');
        while (separatorIndex !== -1) {
          const block = buffer.slice(0, separatorIndex);
          buffer = buffer.slice(separatorIndex + 2);

          const parsed = parseSseBlock(block);
          if (parsed && typeof onEvent === 'function') {
            onEvent(parsed.event, parsed.data);
          }

          separatorIndex = buffer.indexOf('\n\n');
        }
      });

      res.on('end', () => {
        emitDisconnect(new Error('sse connection ended'));
      });

      res.on('close', () => {
        emitDisconnect(new Error('sse connection closed'));
      });

      res.on('error', (error) => {
        emitDisconnect(error);
      });
    });

    request.on('error', (error) => {
      if (!response) {
        reject(error);
        return;
      }

      emitDisconnect(error);
    });

    request.end();
  });
}

class ConsoleConnectorClient {
  constructor(options = {}) {
    this.botId = String(options.botId || '').trim();
    this.apiBase = normalizeBaseUrl(options.apiBase);
    this.token = String(options.token || '').trim();
    this.sender = String(options.sender || 'panel_connector').trim() || 'panel_connector';
    this.openStream = typeof options.openStream === 'function' ? options.openStream : openSseStream;
    this.requestJson = typeof options.requestJson === 'function' ? options.requestJson : requestJson;
    this.writeLine = typeof options.writeLine === 'function' ? options.writeLine : ((line) => console.log(line));
    this.reconnectDelayMs = Number.isFinite(Number(options.reconnectDelayMs))
      ? Math.max(1000, Number(options.reconnectDelayMs))
      : 3000;
    this.slowReconnectDelayMs = Number.isFinite(Number(options.slowReconnectDelayMs))
      ? Math.max(1000, Number(options.slowReconnectDelayMs))
      : 30000;
    this.phase = 'stopped';
    this.connectPromise = null;
    this.reconnectTimer = null;
    this.streamConnection = null;
    this.stopped = false;
    this.lastPrintedBackendSessionId = null;
    this.lastConnectionErrorKey = null;
    this.lastBotStatus = null;
    this.lastAnnouncedOffline = false;

    if (!this.botId) {
      throw new Error('botId is required');
    }
    if (!this.token) {
      throw new Error('token is required');
    }
  }

  getConsoleStreamUrl() {
    return buildUrl(this.apiBase, `/api/bots/${encodeURIComponent(this.botId)}/console-stream`);
  }

  getBotActionUrl(action) {
    return buildUrl(this.apiBase, `/api/bots/${encodeURIComponent(this.botId)}/${action}`);
  }

  formatConnectorLine(level, message) {
    return `[CONNECTOR][${this.botId}][${String(level || 'info').toUpperCase()}] ${message}`;
  }

  formatBotLogLine(entry) {
    const level = String(entry && entry.level ? entry.level : 'info').toUpperCase();
    return `[MULTIBOT][${this.botId}][${level}] ${entry && entry.message ? entry.message : ''}`;
  }

  printConnector(level, message) {
    this.writeLine(this.formatConnectorLine(level, message));
  }

  printBotLog(entry) {
    this.writeLine(this.formatBotLogLine(entry));
  }

  clearReconnectTimer() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  closeStreamConnection() {
    if (this.streamConnection && typeof this.streamConnection.close === 'function') {
      try {
        this.streamConnection.close();
      } catch (error) {
      }
    }
    this.streamConnection = null;
  }

  classifyConnectionError(error) {
    const statusCode = Number(error && error.statusCode);
    if (statusCode === 401) {
      return {
        key: 'unauthorized',
        delayMs: this.slowReconnectDelayMs,
        message: '连接后端失败：未授权，请检查 token'
      };
    }

    if (statusCode === 404) {
      return {
        key: 'bot_not_found',
        delayMs: this.slowReconnectDelayMs,
        message: `连接后端失败：找不到 botId=${this.botId}`
      };
    }

    return {
      key: 'network',
      delayMs: this.reconnectDelayMs,
      message: `连接后端失败：${formatRequestError(error)}`
    };
  }

  reportConnectionError(error, options = {}) {
    const { force = false } = options;
    const classified = this.classifyConnectionError(error);
    if (force || this.lastConnectionErrorKey !== classified.key) {
      this.printConnector('warn', classified.message);
    }
    this.lastConnectionErrorKey = classified.key;
    return classified;
  }

  scheduleReconnect(delayMs) {
    if (this.stopped || this.reconnectTimer) {
      return;
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connectNow({ background: true });
    }, delayMs);

    if (typeof this.reconnectTimer.unref === 'function') {
      this.reconnectTimer.unref();
    }
  }

  handleBootstrap(payload, previousPhase) {
    const wasOffline = previousPhase === 'offline';
    const isFirstConnection = this.lastPrintedBackendSessionId === null;

    this.phase = 'online';
    this.lastConnectionErrorKey = null;
    this.lastAnnouncedOffline = false;
    this.lastBotStatus = payload && payload.bot ? payload.bot : null;

    if (isFirstConnection) {
      this.printConnector('info', `已连接到 MULTIBOT 后端，目标实例: ${this.botId}`);
    } else if (wasOffline) {
      this.printConnector('info', '已重新连接到 MULTIBOT 后端');
    }

    const nextSessionId = payload && payload.backendSessionId
      ? String(payload.backendSessionId)
      : null;
    const shouldPrintHistory = this.lastPrintedBackendSessionId === null
      || (nextSessionId && this.lastPrintedBackendSessionId !== nextSessionId);

    if (shouldPrintHistory && Array.isArray(payload && payload.logs)) {
      for (const entry of payload.logs) {
        this.printBotLog(entry);
      }
    }

    if (nextSessionId) {
      this.lastPrintedBackendSessionId = nextSessionId;
    }
  }

  handleStreamDisconnect(error) {
    this.streamConnection = null;

    if (this.stopped) {
      return;
    }

    const classified = this.classifyConnectionError(error);

    if (this.phase === 'online') {
      this.phase = 'offline';
      if (!this.lastAnnouncedOffline) {
        this.printConnector('warn', '实例已离线：MULTIBOT 后端连接已断开');
        this.lastAnnouncedOffline = true;
      }
    } else {
      this.phase = 'offline';
      this.reportConnectionError(error);
    }

    this.scheduleReconnect(classified.delayMs);
  }

  async connectNow(options = {}) {
    const { background = false } = options;
    if (this.stopped) {
      return false;
    }

    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.clearReconnectTimer();
    const previousPhase = this.phase;
    if (this.phase !== 'online') {
      this.phase = 'connecting';
    }

    this.connectPromise = (async () => {
      let bootstrapped = false;
      let connection = null;

      const connected = await new Promise(async (resolve, reject) => {
        try {
          connection = await this.openStream({
            url: this.getConsoleStreamUrl(),
            token: this.token,
            onEvent: (eventName, data) => {
              if (eventName === 'bootstrap') {
                bootstrapped = true;
                this.streamConnection = connection;
                this.handleBootstrap(data, previousPhase);
                resolve(true);
                return;
              }

              if (eventName === 'log') {
                this.printBotLog(data);
                return;
              }

              if (eventName === 'botStatus') {
                this.lastBotStatus = data;
              }
            },
            onDisconnect: (error) => {
              if (!bootstrapped) {
                reject(error || new Error('stream disconnected before bootstrap'));
                return;
              }

              this.handleStreamDisconnect(error);
            }
          });

          this.streamConnection = connection;
          if (this.stopped) {
            this.closeStreamConnection();
            resolve(false);
          }
        } catch (error) {
          reject(error);
        }
      }).catch((error) => {
        const classified = this.reportConnectionError(error, {
          force: background !== true
        });
        this.phase = 'offline';
        this.scheduleReconnect(classified.delayMs);
        return false;
      });

      return connected === true;
    })().finally(() => {
      this.connectPromise = null;
    });

    return this.connectPromise;
  }

  async start() {
    if (this.phase !== 'stopped') {
      return false;
    }

    this.stopped = false;
    this.phase = 'connecting';
    return this.connectNow({ background: true });
  }

  async stop() {
    this.stopped = true;
    this.clearReconnectTimer();
    this.closeStreamConnection();
    this.phase = 'stopped';
  }

  async requestStart() {
    try {
      const result = await this.requestJson({
        url: this.getBotActionUrl('start'),
        method: 'POST',
        token: this.token,
        body: {}
      });
      this.lastBotStatus = result && result.body ? result.body.bot : this.lastBotStatus;
      const state = result && result.body && result.body.bot && result.body.bot.state
        ? result.body.bot.state
        : 'unknown';
      this.printConnector('info', `已向后端发送 start，当前状态: ${state}`);
      return true;
    } catch (error) {
      this.printConnector('error', `发送 start 失败：${formatRequestError(error)}`);
      return false;
    }
  }

  async sendConsoleInput(rawInput) {
    try {
      await this.requestJson({
        url: this.getBotActionUrl('command'),
        method: 'POST',
        token: this.token,
        body: {
          input: rawInput,
          source: 'console',
          sender: this.sender
        }
      });
      return true;
    } catch (error) {
      this.printConnector('error', `发送控制台输入失败：${formatRequestError(error)}`);
      return false;
    }
  }

  async handleStartCommand() {
    if (this.phase === 'online') {
      return this.requestStart();
    }

    const connected = await this.connectNow({ background: false });
    if (!connected) {
      this.printConnector('warn', '无法连接到 MULTIBOT 后端，实例未启动');
      return false;
    }

    return this.requestStart();
  }

  async handleConsoleInput(rawInput) {
    const input = typeof rawInput === 'string' ? rawInput : '';
    const trimmed = input.trim();
    if (!trimmed) {
      return false;
    }

    if (trimmed === '/start') {
      return this.handleStartCommand();
    }

    if (this.phase !== 'online') {
      this.printConnector('warn', '后端未连接，无法发送控制台输入');
      return false;
    }

    return this.sendConsoleInput(input);
  }
}

module.exports = {
  ConsoleConnectorClient,
  buildUrl,
  normalizeBaseUrl,
  openSseStream,
  requestJson
};
