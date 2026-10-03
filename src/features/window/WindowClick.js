// 原版(Java 版客户端)物品点击语义: 把"游戏内操作"翻译成 ServerboundContainerClickPacket 的
// (slot, mouseButton, mode) 三元组, 并做与原版一致的本地预测。
//
// 参考依据:
//   - 协议包 packet_window_click(windowId, stateId, slot, mouseButton, mode, changedSlots, cursorItem)
//   - prismarine-windows 的 Window#acceptClick: 原版 AbstractContainerMenu.clicked 的移植,
//     已覆盖原版全部 7 种模式(0..6), 因此本地预测直接复用它, 不自己造一套移动规则。
//   - mineflayer 自身的 bot.clickWindow 只允许 mode 0..4 且不认副手交换(40)/拖拽起始(0/4/8),
//     所以完整点击(拖拽分发、双击收集、副手交换)必须由本模块直接发包。
//
// 关于 changedSlots / cursorItem(1.21.11 实测结论):
//   原版这两个字段是 HashedStack(组件经 CRC32C 哈希), 而 JS 栈里 Item.toNotch() 产出的是
//   UntrustedSlot 形状(itemId/itemCount/components/removeComponents, 组件带 data 而非 hash)。
//   实测: 组件为空时两者字段名恰好重合、可正确编码; 组件非空时能编码但组件类型与 hash(0)是错的,
//   服务器会把它记成"远端预期", 一旦与服务端真实值恰好相同就会**跳过应有的回包纠正**。
//   服务端从不校验这两个字段(只用于决定是否回发纠正), 因此这里选择**不传输本地预测**:
//   changedSlots 发空、cursorItem 省略 —— 服务器因此总会回发真实槽位, 客户端状态只会更准。
//   代价是每次点击多几个 set_slot / container_set_content 包, 换来的是绝不出现状态漂移。
//   (若将来要实现真正的 HashedStack, 需要按组件做 CRC32C 哈希, 属独立课题)
//
// 模式(mode)与原版 ClickType 对应:
//   0 PICKUP      左/右键 拿起-放下
//   1 QUICK_MOVE  Shift 点击(快速移动)
//   2 SWAP        数字键 1-9 / 副手(F) 交换
//   3 CLONE       创造模式中键复制
//   4 THROW       Q 丢一个 / Ctrl+Q 丢一组
//   5 QUICK_CRAFT 拖拽分发(开始 / 经过 / 结束)
//   6 PICKUP_ALL  双击收集同类物品
const ItemLib = require('prismarine-item');

const CLICK_MODES = {
  PICKUP: 0,
  QUICK_MOVE: 1,
  SWAP: 2,
  CLONE: 3,
  THROW: 4,
  QUICK_CRAFT: 5,
  PICKUP_ALL: 6
};

// 原版用 -999 表示"点击窗口外"(丢弃光标上的物品)
const OUTSIDE_SLOT = -999;
// 原版 mode 2 用 40 表示与副手交换(0..8 为快捷栏 1..9)
const OFFHAND_SWAP_BUTTON = 40;

// 语义动作 -> (mouseButton, mode): 与游戏内按键一一对应
const CLICK_ACTIONS = {
  left: { mouseButton: 0, mode: CLICK_MODES.PICKUP },
  right: { mouseButton: 1, mode: CLICK_MODES.PICKUP },
  shift: { mouseButton: 0, mode: CLICK_MODES.QUICK_MOVE },
  'shift-right': { mouseButton: 1, mode: CLICK_MODES.QUICK_MOVE },
  drop: { mouseButton: 0, mode: CLICK_MODES.THROW },
  'drop-stack': { mouseButton: 1, mode: CLICK_MODES.THROW },
  collect: { mouseButton: 0, mode: CLICK_MODES.PICKUP_ALL },
  clone: { mouseButton: 2, mode: CLICK_MODES.CLONE }
};

// 动作别名(命令/接口里好写)
const ACTION_ALIASES = {
  l: 'left',
  'left-click': 'left',
  r: 'right',
  'right-click': 'right',
  quick: 'shift',
  'quick-move': 'shift',
  shiftright: 'shift-right',
  'shift-right-click': 'shift-right',
  q: 'drop',
  dropstack: 'drop-stack',
  'drop-all': 'drop-stack',
  'pickup-all': 'collect',
  double: 'collect',
  doubleclick: 'collect',
  middle: 'clone',
  copy: 'clone'
};

// 拖拽按钮表(原版: 左 0/1/2, 右 4/5/6, 中 8/9/10; 开始与结束包用 slot=-999)
const DRAG_BUTTONS = {
  left: { start: 0, add: 1, end: 2 },
  right: { start: 4, add: 5, end: 6 },
  middle: { start: 8, add: 9, end: 10 }
};

const DRAG_PHASES = ['start', 'add', 'end'];

function normalizeAction(action) {
  const raw = String(action == null ? 'left' : action).trim().toLowerCase();
  const resolved = ACTION_ALIASES[raw] || raw;
  if (raw === 'swap') return 'swap';
  if (raw.startsWith('swap-')) return raw;
  if (raw.startsWith('drag-')) return raw;
  return resolved;
}

function normalizeDragPhase(value) {
  const phase = String(value == null ? '' : value).trim().toLowerCase();
  if (!DRAG_PHASES.includes(phase)) {
    throw new Error(`拖拽阶段必须是 ${DRAG_PHASES.join('/')}`);
  }
  return phase;
}

function normalizeDragButton(value) {
  const name = String(value == null || value === '' ? 'left' : value).trim().toLowerCase();
  if (!DRAG_BUTTONS[name]) {
    throw new Error('拖拽按键必须是 left/right/middle');
  }
  return name;
}

// 原版模式/按键合法组合(与 prismarine-windows 的 acceptClick 断言一致, 额外允许副手 40 与拖拽起始)
function isValidModeButton(mode, mouseButton) {
  switch (mode) {
    case CLICK_MODES.PICKUP:
    case CLICK_MODES.QUICK_MOVE:
    case CLICK_MODES.THROW:
      return mouseButton === 0 || mouseButton === 1;
    case CLICK_MODES.SWAP:
      return (mouseButton >= 0 && mouseButton <= 8) || mouseButton === OFFHAND_SWAP_BUTTON;
    case CLICK_MODES.CLONE:
      return mouseButton === 2;
    case CLICK_MODES.QUICK_CRAFT:
      return [0, 4, 8, 1, 5, 9, 2, 6, 10].includes(mouseButton);
    case CLICK_MODES.PICKUP_ALL:
      return mouseButton === 0;
    default:
      return false;
  }
}

// 能否用 prismarine-windows 做本地预测。
// 它不接受副手交换(40)与拖拽起始(0/4/8), 这两种情况只发包、不预测(等服务器回包纠正)。
function canPredictLocally(mode, mouseButton) {
  if (!isValidModeButton(mode, mouseButton)) return false;
  if (mode === CLICK_MODES.SWAP && mouseButton > 8) return false;
  if (mode === CLICK_MODES.QUICK_CRAFT && [0, 4, 8].includes(mouseButton)) return false;
  return true;
}

// 把语义动作解析成一次点击(带原版级别的参数校验)
function resolveClickAction(action, options = {}) {
  const slot = options.slot === undefined || options.slot === null ? OUTSIDE_SLOT : Number(options.slot);
  if (!Number.isInteger(slot)) {
    throw new Error('槽位必须是整数(-999 表示窗口外)');
  }

  const name = normalizeAction(action);

  if (name === 'swap') {
    const target = String(options.swapSlot == null ? '' : options.swapSlot).trim().toLowerCase();
    if (target === 'offhand' || target === 'f') {
      return { slot, mouseButton: OFFHAND_SWAP_BUTTON, mode: CLICK_MODES.SWAP, action: 'swap-offhand' };
    }
    const index = Number.parseInt(target, 10);
    if (!Number.isInteger(index) || index < 1 || index > 9) {
      throw new Error('交换槽位必须是 1-9 或 offhand');
    }
    return { slot, mouseButton: index - 1, mode: CLICK_MODES.SWAP, action: `swap-${index}` };
  }

  if (name.startsWith('swap-')) {
    const tail = name.slice('swap-'.length);
    if (tail === 'offhand' || tail === 'f') {
      return { slot, mouseButton: OFFHAND_SWAP_BUTTON, mode: CLICK_MODES.SWAP, action: 'swap-offhand' };
    }
    const index = Number.parseInt(tail, 10);
    if (!Number.isInteger(index) || index < 1 || index > 9) {
      throw new Error('交换槽位必须是 1-9 或 offhand');
    }
    return { slot, mouseButton: index - 1, mode: CLICK_MODES.SWAP, action: `swap-${index}` };
  }

  if (name.startsWith('drag-')) {
    const phase = normalizeDragPhase(name.slice('drag-'.length));
    return resolveDragClick(phase, options.button, slot);
  }

  const preset = CLICK_ACTIONS[name];
  if (!preset) {
    throw new Error(`未知点击动作: ${action}(支持 ${Object.keys(CLICK_ACTIONS).join('/')}/swap/drag)`);
  }

  return { slot, mouseButton: preset.mouseButton, mode: preset.mode, action: name };
}

// 拖拽: 开始/结束包用 slot=-999, 经过用真实槽位(与原版一致)
function resolveDragClick(phase, button, slot) {
  const resolvedPhase = normalizeDragPhase(phase);
  const buttonName = normalizeDragButton(button);
  const buttons = DRAG_BUTTONS[buttonName];
  const mouseButton = buttons[resolvedPhase];
  const resolvedSlot = resolvedPhase === 'add'
    ? (Number.isInteger(slot) ? slot : (() => { throw new Error('拖拽经过( add )必须给出槽位'); })())
    : OUTSIDE_SLOT;

  return {
    slot: resolvedSlot,
    mouseButton,
    mode: CLICK_MODES.QUICK_CRAFT,
    action: `drag-${resolvedPhase}`,
    dragButton: buttonName
  };
}

function resolveGamemodeNumber(bot) {
  const gamemode = bot && bot.game ? bot.game.gameMode : null;
  if (gamemode === 'creative') return 1;
  if (gamemode === 'adventure') return 2;
  if (gamemode === 'spectator') return 3;
  return 0;
}

// 点击器: 跟踪每个窗口最新 stateId(1.17.1+ 点击必须携带), 做本地预测, 然后按原版字段发包。
// hooks: { addListener(target, event, handler) } —— 用外部登记便于随连接一起清理
function createWindowClicker(bot, hooks = {}) {
  if (!bot || !bot._client || typeof bot._client.write !== 'function') {
    return null;
  }

  const addListener = typeof hooks.addListener === 'function'
    ? hooks.addListener
    : (target, event, handler) => target.on(event, handler);
  const logger = hooks.logger || null;
  const Item = ItemLib(bot.registry);
  const stateIdByWindow = new Map();
  // 拖拽会话: 原版在鼠标释放时才把 start/全部 add/end 一次性发出, 同槽只算一次;
  // 这里改为按调用即时发包(便于面板逐步驱动), 因此自行做同槽去重与顺序校验。
  let activeDrag = null;

  const trackStateId = (packet) => {
    if (packet && Number.isInteger(packet.stateId) && Number.isInteger(packet.windowId)) {
      stateIdByWindow.set(packet.windowId, packet.stateId);
    }
  };

  // 光标物品同步: ClientboundSetCursorItemPacket(contents) 没有 containerId, 作用于当前打开的容器。
  // mineflayer 至今没有处理这个包(1.21.11), 不补的话服务端改了光标物品后本地会一直是旧值。
  const applyCursorItem = (packet) => {
    const window = bot.currentWindow || bot.inventory;
    if (!window) return;

    const contents = packet && packet.contents !== undefined ? packet.contents : packet;
    window.selectedItem = Item.fromNotch(contents);
    bot.emit('windowCursorChanged', window, window.selectedItem);
  };

  addListener(bot._client, 'window_items', trackStateId);
  addListener(bot._client, 'set_slot', trackStateId);
  addListener(bot._client, 'set_cursor_item', applyCursorItem);

  const getStateId = (windowId) => (stateIdByWindow.has(windowId) ? stateIdByWindow.get(windowId) : -1);

  const resolveWindow = (window) => window || bot.currentWindow || bot.inventory;

  const usesStateId = () => {
    if (typeof bot.supportFeature !== 'function') return true;
    try {
      return bot.supportFeature('stateIdUsed') === true;
    } catch (error) {
      return true;
    }
  };

  function assertSlotValid(window, slot) {
    if (slot === OUTSIDE_SLOT) return;
    if (!Number.isInteger(slot) || slot < 0 || slot >= window.slots.length) {
      throw new Error(`槽位越界: ${slot}(该窗口共 ${window.slots.length} 格)`);
    }
  }

  // 本地预测: 调用原版菜单逻辑(acceptClick), 再按"槽位内容是否变化"得出 changedSlots —— 与原版一致
  function predictLocal(window, click) {
    if (!canPredictLocally(click.mode, click.mouseButton) || typeof window.acceptClick !== 'function') {
      return { predicted: false, changedSlots: [], cursorChanged: false };
    }

    const beforeSlots = window.slots.slice();
    const beforeCursor = window.selectedItem || null;

    try {
      window.acceptClick({
        slot: click.slot,
        mouseButton: click.mouseButton,
        mode: click.mode,
        windowId: window.id,
        item: click.slot === OUTSIDE_SLOT ? null : window.slots[click.slot]
      }, resolveGamemodeNumber(bot));
    } catch (error) {
      if (logger && typeof logger.warn === 'function') {
        logger.warn(`[WINDOW] 本地预测跳过: ${error.message}`);
      }
      return { predicted: false, changedSlots: [], cursorChanged: false };
    }

    const changedSlots = [];
    for (let i = 0; i < window.slots.length; i += 1) {
      if (!Item.equal(beforeSlots[i], window.slots[i])) {
        changedSlots.push(i);
      }
    }

    return {
      predicted: true,
      changedSlots,
      cursorChanged: !Item.equal(beforeCursor, window.selectedItem)
    };
  }

  // 发一次点击: 参数已由 resolveClickAction 归一化, 这里只做窗口级校验 + 预测 + 发包
  function click(options = {}) {
    const window = resolveWindow(options.window);
    if (!window) {
      throw new Error('当前没有可点击的窗口');
    }

    const slot = options.slot === undefined || options.slot === null ? OUTSIDE_SLOT : Number(options.slot);
    let mouseButton = Number.isInteger(options.mouseButton) ? options.mouseButton : 0;
    let mode = Number.isInteger(options.mode) ? options.mode : CLICK_MODES.PICKUP;

    // 原版语义: 空手点窗口外发 THROW(-999, 服务端无操作), 手持物品才是 PICKUP(-999 丢弃)
    if (slot === OUTSIDE_SLOT && mode === CLICK_MODES.PICKUP && !window.selectedItem) {
      mode = CLICK_MODES.THROW;
    }

    if (!isValidModeButton(mode, mouseButton)) {
      throw new Error(`原版不存在的点击组合: mode=${mode} button=${mouseButton}`);
    }
    assertSlotValid(window, slot);

    const stateId = getStateId(window.id);
    if (usesStateId() && stateId < 0) {
      throw new Error('窗口尚未同步(未收到 stateId)，请等服务器下发容器内容后再点击');
    }

    // 拖拽顺序与同槽去重(原版同槽只算一次)
    if (mode === CLICK_MODES.QUICK_CRAFT) {
      const isStart = [0, 4, 8].includes(mouseButton);
      const isEnd = [2, 6, 10].includes(mouseButton);
      if (isStart) {
        activeDrag = { windowId: window.id, mouseButton, slots: new Set() };
      } else if (!activeDrag || activeDrag.windowId !== window.id) {
        throw new Error('拖拽未开始: 请先发送 drag start');
      } else if (!isEnd) {
        if (activeDrag.slots.has(slot)) {
          return {
            windowId: window.id,
            slot,
            mouseButton,
            mode,
            stateId,
            action: options.action || null,
            predicted: false,
            skipped: true,
            changedSlots: [],
            cursorChanged: false
          };
        }
        if (mouseButton !== activeDrag.mouseButton + 1) {
          throw new Error('拖拽按钮与 drag start 不一致');
        }
        activeDrag.slots.add(slot);
      } else {
        if (mouseButton !== activeDrag.mouseButton + 2) {
          throw new Error('拖拽结束按钮与 drag start 不一致');
        }
        activeDrag = null;
      }
    }

    const prediction = predictLocal(window, { slot, mouseButton, mode });

    // 刻意不传输 changedSlots / cursorItem(见文件头说明): 服务器因此总会回发真实槽位
    bot._client.write('window_click', {
      windowId: window.id,
      stateId,
      slot,
      mouseButton,
      mode,
      changedSlots: [],
      cursorItem: undefined
    });

    if (prediction.cursorChanged) {
      bot.emit('windowCursorChanged', window, window.selectedItem);
    }

    if (logger && typeof logger.info === 'function' && mode !== CLICK_MODES.QUICK_CRAFT) {
      // 保留一条简短轨迹便于排查菜单类点击(不打印物品内容)
      logger.info(`[WINDOW] click window=${window.id} slot=${slot} button=${mouseButton} mode=${mode} stateId=${stateId} predicted=${prediction.predicted}`);
    }

    return {
      windowId: window.id,
      slot,
      mouseButton,
      mode,
      stateId,
      action: options.action || null,
      predicted: prediction.predicted,
      skipped: false,
      changedSlots: prediction.changedSlots,
      cursorChanged: prediction.cursorChanged
    };
  }

  function clickAction(action, options = {}) {
    const resolved = resolveClickAction(action, options);
    return click({ ...resolved, window: options.window });
  }

  return {
    getStateId,
    click,
    clickAction,
    getActiveDrag: () => (activeDrag ? { windowId: activeDrag.windowId, mouseButton: activeDrag.mouseButton, slots: [...activeDrag.slots] } : null)
  };
}

module.exports = {
  CLICK_MODES,
  CLICK_ACTIONS,
  ACTION_ALIASES,
  DRAG_BUTTONS,
  DRAG_PHASES,
  OUTSIDE_SLOT,
  OFFHAND_SWAP_BUTTON,
  isValidModeButton,
  canPredictLocally,
  normalizeAction,
  normalizeDragPhase,
  normalizeDragButton,
  resolveClickAction,
  resolveDragClick,
  resolveGamemodeNumber,
  createWindowClicker
};
