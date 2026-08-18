const fs = require('fs');

// 仓库规则表:WareHouse/<serverDir>/<warehouseId>/rules.json
// {
//   "movement": { "lockY": { "enabled": true, "value": 74 } },
//   "idle": { "enabled": true, "position": { "x": 80, "y": 74, "z": 180 } },
//   "automation": {
//     "pickupSort": { "enabled": true, "delaySeconds": 10 },
//     "scheduled": { "enabled": true, "intervalSeconds": 1800, "action": "sortThenAudit" }
//   },
//   "inbox": [ { "x": 90, "y": 64, "z": 190 } ],
//   "dropZone": { "min": { "x": 85, "y": 63, "z": 185 }, "max": { "x": 95, "y": 65, "z": 195 } },
//   "containers": [
//     { "name": "矿石箱", "x": 100, "y": 64, "z": 200, "allow": ["minecraft:iron_ingot"] },
//     { "name": "杂项箱", "x": 102, "y": 64, "z": 200, "default": true }
//   ],
//   "pickup": { "x": 80, "y": 64, "z": 180 }
// }
// 匹配顺序:精确物品名(allow) → default 箱兜底。

function normalizeItemName(name) {
  const raw = String(name || '').trim().toLowerCase();
  if (!raw) {
    return null;
  }
  return raw.startsWith('minecraft:') ? raw : `minecraft:${raw}`;
}

function stripNamespace(name) {
  return String(name || '').replace(/^minecraft:/, '');
}

function isInteger(value) {
  return Number.isInteger(value);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNonNegativeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isValidPosition(pos) {
  return Boolean(pos) && isInteger(pos.x) && isInteger(pos.y) && isInteger(pos.z);
}

// 解析并校验规则。raw 可以是 JSON 字符串或已解析对象。
// 返回 { ok, rules, errors }。
function parseRules(raw) {
  let input = raw;
  if (typeof raw === 'string') {
    try {
      input = JSON.parse(raw);
    } catch (error) {
      return { ok: false, rules: null, errors: [`rules.json 不是合法 JSON: ${error.message}`] };
    }
  }

  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, rules: null, errors: ['rules 必须是 JSON 对象'] };
  }

  const errors = [];
  const positionKey = (pos) => `${pos.x},${pos.y},${pos.z}`;

  // ---------- 仓库运行设置 ----------
  const movementInput = input.movement === undefined ? {} : input.movement;
  const movement = {
    lockY: { enabled: false, value: 74 }
  };
  if (!isPlainObject(movementInput)) {
    errors.push('movement 必须是对象');
  } else if (movementInput.lockY !== undefined) {
    if (!isPlainObject(movementInput.lockY)) {
      errors.push('movement.lockY 必须是对象');
    } else {
      const lockY = movementInput.lockY;
      if (lockY.enabled !== undefined && typeof lockY.enabled !== 'boolean') {
        errors.push('movement.lockY.enabled 必须是布尔值');
      } else if (lockY.enabled !== undefined) {
        movement.lockY.enabled = lockY.enabled;
      }
      if (lockY.value !== undefined && !isInteger(lockY.value)) {
        errors.push('movement.lockY.value 必须是整数');
      } else if (lockY.value !== undefined) {
        movement.lockY.value = lockY.value;
      }
    }
  }

  const idleInput = input.idle === undefined ? {} : input.idle;
  const idle = { enabled: false, position: null };
  if (!isPlainObject(idleInput)) {
    errors.push('idle 必须是对象');
  } else {
    if (idleInput.enabled !== undefined && typeof idleInput.enabled !== 'boolean') {
      errors.push('idle.enabled 必须是布尔值');
    } else if (idleInput.enabled !== undefined) {
      idle.enabled = idleInput.enabled;
    }
    if (idleInput.position !== undefined) {
      if (!isValidPosition(idleInput.position)) {
        errors.push('idle.position 需要有效坐标 x/y/z(须为整数)');
      } else {
        idle.position = {
          x: idleInput.position.x,
          y: idleInput.position.y,
          z: idleInput.position.z
        };
      }
    }
    if (idle.enabled && !idle.position) {
      errors.push('idle.enabled=true 时必须配置 idle.position');
    }
    if (
      idle.enabled
      && idle.position
      && movement.lockY.enabled
      && idle.position.y !== movement.lockY.value
    ) {
      errors.push(`idle.position.y 必须等于锁定高度 y=${movement.lockY.value}`);
    }
  }

  const automationInput = input.automation === undefined ? {} : input.automation;
  const automation = {
    pickupSort: { enabled: false, delaySeconds: 10 },
    scheduled: { enabled: false, intervalSeconds: 1800, action: 'sortThenAudit' }
  };
  if (!isPlainObject(automationInput)) {
    errors.push('automation 必须是对象');
  } else {
    const pickupSort = automationInput.pickupSort === undefined ? {} : automationInput.pickupSort;
    if (!isPlainObject(pickupSort)) {
      errors.push('automation.pickupSort 必须是对象');
    } else {
      if (pickupSort.enabled !== undefined && typeof pickupSort.enabled !== 'boolean') {
        errors.push('automation.pickupSort.enabled 必须是布尔值');
      } else if (pickupSort.enabled !== undefined) {
        automation.pickupSort.enabled = pickupSort.enabled;
      }
      if (pickupSort.delaySeconds !== undefined && !isNonNegativeNumber(pickupSort.delaySeconds)) {
        errors.push('automation.pickupSort.delaySeconds 必须是非负数');
      } else if (pickupSort.delaySeconds !== undefined) {
        automation.pickupSort.delaySeconds = pickupSort.delaySeconds;
      }
    }

    const scheduled = automationInput.scheduled === undefined ? {} : automationInput.scheduled;
    if (!isPlainObject(scheduled)) {
      errors.push('automation.scheduled 必须是对象');
    } else {
      if (scheduled.enabled !== undefined && typeof scheduled.enabled !== 'boolean') {
        errors.push('automation.scheduled.enabled 必须是布尔值');
      } else if (scheduled.enabled !== undefined) {
        automation.scheduled.enabled = scheduled.enabled;
      }
      if (scheduled.intervalSeconds !== undefined && !isNonNegativeNumber(scheduled.intervalSeconds)) {
        errors.push('automation.scheduled.intervalSeconds 必须是非负数');
      } else if (scheduled.intervalSeconds !== undefined) {
        automation.scheduled.intervalSeconds = Math.max(1, scheduled.intervalSeconds);
      }
      const allowedActions = ['sort', 'audit', 'sortThenAudit'];
      if (scheduled.action !== undefined && !allowedActions.includes(scheduled.action)) {
        errors.push(`automation.scheduled.action 必须是 ${allowedActions.join('、')} 之一`);
      } else if (scheduled.action !== undefined) {
        automation.scheduled.action = scheduled.action;
      }
    }
  }

  // ---------- containers ----------
  const containers = [];
  if (!Array.isArray(input.containers) || input.containers.length === 0) {
    errors.push('containers 必须是非空数组');
  } else {
    const seen = new Set();
    let defaultCount = 0;
    input.containers.forEach((entry, index) => {
      const label = `containers[${index}]`;
      const problems = [];
      if (!isValidPosition(entry)) {
        problems.push('缺少有效坐标 x/y/z(须为整数)');
      }
      if (typeof entry.name !== 'string' || entry.name.trim() === '') {
        problems.push('name 必须是非空字符串');
      }
      if (entry.allow !== undefined && !Array.isArray(entry.allow)) {
        problems.push('allow 必须是数组');
      }
      if (entry.default !== undefined && typeof entry.default !== 'boolean') {
        problems.push('default 必须是布尔值');
      }
      if (problems.length > 0) {
        errors.push(`${label}: ${problems.join('; ')}`);
        return;
      }

      const key = positionKey(entry);
      if (seen.has(key)) {
        errors.push(`${label}: 坐标重复 ${key}`);
        return;
      }
      seen.add(key);

      if (entry.default === true) {
        defaultCount += 1;
      }

      containers.push({
        name: entry.name.trim(),
        x: entry.x,
        y: entry.y,
        z: entry.z,
        allow: Array.isArray(entry.allow)
          ? entry.allow.map(normalizeItemName).filter(Boolean)
          : [],
        default: entry.default === true
      });
    });
    if (defaultCount > 1) {
      errors.push('最多只能有一个 default(杂项)箱子');
    }
  }

  // ---------- inbox ----------
  const inbox = [];
  if (input.inbox !== undefined) {
    if (!Array.isArray(input.inbox)) {
      errors.push('inbox 必须是数组');
    } else {
      input.inbox.forEach((entry, index) => {
        if (!isValidPosition(entry)) {
          errors.push(`inbox[${index}]: 缺少有效坐标 x/y/z(须为整数)`);
          return;
        }
        inbox.push({ x: entry.x, y: entry.y, z: entry.z });
      });
    }
  }

  // ---------- dropZone ----------
  let dropZone = null;
  if (input.dropZone !== undefined) {
    if (!input.dropZone || !isValidPosition(input.dropZone.min) || !isValidPosition(input.dropZone.max)) {
      errors.push('dropZone 需要 min/max 各三个整数坐标');
    } else {
      dropZone = {
        min: { x: input.dropZone.min.x, y: input.dropZone.min.y, z: input.dropZone.min.z },
        max: { x: input.dropZone.max.x, y: input.dropZone.max.y, z: input.dropZone.max.z }
      };
    }
  }

  // ---------- pickup ----------
  let pickup = null;
  if (input.pickup !== undefined) {
    if (!isValidPosition(input.pickup)) {
      errors.push('pickup 需要有效坐标 x/y/z(须为整数)');
    } else {
      pickup = { x: input.pickup.x, y: input.pickup.y, z: input.pickup.z };
    }
  }

  // ---------- 坐标冲突 ----------
  const containerKeys = new Set(containers.map(positionKey));
  for (const entry of inbox) {
    if (containerKeys.has(positionKey(entry))) {
      errors.push(`inbox 坐标与容器重复: ${positionKey(entry)}`);
    }
  }
  if (pickup && containerKeys.has(positionKey(pickup))) {
    errors.push(`pickup 坐标与容器重复: ${positionKey(pickup)}`);
  }

  if (errors.length > 0) {
    return { ok: false, rules: null, errors };
  }

  return {
    ok: true,
    rules: { movement, idle, automation, inbox, dropZone, containers, pickup },
    errors: []
  };
}

// 从文件加载并解析。文件不存在/读取失败返回错误结果。
function loadRulesFile(filePath) {
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    return { ok: false, rules: null, errors: [`读取规则文件失败: ${error.message}`] };
  }
  return parseRules(content);
}

// 按物品名匹配目标容器。返回 { container } 或 null(无匹配且无 default 箱)。
function matchContainer(rules, itemName) {
  const name = normalizeItemName(itemName);
  if (!rules || !name) {
    return null;
  }
  const exact = rules.containers.find((entry) => entry.allow.includes(name));
  if (exact) {
    return { container: exact };
  }
  const fallback = rules.containers.find((entry) => entry.default);
  if (fallback) {
    return { container: fallback };
  }
  return null;
}

module.exports = {
  normalizeItemName,
  stripNamespace,
  parseRules,
  loadRulesFile,
  matchContainer
};
