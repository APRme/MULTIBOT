const { FullPacketParser, types } = require('protodef');

const readVarInt = types && types.varint ? types.varint[0] : null;

const DEFAULT_CONFIG = {
  enabled: true,
  ignoreMalformedNbtArrayPackets: true,
  burstLimit: 20,
  burstWindowMs: 60000,
  logParseErrors: true
};

const STATE_KEY = Symbol('protocolGuardState');
const INSTALLED_KEY = Symbol.for('assn.protocolGuard.installed');

let runtimeConfig = { ...DEFAULT_CONFIG };

function normalizeConfig(config = {}) {
  const normalized = {
    ...DEFAULT_CONFIG,
    ...(config || {})
  };

  if (!Number.isFinite(normalized.burstLimit) || normalized.burstLimit < 1) {
    normalized.burstLimit = DEFAULT_CONFIG.burstLimit;
  } else {
    normalized.burstLimit = Math.floor(normalized.burstLimit);
  }

  if (!Number.isFinite(normalized.burstWindowMs) || normalized.burstWindowMs < 1) {
    normalized.burstWindowMs = DEFAULT_CONFIG.burstWindowMs;
  } else {
    normalized.burstWindowMs = Math.floor(normalized.burstWindowMs);
  }

  normalized.enabled = normalized.enabled !== false;
  normalized.ignoreMalformedNbtArrayPackets = normalized.ignoreMalformedNbtArrayPackets !== false;
  normalized.logParseErrors = normalized.logParseErrors !== false;

  return normalized;
}

function isIgnorableMalformedNbtArrayError(err) {
  if (!err) return false;

  const message = err.message ? String(err.message) : '';
  const stack = err.stack ? String(err.stack) : '';
  const combined = `${message}\n${stack}`.toLowerCase();
  const hasNbtSlotContext = (
    combined.includes('anonymousnbt') ||
    combined.includes('itemwrittenbookpage') ||
    combined.includes('slotcomponent') ||
    combined.includes('slot') ||
    combined.includes('compound')
  );

  if (!hasNbtSlotContext) {
    return false;
  }

  if (combined.includes('array size is abnormally large')) {
    return true;
  }

  if (/invalid tag:\s*\d+\s*>\s*20/.test(combined)) {
    return true;
  }

  if (
    combined.includes('the value of "offset" is out of range') ||
    combined.includes("the value of 'offset' is out of range") ||
    combined.includes('err_out_of_range')
  ) {
    return true;
  }

  return false;
}

function getGuardState(parser) {
  if (!parser[STATE_KEY]) {
    parser[STATE_KEY] = {
      timestamps: []
    };
  }

  return parser[STATE_KEY];
}

function pruneTimestamps(timestamps, now, windowMs) {
  return timestamps.filter((timestamp) => now - timestamp <= windowMs);
}

function readPacketId(chunk) {
  if (!Buffer.isBuffer(chunk) || typeof readVarInt !== 'function') {
    return null;
  }

  try {
    const result = readVarInt(chunk, 0);
    if (!result || !Number.isFinite(result.value)) return null;
    return result.value;
  } catch (error) {
    return null;
  }
}

function buildPacketInfo(err, chunk, ignoredCount, config, reason) {
  return {
    packetId: readPacketId(chunk),
    chunkLength: Buffer.isBuffer(chunk) ? chunk.length : 0,
    ignoredCount,
    burstLimit: config.burstLimit,
    burstWindowMs: config.burstWindowMs,
    reason: reason || 'ignored',
    errorMessage: err && err.message ? String(err.message) : String(err),
    errorName: err && err.name ? String(err.name) : 'Error'
  };
}

function applyProtocolGuardHotfix(config = {}) {
  runtimeConfig = normalizeConfig(config);

  if (FullPacketParser.prototype[INSTALLED_KEY]) {
    return {
      installed: false,
      config: { ...runtimeConfig }
    };
  }

  const originalTransform = FullPacketParser.prototype._transform;

  FullPacketParser.prototype._transform = function protocolGuardTransform(chunk, enc, cb) {
    const configSnapshot = runtimeConfig;
    let packet;

    try {
      packet = this.parsePacketBuffer(chunk);
      if (packet.metadata.size !== chunk.length && !this.noErrorLogging && configSnapshot.logParseErrors) {
        console.log('Chunk size is ' + chunk.length + ' but only ' + packet.metadata.size + ' was read ; partial packet : ' +
          JSON.stringify(packet.data) + '; buffer :' + chunk.toString('hex'));
      }
    } catch (error) {
      // 无论最终吞不吞, 都先按窗口统计一次, 便于上层判断"这片流还可不可信"
      const state = getGuardState(this);
      const now = Date.now();
      state.timestamps = pruneTimestamps(state.timestamps, now, configSnapshot.burstWindowMs);
      const nextCount = state.timestamps.length + 1;

      // 半包: 保持原有"静默丢弃"行为, 但通知上层(它可能是连接卡死的前兆)
      if (error.partialReadError) {
        if (!this.noErrorLogging && configSnapshot.logParseErrors) {
          console.log(error.stack);
        }
        this.emit('packet_parse_error', buildPacketInfo(error, chunk, state.timestamps.length, configSnapshot, 'partial_read'));
        return cb();
      }

      const shouldIgnore = (
        configSnapshot.enabled &&
        configSnapshot.ignoreMalformedNbtArrayPackets &&
        isIgnorableMalformedNbtArrayError(error)
      );

      // 不可归类: 原样抛给上层, 同时通知
      if (!shouldIgnore) {
        this.emit('packet_parse_error', buildPacketInfo(error, chunk, state.timestamps.length, configSnapshot, 'unclassified'));
        return cb(error);
      }

      // 突发超限: 不再吞包, 原样抛给上层, 同时通知(这条路上层最需要布置看门狗)
      if (nextCount > configSnapshot.burstLimit) {
        this.emit('packet_parse_error', buildPacketInfo(error, chunk, state.timestamps.length, configSnapshot, 'burst_limit'));
        return cb(error);
      }

      state.timestamps.push(now);
      this.emit('malformed_packet_ignored', buildPacketInfo(error, chunk, state.timestamps.length, configSnapshot, 'ignored'));
      return cb();
    }

    this.push(packet);
    cb();
  };

  FullPacketParser.prototype[INSTALLED_KEY] = {
    originalTransform
  };

  return {
    installed: true,
    config: { ...runtimeConfig }
  };
}

module.exports = {
  applyProtocolGuardHotfix,
  isIgnorableMalformedNbtArrayError
};
