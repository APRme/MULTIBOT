const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const net = require('net');
const { HttpApiServer } = require('../src/control/HttpApiServer');

async function makeRequest(options) {
  const {
    port,
    method = 'GET',
    path = '/',
    token = 'test-token',
    body,
    rawBody,
    origin
  } = options;

  const payload = rawBody !== undefined
    ? rawBody
    : body !== undefined
      ? JSON.stringify(body)
      : null;

  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path,
      headers: {
        Authorization: token ? `Bearer ${token}` : '',
        'Content-Type': 'application/json',
        ...(origin ? { Origin: origin } : {})
      }
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({
          statusCode: res.statusCode,
          body: text ? JSON.parse(text) : null
        });
      });
    });

    req.on('error', reject);

    if (payload !== null) {
      req.write(payload);
    }

    req.end();
  });
}

async function makeTextRequest(options) {
  const {
    port,
    method = 'GET',
    path = '/',
    token = 'test-token',
    body,
    rawBody,
    origin
  } = options;

  const payload = rawBody !== undefined
    ? rawBody
    : body !== undefined
      ? JSON.stringify(body)
      : null;

  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path,
      headers: {
        Authorization: token ? `Bearer ${token}` : '',
        'Content-Type': 'application/json',
        ...(origin ? { Origin: origin } : {})
      }
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8')
        });
      });
    });

    req.on('error', reject);

    if (payload !== null) {
      req.write(payload);
    }

    req.end();
  });
}

test('HttpApiServer serves bot list, details and actions', async () => {
  const calls = [];
  const server = new HttpApiServer({
    apiConfig: {
      host: '127.0.0.1',
      port: 0,
      token: 'test-token'
    },
    botManager: {
      listBots() {
        calls.push(['listBots']);
        return [{ id: 'alpha' }];
      },
      getMemoryDiagnostics() {
        calls.push(['getMemoryDiagnostics']);
        return {
          pid: 1234,
          memory: {
            rssMB: 100,
            arrayBuffersMB: 20
          },
          totals: {
            worldColumns: 12
          },
          endedBotRefs: [
            {
              id: 'alpha',
              columnsAtEnd: 12,
              alive: {
                bot: true,
                world: true,
                columns: true
              }
            }
          ],
          botMemory: [
            {
              id: 'alpha',
              worldColumns: 12
            }
          ]
        };
      },
      isMemoryDetailsEnabled() {
        return true;
      },
      getBotDetails(id) {
        calls.push(['getBotDetails', id]);
        return { id, state: 'online' };
      },
      async startBot(id) {
        calls.push(['startBot', id]);
        return { id, state: 'starting' };
      },
      async stopBot(id) {
        calls.push(['stopBot', id]);
        return { id, state: 'stopped' };
      },
      async restartBot(id) {
        calls.push(['restartBot', id]);
        return { id, state: 'restarting' };
      },
      async executeCommand(id, command, options) {
        calls.push(['executeCommand', id, command, options.source, options.sender]);
        return {
          handled: true,
          messages: [{ mode: 'whisper', message: 'ok' }],
          bot: { id, state: 'online' }
        };
      },
      async executeConsoleInput(id, input, options) {
        calls.push(['executeConsoleInput', id, input, options.source, options.sender]);
        return {
          handled: false,
          messages: [],
          bot: { id, state: 'online' },
          inputMode: 'chat'
        };
      }
    },
    instanceService: {
      listInstances() {
        calls.push(['listInstances']);
        return [{ id: 'server__bot' }];
      },
      getInstance(serverDir, botDir) {
        calls.push(['getInstance', serverDir, botDir]);
        return { id: `${serverDir}__${botDir}` };
      },
      async createInstance(body) {
        calls.push(['createInstance', body.serverDir, body.botDir]);
        return { id: `${body.serverDir}__${body.botDir}` };
      },
      async updateInstance(serverDir, botDir, body) {
        calls.push(['updateInstance', serverDir, botDir, Boolean(body.bot)]);
        return { instance: { id: `${serverDir}__${botDir}` }, affectedBotIds: [`${serverDir}__${botDir}`] };
      },
      async deleteInstance(serverDir, botDir) {
        calls.push(['deleteInstance', serverDir, botDir]);
        return { deleted: true, id: `${serverDir}__${botDir}` };
      }
    },
    eventStream: {
      addClient(req, res) {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('events');
      }
    }
  });

  await server.start();
  const port = server.server.address().port;

  const listResponse = await makeRequest({ port, path: '/api/bots' });
  const diagnosticsResponse = await makeRequest({ port, path: '/api/diagnostics/memory' });
  const instancesResponse = await makeRequest({ port, path: '/api/instances' });
  const instanceDetailResponse = await makeRequest({ port, path: '/api/instances/server/bot' });
  const instanceCreateResponse = await makeRequest({
    port,
    method: 'POST',
    path: '/api/instances',
    body: {
      serverDir: 'server',
      botDir: 'bot'
    }
  });
  const instanceUpdateResponse = await makeRequest({
    port,
    method: 'PATCH',
    path: '/api/instances/server/bot',
    body: {
      bot: {
        enabled: true
      }
    }
  });
  const instanceDeleteResponse = await makeRequest({
    port,
    method: 'DELETE',
    path: '/api/instances/server/bot'
  });
  const detailResponse = await makeRequest({ port, path: '/api/bots/alpha' });
  const startResponse = await makeRequest({ port, method: 'POST', path: '/api/bots/alpha/start', body: {} });
  const stopResponse = await makeRequest({ port, method: 'POST', path: '/api/bots/alpha/stop', body: {} });
  const restartResponse = await makeRequest({ port, method: 'POST', path: '/api/bots/alpha/restart', body: {} });
  const commandResponse = await makeRequest({
    port,
    method: 'POST',
    path: '/api/bots/alpha/command',
    body: {
      command: 'health',
      source: 'http',
      sender: 'panel'
    }
  });
  const consoleInputResponse = await makeRequest({
    port,
    method: 'POST',
    path: '/api/bots/alpha/command',
    body: {
      input: 'hello world',
      source: 'console',
      sender: 'panel'
    }
  });

  await server.stop();

  assert.equal(listResponse.statusCode, 200);
  assert.equal(instancesResponse.statusCode, 200);
  assert.deepEqual(instancesResponse.body, { instances: [{ id: 'server__bot' }] });
  assert.equal(instanceDetailResponse.statusCode, 200);
  assert.deepEqual(instanceDetailResponse.body, { instance: { id: 'server__bot' } });
  assert.equal(instanceCreateResponse.statusCode, 201);
  assert.equal(instanceUpdateResponse.statusCode, 200);
  assert.equal(instanceDeleteResponse.statusCode, 200);
  assert.deepEqual(listResponse.body, { bots: [{ id: 'alpha' }] });
  assert.equal(diagnosticsResponse.statusCode, 200);
  assert.equal(diagnosticsResponse.body.pid, 1234);
  assert.equal(diagnosticsResponse.body.totals.worldColumns, 12);
  assert.equal(diagnosticsResponse.body.endedBotRefs[0].alive.columns, true);
  assert.equal(detailResponse.statusCode, 200);
  assert.deepEqual(detailResponse.body, { bot: { id: 'alpha', state: 'online' } });
  assert.equal(startResponse.statusCode, 200);
  assert.equal(stopResponse.statusCode, 200);
  assert.equal(restartResponse.statusCode, 200);
  assert.equal(commandResponse.statusCode, 200);
  assert.equal(consoleInputResponse.statusCode, 200);
  assert.deepEqual(commandResponse.body.messages, [{ mode: 'whisper', message: 'ok' }]);
  assert.equal(consoleInputResponse.body.inputMode, 'chat');
  assert.deepEqual(calls, [
    ['listBots'],
    ['getMemoryDiagnostics'],
    ['listInstances'],
    ['getInstance', 'server', 'bot'],
    ['createInstance', 'server', 'bot'],
    ['updateInstance', 'server', 'bot', true],
    ['deleteInstance', 'server', 'bot'],
    ['getBotDetails', 'alpha'],
    ['startBot', 'alpha'],
    ['stopBot', 'alpha'],
    ['restartBot', 'alpha'],
    ['executeCommand', 'alpha', 'health', 'http', 'panel'],
    ['executeConsoleInput', 'alpha', 'hello world', 'console', 'panel']
  ]);
});

test('HttpApiServer reports memory diagnostics as disabled when switch is off', async () => {
  const calls = [];
  const server = new HttpApiServer({
    apiConfig: {
      host: '127.0.0.1',
      port: 0,
      token: 'test-token'
    },
    botManager: {
      isMemoryDetailsEnabled() {
        calls.push(['isMemoryDetailsEnabled']);
        return false;
      },
      getMemoryDiagnostics() {
        calls.push(['getMemoryDiagnostics']);
        return {};
      }
    }
  });

  await server.start();
  const port = server.server.address().port;
  const response = await makeRequest({ port, path: '/api/diagnostics/memory' });
  await server.stop();

  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.body, { error: 'memory diagnostics disabled' });
  assert.deepEqual(calls, [['isMemoryDetailsEnabled']]);
});

test('HttpApiServer bootstraps global event stream with recent bot logs', async () => {
  const addClientCalls = [];
  const botDetails = {
    alpha: {
      id: 'alpha',
      logs: [
        { timestamp: '2026-04-26T10:00:00.000Z', botId: 'alpha', level: 'info', message: 'alpha-1' },
        { timestamp: '2026-04-26T10:00:01.000Z', botId: 'alpha', level: 'warn', message: 'alpha-2' },
        { timestamp: '2026-04-26T10:00:02.000Z', botId: 'alpha', level: 'error', message: 'alpha-3' }
      ]
    },
    beta: {
      id: 'beta',
      logs: [
        { timestamp: '2026-04-26T10:00:03.000Z', botId: 'beta', level: 'info', message: 'beta-1' }
      ]
    }
  };

  const server = new HttpApiServer({
    apiConfig: {
      host: '127.0.0.1',
      port: 0,
      token: 'test-token'
    },
    consoleConnectorConfig: {
      historyLimit: 2
    },
    botManager: {
      listBots() {
        return [
          { id: 'alpha', state: 'starting' },
          { id: 'beta', state: 'online' }
        ];
      },
      getBotDetails(id) {
        return botDetails[id] || null;
      }
    },
    instanceService: {
      listInstances() {
        return [];
      }
    },
    eventStream: {
      getSessionInfo() {
        return {
          sessionId: 'backend-session-1',
          startedAt: '2026-04-26T09:59:00.000Z'
        };
      },
      addClient(req, res, options) {
        addClientCalls.push({ req, res, options });
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('ok');
      }
    }
  });

  await server.start();
  const port = server.server.address().port;
  const response = await makeTextRequest({
    port,
    path: '/api/events'
  });
  await server.stop();

  assert.equal(response.statusCode, 200);
  assert.equal(addClientCalls.length, 1);
  assert.equal(addClientCalls[0].options.heartbeatMs, 15000);
  assert.deepEqual(addClientCalls[0].options.bootstrapEvents, [{
    event: 'bootstrap',
    data: {
      backendSessionId: 'backend-session-1',
      backendStartedAt: '2026-04-26T09:59:00.000Z',
      historyLimit: 2,
      bots: [
        { id: 'alpha', state: 'starting' },
        { id: 'beta', state: 'online' }
      ],
      logsByBotId: {
        alpha: botDetails.alpha.logs.slice(-2),
        beta: botDetails.beta.logs
      }
    }
  }]);
});

test('HttpApiServer rejects unauthorized requests and invalid bodies', async () => {
  const server = new HttpApiServer({
    apiConfig: {
      host: '127.0.0.1',
      port: 0,
      token: 'test-token'
    },
    botManager: {
      listBots() {
        return [];
      },
      async executeCommand() {
        return {};
      }
    },
    instanceService: {
      listInstances() {
        return [];
      }
    },
    eventStream: {
      addClient(req, res) {
        res.writeHead(200);
        res.end();
      }
    }
  });

  await server.start();
  const port = server.server.address().port;

  const unauthorized = await makeRequest({ port, path: '/api/bots', token: 'wrong-token' });
  const invalidJson = await makeRequest({
    port,
    method: 'POST',
    path: '/api/bots/alpha/command',
    rawBody: '{'
  });
  const invalidBody = await makeRequest({
    port,
    method: 'POST',
    path: '/api/bots/alpha/command',
    body: {}
  });

  await server.stop();

  assert.equal(unauthorized.statusCode, 401);
  assert.equal(invalidJson.statusCode, 400);
  assert.equal(invalidBody.statusCode, 400);
});

test('HttpApiServer records request outcomes in access logs', async () => {
  const accessEntries = [];
  const server = new HttpApiServer({
    apiConfig: {
      host: '127.0.0.1',
      port: 0,
      token: 'test-token'
    },
    botManager: {
      listBots() {
        return [];
      },
      async executeCommand() {
        return {};
      }
    },
    instanceService: {
      listInstances() {
        return [];
      }
    },
    eventStream: {
      addClient(req, res) {
        res.writeHead(200);
        res.end();
      }
    },
    accessLogService: {
      createRequestContext(req, token) {
        return {
          method: req.method,
          rawUrl: req.url,
          auth: {
            valid: req.headers.authorization === `Bearer ${token}`
          }
        };
      },
      markRoute(context, route) {
        context.route = route;
      },
      markOutcome(context, outcome) {
        context.outcome = outcome;
      },
      markRequestBody(context, rawBody) {
        context.bodyPreview = rawBody;
      },
      markParseErrorBody(context, rawBody) {
        context.parseErrorBodyPreview = rawBody;
      },
      markError(context, error) {
        context.errorMessage = error.message;
      },
      logRequest(context, res, eventName) {
        accessEntries.push({
          eventName,
          statusCode: res.statusCode,
          ...context
        });
      },
      logClientError() {}
    }
  });

  await server.start();
  const port = server.server.address().port;

  await makeRequest({ port, path: '/api/bots' });
  await makeRequest({ port, path: '/api/bots', token: 'wrong-token' });
  await makeRequest({
    port,
    method: 'POST',
    path: '/api/bots/alpha/command',
    rawBody: '{'
  });

  await server.stop();

  const successEntry = accessEntries.find((entry) => entry.route === 'GET /api/bots' && entry.statusCode === 200);
  assert.ok(successEntry);
  assert.equal(successEntry.outcome, 'success');
  assert.equal(successEntry.auth.valid, true);

  const unauthorizedEntry = accessEntries.find((entry) => entry.statusCode === 401);
  assert.ok(unauthorizedEntry);
  assert.equal(unauthorizedEntry.outcome, 'unauthorized');
  assert.equal(unauthorizedEntry.auth.valid, false);

  const invalidJsonEntry = accessEntries.find((entry) => entry.statusCode === 400);
  assert.ok(invalidJsonEntry);
  assert.equal(invalidJsonEntry.route, 'POST /api/bots/:id/command');
  assert.equal(invalidJsonEntry.outcome, 'invalid_json');
  assert.equal(invalidJsonEntry.parseErrorBodyPreview, '{');
});

test('HttpApiServer exposes bot console stream bootstrap metadata', async () => {
  const addClientCalls = [];
  const botDetails = {
    id: 'alpha',
    state: 'online',
    logs: [
      { timestamp: '2026-04-26T10:00:00.000Z', botId: 'alpha', level: 'info', message: 'log-1' },
      { timestamp: '2026-04-26T10:00:01.000Z', botId: 'alpha', level: 'info', message: 'log-2' },
      { timestamp: '2026-04-26T10:00:02.000Z', botId: 'alpha', level: 'warn', message: 'log-3' }
    ]
  };

  const server = new HttpApiServer({
    apiConfig: {
      host: '127.0.0.1',
      port: 0,
      token: 'test-token'
    },
    consoleConnectorConfig: {
      historyLimit: 2
    },
    botManager: {
      listBots() {
        return [];
      },
      getBotDetails(id) {
        return id === 'alpha' ? botDetails : null;
      }
    },
    instanceService: {
      listInstances() {
        return [];
      }
    },
    eventStream: {
      getSessionInfo() {
        return {
          sessionId: 'backend-session-1',
          startedAt: '2026-04-26T09:59:00.000Z'
        };
      },
      addClient(req, res, options) {
        addClientCalls.push({ req, res, options });
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('ok');
      }
    }
  });

  await server.start();
  const port = server.server.address().port;
  const response = await makeTextRequest({
    port,
    path: '/api/bots/alpha/console-stream'
  });
  await server.stop();

  assert.equal(response.statusCode, 200);
  assert.equal(addClientCalls.length, 1);

  const { options } = addClientCalls[0];
  assert.equal(options.heartbeatMs, 15000);
  assert.equal(options.eventFilter('log', { botId: 'alpha' }), true);
  assert.equal(options.eventFilter('log', { botId: 'beta' }), false);
  assert.equal(options.eventFilter('botStatus', { id: 'alpha' }), true);
  assert.equal(options.eventFilter('botStatus', { id: 'beta' }), false);
  assert.equal(options.eventFilter('inventory', { botId: 'alpha' }), true);
  assert.equal(options.eventFilter('inventory', { botId: 'beta' }), false);
  assert.equal(options.eventFilter('other', { id: 'alpha' }), false);
  assert.equal(options.bootstrapEvents.length, 1);
  assert.deepEqual(options.bootstrapEvents[0], {
    event: 'bootstrap',
    data: {
      backendSessionId: 'backend-session-1',
      backendStartedAt: '2026-04-26T09:59:00.000Z',
      historyLimit: 2,
      bot: botDetails,
      logs: botDetails.logs.slice(-2)
    }
  });
});

test('HttpApiServer rejects unauthorized and missing bot console stream requests', async () => {
  let addClientCalled = false;
  const server = new HttpApiServer({
    apiConfig: {
      host: '127.0.0.1',
      port: 0,
      token: 'test-token'
    },
    botManager: {
      listBots() {
        return [];
      },
      getBotDetails() {
        return null;
      }
    },
    instanceService: {
      listInstances() {
        return [];
      }
    },
    eventStream: {
      addClient() {
        addClientCalled = true;
      }
    }
  });

  await server.start();
  const port = server.server.address().port;
  const unauthorized = await makeRequest({
    port,
    path: '/api/bots/alpha/console-stream',
    token: 'wrong-token'
  });
  const missing = await makeRequest({
    port,
    path: '/api/bots/missing/console-stream'
  });
  await server.stop();

  assert.equal(unauthorized.statusCode, 401);
  assert.equal(missing.statusCode, 404);
  assert.equal(addClientCalled, false);
});

test('HttpApiServer records low-level client parse errors', async () => {
  const clientErrors = [];
  const server = new HttpApiServer({
    apiConfig: {
      host: '127.0.0.1',
      port: 0,
      token: 'test-token'
    },
    botManager: {
      listBots() {
        return [];
      }
    },
    instanceService: {
      listInstances() {
        return [];
      }
    },
    eventStream: {
      addClient(req, res) {
        res.writeHead(200);
        res.end();
      }
    },
    accessLogService: {
      createRequestContext() {
        return {};
      },
      logRequest() {},
      logClientError(error, socket) {
        clientErrors.push({
          errorMessage: error.message,
          remoteAddress: socket ? socket.remoteAddress : null
        });
      }
    }
  });

  await server.start();
  const port = server.server.address().port;

  await new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
      socket.write('GARBAGE\r\n\r\n');
    });

    const finish = () => resolve();
    socket.on('error', finish);
    socket.on('close', finish);
    setTimeout(() => {
      socket.destroy();
      finish();
    }, 200);
  });

  await server.stop();

  assert.ok(clientErrors.length >= 1);
  assert.match(clientErrors[0].errorMessage, /Parse Error|Invalid method encountered/i);
});

test('HttpApiServer enforces origin, body, URL and SSE limits', async () => {
  const server = new HttpApiServer({
    apiConfig: {
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
      allowedOrigins: ['https://panel.example'],
      bodyLimitBytes: 32
    },
    botManager: {
      listBots() {
        return [];
      },
      async executeCommand() {
        return {};
      }
    },
    instanceService: {
      listInstances() {
        return [];
      }
    },
    eventStream: {
      canAcceptClient() {
        return false;
      },
      addClient() {
        throw new Error('must not add an over-limit SSE client');
      }
    }
  });

  await server.start();
  const port = server.server.address().port;

  try {
    const forbiddenOrigin = await makeRequest({
      port,
      path: '/api/bots',
      origin: 'https://evil.example'
    });
    assert.equal(forbiddenOrigin.statusCode, 403);

    const allowedPreflight = await makeRequest({
      port,
      method: 'OPTIONS',
      path: '/api/bots',
      origin: 'https://panel.example'
    });
    assert.equal(allowedPreflight.statusCode, 204);

    const oversized = await makeRequest({
      port,
      method: 'POST',
      path: '/api/bots/alpha/command',
      rawBody: JSON.stringify({ command: 'x'.repeat(64) })
    });
    assert.equal(oversized.statusCode, 413);

    const malformedUrl = await makeRequest({ port, path: '/api/bots/%E0%A4%A' });
    assert.equal(malformedUrl.statusCode, 400);

    const sseLimit = await makeRequest({ port, path: '/api/events' });
    assert.equal(sseLimit.statusCode, 429);
  } finally {
    await server.stop();
  }
});

test('HttpApiServer serves inventory snapshot and closes window', async () => {
  const snapshot = {
    id: 3,
    name: 'chest',
    supported: true,
    inventoryStart: 27,
    inventoryEnd: 54,
    slots: []
  };
  let closeCalls = 0;

  const server = new HttpApiServer({
    apiConfig: {
      host: '127.0.0.1',
      port: 0,
      token: 'test-token'
    },
    botManager: {
      getBot(id) {
        if (id !== 'alpha') {
          return null;
        }

        return {
          getWindowSnapshot() {
            return snapshot;
          },
          async closeWindow() {
            closeCalls += 1;
            return { ok: true, closed: true };
          }
        };
      }
    },
    eventStream: {
      addClient() {}
    }
  });

  await server.start();
  const port = server.server.address().port;

  try {
    const inventoryResponse = await makeRequest({ port, path: '/api/bots/alpha/inventory' });
    assert.equal(inventoryResponse.statusCode, 200);
    assert.equal(inventoryResponse.body.botId, 'alpha');
    assert.deepEqual(inventoryResponse.body.window, snapshot);

    const missingResponse = await makeRequest({ port, path: '/api/bots/missing/inventory' });
    assert.equal(missingResponse.statusCode, 404);

    const closeResponse = await makeRequest({
      port,
      method: 'POST',
      path: '/api/bots/alpha/close-window'
    });
    assert.equal(closeResponse.statusCode, 200);
    assert.deepEqual(closeResponse.body, { ok: true, closed: true });
    assert.equal(closeCalls, 1);

    const closeMissing = await makeRequest({
      port,
      method: 'POST',
      path: '/api/bots/missing/close-window'
    });
    assert.equal(closeMissing.statusCode, 404);
  } finally {
    await server.stop();
  }
});

test('HttpApiServer close-window reports runtime errors', async () => {
  const server = new HttpApiServer({
    apiConfig: {
      host: '127.0.0.1',
      port: 0,
      token: 'test-token'
    },
    botManager: {
      getBot() {
        return {
          async closeWindow() {
            throw new Error('window already closed');
          }
        };
      }
    },
    eventStream: {
      addClient() {}
    }
  });

  await server.start();
  const port = server.server.address().port;

  try {
    const response = await makeRequest({
      port,
      method: 'POST',
      path: '/api/bots/alpha/close-window'
    });
    assert.equal(response.statusCode, 500);
    assert.equal(response.body.error, 'window already closed');
  } finally {
    await server.stop();
  }
});
