// 仓库测试共享的 mock 世界:可变的容器窗口 + 共享背包 + 真实 buildWindowSnapshot。
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { WarehouseFeature } = require('../../src/warehouse/WarehouseFeature');
const { closeAllStores } = require('../../src/warehouse/StoreRegistry');
const { buildWindowSnapshot } = require('../../src/features/window/WindowSnapshot');
const { getItemStackSize, sameItemIdentity } = require('../../src/features/window/itemIdentity');

const DEFAULT_RULES = {
  inbox: [{ x: 0, y: 64, z: 0 }],
  containers: [
    { name: '矿石箱', x: 10, y: 64, z: 0, allow: ['minecraft:iron_ingot'] },
    { name: '杂项箱', x: 20, y: 64, z: 0, default: true }
  ]
};

function norm(name) {
  const raw = String(name).toLowerCase();
  return raw.startsWith('minecraft:') ? raw : `minecraft:${raw}`;
}

function item(name, count, slot, extra = {}) {
  return {
    slot,
    name: norm(name),
    displayName: name,
    count,
    metadata: 0,
    durabilityUsed: null,
    maxDurability: null,
    maxStackSize: 64,
    type: norm(name),
    ...extra
  };
}

function makeChest(bot, inventoryStart, contents) {
  const slots = new Array(inventoryStart).fill(null);
  for (const entry of contents) {
    slots[entry.slot] = entry;
  }
  for (let index = 0; index < 36; index += 1) {
    slots.push(bot.inventory.slots[index]);
  }
  return {
    id: 1,
    type: 'minecraft:generic_9x3',
    name: 'chest',
    inventoryStart,
    inventoryEnd: inventoryStart + 36,
    slots
  };
}

function createContext() {
  const messages = [];
  return {
    messages,
    sender: 'player-a',
    replyInfo(message) {
      messages.push(['info', message]);
    },
    replyError(message) {
      messages.push(['error', message]);
    }
  };
}

function chestContents(container) {
  const out = [];
  for (let index = 0; index < container.inventoryStart; index += 1) {
    if (container.slots[index]) {
      out.push({ slot: index, name: container.slots[index].name, count: container.slots[index].count });
    }
  }
  return out;
}

function backpackContents(bot) {
  const out = [];
  for (let index = 0; index < bot.inventory.slots.length; index += 1) {
    const entry = bot.inventory.slots[index];
    if (entry) {
      out.push({ invIndex: index, name: entry.name, count: entry.count });
    }
  }
  return out;
}

// 从回复消息中解析任务 id,如 "分拣任务 #5 已入队"。
function getTaskIdFromReplies(messages) {
  for (const [, text] of messages) {
    const match = /#(\d+)/.exec(text);
    if (match) {
      return Number.parseInt(match[1], 10);
    }
  }
  return null;
}

// 轮询任务进入终态(done/failed/cancelled)。
async function waitForTaskDone(feature, taskId, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const task = feature.store.getTask(taskId);
    if (task && !['queued', 'running'].includes(task.status)) {
      return task;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`任务 #${taskId} 未在 ${timeoutMs}ms 内完成`);
}

function createWorld(options = {}) {
  const tmpRoot = options.tmpRoot || path.resolve(__dirname, '..', '.tmp', 'world');
  fs.mkdirSync(tmpRoot, { recursive: true });
  const serverDir = fs.mkdtempSync(path.join(tmpRoot, 'wh-'));
  const rules = options.rules || DEFAULT_RULES;
  fs.mkdirSync(path.join(serverDir, 'warehouse'), { recursive: true });
  fs.writeFileSync(path.join(serverDir, 'warehouse', 'rules.json'), JSON.stringify(rules), 'utf8');

  const bot = new EventEmitter();
  bot.inventory = { slots: new Array(36).fill(null), hotbarStart: 36, id: 0, type: 'minecraft:inventory' };
  bot.currentWindow = null;
  bot.players = {};

  const calls = [];
  const events = [];
  const containers = new Map();
  const register = (pos, contents) => {
    const win = makeChest(bot, 27, contents);
    containers.set(`${pos.x},${pos.y},${pos.z}`, win);
    return win;
  };

  for (const entry of rules.containers) {
    register(entry, (options.containers && options.containers[entry.name]) || []);
  }
  for (const pos of rules.inbox || []) {
    register(pos, options.inboxContents || []);
  }
  if (rules.pickup) {
    register(rules.pickup, options.pickupContents || []);
  }

  const feature = new WarehouseFeature({
    config: { enabled: true },
    paths: { serverDir },
    eventStream: {
      publish(event, data) {
        events.push({ event, data });
      }
    },
    botId: 'test-bot'
  });
  feature.movementFeature = {
    goto(x, y, z) {
      calls.push(['goto', x, y, z]);
    },
    async awaitGoalReached() {
      calls.push(['arrive']);
    }
  };
  feature.blockUseFeature = {
    async openBlock(x, y, z) {
      const win = containers.get(`${x},${y},${z}`);
      if (!win) {
        throw new Error(`在坐标 (${x}, ${y}, ${z}) 找不到方块`);
      }
      // Mineflayer creates a fresh window view on every open; refresh the
      // shared mock's player-inventory range so repeated batches see current slots.
      for (let index = 0; index < 36; index += 1) {
        win.slots[win.inventoryStart + index] = bot.inventory.slots[index] || null;
      }
      calls.push(['open', x, y, z]);
      bot.currentWindow = win;
      setImmediate(() => bot.emit('windowOpen', win));
    }
  };
  feature.windowFeature = {
    getCurrentSnapshot() {
      return buildWindowSnapshot(bot.currentWindow);
    },
    async moveSlotItem(fromSlot, toSlot, count) {
      const window = bot.currentWindow;
      const invStart = window.inventoryStart;
      const getSlot = (index) => (index >= invStart ? bot.inventory.slots[index - invStart] : window.slots[index]);
      const setSlot = (index, value) => {
        window.slots[index] = value;
        if (index >= invStart) {
          bot.inventory.slots[index - invStart] = value;
        }
      };

      const fromItem = getSlot(fromSlot);
      if (!fromItem) {
        throw new Error(`源槽位 ${fromSlot} 为空`);
      }
      const target = getSlot(toSlot);
      if (target && !sameItemIdentity(target, fromItem)) {
        throw new Error(`目标槽位 ${toSlot} 有不同类型的物品`);
      }
      const maxStack = getItemStackSize(fromItem);
      const moving = count == null || count >= fromItem.count ? fromItem.count : count;
      if (target && target.count + moving > maxStack) {
        throw new Error(`目标槽位 ${toSlot} 无法容纳 ${moving} 个`);
      }

      if (target) {
        target.count += moving;
        if (moving >= fromItem.count) {
          setSlot(fromSlot, null);
        } else {
          fromItem.count -= moving;
        }
      } else {
        setSlot(toSlot, { ...fromItem, slot: toSlot, count: moving });
        if (moving >= fromItem.count) {
          setSlot(fromSlot, null);
        } else {
          fromItem.count -= moving;
        }
      }
      return { ok: true, destinationSlot: toSlot };
    },
    async closeWindow() {
      bot.currentWindow = null;
    }
  };
  feature.attach(bot);

  if (options.backpackContents) {
    for (const entry of options.backpackContents) {
      bot.inventory.slots[entry.invIndex] = entry.item;
    }
  }

  return { feature, bot, containers, register, calls, events };
}

// 把测试临时文件移入待删除区(不删除,遵守全局 no-delete 规则)。
function cleanupTestTmp(tmpRoot, prefix) {
  closeAllStores();
  if (!fs.existsSync(tmpRoot)) {
    return;
  }
  const pendingDir = path.resolve(__dirname, '..', '..', '.pending-delete', prefix);
  const entries = fs.readdirSync(tmpRoot);
  for (const entry of entries) {
    const src = path.join(tmpRoot, entry);
    fs.mkdirSync(pendingDir, { recursive: true });
    let dest = path.join(pendingDir, entry);
    if (fs.existsSync(dest)) {
      dest = path.join(pendingDir, `${Date.now()}-${entry}`);
    }
    fs.renameSync(src, dest);
  }
}

module.exports = {
  DEFAULT_RULES,
  norm,
  item,
  createContext,
  chestContents,
  backpackContents,
  getTaskIdFromReplies,
  waitForTaskDone,
  createWorld,
  cleanupTestTmp
};
