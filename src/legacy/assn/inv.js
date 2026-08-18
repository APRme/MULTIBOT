const { Vec3 } = require('vec3');

// 物品栏管理模块
let bot; // 机器人实例
let messageQueue = []; // 消息队列，用于控制发送频率
let isProcessingQueue = false;
let queueTimer = null;

// 初始化函数
function initInv(botInstance) {
  bot = botInstance;
  startMessageQueueProcessor();
}

// -------------------- 消息队列处理器 --------------------
function startMessageQueueProcessor() {
  if (isProcessingQueue) return;
  isProcessingQueue = true;
  
  const processQueue = () => {
    queueTimer = null;

    if (!isProcessingQueue) return;

    if (messageQueue.length > 0) {
      const { deliver } = messageQueue.shift();
      deliver();
      queueTimer = setTimeout(processQueue, 500); // 500ms间隔发送
    } else {
      queueTimer = setTimeout(processQueue, 100);
    }
  };
  
  processQueue();
}

function cleanupInv() {
  if (queueTimer) {
    clearTimeout(queueTimer);
    queueTimer = null;
  }

  messageQueue = [];
  isProcessingQueue = false;
  bot = null;
}

// -------------------- 主命令处理函数 --------------------
async function handleInvCommand(context, content) {
  const args = content.split(' ').slice(1); // 去掉 "inv"
  
  if (args.length === 0) {
    sendMessage(context, '用法: inv <drop|dropall|move|info|quickbar> [参数]');
    sendMessage(context, '可用命令:');
    sendMessage(context, '  inv drop <槽位/物品名> [数量|all] - 丢弃物品');
    sendMessage(context, '  inv dropall - 丢弃主物品栏和快捷栏全部物品');
    sendMessage(context, '  inv move <源槽位> <目标槽位> - 移动/交换物品');
    sendMessage(context, '  inv info - 查看物品栏信息');
    sendMessage(context, '  inv quickbar <物品名/槽位> <快捷栏位置(1-9)> - 管理快捷栏');
    return;
  }
  
  const subCommand = args[0].toLowerCase();
  
  try {
    switch (subCommand) {
      case 'drop':
        await handleDropCommand(context, args.slice(1));
        break;
      case 'dropall':
        await handleDropAllCommand(context);
        break;
      case 'move':
        await handleMoveCommand(context, args.slice(1));
        break;
      case 'info':
        await handleInfoCommand(context, args.slice(1));
        break;
      case 'quickbar':
      case 'qb':
        await handleQuickbarCommand(context, args.slice(1));
        break;
      case 'help':
        showHelp(context);
        break;
      default:
        sendMessage(context, `未知命令: ${subCommand}，使用 inv help 查看帮助`);
        break;
    }
  } catch (error) {
    console.error('[物品栏] 命令执行出错:', error);
    sendMessage(context, `命令执行出错: ${error.message}`);
  }
}

// -------------------- 发送消息到队列 --------------------
function sendMessage(context, message, mode = 'whisper') {
  messageQueue.push({
    deliver: () => context.reply(message, mode)
  });
}

// -------------------- 槽位索引函数 --------------------
// 直接使用 Minecraft 协议原始索引（与面板/WindowFeature 一致）：
// 0-4 合成、5-8 盔甲(5:头盔,6:胸甲,7:护腿,8:靴子)、9-35 背包、36-44 快捷栏、45 副手。
// 保留函数名仅为兼容旧调用，不再做任何换算。
function getRealSlot(slot) {
  return slot;
}

function getStandardSlot(realSlot) {
  return realSlot;
}

// -------------------- 槽位解析器 --------------------
function parseSlot(slotInput) {
  if (!slotInput) return null;
  
  const input = slotInput.toLowerCase();
  
  // 检查是否为数字槽位（协议原始索引 0-45）
  if (!isNaN(parseInt(input))) {
    const slotNum = parseInt(input);
    if (slotNum >= 0 && slotNum <= 45) return slotNum;
    return null;
  }
  
  // 检查盔甲栏名称（协议索引 5-8, 副手 45）
  const armorSlots = {
    'helmet': 5,
    'head': 5,
    '帽子': 5,
    'chestplate': 6,
    'chest': 6,
    '胸甲': 6,
    'leggings': 7,
    'legs': 7,
    '护腿': 7,
    'boots': 8,
    'feet': 8,
    '靴子': 8,
    'offhand': 45,
    '副手': 45,
    'shield': 45,
    '盾牌': 45
  };
  
  if (armorSlots[input] !== undefined) {
    return armorSlots[input];
  }
  
  // 不是槽位，可能是物品名
  return null;
}

// -------------------- 查找物品函数 --------------------
function findItem(itemName, exactMatch = false) {
  const results = [];
  const searchTerm = itemName.toLowerCase();
  
  // 获取所有物品（包括副手）
  const items = bot.inventory.items();
  
  // 1.9+版本需要单独添加副手物品
  if (bot.registry && bot.registry.isNewerOrEqualTo && bot.registry.isNewerOrEqualTo('1.9')) {
    const offHandSlot = 45;
    const offHandItem = bot.inventory.slots[offHandSlot];
    if (offHandItem) {
      items.push(offHandItem);
    }
  }
  
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const realSlot = item.slot; // Mineflayer提供的真实槽位索引
    const standardSlot = getStandardSlot(realSlot);
    
    const itemDisplayName = (item.displayName || item.name).toLowerCase();
    const itemNameLower = item.name.toLowerCase();
    
    let matches = false;
    if (exactMatch) {
      matches = itemDisplayName === searchTerm || itemNameLower === searchTerm;
    } else {
      matches = itemDisplayName.includes(searchTerm) || itemNameLower.includes(searchTerm);
    }
    
    if (matches) {
      results.push({
        slot: standardSlot, // 标准槽位编号，用于显示
        realSlot: realSlot, // 真实槽位索引，用于操作
        item: item,
        name: item.displayName || item.name,
        count: item.count,
        maxStackSize: item.maxStackSize
      });
    }
  }
  
  return results;
}

// -------------------- 格式化附魔信息 --------------------
function formatEnchantments(enchantments) {
  if (!enchantments || Object.keys(enchantments).length === 0) return '';
  
  const formatted = [];
  for (const [key, value] of Object.entries(enchantments)) {
    const level = value;
    let name = key;
    
    // 简化附魔名称
    const enchantMap = {
      'protection': '保护',
      'fire_protection': '火焰保护',
      'feather_falling': '摔落保护',
      'blast_protection': '爆炸保护',
      'projectile_protection': '弹射物保护',
      'respiration': '水下呼吸',
      'aqua_affinity': '水下速掘',
      'thorns': '荆棘',
      'depth_strider': '深海探索者',
      'sharpness': '锋利',
      'smite': '亡灵杀手',
      'bane_of_arthropods': '节肢杀手',
      'knockback': '击退',
      'fire_aspect': '火焰附加',
      'looting': '抢夺',
      'sweeping': '横扫之刃',
      'efficiency': '效率',
      'silk_touch': '精准采集',
      'unbreaking': '耐久',
      'fortune': '时运',
      'power': '力量',
      'punch': '冲击',
      'flame': '火矢',
      'infinity': '无限',
      'luck_of_the_sea': '海之眷顾',
      'lure': '饵钓',
      'mending': '经验修补',
      'vanishing_curse': '消失诅咒',
      'binding_curse': '绑定诅咒'
    };
    
    if (enchantMap[name]) {
      name = enchantMap[name];
    } else {
      // 尝试从名称中提取有意义的名称
      name = name.split('_').map(word => 
        word.charAt(0).toUpperCase() + word.slice(1)
      ).join(' ');
    }
    
    // 罗马数字转换
    const romanNumerals = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];
    const levelText = level <= 10 ? romanNumerals[level] : level;
    
    formatted.push(`${name}${levelText}`);
  }
  
  return formatted.join(', ');
}

// -------------------- 丢弃物品命令 --------------------
async function handleDropCommand(sender, args) {
  if (args.length < 1) {
    sendMessage(sender, '用法: inv drop <槽位/物品名> [数量|all]');
    sendMessage(sender, '示例: inv drop 12, inv drop diamond 5, inv drop cobblestone all');
    return;
  }
  
  const slotInput = args[0];
  let count = 1;
  
  if (args.length >= 2) {
    if (args[1].toLowerCase() === 'all') {
      count = null; // 表示全部
    } else {
      const parsedCount = parseInt(args[1]);
      if (!isNaN(parsedCount) && parsedCount > 0) {
        count = parsedCount;
      }
    }
  }
  
  // 尝试解析为槽位
  const standardSlot = parseSlot(slotInput);
  
  if (standardSlot !== null) {
    // 按槽位丢弃
    const realSlot = getRealSlot(standardSlot);
    const item = bot.inventory.slots[realSlot];
    
    if (!item) {
      sendMessage(sender, `槽位 ${standardSlot} 是空的`);
      return;
    }
    
    const itemName = item.displayName || item.name;
    const maxCount = item.count;
    
    if (count === null || count > maxCount) {
      count = maxCount;
    }
    
    // 执行丢弃
    try {
      // 使用Mineflayer的toss方法
      await bot.toss(item.type, null, count);
      sendMessage(sender, `已丢弃 ${count} 个 ${itemName} (从槽位 ${standardSlot})`);
    } catch (error) {
      sendMessage(sender, `丢弃失败: ${error.message}`);
    }
  } else {
    // 按物品名丢弃
    const searchResults = findItem(slotInput);
    
    if (searchResults.length === 0) {
      sendMessage(sender, `未找到物品: ${slotInput}`);
      return;
    }
    
    // 计算总数量
    let totalCount = searchResults.reduce((sum, result) => sum + result.count, 0);
    
    if (count === null) {
      count = totalCount;
    } else if (count > totalCount) {
      count = totalCount;
    }
    
    // 按顺序从找到的物品中丢弃
    let remaining = count;
    let discarded = 0;
    
    for (const result of searchResults) {
      if (remaining <= 0) break;
      
      const toDiscard = Math.min(remaining, result.count);
      
      try {
        // 使用result.realSlot进行丢弃
        await bot.toss(result.item.type, null, toDiscard);
        discarded += toDiscard;
        remaining -= toDiscard;
      } catch (error) {
        console.error(`丢弃槽位 ${result.slot} 失败:`, error);
      }
    }
    
    if (discarded > 0) {
      sendMessage(sender, `已丢弃 ${discarded} 个 ${slotInput}`);
    } else {
      sendMessage(sender, `丢弃失败，请稍后重试`);
    }
  }
}

async function handleDropAllCommand(sender) {
  if (bot.currentWindow) {
    sendMessage(sender, '请先关闭当前容器界面，再执行 inv dropall');
    return;
  }

  const inventoryStacks = [];

  // 主物品栏 9-35 + 快捷栏 36-44（不含盔甲 5-8 和副手 45）
  for (let slot = 9; slot <= 44; slot++) {
    const item = bot.inventory.slots[slot];

    if (item) {
      inventoryStacks.push({
        slot,
        item
      });
    }
  }

  if (inventoryStacks.length === 0) {
    sendMessage(sender, '主物品栏和快捷栏为空，无需丢弃');
    return;
  }

  let discardedStacks = 0;
  let discardedItems = 0;
  const failedSlots = [];

  for (const { slot, item } of inventoryStacks) {
    const currentItem = bot.inventory.slots[slot];
    if (!currentItem) continue;

    try {
      await bot.tossStack(currentItem);
      discardedStacks += 1;
      discardedItems += currentItem.count;
    } catch (error) {
      const itemName = currentItem.displayName || currentItem.name;
      failedSlots.push(`${slot}:${itemName}`);
      console.error(`[物品栏] 丢弃槽位 ${slot} 失败:`, error);
    }
  }

  if (failedSlots.length === 0) {
    sendMessage(sender, `已丢弃主物品栏全部物品，共 ${discardedStacks} 组 ${discardedItems} 个`);
    return;
  }

  sendMessage(sender, `已丢弃 ${discardedStacks} 组 ${discardedItems} 个，另有 ${failedSlots.length} 组丢弃失败`);
  sendMessage(sender, `失败槽位: ${failedSlots.slice(0, 5).join(', ')}${failedSlots.length > 5 ? ' ...' : ''}`);
}

// -------------------- 移动物品命令 --------------------
async function handleMoveCommand(sender, args) {
  if (args.length < 2) {
    sendMessage(sender, '用法: inv move <源槽位> <目标槽位>');
    sendMessage(sender, '示例: inv move 12 5, inv move helmet 40');
    return;
  }
  
  const fromSlotInput = args[0];
  const toSlotInput = args[1];
  
  const fromStandardSlot = parseSlot(fromSlotInput);
  const toStandardSlot = parseSlot(toSlotInput);
  
  if (fromStandardSlot === null) {
    sendMessage(sender, `无法解析源槽位: ${fromSlotInput}`);
    return;
  }
  
  if (toStandardSlot === null) {
    sendMessage(sender, `无法解析目标槽位: ${toSlotInput}`);
    return;
  }
  
  // 检查槽位是否有效（协议原始索引 0-45）
  if (fromStandardSlot < 0 || fromStandardSlot > 45 || toStandardSlot < 0 || toStandardSlot > 45) {
    sendMessage(sender, '槽位编号必须在 0-45 范围内');
    return;
  }
  
  // 转换为真实槽位
  const fromRealSlot = getRealSlot(fromStandardSlot);
  const toRealSlot = getRealSlot(toStandardSlot);
  
  // 检查源槽位是否有物品
  const fromItem = bot.inventory.slots[fromRealSlot];
  if (!fromItem) {
    sendMessage(sender, `源槽位 ${fromStandardSlot} 是空的`);
    return;
  }
  
  const fromItemName = fromItem.displayName || fromItem.name;

  // 整组移动:拿 → 放 → 验证 → 失败则放回源槽。
  // 服务器拒绝放置(如非盔甲物品放入盔甲槽)时,物品留在服务器 cursor 上且不再同步给客户端,
  // 本地窗口会显示物品消失;主动点击源槽即可放回,服务器会以 set_slot 确认。
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const itemMatches = (left, right) => left && right &&
    String(left.name).replace(/^minecraft:/, '') === String(right.name).replace(/^minecraft:/, '');

  try {
    await bot.clickWindow(fromRealSlot, 0, 0);
    await bot.clickWindow(toRealSlot, 0, 0);
    await delay(300);

    if (itemMatches(bot.inventory.slots[toRealSlot], fromItem)) {
      // 放置成功;若目标槽原有物品(发生了交换),把换出的物品放回源槽
      if (bot.inventory.selectedItem) {
        await bot.clickWindow(fromRealSlot, 0, 0);
        await delay(300);
      }
      sendMessage(sender, `已将 ${fromItemName} 从槽位 ${fromStandardSlot} 移动到槽位 ${toStandardSlot}`);
    } else {
      await bot.clickWindow(fromRealSlot, 0, 0);
      await delay(300);
      if (itemMatches(bot.inventory.slots[fromRealSlot], fromItem)) {
        sendMessage(sender, `移动失败:目标槽位 ${toStandardSlot} 未收到 ${fromItemName}，已自动放回源槽位 ${fromStandardSlot}`);
      } else {
        sendMessage(sender, `移动失败:目标槽位 ${toStandardSlot} 未收到 ${fromItemName}，且未能放回源槽位，物品可能已被服务器丢弃，请检查附近地面`);
      }
    }
  } catch (error) {
    console.error('[物品栏] 移动物品失败:', error);
    sendMessage(sender, `移动失败: ${error.message}`);
  }
}

// -------------------- 查看物品栏信息命令 --------------------
async function handleInfoCommand(sender, args) {
  const detailedMode = args.length > 0 && args[0].toLowerCase() === 'detail';
  
  // 获取当前物品栏
  const inventory = bot.inventory;
  
  // 使用Mineflayer的items()方法获取所有物品
  const items = inventory.items();
  
  // 1.9+版本需要单独添加副手物品
  if (bot.registry && bot.registry.isNewerOrEqualTo && bot.registry.isNewerOrEqualTo('1.9')) {
    const offHandSlot = 45;
    const offHandItem = inventory.slots[offHandSlot];
    if (offHandItem) {
      items.push(offHandItem);
    }
  }
  
  // 按标准槽位分组
  const slotMap = {};
  for (const item of items) {
    const standardSlot = getStandardSlot(item.slot);
    slotMap[standardSlot] = item;
  }
  
  // 第1行：快捷栏 (36-44)
  let hotbarItems = [];
  
  for (let i = 36; i <= 44; i++) {
    const item = slotMap[i];
    if (item) {
      const itemName = item.displayName || item.name;
      let itemInfo = `[${i}]${itemName}×${item.count}`;
      
      if (detailedMode) {
        if (item.durability !== undefined && item.maxDurability !== undefined) {
          const durability = item.maxDurability - item.durability;
          const maxDurability = item.maxDurability;
          itemInfo += `(${durability}/${maxDurability})`;
        }
        
        const enchantments = formatEnchantments(item.enchants);
        if (enchantments) {
          itemInfo += `<${enchantments}>`;
        }
      }
      
      hotbarItems.push(itemInfo);
    } else {
      hotbarItems.push(`[${i}]空`);
    }
  }
  
  const hotbarInfo = `快捷栏(36-44): ${hotbarItems.join(', ')}`;
  sendMessage(sender, hotbarInfo);
  
  // 第2行：背包第1行 (9-17)
  let row1Items = [];
  
  for (let i = 9; i <= 17; i++) {
    const item = slotMap[i];
    if (item) {
      const itemName = item.displayName || item.name;
      let itemInfo = `[${i}]${itemName}×${item.count}`;
      
      if (detailedMode) {
        const enchantments = formatEnchantments(item.enchants);
        if (enchantments) {
          itemInfo += `<${enchantments}>`;
        }
      }
      
      row1Items.push(itemInfo);
    } else {
      row1Items.push(`[${i}]空`);
    }
  }
  
  setTimeout(() => {
    const row1Info = `背包1行(9-17): ${row1Items.join(', ')}`;
    sendMessage(sender, row1Info);
  }, 500);
  
  // 第3行：背包第2行 (18-26)
  let row2Items = [];
  
  for (let i = 18; i <= 26; i++) {
    const item = slotMap[i];
    if (item) {
      const itemName = item.displayName || item.name;
      let itemInfo = `[${i}]${itemName}×${item.count}`;
      
      if (detailedMode) {
        const enchantments = formatEnchantments(item.enchants);
        if (enchantments) {
          itemInfo += `<${enchantments}>`;
        }
      }
      
      row2Items.push(itemInfo);
    } else {
      row2Items.push(`[${i}]空`);
    }
  }
  
  setTimeout(() => {
    const row2Info = `背包2行(18-26): ${row2Items.join(', ')}`;
    sendMessage(sender, row2Info);
  }, 1000);
  
  // 第4行：背包第3行 (27-35)
  let row3Items = [];
  
  for (let i = 27; i <= 35; i++) {
    const item = slotMap[i];
    if (item) {
      const itemName = item.displayName || item.name;
      let itemInfo = `[${i}]${itemName}×${item.count}`;
      
      if (detailedMode) {
        const enchantments = formatEnchantments(item.enchants);
        if (enchantments) {
          itemInfo += `<${enchantments}>`;
        }
      }
      
      row3Items.push(itemInfo);
    } else {
      row3Items.push(`[${i}]空`);
    }
  }
  
  setTimeout(() => {
    const row3Info = `背包3行(27-35): ${row3Items.join(', ')}`;
    sendMessage(sender, row3Info);
  }, 1500);
  
  // 盔甲栏和副手 (5-8, 45)
  setTimeout(() => {
    let armorItems = [];
    
    // 头盔 (5)
    const helmet = slotMap[5];
    if (helmet) {
      const helmetName = helmet.displayName || helmet.name;
      let helmetInfo = `头盔:${helmetName}×${helmet.count}`;
      
      if (detailedMode) {
        if (helmet.durability !== undefined && helmet.maxDurability !== undefined) {
          const durability = helmet.maxDurability - helmet.durability;
          const maxDurability = helmet.maxDurability;
          helmetInfo += `(${durability}/${maxDurability})`;
        }
        
        const enchantments = formatEnchantments(helmet.enchants);
        if (enchantments) {
          helmetInfo += `<${enchantments}>`;
        }
      }
      
      armorItems.push(helmetInfo);
    } else {
      armorItems.push('头盔:空');
    }
    
    // 胸甲 (6)
    const chestplate = slotMap[6];
    if (chestplate) {
      const chestplateName = chestplate.displayName || chestplate.name;
      let chestplateInfo = `胸甲:${chestplateName}×${chestplate.count}`;
      
      if (detailedMode) {
        if (chestplate.durability !== undefined && chestplate.maxDurability !== undefined) {
          const durability = chestplate.maxDurability - chestplate.durability;
          const maxDurability = chestplate.maxDurability;
          chestplateInfo += `(${durability}/${maxDurability})`;
        }
        
        const enchantments = formatEnchantments(chestplate.enchants);
        if (enchantments) {
          chestplateInfo += `<${enchantments}>`;
        }
      }
      
      armorItems.push(chestplateInfo);
    } else {
      armorItems.push('胸甲:空');
    }
    
    // 护腿 (7)
    const leggings = slotMap[7];
    if (leggings) {
      const leggingsName = leggings.displayName || leggings.name;
      let leggingsInfo = `护腿:${leggingsName}×${leggings.count}`;
      
      if (detailedMode) {
        if (leggings.durability !== undefined && leggings.maxDurability !== undefined) {
          const durability = leggings.maxDurability - leggings.durability;
          const maxDurability = leggings.maxDurability;
          leggingsInfo += `(${durability}/${maxDurability})`;
        }
        
        const enchantments = formatEnchantments(leggings.enchants);
        if (enchantments) {
          leggingsInfo += `<${enchantments}>`;
        }
      }
      
      armorItems.push(leggingsInfo);
    } else {
      armorItems.push('护腿:空');
    }
    
    // 靴子 (8)
    const boots = slotMap[8];
    if (boots) {
      const bootsName = boots.displayName || boots.name;
      let bootsInfo = `靴子:${bootsName}×${boots.count}`;
      
      if (detailedMode) {
        if (boots.durability !== undefined && boots.maxDurability !== undefined) {
          const durability = boots.maxDurability - boots.durability;
          const maxDurability = boots.maxDurability;
          bootsInfo += `(${durability}/${maxDurability})`;
        }
        
        const enchantments = formatEnchantments(boots.enchants);
        if (enchantments) {
          bootsInfo += `<${enchantments}>`;
        }
      }
      
      armorItems.push(bootsInfo);
    } else {
      armorItems.push('靴子:空');
    }
    
    // 副手 (45)
    const offhand = slotMap[45];
    if (offhand) {
      const offhandName = offhand.displayName || offhand.name;
      let offhandInfo = `副手:${offhandName}×${offhand.count}`;
      
      if (detailedMode) {
        if (offhand.durability !== undefined && offhand.maxDurability !== undefined) {
          const durability = offhand.maxDurability - offhand.durability;
          const maxDurability = offhand.maxDurability;
          offhandInfo += `(${durability}/${maxDurability})`;
        }
        
        const enchantments = formatEnchantments(offhand.enchants);
        if (enchantments) {
          offhandInfo += `<${enchantments}>`;
        }
      }
      
      armorItems.push(offhandInfo);
    } else {
      armorItems.push('副手:空');
    }
    
    const armorInfo = `盔甲副手: ${armorItems.join(', ')}`;
    sendMessage(sender, armorInfo);
  }, 2000);
  
  if (detailedMode) {
    setTimeout(() => {
      sendMessage(sender, '详细信息模式已开启，显示了耐久度和附魔信息。');
    }, 2500);
  }
}

// -------------------- 快捷栏管理命令 --------------------
async function handleQuickbarCommand(sender, args) {
  if (args.length < 2) {
    sendMessage(sender, '用法: inv quickbar <物品名/槽位> <快捷栏位置(1-9)>');
    sendMessage(sender, '示例: inv quickbar diamond 1, inv quickbar 15 3');
    return;
  }
  
  const itemInput = args[0];
  const hotbarSlotInput = args[1];
  
  // 解析目标快捷栏位置 (1-9 -> 36-44)
  const targetStandardSlot = parseInt(hotbarSlotInput) - 1 + 36;
  
  if (isNaN(targetStandardSlot) || targetStandardSlot < 36 || targetStandardSlot > 44) {
    sendMessage(sender, '快捷栏位置必须是 1-9 之间的数字');
    return;
  }
  
  // 查找源物品
  let sourceStandardSlot = null;
  let sourceItem = null;
  
  // 先尝试解析为槽位
  const parsedSlot = parseSlot(itemInput);
  if (parsedSlot !== null) {
    sourceStandardSlot = parsedSlot;
    const sourceRealSlot = getRealSlot(sourceStandardSlot);
    sourceItem = bot.inventory.slots[sourceRealSlot];
  } else {
    // 按物品名查找
    const searchResults = findItem(itemInput);
    if (searchResults.length === 0) {
      sendMessage(sender, `未找到物品: ${itemInput}`);
      return;
    }
    
    // 优先选择已经在快捷栏中的相同物品
    const hotbarResult = searchResults.find(r => r.slot >= 36 && r.slot <= 44);
    if (hotbarResult) {
      sourceStandardSlot = hotbarResult.slot;
      sourceItem = hotbarResult.item;
    } else {
      // 选择第一个找到的物品
      sourceStandardSlot = searchResults[0].slot;
      sourceItem = searchResults[0].item;
    }
  }
  
  if (!sourceItem) {
    sendMessage(sender, `指定的物品不存在或槽位为空`);
    return;
  }
  
  const itemName = sourceItem.displayName || sourceItem.name;
  
  // 如果源位置就是目标位置，不需要操作
  if (sourceStandardSlot === targetStandardSlot) {
    sendMessage(sender, `${itemName} 已经在快捷栏位置 ${targetStandardSlot - 35}`);
    return;
  }
  
  // 转换为真实槽位
  const sourceRealSlot = getRealSlot(sourceStandardSlot);
  const targetRealSlot = getRealSlot(targetStandardSlot);
  
  // 检查目标位置是否有物品
  const targetItem = bot.inventory.slots[targetRealSlot];
  
  try {
    if (targetItem) {
      // 目标位置有物品，交换
      const targetItemName = targetItem.displayName || targetItem.name;
      await bot.moveSlotItem(sourceRealSlot, targetRealSlot);
      sendMessage(sender, `已交换 ${itemName} 和 ${targetItemName} (快捷栏位置 ${targetStandardSlot - 35})`);
    } else {
      // 目标位置为空，移动物品
      await bot.moveSlotItem(sourceRealSlot, targetRealSlot);
      sendMessage(sender, `已将 ${itemName} 移动到快捷栏位置 ${targetStandardSlot - 35}`);
    }
  } catch (error) {
    console.error('[物品栏] 快捷栏操作失败:', error);
    sendMessage(sender, `快捷栏操作失败: ${error.message}`);
  }
}

// -------------------- 显示帮助（在控制台输出） --------------------
function showHelp(sender) {
  // 发送简短消息给玩家
  sendMessage(sender, '物品栏管理帮助信息已输出到控制台，请查看机器人控制台窗口。');
  
  // 在控制台输出详细帮助信息
  console.log('\n' + '='.repeat(50));
  console.log('物品栏管理命令帮助');
  console.log('='.repeat(50));
  console.log('\n基本命令格式:');
  console.log('  inv <子命令> [参数]');
  console.log('\n可用子命令:');
  console.log('  inv drop <槽位/物品名> [数量|all]');
  console.log('    丢弃物品。数量可以是数字或"all"表示全部');
  console.log('    示例: inv drop 12, inv drop diamond 5, inv drop cobblestone all');
  console.log('');
  console.log('  inv dropall');
  console.log('    丢弃主物品栏和快捷栏中的全部物品，不包含盔甲栏和副手');
  console.log('    示例: inv dropall');
  console.log('');
  console.log('  inv move <源槽位> <目标槽位>');
  console.log('    移动或交换物品。如果目标槽位为空则移动，否则交换');
  console.log('    示例: inv move 12 5, inv move helmet 40');
  console.log('    槽位编号: 0-45 或使用名称: helmet, chestplate, leggings, boots, offhand');
  console.log('');
  console.log('  inv info [detail]');
  console.log('    查看物品栏信息。添加detail参数显示详细附魔和耐久信息');
  console.log('    示例: inv info, inv info detail');
  console.log('');
  console.log('  inv quickbar <物品名/槽位> <快捷栏位置(1-9)>');
  console.log('    将物品放到指定快捷栏位置。如果该位置已有物品则交换');
  console.log('    示例: inv quickbar diamond 1, inv quickbar 15 3');
  console.log('');
  console.log('槽位编号说明（协议原始索引，与面板一致）:');
  console.log('  盔甲栏: 5-8 (5:头盔,6:胸甲,7:护腿,8:靴子)');
  console.log('  背包: 9-35 (3行×9列)');
  console.log('  快捷栏: 36-44 (对应1-9)');
  console.log('  副手: 45');
  console.log('  槽位别名: helmet/head/帽子, chestplate/chest/胸甲, leggings/legs/护腿, boots/feet/靴子, offhand/shield/副手/盾牌');
  console.log('');
  console.log('物品栏信息输出格式:');
  console.log('  快捷栏(36-44): [36]钻石剑×1, [37]钻石镐×1, [38]空, ...');
  console.log('  背包1行(9-17): [9]圆石×64, [10]泥土×32, [11]空, ...');
  console.log('  背包2行(18-26): [18]煤炭×64, [19]红石粉×32, [20]空, ...');
  console.log('  背包3行(27-35): [27]铁锭×16, [28]金锭×8, [29]空, ...');
  console.log('  盔甲副手: 头盔:钻石头盔×1, 胸甲:钻石胸甲×1, 护腿:空, ... (盔甲槽位5-8, 副手45)');
  console.log('');
  console.log('详细模式格式:');
  console.log('  [36]钻石剑×1(1562/1562)<锋利IV,耐久III>');
  console.log('  括号内为耐久度(当前/最大), 尖括号内为附魔信息');
  console.log('='.repeat(50) + '\n');
}

// -------------------- 获取模块状态 --------------------
function getInvStatus() {
  return {
    messageQueueLength: messageQueue.length,
    isProcessingQueue: isProcessingQueue,
    hasQueueTimer: Boolean(queueTimer),
    hasBot: Boolean(bot)
  };
}

// 导出模块
module.exports = {
  initInv,
  cleanupInv,
  handleInvCommand,
  getInvStatus,
  findItem,
  parseSlot,
  getRealSlot,
  getStandardSlot
};
