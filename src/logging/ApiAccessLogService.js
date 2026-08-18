const fs = require('fs');
const path = require('path');
const { getTimestamp } = require('../util/time');

function normalizeBoolean(value, fallback) {
  if (value === true) return true;
  if (value === false) return false;
  return fallback;
}

function normalizeFilePath(appRoot, configuredPath, fallbackPath) {
  const value = typeof configuredPath === 'string' ? configuredPath.trim() : '';
  if (!value) {
    return path.join(appRoot, fallbackPath);
  }

  if (path.isAbsolute(value)) {
    return value;
  }

  return path.resolve(appRoot, value);
}

function sanitizeHeaderValue(name, value) {
  const lower = String(name || '').toLowerCase();
  if (lower === 'authorization') {
    const raw = typeof value === 'string' ? value.trim() : '';
    if (!raw) return '';

    const [scheme] = raw.split(/\s+/, 1);
    return scheme ? `${scheme} ***` : '***';
  }

  if (lower === 'cookie' || lower === 'set-cookie' || lower === 'x-api-key') {
    return '***';
  }

  return value;
}

function sanitizeHeaders(headers) {
  const output = {};
  const source = headers && typeof headers === 'object' ? headers : {};

  for (const [key, value] of Object.entries(source)) {
    output[key] = sanitizeHeaderValue(key, value);
  }

  return output;
}

const SENSITIVE_BODY_KEYS = /^(authorization|auth|token|access_?token|refresh_?token|api_?key|cookie|password|secret|client_?secret|credential|email|username)$/i;

function sanitizeBodyValue(value, key = '') {
  if (SENSITIVE_BODY_KEYS.test(String(key))) {
    return '***';
  }

  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeBodyValue(entry));
  }

  if (value && typeof value === 'object') {
    const output = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      output[childKey] = sanitizeBodyValue(childValue, childKey);
    }
    return output;
  }

  return value;
}

function createBodyPreview(rawBody, maxLength = 400) {
  const body = typeof rawBody === 'string' ? rawBody : '';
  if (!body) return null;

  try {
    return JSON.stringify(sanitizeBodyValue(JSON.parse(body))).slice(0, maxLength);
  } catch (error) {
    return body.slice(0, maxLength);
  }
}

function getRemoteAddress(req) {
  return req?.socket?.remoteAddress || null;
}

function getRemotePort(req) {
  return req?.socket?.remotePort || null;
}

function summarizeAuthorizationHeader(headerValue, expectedToken) {
  const raw = typeof headerValue === 'string' ? headerValue.trim() : '';
  const hasHeader = raw.length > 0;
  const match = raw.match(/^(\S+)\s+(.*)$/);
  const scheme = match ? match[1] : null;
  const credential = match ? match[2] : '';

  return {
    hasHeader,
    scheme,
    credentialLength: credential ? credential.length : 0,
    valid: Boolean(expectedToken) && raw === `Bearer ${expectedToken}`
  };
}

function createPacketPreview(bufferLike, maxBytes = 120) {
  if (!bufferLike) {
    return null;
  }

  const buffer = Buffer.isBuffer(bufferLike) ? bufferLike : Buffer.from(bufferLike);
  const sliced = buffer.subarray(0, maxBytes);
  const text = sliced.toString('utf8').replace(/[^\x20-\x7E\r\n\t]/g, '.');
  return text;
}

class ApiAccessLogService {
  constructor(options = {}) {
    this.appRoot = options.appRoot || process.cwd();
    this.config = options.config || {};
    this.enabled = normalizeBoolean(this.config.enabled, true);
    this.includeHeaders = normalizeBoolean(this.config.includeHeaders, true);
    this.includeBodyPreview = normalizeBoolean(this.config.includeBodyPreview, false);
    this.logToConsole = normalizeBoolean(this.config.logToConsole, false);
    this.filePath = normalizeFilePath(this.appRoot, this.config.filePath, path.join('logs', 'api-access.log'));
  }

  isEnabled() {
    return this.enabled === true;
  }

  createRequestContext(req, expectedToken) {
    const rawUrl = typeof req?.url === 'string' ? req.url : '/';
    const host = req?.headers?.host || '127.0.0.1';
    let parsedUrl = null;

    try {
      parsedUrl = new URL(rawUrl, `http://${host}`);
    } catch (error) {
      parsedUrl = null;
    }

    return {
      startedAtMs: Date.now(),
      timestamp: getTimestamp(),
      method: req?.method || 'UNKNOWN',
      rawUrl,
      path: parsedUrl ? parsedUrl.pathname : null,
      query: parsedUrl ? parsedUrl.search || '' : null,
      host,
      remoteAddress: getRemoteAddress(req),
      remotePort: getRemotePort(req),
      headers: this.includeHeaders ? sanitizeHeaders(req?.headers) : undefined,
      userAgent: req?.headers?.['user-agent'] || null,
      referer: req?.headers?.referer || req?.headers?.referrer || null,
      auth: summarizeAuthorizationHeader(req?.headers?.authorization, expectedToken),
      route: null,
      outcome: null,
      note: null,
      requestBytes: 0,
      bodyPreview: null,
      parseErrorBodyPreview: null,
      errorMessage: null
    };
  }

  markRoute(context, route) {
    if (context) {
      context.route = route || null;
    }
  }

  markOutcome(context, outcome, note = null) {
    if (context) {
      context.outcome = outcome || null;
      context.note = note || null;
    }
  }

  markRequestBody(context, rawBody) {
    if (!context) {
      return;
    }

    const body = typeof rawBody === 'string' ? rawBody : '';
    context.requestBytes = Buffer.byteLength(body, 'utf8');
    if (body && this.includeBodyPreview) {
      context.bodyPreview = createBodyPreview(body);
    }
  }

  markParseErrorBody(context, rawBody) {
    if (!context) {
      return;
    }

    const body = typeof rawBody === 'string' ? rawBody : '';
    context.requestBytes = Buffer.byteLength(body, 'utf8');
    if (this.includeBodyPreview) {
      context.parseErrorBodyPreview = createBodyPreview(body);
    }
  }

  markError(context, error) {
    if (!context || !error) {
      return;
    }

    context.errorMessage = error && error.message ? error.message : String(error);
  }

  buildRequestEntry(context, res, eventName = 'finish') {
    return {
      type: 'http_request',
      event: eventName,
      timestamp: context?.timestamp || getTimestamp(),
      finishedAt: getTimestamp(),
      durationMs: context ? Math.max(0, Date.now() - context.startedAtMs) : 0,
      method: context?.method || 'UNKNOWN',
      rawUrl: context?.rawUrl || '/',
      path: context?.path || null,
      query: context?.query || null,
      route: context?.route || null,
      outcome: context?.outcome || null,
      note: context?.note || null,
      statusCode: res?.statusCode || 0,
      host: context?.host || null,
      remoteAddress: context?.remoteAddress || null,
      remotePort: context?.remotePort || null,
      userAgent: context?.userAgent || null,
      referer: context?.referer || null,
      requestBytes: context?.requestBytes || 0,
      auth: context?.auth || null,
      headers: context?.headers,
      bodyPreview: context?.bodyPreview || null,
      parseErrorBodyPreview: context?.parseErrorBodyPreview || null,
      errorMessage: context?.errorMessage || null
    };
  }

  buildClientErrorEntry(error, socket) {
    return {
      type: 'http_client_error',
      timestamp: getTimestamp(),
      errorMessage: error && error.message ? error.message : String(error),
      code: error && error.code ? error.code : null,
      bytesParsed: Number.isInteger(error?.bytesParsed) ? error.bytesParsed : null,
      rawPacketPreview: createPacketPreview(error?.rawPacket),
      remoteAddress: socket?.remoteAddress || null,
      remotePort: socket?.remotePort || null
    };
  }

  appendEntry(entry) {
    if (!this.isEnabled()) {
      return;
    }

    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.appendFileSync(this.filePath, `${JSON.stringify(entry)}\n`, 'utf8');

    if (this.logToConsole) {
      console.log(`[MULTIBOT][API][ACCESS] ${JSON.stringify(entry)}`);
    }
  }

  logRequest(context, res, eventName = 'finish') {
    this.appendEntry(this.buildRequestEntry(context, res, eventName));
  }

  logClientError(error, socket) {
    this.appendEntry(this.buildClientErrorEntry(error, socket));
  }
}

module.exports = {
  ApiAccessLogService,
  sanitizeHeaders,
  summarizeAuthorizationHeader,
  createPacketPreview,
  sanitizeBodyValue,
  createBodyPreview
};
