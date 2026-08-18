const crypto = require('crypto');

function canonicalize(value) {
  if (value === null || value === undefined) {
    return value === undefined ? null : value;
  }
  if (Buffer.isBuffer(value)) {
    return { __buffer: value.toString('base64') };
  }
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalize(entry));
  }
  if (value instanceof Map) {
    return [...value.entries()]
      .map(([key, entry]) => [String(key), canonicalize(entry)])
      .sort(([left], [right]) => left.localeCompare(right));
  }
  if (typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((result, key) => {
        result[key] = canonicalize(value[key]);
        return result;
      }, {});
  }
  return value;
}

function getItemIdentity(item) {
  if (!item) {
    return null;
  }

  return JSON.stringify(canonicalize({
    type: item.type,
    metadata: item.metadata == null ? 0 : item.metadata,
    nbt: item.nbt || null,
    components: item.components || [],
    removedComponents: item.removedComponents || []
  }));
}

function sameItemIdentity(left, right) {
  return Boolean(left && right) && getItemIdentity(left) === getItemIdentity(right);
}

function getItemStackSize(item) {
  if (Number.isInteger(item && item.stackSize) && item.stackSize > 0) {
    return item.stackSize;
  }
  if (Number.isInteger(item && item.maxStackSize) && item.maxStackSize > 0) {
    return item.maxStackSize;
  }
  return 64;
}

function getItemIdentityHash(item) {
  const identity = getItemIdentity(item);
  return identity === null
    ? null
    : crypto.createHash('sha256').update(identity).digest('hex');
}

module.exports = {
  canonicalize,
  getItemIdentity,
  getItemIdentityHash,
  getItemStackSize,
  sameItemIdentity
};
