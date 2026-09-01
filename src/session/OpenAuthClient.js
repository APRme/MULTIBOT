const dns = require('dns');
const https = require('https');
const net = require('net');
const { TextDecoder } = require('util');

const OPEN_AUTH_JOIN_CHANNEL = 'oam:join';
const OPEN_AUTH_DATA_CHANNEL = 'oam:data';
const MOJANG_JOIN_HOST = 'sessionserver.mojang.com';
const MOJANG_JOIN_PATH = '/session/minecraft/join';
const DNS_LOOKUP_TIMEOUT_MS = 3000;
const MAX_MOJANG_RESPONSE_BYTES = 8 * 1024;
const DEFAULT_JOIN_TIMEOUT_MS = 4500;
const MIN_JOIN_TIMEOUT_MS = 1000;
const MAX_JOIN_TIMEOUT_MS = 5000;
const CLIENT_HANDLER_MARKER = Symbol('multibotOpenAuthClient');

const LOOPBACK_ADDRESSES = new net.BlockList();
LOOPBACK_ADDRESSES.addSubnet('127.0.0.0', 8, 'ipv4');
LOOPBACK_ADDRESSES.addAddress('::1', 'ipv6');
LOOPBACK_ADDRESSES.addSubnet('::ffff:127.0.0.0', 104, 'ipv6');

const FAILURE_METADATA = Object.freeze({
  DNS_TIMEOUT: ['transient', false],
  DNS_LOOKUP_FAILED: ['transient', false],
  PROXY_HOST_INVALID: ['configuration', false],
  PROXY_NOT_LOOPBACK: ['configuration', false],
  INVALID_TIMEOUT: ['configuration', false],
  DEFAULT_LOGIN_LISTENER_NOT_FOUND: ['configuration', false],
  CLIENT_ALREADY_ATTACHED: ['configuration', false],
  INVALID_PACKET: ['protocol', false],
  INVALID_HASH: ['protocol', false],
  INVALID_MESSAGE_ID: ['protocol', false],
  SESSION_MISSING: ['reauth', true],
  ACCESS_TOKEN_MISSING: ['reauth', true],
  INVALID_PROFILE: ['reauth', true],
  REQUEST_IN_PROGRESS: ['protocol', false],
  REQUEST_ABORTED: ['none', false],
  RESPONSE_WRITE_FAILED: ['transient', false],
  MOJANG_TIMEOUT: ['transient', false],
  MOJANG_NETWORK_ERROR: ['transient', false],
  MOJANG_SESSION_INVALID: ['reauth', true],
  MOJANG_RATE_LIMITED: ['transient', false],
  MOJANG_UNAVAILABLE: ['transient', false],
  MOJANG_REDIRECT_REJECTED: ['configuration', false],
  MOJANG_RESPONSE_TOO_LARGE: ['transient', false],
  MOJANG_UNEXPECTED_STATUS: ['configuration', false],
  INTERNAL_ERROR: ['transient', false]
});

class OpenAuthError extends Error {
  constructor(code, options = {}) {
    super(code);
    this.name = 'OpenAuthError';
    this.code = code;
    const defaults = FAILURE_METADATA[code] || FAILURE_METADATA.INTERNAL_ERROR;
    this.retryClass = options.retryClass || defaults[0];
    this.sessionInvalid = options.sessionInvalid === undefined
      ? defaults[1]
      : options.sessionInvalid === true;
  }
}

function createOpenAuthError(code, options) {
  return new OpenAuthError(code, options);
}

function normalizeAddress(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.startsWith('[') && text.endsWith(']')) {
    return text.slice(1, -1);
  }
  return text;
}

function normalizeFamily(value, address) {
  if (value === 4 || value === 'IPv4') return 4;
  if (value === 6 || value === 'IPv6') return 6;
  return net.isIP(address);
}

function isLoopbackAddress(address) {
  const normalized = normalizeAddress(address);
  const family = net.isIP(normalized);
  if (family === 4) return LOOPBACK_ADDRESSES.check(normalized, 'ipv4');
  if (family === 6) return LOOPBACK_ADDRESSES.check(normalized, 'ipv6');
  return false;
}

function resolveLocalProxyHost(host, options = {}) {
  const normalizedHost = normalizeAddress(host);
  if (!normalizedHost) {
    return Promise.reject(createOpenAuthError('PROXY_HOST_INVALID'));
  }

  const literalFamily = net.isIP(normalizedHost);
  if (literalFamily) {
    if (!isLoopbackAddress(normalizedHost)) {
      return Promise.reject(createOpenAuthError('PROXY_NOT_LOOPBACK'));
    }
    return Promise.resolve(Object.freeze({
      address: normalizedHost,
      family: literalFamily
    }));
  }

  const lookup = options.lookup || dns.lookup;
  const setTimeoutFn = options.setTimeout || setTimeout;
  const clearTimeoutFn = options.clearTimeout || clearTimeout;

  return new Promise((resolve, reject) => {
    let settled = false;
    let timeoutHandle = null;

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (timeoutHandle !== null) clearTimeoutFn(timeoutHandle);
      if (error) reject(error);
      else resolve(value);
    };

    timeoutHandle = setTimeoutFn(() => {
      finish(createOpenAuthError('DNS_TIMEOUT'));
    }, DNS_LOOKUP_TIMEOUT_MS);
    if (timeoutHandle && typeof timeoutHandle.unref === 'function') {
      timeoutHandle.unref();
    }
    if (settled) return;

    const onLookup = (error, records) => {
      if (error) {
        finish(createOpenAuthError('DNS_LOOKUP_FAILED'));
        return;
      }

      const addresses = Array.isArray(records) ? records : records ? [records] : [];
      if (addresses.length === 0) {
        finish(createOpenAuthError('DNS_LOOKUP_FAILED'));
        return;
      }

      const normalizedRecords = [];
      for (const record of addresses) {
        const address = normalizeAddress(record && record.address);
        const family = normalizeFamily(record && record.family, address);
        if (!family || !isLoopbackAddress(address)) {
          finish(createOpenAuthError('PROXY_NOT_LOOPBACK'));
          return;
        }
        normalizedRecords.push({ address, family });
      }

      const selected = normalizedRecords.find((record) => record.family === 4)
        || normalizedRecords[0];
      finish(null, Object.freeze({ ...selected }));
    };

    try {
      const result = lookup(normalizedHost, { all: true, verbatim: true }, onLookup);
      if (result && typeof result.then === 'function') {
        result.then((records) => onLookup(null, records), onLookup);
      }
    } catch (error) {
      onLookup(error);
    }
  });
}

function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  throw createOpenAuthError('INVALID_PACKET');
}

function encodeVarInt(value) {
  if (!Number.isInteger(value) || value < -0x80000000 || value > 0x7fffffff) {
    throw createOpenAuthError('INVALID_PACKET');
  }

  let unsigned = value < 0 ? value + 0x100000000 : value;
  const bytes = [];
  do {
    let current = unsigned % 128;
    unsigned = Math.floor(unsigned / 128);
    if (unsigned !== 0) current |= 0x80;
    bytes.push(current);
  } while (unsigned !== 0);

  return Buffer.from(bytes);
}

function decodeVarInt(value, offset = 0) {
  const buffer = toBuffer(value);
  if (!Number.isInteger(offset) || offset < 0 || offset > buffer.length) {
    throw createOpenAuthError('INVALID_PACKET');
  }

  let unsigned = 0;
  let bytesRead = 0;
  while (bytesRead < 5) {
    if (offset + bytesRead >= buffer.length) {
      throw createOpenAuthError('INVALID_PACKET');
    }

    const current = buffer[offset + bytesRead];
    const payload = current & 0x7f;
    if (bytesRead === 4 && payload > 0x0f) {
      throw createOpenAuthError('INVALID_PACKET');
    }

    unsigned += payload * (2 ** (7 * bytesRead));
    bytesRead += 1;

    if ((current & 0x80) === 0) {
      const decoded = unsigned >= 0x80000000 ? unsigned - 0x100000000 : unsigned;
      const canonical = encodeVarInt(decoded);
      if (!canonical.equals(buffer.subarray(offset, offset + bytesRead))) {
        throw createOpenAuthError('INVALID_PACKET');
      }
      return {
        value: decoded,
        bytesRead
      };
    }
  }

  throw createOpenAuthError('INVALID_PACKET');
}

function normalizeStringLimits(options = {}) {
  const maxChars = options.maxChars === undefined ? 32767 : options.maxChars;
  const maxBytes = options.maxBytes === undefined ? maxChars * 4 : options.maxBytes;
  if (!Number.isInteger(maxChars) || maxChars < 0 || !Number.isInteger(maxBytes) || maxBytes < 0) {
    throw createOpenAuthError('INVALID_PACKET');
  }
  return { maxChars, maxBytes };
}

function encodeMinecraftString(value, options = {}) {
  if (typeof value !== 'string') throw createOpenAuthError('INVALID_PACKET');
  if (typeof value.isWellFormed === 'function' && !value.isWellFormed()) {
    throw createOpenAuthError('INVALID_PACKET');
  }

  const { maxChars, maxBytes } = normalizeStringLimits(options);
  const encoded = Buffer.from(value, 'utf8');
  if (value.length > maxChars || encoded.length > maxBytes) {
    throw createOpenAuthError('INVALID_PACKET');
  }

  return Buffer.concat([encodeVarInt(encoded.length), encoded]);
}

function decodeMinecraftString(value, offset = 0, options = {}) {
  const buffer = toBuffer(value);
  const { maxChars, maxBytes } = normalizeStringLimits(options);
  const length = decodeVarInt(buffer, offset);
  if (length.value < 0 || length.value > maxBytes) {
    throw createOpenAuthError('INVALID_PACKET');
  }

  const stringOffset = offset + length.bytesRead;
  const endOffset = stringOffset + length.value;
  if (endOffset > buffer.length) {
    throw createOpenAuthError('INVALID_PACKET');
  }

  let decoded;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(stringOffset, endOffset));
  } catch (error) {
    throw createOpenAuthError('INVALID_PACKET');
  }

  if (decoded.length > maxChars) {
    throw createOpenAuthError('INVALID_PACKET');
  }

  const bytesRead = length.bytesRead + length.value;
  if (options.requireFull === true && offset + bytesRead !== buffer.length) {
    throw createOpenAuthError('INVALID_PACKET');
  }

  return {
    value: decoded,
    bytesRead
  };
}

function normalizeJoinTimeout(value) {
  const timeoutMs = value === undefined ? DEFAULT_JOIN_TIMEOUT_MS : Number(value);
  if (!Number.isInteger(timeoutMs) || timeoutMs < MIN_JOIN_TIMEOUT_MS || timeoutMs > MAX_JOIN_TIMEOUT_MS) {
    throw createOpenAuthError('INVALID_TIMEOUT');
  }
  return timeoutMs;
}

function isDefaultLoginPluginListener(listener) {
  if (typeof listener !== 'function') return false;
  const original = typeof listener.listener === 'function' ? listener.listener : listener;
  let source = '';
  try {
    source = Function.prototype.toString.call(original);
  } catch (error) {
    return false;
  }
  return original.name === 'onLoginPluginRequest'
    && source.includes('login_plugin_response')
    && source.includes('messageId');
}

function createFailureDetails(error) {
  const normalized = error instanceof OpenAuthError
    ? error
    : createOpenAuthError('INTERNAL_ERROR');
  return Object.freeze({
    code: normalized.code,
    retryClass: normalized.retryClass,
    sessionInvalid: normalized.sessionInvalid
  });
}

class OpenAuthClient {
  constructor(options = {}) {
    const config = options.config && typeof options.config === 'object' ? options.config : {};
    this.timeoutMs = normalizeJoinTimeout(config.timeoutMs);
    this.logger = options.logger || null;
    this.onRequest = typeof options.onRequest === 'function' ? options.onRequest : null;
    this.onFailure = typeof options.onFailure === 'function' ? options.onFailure : null;
    this.onSuccess = typeof options.onSuccess === 'function' ? options.onSuccess : null;
    this.httpsRequest = options.httpsRequest || https.request;
    this.setTimeout = options.setTimeout || setTimeout;
    this.clearTimeout = options.clearTimeout || clearTimeout;
    this.client = null;
    this.defaultLoginListener = null;
    this.pendingRequest = null;
    this.joinAttempted = false;
    this.loginHandler = (packet) => this.handleLoginPluginRequest(packet);
    this.playHandler = (packet) => this.handlePlayCustomPayload(packet);
    this.endHandler = () => this.detach({ restoreDefault: false });

    this.loginHandler[CLIENT_HANDLER_MARKER] = true;
    if (options.client) this.attach(options.client);
  }

  attach(client) {
    if (!client || typeof client.on !== 'function' || typeof client.write !== 'function') {
      throw createOpenAuthError('CLIENT_ALREADY_ATTACHED');
    }
    if (this.client === client) return this;
    if (this.client || client[CLIENT_HANDLER_MARKER]) {
      throw createOpenAuthError('CLIENT_ALREADY_ATTACHED');
    }

    const listeners = typeof client.listeners === 'function'
      ? client.listeners('login_plugin_request')
      : [];
    const defaultListeners = listeners.filter(isDefaultLoginPluginListener);
    if (defaultListeners.length !== 1 || typeof client.removeListener !== 'function') {
      throw createOpenAuthError('DEFAULT_LOGIN_LISTENER_NOT_FOUND');
    }
    const defaultListener = defaultListeners[0];

    client.removeListener('login_plugin_request', defaultListener);
    try {
      client.on('login_plugin_request', this.loginHandler);
      if (typeof client.prependListener === 'function') {
        client.prependListener('custom_payload', this.playHandler);
      } else {
        client.on('custom_payload', this.playHandler);
      }
      if (typeof client.once === 'function') client.once('end', this.endHandler);
      client[CLIENT_HANDLER_MARKER] = this;
      this.defaultLoginListener = defaultListener;
      this.client = client;
      this.joinAttempted = false;
      return this;
    } catch (error) {
      if (typeof client.removeListener === 'function') {
        client.removeListener('login_plugin_request', this.loginHandler);
        client.removeListener('custom_payload', this.playHandler);
        client.removeListener('end', this.endHandler);
      }
      client.on('login_plugin_request', defaultListener);
      throw createOpenAuthError('CLIENT_ALREADY_ATTACHED');
    }
  }

  detach(options = {}) {
    const client = this.client;
    if (!client) return;

    this.abortPending();
    if (typeof client.removeListener === 'function') {
      client.removeListener('login_plugin_request', this.loginHandler);
      client.removeListener('custom_payload', this.playHandler);
      client.removeListener('end', this.endHandler);
    }
    if (options.restoreDefault !== false && this.defaultLoginListener && client.ended !== true) {
      client.on('login_plugin_request', this.defaultLoginListener);
    }
    if (client[CLIENT_HANDLER_MARKER] === this) delete client[CLIENT_HANDLER_MARKER];

    this.client = null;
    this.defaultLoginListener = null;
    this.joinAttempted = false;
  }

  dispose() {
    this.detach({ restoreDefault: false });
  }

  abortPending() {
    if (this.pendingRequest && this.pendingRequest.controller) {
      this.pendingRequest.controller.abort();
    }
  }

  handleLoginPluginRequest(packet) {
    const client = this.client;
    if (!client) return;

    if (!packet || packet.channel !== OPEN_AUTH_JOIN_CHANNEL) {
      this.writePacket('login_plugin_response', {
        messageId: packet && packet.messageId
      }, false);
      return;
    }

    const messageId = packet.messageId;
    const context = {
      client,
      type: 'login',
      id: messageId,
      sent: false
    };
    if (!Number.isInteger(messageId) || messageId < 0 || messageId > 0x7fffffff) {
      this.failContext(context, createOpenAuthError('INVALID_MESSAGE_ID'));
      return;
    }
    if (!this.claimJoinRequest(context)) return;

    let serverIdHash;
    try {
      serverIdHash = decodeMinecraftString(packet.data, 0, {
        maxChars: 64,
        maxBytes: 256,
        requireFull: true
      }).value;
    } catch (error) {
      this.failContext(context, createOpenAuthError('INVALID_PACKET'));
      return;
    }

    this.startJoin(context, serverIdHash);
  }

  handlePlayCustomPayload(packet) {
    const client = this.client;
    if (!client || !packet || packet.channel !== OPEN_AUTH_JOIN_CHANNEL) return;

    let requestId;
    let idLength;
    try {
      const decodedId = decodeVarInt(packet.data, 0);
      requestId = decodedId.value;
      idLength = decodedId.bytesRead;
      if (requestId < 0) throw createOpenAuthError('INVALID_MESSAGE_ID');
    } catch (error) {
      this.notifyFailure(createOpenAuthError('INVALID_MESSAGE_ID'));
      return;
    }

    const context = {
      client,
      type: 'play',
      id: requestId,
      sent: false
    };
    if (!this.claimJoinRequest(context)) return;
    let serverIdHash;
    try {
      serverIdHash = decodeMinecraftString(packet.data, idLength, {
        maxChars: 64,
        maxBytes: 256,
        requireFull: true
      }).value;
    } catch (error) {
      this.failContext(context, createOpenAuthError('INVALID_PACKET'));
      return;
    }

    this.startJoin(context, serverIdHash);
  }

  claimJoinRequest(context) {
    if (this.joinAttempted) {
      this.failContext(context, createOpenAuthError('REQUEST_IN_PROGRESS'));
      return false;
    }
    this.joinAttempted = true;
    return true;
  }

  startJoin(context, serverIdHash) {
    let credentials;
    try {
      credentials = this.validateRequest(context.client, serverIdHash);
    } catch (error) {
      this.failContext(context, error);
      return;
    }

    if (this.pendingRequest) {
      this.failContext(context, createOpenAuthError('REQUEST_IN_PROGRESS'));
      return;
    }

    this.callHook(this.onRequest);
    const controller = new AbortController();
    const pending = { controller, context };
    this.pendingRequest = pending;

    void this.requestMojangJoin(credentials, controller.signal)
      .then(() => {
        if (this.pendingRequest !== pending) return;
        if (!this.writeContextResponse(context, true)) return;
        this.log('info', '[AUTH][OpenAuth] join success');
        this.callHook(this.onSuccess);
      })
      .catch((error) => {
        if (this.pendingRequest !== pending) return;
        this.failContext(context, error);
      })
      .finally(() => {
        if (this.pendingRequest === pending) this.pendingRequest = null;
      });
  }

  validateRequest(client, serverIdHash) {
    if (!isLoopbackAddress(client && client.socket && client.socket.remoteAddress)) {
      throw createOpenAuthError('PROXY_NOT_LOOPBACK');
    }
    if (typeof serverIdHash !== 'string' || !/^-?[0-9a-f]{1,40}$/.test(serverIdHash)) {
      throw createOpenAuthError('INVALID_HASH');
    }

    const session = client && client.session;
    if (!session || typeof session !== 'object') {
      throw createOpenAuthError('SESSION_MISSING');
    }
    if (typeof session.accessToken !== 'string' || !session.accessToken.trim()) {
      throw createOpenAuthError('ACCESS_TOKEN_MISSING');
    }

    const profileId = session.selectedProfile && session.selectedProfile.id;
    if (typeof profileId !== 'string' || !/^[0-9a-f]{32}$/i.test(profileId)) {
      throw createOpenAuthError('INVALID_PROFILE');
    }

    return {
      accessToken: session.accessToken,
      selectedProfile: profileId,
      serverId: serverIdHash
    };
  }

  requestMojangJoin(credentials, signal) {
    const body = Buffer.from(JSON.stringify(credentials), 'utf8');

    return new Promise((resolve, reject) => {
      let settled = false;
      let request = null;
      let response = null;
      let responseBytes = 0;
      let timeoutHandle = null;

      const cleanup = () => {
        if (timeoutHandle !== null) this.clearTimeout(timeoutHandle);
        if (signal) signal.removeEventListener('abort', onAbort);
      };
      const finish = (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve();
      };
      const destroyRequest = () => {
        if (response && typeof response.destroy === 'function') response.destroy();
        if (request && typeof request.destroy === 'function') request.destroy();
      };
      const onAbort = () => {
        finish(createOpenAuthError('REQUEST_ABORTED'));
        destroyRequest();
      };
      const onTimeout = () => {
        finish(createOpenAuthError('MOJANG_TIMEOUT'));
        destroyRequest();
      };
      const onRequestError = () => {
        finish(createOpenAuthError('MOJANG_NETWORK_ERROR'));
      };
      const onResponse = (incoming) => {
        response = incoming;
        incoming.on('data', (chunk) => {
          if (settled) return;
          responseBytes += Buffer.byteLength(chunk);
          if (responseBytes > MAX_MOJANG_RESPONSE_BYTES) {
            finish(createOpenAuthError('MOJANG_RESPONSE_TOO_LARGE'));
            destroyRequest();
          }
        });
        incoming.once('aborted', () => finish(createOpenAuthError('MOJANG_NETWORK_ERROR')));
        incoming.once('error', () => finish(createOpenAuthError('MOJANG_NETWORK_ERROR')));
        incoming.once('end', () => {
          if (settled) return;
          const statusCode = Number(incoming.statusCode);
          if (statusCode === 204) {
            finish();
          } else if (statusCode === 401 || statusCode === 403) {
            finish(createOpenAuthError('MOJANG_SESSION_INVALID'));
          } else if (statusCode === 429) {
            finish(createOpenAuthError('MOJANG_RATE_LIMITED'));
          } else if (statusCode >= 500 && statusCode <= 599) {
            finish(createOpenAuthError('MOJANG_UNAVAILABLE'));
          } else if (statusCode >= 300 && statusCode <= 399) {
            finish(createOpenAuthError('MOJANG_REDIRECT_REJECTED'));
          } else {
            finish(createOpenAuthError('MOJANG_UNEXPECTED_STATUS'));
          }
        });
      };

      if (signal && signal.aborted) {
        finish(createOpenAuthError('REQUEST_ABORTED'));
        return;
      }
      if (signal) signal.addEventListener('abort', onAbort, { once: true });

      timeoutHandle = this.setTimeout(onTimeout, this.timeoutMs);
      if (timeoutHandle && typeof timeoutHandle.unref === 'function') timeoutHandle.unref();
      if (settled) return;

      try {
        request = this.httpsRequest({
          protocol: 'https:',
          hostname: MOJANG_JOIN_HOST,
          port: 443,
          method: 'POST',
          path: MOJANG_JOIN_PATH,
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'Content-Length': body.length
          }
        }, onResponse);
        request.once('error', onRequestError);
        request.end(body);
      } catch (error) {
        finish(createOpenAuthError('MOJANG_NETWORK_ERROR'));
        destroyRequest();
      }
    });
  }

  failContext(context, error) {
    const normalized = error instanceof OpenAuthError
      ? error
      : createOpenAuthError('INTERNAL_ERROR');
    if (this.writeContextResponse(context, false) || normalized.code === 'REQUEST_ABORTED') {
      this.notifyFailure(normalized);
    }
  }

  notifyFailure(error) {
    const details = createFailureDetails(error);
    this.log('warn', `[AUTH][OpenAuth] join failed code=${details.code}`);
    this.callHook(this.onFailure, details);
    return details;
  }

  callHook(hook, value) {
    if (!hook) return;
    try {
      const result = hook(value);
      if (result && typeof result.catch === 'function') {
        result.catch(() => this.log('warn', '[AUTH][OpenAuth] callback failed'));
      }
    } catch (error) {
      this.log('warn', '[AUTH][OpenAuth] callback failed');
    }
  }

  log(level, message) {
    const method = this.logger && this.logger[level];
    if (typeof method !== 'function') return;
    try {
      method.call(this.logger, message);
    } catch (error) {
    }
  }

  writeContextResponse(context, accepted) {
    if (!context || context.sent) return false;
    context.sent = true;
    if (!this.client || context.client !== this.client || context.client.ended === true) return false;

    if (context.type === 'login') {
      return this.writePacket('login_plugin_response', {
        messageId: context.id,
        data: Buffer.from([accepted ? 1 : 0])
      }, true);
    }

    return this.writePacket('custom_payload', {
      channel: OPEN_AUTH_DATA_CHANNEL,
      data: Buffer.concat([encodeVarInt(context.id), Buffer.from([accepted ? 1 : 0])])
    }, true);
  }

  writePacket(name, payload, reportFailure) {
    try {
      this.client.write(name, payload);
      return true;
    } catch (error) {
      if (reportFailure) this.notifyFailure(createOpenAuthError('RESPONSE_WRITE_FAILED'));
      return false;
    }
  }
}

module.exports = {
  OpenAuthClient,
  OpenAuthError,
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
};
