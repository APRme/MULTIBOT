const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ConsoleConnectorClient
} = require('../src/connector/ConsoleConnectorClient');
const {
  parseConnectorArgs,
  validateConnectorArgs,
  main
} = require('../console-connector');

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(check, timeoutMs = 200) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (check()) {
      return;
    }
    await wait(5);
  }

  throw new Error('waitFor timeout');
}

function createOpenStreamHarness() {
  const connections = [];

  async function openStream(options = {}) {
    const connection = {
      options,
      closed: false,
      close() {
        this.closed = true;
      }
    };

    connections.push(connection);
    return connection;
  }

  return {
    openStream,
    connections
  };
}

function createClient(options = {}) {
  const lines = [];
  const requests = [];
  const harness = createOpenStreamHarness();
  const client = new ConsoleConnectorClient({
    botId: 'alpha',
    apiBase: 'http://127.0.0.1:18080',
    token: 'test-token',
    sender: 'panel_connector',
    reconnectDelayMs: 10,
    slowReconnectDelayMs: 10,
    openStream: options.openStream || harness.openStream,
    requestJson: options.requestJson || (async (request) => {
      requests.push(request);
      return {
        body: {
          bot: {
            id: 'alpha',
            state: 'online'
          }
        }
      };
    }),
    writeLine(line) {
      lines.push(line);
    }
  });

  return {
    client,
    lines,
    requests,
    connections: harness.connections
  };
}

test('ConsoleConnectorClient prints history once per backend session', async () => {
  const { client, lines, connections } = createClient();

  const startPromise = client.start();
  await waitFor(() => connections.length === 1);

  connections[0].options.onEvent('bootstrap', {
    backendSessionId: 'session-1',
    bot: {
      id: 'alpha',
      state: 'online'
    },
    logs: [
      { level: 'info', message: 'history-a' },
      { level: 'warn', message: 'history-b' }
    ]
  });

  assert.equal(await startPromise, true);
  assert.equal(client.phase, 'online');
  assert.equal(lines.filter((line) => line.includes('history-a')).length, 1);
  assert.equal(lines.filter((line) => line.includes('history-b')).length, 1);

  connections[0].options.onDisconnect(new Error('socket closed'));
  const reconnectSameSessionPromise = client.connectNow({ background: true });
  await waitFor(() => connections.length === 2);

  connections[1].options.onEvent('bootstrap', {
    backendSessionId: 'session-1',
    bot: {
      id: 'alpha',
      state: 'online'
    },
    logs: [
      { level: 'info', message: 'history-a' },
      { level: 'warn', message: 'history-b' }
    ]
  });

  assert.equal(await reconnectSameSessionPromise, true);
  assert.equal(lines.filter((line) => line.includes('history-a')).length, 1);
  assert.equal(lines.filter((line) => line.includes('history-b')).length, 1);
  assert.equal(lines.filter((line) => line.includes('实例已离线')).length, 1);
  assert.equal(lines.filter((line) => line.includes('已重新连接到 MULTIBOT 后端')).length, 1);

  connections[1].options.onDisconnect(new Error('socket closed again'));
  const reconnectNewSessionPromise = client.connectNow({ background: true });
  await waitFor(() => connections.length === 3);

  connections[2].options.onEvent('bootstrap', {
    backendSessionId: 'session-2',
    bot: {
      id: 'alpha',
      state: 'online'
    },
    logs: [
      { level: 'info', message: 'history-c' }
    ]
  });

  assert.equal(await reconnectNewSessionPromise, true);
  assert.equal(lines.filter((line) => line.includes('history-c')).length, 1);

  await client.stop();
});

test('ConsoleConnectorClient forwards online input and start requests', async () => {
  const { client, requests } = createClient();
  client.phase = 'online';

  assert.equal(await client.handleConsoleInput('hello world'), true);
  assert.equal(await client.handleConsoleInput('/start'), true);

  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, 'http://127.0.0.1:18080/api/bots/alpha/command');
  assert.equal(requests[0].method, 'POST');
  assert.deepEqual(requests[0].body, {
    input: 'hello world',
    source: 'console',
    sender: 'panel_connector'
  });
  assert.equal(requests[1].url, 'http://127.0.0.1:18080/api/bots/alpha/start');
  assert.equal(requests[1].method, 'POST');
});

test('ConsoleConnectorClient rejects offline normal input without buffering', async () => {
  const { client, lines, requests } = createClient();
  client.phase = 'offline';

  assert.equal(await client.handleConsoleInput('hello world'), false);
  assert.equal(requests.length, 0);
  assert.equal(lines.filter((line) => line.includes('后端未连接，无法发送控制台输入')).length, 1);
});

test('ConsoleConnectorClient reconnects before offline /start', async () => {
  const { client, lines, requests, connections } = createClient({
    requestJson: async (request) => {
      requests.push(request);
      return {
        body: {
          bot: {
            id: 'alpha',
            state: 'starting'
          }
        }
      };
    }
  });
  client.phase = 'offline';

  const startPromise = client.handleConsoleInput('/start');
  await waitFor(() => connections.length === 1);

  connections[0].options.onEvent('bootstrap', {
    backendSessionId: 'session-start',
    bot: {
      id: 'alpha',
      state: 'stopped'
    },
    logs: []
  });

  assert.equal(await startPromise, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'http://127.0.0.1:18080/api/bots/alpha/start');
  assert.equal(lines.filter((line) => line.includes('已向后端发送 start')).length, 1);

  await client.stop();
});

test('ConsoleConnectorClient reports failed offline /start reconnects', async () => {
  const lines = [];
  const requests = [];
  const client = new ConsoleConnectorClient({
    botId: 'alpha',
    apiBase: 'http://127.0.0.1:18080',
    token: 'test-token',
    reconnectDelayMs: 10,
    slowReconnectDelayMs: 10,
    openStream: async () => {
      const error = new Error('backend unavailable');
      error.statusCode = 503;
      throw error;
    },
    requestJson: async (request) => {
      requests.push(request);
      return { body: {} };
    },
    writeLine(line) {
      lines.push(line);
    }
  });

  client.phase = 'offline';
  assert.equal(await client.handleConsoleInput('/start'), false);
  assert.equal(requests.length, 0);
  assert.equal(lines.filter((line) => line.includes('无法连接到 MULTIBOT 后端，实例未启动')).length, 1);

  await client.stop();
});

test('console connector CLI parses required args and reports missing ones', async () => {
  assert.deepEqual(parseConnectorArgs([
    '--bot-id', 'example_bot',
    '--api-base', 'http://127.0.0.1:18080',
    '--token', 'change-me',
    '--sender', 'panel_connector'
  ]), {
    botId: 'example_bot',
    apiBase: 'http://127.0.0.1:18080',
    token: 'change-me',
    sender: 'panel_connector'
  });

  assert.deepEqual(validateConnectorArgs({
    botId: '',
    apiBase: '',
    token: ''
  }), ['--bot-id', '--api-base', '--token']);

  const errors = [];
  const originalError = console.error;
  const originalExitCode = process.exitCode;
  console.error = (...parts) => {
    errors.push(parts.join(' '));
  };

  try {
    process.exitCode = 0;
    const result = await main([]);
    assert.equal(result, null);
    assert.equal(process.exitCode, 1);
    assert.match(errors.join('\n'), /Missing required arguments/);
  } finally {
    console.error = originalError;
    process.exitCode = originalExitCode;
  }
});
