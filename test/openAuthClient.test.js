const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const {
  OpenAuthClient,
  OPEN_AUTH_JOIN_CHANNEL,
  OPEN_AUTH_DATA_CHANNEL,
  DNS_LOOKUP_TIMEOUT_MS,
  MAX_MOJANG_RESPONSE_BYTES,
  isLoopbackAddress,
  resolveLocalProxyHost,
  encodeVarInt,
  decodeVarInt,
  encodeMinecraftString,
  decodeMinecraftString
} = require('../src/session/OpenAuthClient');

const VALID_HASH = '-af59e5b1d5d92e5c2c2776ed0e65e90be181f2a';
const VALID_PROFILE = '1234567890abcdef1234567890abcdef';
const SECRET_TOKEN = 'secret-access-token-never-log';

function createNoopTimers() {
  return {
    setTimeout() {
      return { unref() {} };
    },
    clearTimeout() {}
  };
}

function createLogger() {
  const entries = [];
  return {
    entries,
    info(...parts) {
      entries.push(parts.join(' '));
    },
    warn(...parts) {
      entries.push(parts.join(' '));
    },
    error(...parts) {
      entries.push(parts.join(' '));
    }
  };
}

function createClient(overrides = {}) {
  const client = new EventEmitter();
  client.writes = [];
  client.ended = false;
  client.socket = {
    remoteAddress: '127.0.0.1'
  };
  client.session = {
    accessToken: SECRET_TOKEN,
    selectedProfile: {
      id: VALID_PROFILE,
      name: 'ExamplePlayer'
    }
  };
  client.write = (name, payload) => {
    client.writes.push({ name, payload });
  };

  function onLoginPluginRequest(packet) {
    client.write('login_plugin_response', {
      messageId: packet.messageId
    });
  }

  client.on('login_plugin_request', onLoginPluginRequest);
  Object.assign(client, overrides);
  return { client, defaultListener: onLoginPluginRequest };
}

function createHttpsMock(behaviors = []) {
  const queue = [...behaviors];
  const calls = [];

  const httpsRequest = (options, onResponse) => {
    const request = new EventEmitter();
    const behavior = queue.shift() || { statusCode: 204 };
    const call = {
      options,
      request,
      body: null,
      behavior
    };
    calls.push(call);

    request.destroyed = false;
    request.destroy = () => {
      request.destroyed = true;
    };
    request.end = (body) => {
      call.body = Buffer.from(body);

      const deliver = () => {
        if (behavior.error) {
          request.emit('error', behavior.error);
          return;
        }

        const response = new EventEmitter();
        response.statusCode = behavior.statusCode;
        response.destroyed = false;
        response.destroy = () => {
          response.destroyed = true;
        };
        call.response = response;
        onResponse(response);

        queueMicrotask(() => {
          for (const chunk of behavior.chunks || []) {
            if (response.destroyed) break;
            response.emit('data', chunk);
          }
          if (!response.destroyed) response.emit('end');
        });
      };

      if (behavior.hold === true) {
        behavior.release = deliver;
      } else {
        queueMicrotask(deliver);
      }
    };

    return request;
  };

  return { httpsRequest, calls };
}

async function waitFor(predicate, message = 'condition') {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(`timed out waiting for ${message}`);
}

function createOpenAuth(options = {}) {
  const timers = options.timers || createNoopTimers();
  return new OpenAuthClient({
    client: options.client,
    config: {
      timeoutMs: options.timeoutMs === undefined ? 4500 : options.timeoutMs
    },
    httpsRequest: options.httpsRequest,
    logger: options.logger,
    onRequest: options.onRequest,
    onFailure: options.onFailure,
    onSuccess: options.onSuccess,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout
  });
}

test('isLoopbackAddress accepts IPv4, IPv6 and mapped loopback addresses only', () => {
  for (const address of [
    '127.0.0.1',
    '127.200.10.5',
    '::1',
    '[::1]',
    '::ffff:127.0.0.1',
    '0:0:0:0:0:ffff:7f00:1'
  ]) {
    assert.equal(isLoopbackAddress(address), true, address);
  }

  for (const address of [
    '0.0.0.0',
    '192.168.1.2',
    '8.8.8.8',
    '::',
    '::ffff:192.168.1.2',
    'localhost',
    ''
  ]) {
    assert.equal(isLoopbackAddress(address), false, address);
  }
});

test('resolveLocalProxyHost pins literal loopback IPs without DNS', async () => {
  let lookupCalled = false;
  const ipv4 = await resolveLocalProxyHost('127.0.0.9', {
    lookup() {
      lookupCalled = true;
    }
  });
  const ipv6 = await resolveLocalProxyHost('[::1]');

  assert.deepEqual(ipv4, { address: '127.0.0.9', family: 4 });
  assert.deepEqual(ipv6, { address: '::1', family: 6 });
  assert.equal(lookupCalled, false);
  await assert.rejects(
    resolveLocalProxyHost('10.0.0.1'),
    (error) => error.code === 'PROXY_NOT_LOOPBACK'
  );
});

test('resolveLocalProxyHost requires every DNS answer to be loopback', async () => {
  let lookupOptions;
  const resolved = await resolveLocalProxyHost('proxy.local', {
    lookup(host, options, callback) {
      assert.equal(host, 'proxy.local');
      lookupOptions = options;
      callback(null, [
        { address: '::1', family: 6 },
        { address: '127.0.0.1', family: 4 }
      ]);
    }
  });

  assert.deepEqual(lookupOptions, { all: true, verbatim: true });
  assert.deepEqual(resolved, { address: '127.0.0.1', family: 4 });

  await assert.rejects(
    resolveLocalProxyHost('mixed.local', {
      lookup(host, options, callback) {
        callback(null, [
          { address: '127.0.0.1', family: 4 },
          { address: '192.168.1.2', family: 4 }
        ]);
      }
    }),
    (error) => error.code === 'PROXY_NOT_LOOPBACK'
  );
});

test('resolveLocalProxyHost applies a three second lookup timeout', async () => {
  let timeoutCallback;
  let timeoutDelay;
  let cleared = false;
  const pending = resolveLocalProxyHost('slow.local', {
    lookup() {},
    setTimeout(callback, delay) {
      timeoutCallback = callback;
      timeoutDelay = delay;
      return 77;
    },
    clearTimeout(handle) {
      assert.equal(handle, 77);
      cleared = true;
    }
  });

  assert.equal(timeoutDelay, DNS_LOOKUP_TIMEOUT_MS);
  timeoutCallback();
  await assert.rejects(pending, (error) => error.code === 'DNS_TIMEOUT');
  assert.equal(cleared, true);
});

test('VarInt codec round-trips canonical signed 32-bit values', () => {
  for (const value of [0, 1, 127, 128, 255, 2147483647, -1, -2147483648]) {
    const encoded = encodeVarInt(value);
    assert.ok(encoded.length >= 1 && encoded.length <= 5);
    assert.deepEqual(decodeVarInt(encoded), {
      value,
      bytesRead: encoded.length
    });
  }

  assert.throws(() => encodeVarInt(2147483648), (error) => error.code === 'INVALID_PACKET');
  assert.throws(() => decodeVarInt(Buffer.from([0x80])), (error) => error.code === 'INVALID_PACKET');
  assert.throws(() => decodeVarInt(Buffer.from([0x80, 0x00])), (error) => error.code === 'INVALID_PACKET');
  assert.throws(
    () => decodeVarInt(Buffer.from([0xff, 0xff, 0xff, 0xff, 0x10])),
    (error) => error.code === 'INVALID_PACKET'
  );
});

test('Minecraft String codec enforces UTF-8, limits and full consumption', () => {
  const encoded = encodeMinecraftString('hello 世界', { maxChars: 20 });
  assert.deepEqual(decodeMinecraftString(encoded, 0, {
    maxChars: 20,
    requireFull: true
  }), {
    value: 'hello 世界',
    bytesRead: encoded.length
  });

  const prefixed = Buffer.concat([Buffer.from([0xaa]), encoded]);
  assert.equal(decodeMinecraftString(prefixed, 1, { maxChars: 20 }).value, 'hello 世界');
  assert.throws(
    () => decodeMinecraftString(Buffer.from([2, 0xc3, 0x28]), 0, { requireFull: true }),
    (error) => error.code === 'INVALID_PACKET'
  );
  assert.throws(
    () => decodeMinecraftString(Buffer.concat([encoded, Buffer.from([0])]), 0, { requireFull: true }),
    (error) => error.code === 'INVALID_PACKET'
  );
  assert.throws(
    () => encodeMinecraftString('too long', { maxChars: 3 }),
    (error) => error.code === 'INVALID_PACKET'
  );
  assert.throws(
    () => encodeMinecraftString('\ud800'),
    (error) => error.code === 'INVALID_PACKET'
  );
});

test('OpenAuthClient synchronously replaces only the default LOGIN listener', () => {
  const { client, defaultListener } = createClient();
  const unrelated = () => {};
  client.on('login_plugin_request', unrelated);
  const auth = createOpenAuth({ client });

  assert.equal(client.listeners('login_plugin_request').includes(defaultListener), false);
  assert.equal(client.listeners('login_plugin_request').includes(unrelated), true);
  client.emit('login_plugin_request', {
    messageId: 9,
    channel: 'example:unknown',
    data: Buffer.alloc(0)
  });
  assert.deepEqual(client.writes, [{
    name: 'login_plugin_response',
    payload: { messageId: 9 }
  }]);

  auth.detach();
  assert.equal(client.listeners('login_plugin_request').includes(defaultListener), true);
});

test('OpenAuthClient refuses ambiguous duplicate default LOGIN listeners', () => {
  const { client, defaultListener } = createClient();
  client.on('login_plugin_request', defaultListener);

  assert.throws(
    () => createOpenAuth({ client }),
    (error) => error.code === 'DEFAULT_LOGIN_LISTENER_NOT_FOUND'
  );
  assert.equal(client.listeners('login_plugin_request').length, 2);
});

test('OpenAuthClient completes LOGIN oam:join through the fixed Mojang endpoint', async () => {
  const { client } = createClient();
  const logger = createLogger();
  const failures = [];
  const mock = createHttpsMock([{ statusCode: 204 }]);
  const auth = createOpenAuth({
    client,
    httpsRequest: mock.httpsRequest,
    logger,
    onFailure: (failure) => failures.push(failure)
  });

  client.emit('login_plugin_request', {
    messageId: 42,
    channel: OPEN_AUTH_JOIN_CHANNEL,
    data: encodeMinecraftString(VALID_HASH, { maxChars: 64 })
  });
  await waitFor(() => client.writes.length === 1, 'LOGIN OpenAuth response');

  assert.equal(mock.calls.length, 1);
  assert.deepEqual(mock.calls[0].options, {
    protocol: 'https:',
    hostname: 'sessionserver.mojang.com',
    port: 443,
    method: 'POST',
    path: '/session/minecraft/join',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'Content-Length': mock.calls[0].body.length
    }
  });
  assert.deepEqual(JSON.parse(mock.calls[0].body.toString('utf8')), {
    accessToken: SECRET_TOKEN,
    selectedProfile: VALID_PROFILE,
    serverId: VALID_HASH
  });
  assert.deepEqual(client.writes[0], {
    name: 'login_plugin_response',
    payload: {
      messageId: 42,
      data: Buffer.from([1])
    }
  });
  assert.deepEqual(failures, []);
  assert.equal(logger.entries.join('\n').includes(SECRET_TOKEN), false);
  assert.equal(logger.entries.join('\n').includes(VALID_PROFILE), false);
  assert.equal(logger.entries.join('\n').includes(VALID_HASH), false);
  auth.dispose();
});

test('OpenAuthClient reports a valid request before Mojang Join completes', () => {
  const { client } = createClient();
  const held = { statusCode: 204, hold: true };
  const mock = createHttpsMock([held]);
  let requestCount = 0;
  let successCount = 0;
  const auth = createOpenAuth({
    client,
    httpsRequest: mock.httpsRequest,
    onRequest: () => {
      requestCount += 1;
    },
    onSuccess: () => {
      successCount += 1;
    }
  });

  client.emit('login_plugin_request', {
    messageId: 43,
    channel: OPEN_AUTH_JOIN_CHANNEL,
    data: encodeMinecraftString(VALID_HASH, { maxChars: 64 })
  });

  assert.equal(requestCount, 1);
  assert.equal(successCount, 0);
  assert.equal(mock.calls.length, 1);
  assert.equal(client.writes.length, 0);
  auth.dispose();
});

test('OpenAuthClient supports PLAY oam:join and replies on oam:data', async () => {
  const { client } = createClient();
  const mock = createHttpsMock([{ statusCode: 204 }]);
  const auth = createOpenAuth({ client, httpsRequest: mock.httpsRequest });
  const requestId = 321;

  client.emit('custom_payload', {
    channel: OPEN_AUTH_JOIN_CHANNEL,
    data: Buffer.concat([
      encodeVarInt(requestId),
      encodeMinecraftString(VALID_HASH, { maxChars: 64 })
    ])
  });
  client.emit('custom_payload', {
    channel: 'example:unknown',
    data: Buffer.alloc(0)
  });
  await waitFor(() => client.writes.length === 1, 'PLAY OpenAuth response');

  assert.equal(client.writes[0].name, 'custom_payload');
  assert.equal(client.writes[0].payload.channel, OPEN_AUTH_DATA_CHANNEL);
  const responseData = client.writes[0].payload.data;
  const decodedId = decodeVarInt(responseData);
  assert.equal(decodedId.value, requestId);
  assert.deepEqual(responseData.subarray(decodedId.bytesRead), Buffer.from([1]));
  assert.equal(mock.calls.length, 1);
  auth.dispose();
});

test('OpenAuthClient rejects malformed, non-local and invalid-session requests without HTTPS', () => {
  const cases = [
    {
      mutate(client) {
        client.socket.remoteAddress = '192.168.1.10';
      },
      packet: encodeMinecraftString(VALID_HASH),
      code: 'PROXY_NOT_LOOPBACK'
    },
    {
      mutate(client) {
        client.session = null;
      },
      packet: encodeMinecraftString(VALID_HASH),
      code: 'SESSION_MISSING',
      sessionInvalid: true
    },
    {
      mutate(client) {
        client.session.selectedProfile.id = 'not-a-uuid';
      },
      packet: encodeMinecraftString(VALID_HASH),
      code: 'INVALID_PROFILE',
      sessionInvalid: true
    },
    {
      mutate() {},
      packet: encodeMinecraftString('not-a-hash'),
      code: 'INVALID_HASH'
    },
    {
      mutate() {},
      packet: encodeMinecraftString('ABCDEF'),
      code: 'INVALID_HASH'
    },
    {
      mutate() {},
      packet: Buffer.from([0x80]),
      code: 'INVALID_PACKET'
    }
  ];

  for (const entry of cases) {
    const { client } = createClient();
    entry.mutate(client);
    const failures = [];
    let requestCount = 0;
    const auth = createOpenAuth({
      client,
      httpsRequest() {
        requestCount += 1;
        throw new Error('must not run');
      },
      onFailure: (failure) => failures.push(failure)
    });
    client.emit('login_plugin_request', {
      messageId: 1,
      channel: OPEN_AUTH_JOIN_CHANNEL,
      data: entry.packet
    });

    assert.equal(requestCount, 0, entry.code);
    assert.equal(client.writes.length, 1, entry.code);
    assert.deepEqual(client.writes[0].payload.data, Buffer.from([0]), entry.code);
    assert.equal(failures[0].code, entry.code);
    assert.equal(failures[0].sessionInvalid, entry.sessionInvalid === true);
    auth.dispose();
  }
});

test('OpenAuthClient writes a rejection before notifying runtime failure handling', () => {
  const { client } = createClient();
  const sequence = [];
  const originalWrite = client.write;
  client.session = null;
  client.write = (...args) => {
    sequence.push('write');
    return originalWrite(...args);
  };
  const auth = createOpenAuth({
    client,
    onFailure() {
      sequence.push('failure');
    }
  });

  client.emit('login_plugin_request', {
    messageId: 1,
    channel: OPEN_AUTH_JOIN_CHANNEL,
    data: encodeMinecraftString(VALID_HASH)
  });

  assert.deepEqual(sequence, ['write', 'failure']);
  auth.dispose();
});

test('OpenAuthClient maps Mojang status codes and accepts only 204', async (t) => {
  const cases = [
    [200, 'MOJANG_UNEXPECTED_STATUS', 'configuration', false],
    [302, 'MOJANG_REDIRECT_REJECTED', 'configuration', false],
    [403, 'MOJANG_SESSION_INVALID', 'reauth', true],
    [429, 'MOJANG_RATE_LIMITED', 'transient', false],
    [503, 'MOJANG_UNAVAILABLE', 'transient', false]
  ];

  for (const [statusCode, code, retryClass, sessionInvalid] of cases) {
    await t.test(String(statusCode), async () => {
      const { client } = createClient();
      const failures = [];
      const mock = createHttpsMock([{ statusCode }]);
      const auth = createOpenAuth({
        client,
        httpsRequest: mock.httpsRequest,
        onFailure: (failure) => failures.push(failure)
      });
      client.emit('login_plugin_request', {
        messageId: statusCode,
        channel: OPEN_AUTH_JOIN_CHANNEL,
        data: encodeMinecraftString(VALID_HASH)
      });
      await waitFor(() => client.writes.length === 1, `${statusCode} response`);

      assert.deepEqual(client.writes[0].payload.data, Buffer.from([0]));
      assert.deepEqual(failures, [{ code, retryClass, sessionInvalid }]);
      auth.dispose();
    });
  }
});

test('OpenAuthClient enforces the 8 KiB Mojang response limit', async () => {
  const { client } = createClient();
  const failures = [];
  const mock = createHttpsMock([{
    statusCode: 500,
    chunks: [Buffer.alloc(MAX_MOJANG_RESPONSE_BYTES + 1, 0x61)]
  }]);
  const auth = createOpenAuth({
    client,
    httpsRequest: mock.httpsRequest,
    onFailure: (failure) => failures.push(failure)
  });
  client.emit('login_plugin_request', {
    messageId: 8,
    channel: OPEN_AUTH_JOIN_CHANNEL,
    data: encodeMinecraftString(VALID_HASH)
  });
  await waitFor(() => client.writes.length === 1, 'oversized response rejection');

  assert.deepEqual(client.writes[0].payload.data, Buffer.from([0]));
  assert.equal(failures[0].code, 'MOJANG_RESPONSE_TOO_LARGE');
  assert.equal(mock.calls[0].response.destroyed, true);
  auth.dispose();
});

test('OpenAuthClient reports network errors without leaking exception text', async () => {
  const { client } = createClient();
  const logger = createLogger();
  const failures = [];
  const mock = createHttpsMock([{
    error: new Error(`network failed ${SECRET_TOKEN} ${VALID_HASH}`)
  }]);
  const auth = createOpenAuth({
    client,
    httpsRequest: mock.httpsRequest,
    logger,
    onFailure: (failure) => failures.push(failure)
  });
  client.emit('login_plugin_request', {
    messageId: 5,
    channel: OPEN_AUTH_JOIN_CHANNEL,
    data: encodeMinecraftString(VALID_HASH)
  });
  await waitFor(() => client.writes.length === 1, 'network error response');

  assert.equal(failures[0].code, 'MOJANG_NETWORK_ERROR');
  const serialized = JSON.stringify({ logs: logger.entries, failures });
  assert.equal(serialized.includes(SECRET_TOKEN), false);
  assert.equal(serialized.includes(VALID_HASH), false);
  assert.equal(serialized.includes(VALID_PROFILE), false);
  auth.dispose();
});

test('OpenAuthClient limits each connection to one in-flight request', async () => {
  const { client } = createClient();
  const failures = [];
  const first = { statusCode: 204, hold: true };
  const mock = createHttpsMock([first]);
  const auth = createOpenAuth({
    client,
    httpsRequest: mock.httpsRequest,
    onFailure: (failure) => failures.push(failure)
  });

  client.emit('login_plugin_request', {
    messageId: 1,
    channel: OPEN_AUTH_JOIN_CHANNEL,
    data: encodeMinecraftString(VALID_HASH)
  });
  client.emit('login_plugin_request', {
    messageId: 2,
    channel: OPEN_AUTH_JOIN_CHANNEL,
    data: encodeMinecraftString(VALID_HASH)
  });

  assert.equal(mock.calls.length, 1);
  assert.equal(client.writes.length, 1);
  assert.equal(client.writes[0].payload.messageId, 2);
  assert.deepEqual(client.writes[0].payload.data, Buffer.from([0]));
  assert.equal(failures[0].code, 'REQUEST_IN_PROGRESS');

  first.release();
  await waitFor(() => client.writes.length === 2, 'first request completion');
  assert.equal(client.writes[1].payload.messageId, 1);
  assert.deepEqual(client.writes[1].payload.data, Buffer.from([1]));

  client.emit('login_plugin_request', {
    messageId: 3,
    channel: OPEN_AUTH_JOIN_CHANNEL,
    data: encodeMinecraftString(VALID_HASH)
  });
  assert.equal(mock.calls.length, 1);
  assert.equal(client.writes[2].payload.messageId, 3);
  assert.deepEqual(client.writes[2].payload.data, Buffer.from([0]));
  assert.equal(failures[1].code, 'REQUEST_IN_PROGRESS');
  auth.dispose();
});

test('OpenAuthClient aborts Mojang HTTPS at the configured timeout', async () => {
  const { client } = createClient();
  const failures = [];
  const held = { statusCode: 204, hold: true };
  const mock = createHttpsMock([held]);
  let timeoutCallback;
  let timeoutDelay;
  let clearedHandle = null;
  const auth = createOpenAuth({
    client,
    timeoutMs: 1234,
    httpsRequest: mock.httpsRequest,
    onFailure: (failure) => failures.push(failure),
    timers: {
      setTimeout(callback, delay) {
        timeoutCallback = callback;
        timeoutDelay = delay;
        return 19;
      },
      clearTimeout(handle) {
        clearedHandle = handle;
      }
    }
  });
  client.emit('login_plugin_request', {
    messageId: 12,
    channel: OPEN_AUTH_JOIN_CHANNEL,
    data: encodeMinecraftString(VALID_HASH)
  });

  assert.equal(timeoutDelay, 1234);
  timeoutCallback();
  await waitFor(() => client.writes.length === 1, 'Mojang timeout response');
  assert.equal(clearedHandle, 19);
  assert.equal(mock.calls[0].request.destroyed, true);
  assert.deepEqual(client.writes[0].payload.data, Buffer.from([0]));
  assert.deepEqual(failures, [{
    code: 'MOJANG_TIMEOUT',
    retryClass: 'transient',
    sessionInvalid: false
  }]);
  auth.dispose();
});

test('OpenAuthClient aborts pending HTTPS work on disposal without a late write', async () => {
  const { client } = createClient();
  const failures = [];
  const held = { statusCode: 204, hold: true };
  const mock = createHttpsMock([held]);
  const auth = createOpenAuth({
    client,
    httpsRequest: mock.httpsRequest,
    onFailure: (failure) => failures.push(failure)
  });
  client.emit('login_plugin_request', {
    messageId: 77,
    channel: OPEN_AUTH_JOIN_CHANNEL,
    data: encodeMinecraftString(VALID_HASH)
  });
  auth.dispose();
  await waitFor(() => failures.length === 1, 'abort failure callback');

  assert.equal(mock.calls[0].request.destroyed, true);
  assert.deepEqual(failures[0], {
    code: 'REQUEST_ABORTED',
    retryClass: 'none',
    sessionInvalid: false
  });
  held.release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(client.writes, []);
});

test('OpenAuthClient validates the configured request timeout', () => {
  const { client } = createClient();
  assert.throws(
    () => createOpenAuth({ client, timeoutMs: 999 }),
    (error) => error.code === 'INVALID_TIMEOUT'
  );
  assert.throws(
    () => createOpenAuth({ client, timeoutMs: 5001 }),
    (error) => error.code === 'INVALID_TIMEOUT'
  );
});
