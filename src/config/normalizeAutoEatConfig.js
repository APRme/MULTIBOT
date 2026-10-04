// autoEat 配置归一化: 只来自实例 config.json 与服务器 default.config.json(经既有合并链),
// 不读取 server.json 与 backend 主配置。
const DEFAULT_AUTO_EAT_CONFIG = {
  enabled: false,
  threshold: 19,
  items: [],
  cooldownMs: 3000,
  failureBackoffMs: 30000,
  maxFailures: 3
};

const MAX_ITEM_LIST = 32;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeInteger(value, fallbackValue, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallbackValue;
  const rounded = Math.trunc(numeric);
  if (rounded < min) return min;
  if (rounded > max) return max;
  return rounded;
}

function normalizeItemList(rawItems) {
  if (!Array.isArray(rawItems)) return [];

  const output = [];
  for (const entry of rawItems) {
    if (typeof entry !== 'string') continue;
    const normalized = entry.trim().toLowerCase().replace(/^minecraft:/, '');
    if (!normalized || output.includes(normalized)) continue;
    output.push(normalized);
    if (output.length >= MAX_ITEM_LIST) break;
  }

  return output;
}

function getDefaultAutoEatConfig() {
  return {
    ...DEFAULT_AUTO_EAT_CONFIG,
    items: []
  };
}

// 兼容三种写法: true(用默认参数开启) / false(关闭) / 对象(部分覆盖)
function normalizeAutoEatConfig(rawConfig, defaultConfig = DEFAULT_AUTO_EAT_CONFIG) {
  const defaults = {
    ...DEFAULT_AUTO_EAT_CONFIG,
    ...(isPlainObject(defaultConfig) ? defaultConfig : {})
  };

  if (rawConfig === true) {
    return { ...defaults, enabled: true };
  }

  if (rawConfig === false || rawConfig === undefined || rawConfig === null) {
    return { ...defaults, enabled: false };
  }

  if (!isPlainObject(rawConfig)) {
    return { ...defaults, enabled: false };
  }

  return {
    enabled: rawConfig.enabled === undefined
      ? defaults.enabled === true
      : rawConfig.enabled === true,
    threshold: normalizeInteger(rawConfig.threshold, defaults.threshold, 0, 20),
    items: rawConfig.items === undefined ? normalizeItemList(defaults.items) : normalizeItemList(rawConfig.items),
    cooldownMs: normalizeInteger(rawConfig.cooldownMs, defaults.cooldownMs, 0, 600000),
    failureBackoffMs: normalizeInteger(rawConfig.failureBackoffMs, defaults.failureBackoffMs, 0, 3600000),
    maxFailures: normalizeInteger(rawConfig.maxFailures, defaults.maxFailures, 1, 100)
  };
}

module.exports = {
  DEFAULT_AUTO_EAT_CONFIG,
  getDefaultAutoEatConfig,
  normalizeAutoEatConfig
};
