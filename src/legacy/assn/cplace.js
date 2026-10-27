const { Vec3 } = require('vec3');

// 持续放置相关变量
let isContinuousPlacing = false;
let stopContinuousPlacing = false;
let placingInterval = 500; // 默认放置间隔500ms
let stopOnFailures = false; // 默认连续失败后停止
let bot; // 机器人实例，将在初始化时设置
let placingTimer = null; // 放置定时器引用
let viewRestoreTimer = null; // 视角恢复定时器引用
let originalYaw = 0; // 原始偏航角
let originalPitch = 0; // 原始俯仰角
let placeCountSinceLastRestore = 0; // 上次恢复视角后的放置次数
let targetBlockType = null; // 要放置的方块类型
let targetBlockMetadata = null; // 方块元数据
let targetBlockName = ''; // 方块显示名称
let targetContext = null; // 通知目标上下文

function notifyTarget(message, mode = 'whisper') {
  if (!targetContext || typeof targetContext.reply !== 'function') return;
  targetContext.reply(message, mode);
}

// 重力方块列表（放置后会下落或移动的方块）
const gravityBlocks = [
  'sand', 'red_sand', 'gravel', 'anvil', 'chipped_anvil', 'damaged_anvil',
  'dragon_egg', 'white_concrete_powder', 'orange_concrete_powder', 
  'magenta_concrete_powder', 'light_blue_concrete_powder', 'yellow_concrete_powder',
  'lime_concrete_powder', 'pink_concrete_powder', 'gray_concrete_powder',
  'light_gray_concrete_powder', 'cyan_concrete_powder', 'purple_concrete_powder',
  'blue_concrete_powder', 'brown_concrete_powder', 'green_concrete_powder',
  'red_concrete_powder', 'black_concrete_powder',
  'pointed_dripstone', 'scaffolding'
];

// 检查是否是重力方块
function isGravityBlock(blockName) {
  if (!blockName) return false;
  const lowerName = blockName.toLowerCase();
  return gravityBlocks.some(gravityBlock => lowerName.includes(gravityBlock.toLowerCase()));
}

// 初始化函数，从主文件传入机器人实例
let getSequence = null; // 与其它交互共用的 sequence 计数器
let fallbackSequence = 0;

function initCplace(botInstance, options = {}) {
  bot = botInstance;
  getSequence = typeof options.getSequence === 'function' ? options.getSequence : null;
  fallbackSequence = 0;
}

function nextInteractionSequence() {
  if (getSequence) return getSequence();
  fallbackSequence = (fallbackSequence + 1) % 32767;
  return fallbackSequence;
}

// 眼睛 -> 方块 1x1x1 AABB 最近点距离(与服务端交互距离同度量)
function distanceToBlockCube(position, blockPosition) {
  if (!position || !blockPosition) return null;

  const eyeX = Number(position.x);
  const eyeY = Number(position.y) + 1.62;
  const eyeZ = Number(position.z);
  if (![eyeX, eyeY, eyeZ].every((value) => Number.isFinite(value))) return null;

  const dx = Math.max(blockPosition.x - eyeX, 0, eyeX - (blockPosition.x + 1));
  const dy = Math.max(blockPosition.y - eyeY, 0, eyeY - (blockPosition.y + 1));
  const dz = Math.max(blockPosition.z - eyeZ, 0, eyeZ - (blockPosition.z + 1));
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function getInteractionLimit() {
  const mode = bot && bot.game ? bot.game.gameMode : 'survival';
  return mode === 'creative' ? 6.0 : 5.5;
}

// 等目标位置出现 block_change(服务端已落地的证据)
function waitForBlockChange(position, timeoutMs) {
  const client = bot && bot._client;
  if (!client || typeof client.on !== 'function') return Promise.resolve(false);

  return new Promise((resolve) => {
    let settled = false;
    let timer = null;

    const finish = (hit) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      for (const eventName of ['block_change', 'block_update']) {
        client.removeListener(eventName, onBlockChange);
      }
      resolve(hit);
    };

    const onBlockChange = (packet) => {
      const location = packet && packet.location;
      if (!location) return;
      if (location.x === position.x && location.y === position.y && location.z === position.z) finish(true);
    };

    for (const eventName of ['block_change', 'block_update']) client.on(eventName, onBlockChange);
    timer = setTimeout(() => finish(false), Math.max(50, Number(timeoutMs) || 400));
  });
}

// -------------------- 持续放置命令处理 --------------------
async function handleCplaceCommand(context, content) {
  if (isContinuousPlacing) {
    context.replyInfo('已经在持续放置中，使用 stopcplace 停止');
    return;
  }
  
  try {
    const args = content.split(' ');
    let interval = placingInterval; // 默认间隔
    let shouldStopOnFailures = stopOnFailures; // 默认连续失败后停止
    
    // 检查参数
    for (let i = 1; i < args.length; i++) {
      const arg = args[i].toLowerCase();
      
      // 检查是否是数字（放置间隔）
      if (!isNaN(parseInt(arg)) && parseInt(arg) > 0) {
        interval = parseInt(arg);
        console.log(`[持续放置] 设置放置间隔为 ${interval} 毫秒`);
      }
      // 检查是否指定连续失败后停止
      else if (arg === 'stop' || arg === 'stoponfail') {
        shouldStopOnFailures = true;
        console.log(`[持续放置] 设置连续失败后停止`);
      }
      // 检查是否指定连续失败后继续
      else if (arg === 'nostop' || arg === 'continue') {
        shouldStopOnFailures = false;
        console.log(`[持续放置] 设置连续失败后继续`);
      }
    }
    
    // 检查手中是否有物品
    const heldItem = bot.heldItem;
    if (!heldItem) {
      // 尝试从快捷栏获取物品
      const quickBarSlot = bot.inventory.slots[bot.quickBarSlot];
      if (!quickBarSlot) {
        context.replyInfo('手中没有物品，无法放置');
        return;
      }
      // 设置手持物品
      await bot.equip(quickBarSlot, 'hand');
    }
    
    // 重新检查手中物品
    const finalHeldItem = bot.heldItem;
    if (!finalHeldItem) {
      context.replyInfo('无法获取手中物品，请确保有可放置的方块');
      return;
    }
    
    // 记录目标方块类型和名称
    targetBlockType = finalHeldItem.type;
    targetBlockMetadata = finalHeldItem.metadata || 0;
    targetBlockName = finalHeldItem.displayName || finalHeldItem.name;
    targetContext = context; // 设置通知目标
    
    // 保存当前视角作为原始视角
    originalYaw = bot.entity.yaw;
    originalPitch = bot.entity.pitch;
    placeCountSinceLastRestore = 0;
    
    console.log(`[持续放置] 保存原始视角: yaw=${originalYaw.toFixed(2)}°, pitch=${originalPitch.toFixed(2)}°`);
    console.log(`[持续放置] 目标方块: ${targetBlockName} (类型: ${targetBlockType}, 元数据: ${targetBlockMetadata})`);
    
    const itemName = targetBlockName;
    
    // 检查是否是重力方块
    const isGravityItem = isGravityBlock(targetBlockName);
    if (isGravityItem) {
      console.log(`[持续放置] 检测到重力方块，将忽略部分放置失败检测`);
    }
    
    // 根据设置显示不同的消息
    let stopMessage = shouldStopOnFailures ? "连续失败10次后停止" : "连续失败后继续尝试";
    context.replyInfo(`开始持续放置 ${itemName}，间隔 ${interval} 毫秒，${stopMessage}，使用 stopcplace 停止`);
    context.replyInfo('将会自动从背包寻找相同方块，用完为止');
    
    if (isGravityItem) {
      context.replyInfo('注意: 检测到重力方块，已调整放置逻辑');
    }
    
    console.log(`[持续放置] 开始放置 ${itemName}，间隔 ${interval}ms，连续失败后${shouldStopOnFailures ? '停止' : '继续'}`);
    
    // 重置状态
    isContinuousPlacing = true;
    stopContinuousPlacing = false;
    
    // 开始持续放置
    startContinuousPlacing(context, interval, shouldStopOnFailures, isGravityItem);
    
  } catch (error) {
    console.error('[持续放置] 命令执行失败:', error);
    context.replyError(`持续放置失败: ${error.message}`);
  }
}

// -------------------- 从背包寻找相同方块 --------------------
async function findAndEquipSameBlock() {
  try {
    console.log(`[持续放置] 正在从背包寻找相同方块: ${targetBlockName} (类型: ${targetBlockType})`);
    
    // 获取所有物品
    const items = bot.inventory.items();
    
    // 添加副手物品（如果适用）
    if (bot.registry && bot.registry.isNewerOrEqualTo && bot.registry.isNewerOrEqualTo('1.9')) {
      const offHandSlot = 45;
      const offHandItem = bot.inventory.slots[offHandSlot];
      if (offHandItem) {
        items.push(offHandItem);
      }
    }
    
    // 寻找匹配的方块
    let foundItem = null;
    let foundSlot = null;
    
    for (const item of items) {
      if (item.type === targetBlockType && 
          (item.metadata || 0) === targetBlockMetadata) {
        foundItem = item;
        foundSlot = item.slot;
        console.log(`[持续放置] 找到相同方块: ${item.displayName || item.name}，槽位: ${foundSlot}，数量: ${item.count}`);
        break;
      }
    }
    
    // 如果没找到完全匹配的，可以尝试只匹配类型（忽略元数据）
    if (!foundItem) {
      console.log(`[持续放置] 未找到完全匹配的方块，尝试只匹配类型...`);
      for (const item of items) {
        if (item.type === targetBlockType) {
          foundItem = item;
          foundSlot = item.slot;
          console.log(`[持续放置] 找到类型匹配方块: ${item.displayName || item.name}，槽位: ${foundSlot}，数量: ${item.count}`);
          // 更新元数据以便后续使用
          targetBlockMetadata = item.metadata || 0;
          targetBlockName = item.displayName || item.name;
          break;
        }
      }
    }
    
    if (foundItem && foundSlot !== null) {
      // 装备找到的方块
      console.log(`[持续放置] 正在装备方块: ${foundItem.displayName || foundItem.name}`);
      await bot.equip(foundItem, 'hand');
      
      // 验证装备是否成功
      const newHeldItem = bot.heldItem;
      if (newHeldItem && newHeldItem.type === targetBlockType) {
        console.log(`[持续放置] 成功装备方块: ${newHeldItem.displayName || newHeldItem.name}`);
        return true;
      } else {
        console.log(`[持续放置] 装备失败，手中物品不匹配`);
        return false;
      }
    }
    
    console.log(`[持续放置] 背包中没有找到相同的方块`);
    return false;
    
  } catch (error) {
    console.error(`[持续放置] 寻找和装备方块时出错:`, error);
    return false;
  }
}

// -------------------- 检查是否还有相同方块 --------------------
function checkRemainingBlocks() {
  try {
    // 获取所有物品
    const items = bot.inventory.items();
    
    // 添加副手物品
    if (bot.registry && bot.registry.isNewerOrEqualTo && bot.registry.isNewerOrEqualTo('1.9')) {
      const offHandSlot = 45;
      const offHandItem = bot.inventory.slots[offHandSlot];
      if (offHandItem) {
        items.push(offHandItem);
      }
    }
    
    // 统计相同方块的总数量
    let totalCount = 0;
    
    for (const item of items) {
      if (item.type === targetBlockType && 
          (item.metadata || 0) === targetBlockMetadata) {
        totalCount += item.count;
      }
    }
    
    console.log(`[持续放置] 背包中相同方块剩余: ${totalCount} 个`);
    return totalCount;
    
  } catch (error) {
    console.error(`[持续放置] 检查剩余方块时出错:`, error);
    return 0;
  }
}

// -------------------- 开始持续放置函数 --------------------
function startContinuousPlacing(context, baseInterval, shouldStopOnFailures, isGravityBlockItem) {
  // 放置计数器
  let placeCount = 0;
  let consecutiveFailures = 0;
  let currentInterval = baseInterval; // 当前使用的间隔
  let intervalAdjusted = false; // 标记是否已经调整过间隔
  let blockRefills = 0; // 方块补充次数
  let gravityBlockMode = isGravityBlockItem; // 是否为重力方块模式
  
  // 清除可能存在的旧定时器
  if (placingTimer) {
    clearInterval(placingTimer);
    placingTimer = null;
  }
  
  // 清除可能存在的视角恢复定时器
  if (viewRestoreTimer) {
    clearInterval(viewRestoreTimer);
    viewRestoreTimer = null;
  }
  
  // 启动视角恢复定时器（每5秒或每10次放置检查一次）
  viewRestoreTimer = setInterval(() => {
    if (!isContinuousPlacing) {
      clearInterval(viewRestoreTimer);
      return;
    }
    
    // 每5秒或每10次放置后恢复视角
    if (placeCountSinceLastRestore >= 10) {
      restoreOriginalView();
    }
  }, 5000); // 每5秒检查一次
  
  // 主要的放置循环函数
  async function performPlacement() {
    if (stopContinuousPlacing) {
      clearInterval(placingTimer);
      if (viewRestoreTimer) clearInterval(viewRestoreTimer);
      isContinuousPlacing = false;
      notifyTarget(`持续放置已停止，共放置 ${placeCount} 次，补充方块 ${blockRefills} 次`);
      console.log(`[持续放置] 停止，共放置 ${placeCount} 次，补充方块 ${blockRefills} 次`);
      return;
    }
    
    try {
      // 检查手中是否有物品
      let heldItem = bot.heldItem;
      
      // 如果手中没有物品或物品不匹配，尝试寻找并装备相同方块
      if (!heldItem || heldItem.type !== targetBlockType) {
        console.log(`[持续放置] 手中物品不匹配或为空，尝试寻找相同方块`);
        
        // 检查背包中是否还有相同方块
        const remainingCount = checkRemainingBlocks();
        if (remainingCount <= 0) {
          console.log(`[持续放置] 背包中没有相同方块，停止放置`);
          clearInterval(placingTimer);
          if (viewRestoreTimer) clearInterval(viewRestoreTimer);
          isContinuousPlacing = false;
          notifyTarget(`背包中没有 ${targetBlockName} 了，持续放置停止，共放置 ${placeCount} 次`);
          return;
        }
        
        // 寻找并装备相同方块
        const equipSuccess = await findAndEquipSameBlock();
        if (!equipSuccess) {
          console.log(`[持续放置] 装备方块失败，停止放置`);
          clearInterval(placingTimer);
          if (viewRestoreTimer) clearInterval(viewRestoreTimer);
          isContinuousPlacing = false;
          notifyTarget(`无法装备 ${targetBlockName}，持续放置停止`);
          return;
        }
        
        // 重新获取手中物品
        heldItem = bot.heldItem;
        if (!heldItem) {
          console.log(`[持续放置] 装备后手中仍无物品，停止放置`);
          clearInterval(placingTimer);
          if (viewRestoreTimer) clearInterval(viewRestoreTimer);
          isContinuousPlacing = false;
          notifyTarget('装备后手中仍无物品，持续放置停止');
          return;
        }
        
        blockRefills++;
        console.log(`[持续放置] 第 ${blockRefills} 次补充方块，当前手持: ${heldItem.displayName || heldItem.name}`);
        
        // 通知玩家已补充方块
        if (blockRefills === 1) {
          notifyTarget(`已从背包补充 ${targetBlockName}，继续放置`);
        } else if (blockRefills % 3 === 0) {
          notifyTarget(`第 ${blockRefills} 次补充 ${targetBlockName}，剩余 ${checkRemainingBlocks()} 个`);
        }
        
        // 重新检查是否为重力方块
        gravityBlockMode = isGravityBlock(heldItem.displayName || heldItem.name);
        if (gravityBlockMode) {
          console.log(`[持续放置] 检测到重力方块，忽略部分放置失败检测`);
        }
      }
      
      // 检查手中物品数量
      if (heldItem.count <= 0) {
        console.log(`[持续放置] 手中方块数量为0，尝试寻找新方块`);
        // 跳过当前放置循环，下一次循环会自动寻找新方块
        return;
      }
      
      // 放置方块
      const success = await simplePlaceBlock();
      
      if (success) {
        placeCount++;
        placeCountSinceLastRestore++;
        consecutiveFailures = 0; // 重置连续失败计数
        
        // 如果之前因为连续失败增加了间隔，现在重置回原始间隔
        if (intervalAdjusted) {
          intervalAdjusted = false;
          currentInterval = baseInterval;
          clearInterval(placingTimer);
          placingTimer = setInterval(performPlacement, currentInterval);
          console.log(`[持续放置] 放置成功，间隔重置为 ${currentInterval}ms`);
        }
        
        console.log(`[持续放置] 第 ${placeCount} 次放置成功，手中剩余: ${heldItem.count}`);
        
        // 每放置10次报告一次
        if (placeCount % 10 === 0 && placeCount > 0) {
          const remaining = checkRemainingBlocks();
          notifyTarget(`已持续放置 ${placeCount} 次，方块剩余: ${remaining} 个`);
        }
        
      } else {
        // 对于重力方块，不计入连续失败次数
        if (!gravityBlockMode) {
          consecutiveFailures++;
          console.log(`[持续放置] 放置失败，连续失败次数: ${consecutiveFailures}`);
        } else {
          console.log(`[持续放置] 重力方块放置失败（可能因重力下落），不计入连续失败`);
          // 重置连续失败计数，避免因重力方块的下落特性导致停止
          consecutiveFailures = 0;
        }
        
        // 对于非重力方块，处理失败逻辑
        if (!gravityBlockMode) {
          // 如果连续失败3次，增加间隔到1000ms
          if (consecutiveFailures >= 3 && !intervalAdjusted) {
            intervalAdjusted = true;
            currentInterval = 1000;
            clearInterval(placingTimer);
            placingTimer = setInterval(performPlacement, currentInterval);
            console.log(`[持续放置] 连续失败 ${consecutiveFailures} 次，间隔调整为 ${currentInterval}ms`);
            notifyTarget(`连续失败 ${consecutiveFailures} 次，已调整放置间隔为 ${currentInterval}ms`);
          }
          
          // 如果连续失败太多次，且设置了停止，则停止放置
          if (consecutiveFailures >= 10 && shouldStopOnFailures) {
            clearInterval(placingTimer);
            if (viewRestoreTimer) clearInterval(viewRestoreTimer);
            isContinuousPlacing = false;
            notifyTarget(`连续失败次数过多，持续放置已停止，共放置 ${placeCount} 次`);
            console.log(`[持续放置] 连续失败过多，停止`);
            return;
          }
          // 如果不停止，但连续失败过多，报告状态
          else if (consecutiveFailures >= 10 && !shouldStopOnFailures) {
            if (consecutiveFailures % 10 === 0) {
              const remaining = checkRemainingBlocks();
              notifyTarget(`连续失败 ${consecutiveFailures} 次，仍在尝试中...方块剩余: ${remaining} 个`);
            }
          }
        }
      }
      
    } catch (error) {
      console.error('[持续放置] 放置出错:', error.message);
      // 对于重力方块，错误也不计入连续失败
      if (!gravityBlockMode) {
        consecutiveFailures++;
      }
      
      // 如果错误导致连续失败过多，且设置了停止，则停止放置（仅非重力方块）
      if (consecutiveFailures >= 10 && shouldStopOnFailures && !gravityBlockMode) {
        clearInterval(placingTimer);
        if (viewRestoreTimer) clearInterval(viewRestoreTimer);
        isContinuousPlacing = false;
        notifyTarget('连续错误次数过多，持续放置已停止');
        console.log(`[持续放置] 连续错误过多，停止`);
        return;
      }
    }
  }
  
  // 启动放置定时器
  placingTimer = setInterval(performPlacement, currentInterval);
}

// -------------------- 简单的放置方块函数 --------------------
async function simplePlaceBlock() {
  try {
    const heldItem = bot.heldItem;
    if (!heldItem) {
      console.log(`[持续放置] 手中没有物品`);
      return false;
    }

    // 射线只用来决定"点哪一面"; 距离判定另算(与服务端口径一致)
    const targetBlock = bot.blockAtCursor(5.0);
    if (!targetBlock || targetBlock.face === undefined) {
      console.log(`[持续放置] 准星没有指向可放置的方块面`);
      return false;
    }

    const block = targetBlock;
    const face = targetBlock.face;

    const distance = distanceToBlockCube(bot.entity ? bot.entity.position : null, block.position);
    const limit = getInteractionLimit();
    if (distance === null) {
      console.log(`[持续放置] 无法计算与目标方块的距离`);
      return false;
    }
    if (distance > limit) {
      console.log(`[持续放置] 目标方块超出交互距离(实际 ${distance.toFixed(2)} 格, 上限 ${limit} 格)`);
      return false;
    }

    const client = bot._client;
    if (!client || typeof client.write !== 'function') {
      console.log(`[持续放置] 缺少 _client, 无法发送放置包`);
      return false;
    }

    const faceVector = getFaceVector(face);
    const placePosition = new Vec3(
      block.position.x + faceVector.x,
      block.position.y + faceVector.y,
      block.position.z + faceVector.z
    );

    // 目标位置必须可替换: 已经有方块就不要再发包(否则服务端拒绝, 会误判成功)
    const beforeBlock = typeof bot.blockAt === 'function' ? bot.blockAt(placePosition) : null;
    if (beforeBlock) {
      const beforeName = String(beforeBlock.name || '');
      const replaceable = beforeName === 'air' || beforeName === 'cave_air' || beforeName === 'void_air'
        || beforeName === 'water' || beforeName === 'lava';
      if (!replaceable) {
        console.log(`[持续放置] 目标位置已被 ${beforeName} 占用, 跳过`);
        return false;
      }
    }

    // 先挂监听再发包, 免得漏掉很快返回的 block_change
    const settled = waitForBlockChange(placePosition, 400);

    client.write('block_place', {
      hand: 0,
      location: { x: block.position.x, y: block.position.y, z: block.position.z },
      direction: face,
      cursorX: 0.5, cursorY: 0.5, cursorZ: 0.5,
      insideBlock: false, worldBorderHit: false,
      sequence: nextInteractionSequence()
    });

    const changed = await settled;
    if (!changed) {
      console.log(`[持续放置] 未在 400ms 内观察到放置结果`);
      return false;
    }

    // 双重校验: block_change 不一定代表这个地方真的变了, 用世界数据确认一次
    if (typeof bot.blockAt === 'function') {
      const afterBlock = bot.blockAt(placePosition);
      if (afterBlock) {
        const afterName = String(afterBlock.name || '');
        const stillEmpty = afterName === 'air' || afterName === 'cave_air' || afterName === 'void_air';
        if (stillEmpty) {
          console.log(`[持续放置] block_change 到了但该位置仍是空气, 视为失败`);
          return false;
        }
      }
    }

    console.log(`[持续放置] 放置成功 -> (${placePosition.x}, ${placePosition.y}, ${placePosition.z})`);
    return true;
  } catch (error) {
    console.error(`[持续放置] 放置方块时出错:`, error.message);
    return false;
  }
}

// -------------------- 恢复原始视角函数 --------------------
function restoreOriginalView() {
  if (!isContinuousPlacing) return;
  
  try {
    const currentYaw = bot.entity.yaw;
    const currentPitch = bot.entity.pitch;
    
    // 计算视角差异
    const yawDiff = Math.abs(currentYaw - originalYaw);
    const pitchDiff = Math.abs(currentPitch - originalPitch);
    
    // 如果视角差异较大（超过15度），恢复原始视角
    if (yawDiff > 15 || pitchDiff > 15) {
      console.log(`[视角恢复] 当前视角偏移较大 (yaw差: ${yawDiff.toFixed(2)}°, pitch差: ${pitchDiff.toFixed(2)}°)，恢复原始视角`);
      bot.look(originalYaw, originalPitch, true);
      placeCountSinceLastRestore = 0; // 重置放置计数
    } else {
      console.log(`[视角恢复] 当前视角偏移较小 (yaw差: ${yawDiff.toFixed(2)}°, pitch差: ${pitchDiff.toFixed(2)}°)，不恢复`);
    }
  } catch (error) {
    console.error('[视角恢复] 恢复视角出错:', error.message);
  }
}

// -------------------- 计算放置位置 --------------------
function calculatePlacePosition(blockPos, face) {
  switch (face) {
    case 0: // 下 (-Y)
      return new Vec3(blockPos.x, blockPos.y - 1, blockPos.z);
    case 1: // 上 (+Y)
      return new Vec3(blockPos.x, blockPos.y + 1, blockPos.z);
    case 2: // 北 (-Z)
      return new Vec3(blockPos.x, blockPos.y, blockPos.z - 1);
    case 3: // 南 (+Z)
      return new Vec3(blockPos.x, blockPos.y, blockPos.z + 1);
    case 4: // 西 (-X)
      return new Vec3(blockPos.x - 1, blockPos.y, blockPos.z);
    case 5: // 东 (+X)
      return new Vec3(blockPos.x + 1, blockPos.y, blockPos.z);
    default:
      return new Vec3(blockPos.x, blockPos.y + 1, blockPos.z); // 默认上方
  }
}

// -------------------- 获取面的法向量 --------------------
function getFaceVector(face) {
  switch (face) {
    case 0: return new Vec3(0, -1, 0);  // 下
    case 1: return new Vec3(0, 1, 0);   // 上
    case 2: return new Vec3(0, 0, -1);  // 北
    case 3: return new Vec3(0, 0, 1);   // 南
    case 4: return new Vec3(-1, 0, 0);  // 西
    case 5: return new Vec3(1, 0, 0);   // 东
    default: return new Vec3(0, 1, 0);  // 默认向上
  }
}

// -------------------- 检查方块是否可以放置 --------------------
function canPlaceAtBlock(block) {
  // 可以放置的方块类型：空气或可替换的方块
  const blockName = block.name.toLowerCase();
  
  // 可替换的方块列表
  const replaceableBlocks = [
    'air', 'grass', 'tall_grass', 'fern', 'large_fern',
    'dead_bush', 'vine', 'snow', 'water', 'lava',
    'seagrass', 'kelp', 'sea_pickle', 'coral', 'coral_fan',
    'fire', 'soul_fire', 'cave_air', 'void_air'
  ];
  
  // 检查方块名是否包含可替换的字符串
  return replaceableBlocks.some(replaceable => 
    blockName.includes(replaceable.toLowerCase())
  );
}

// -------------------- 停止持续放置命令处理 --------------------
async function handleStopCplaceCommand(context) {
  try {
    if (isContinuousPlacing) {
      stopContinuousPlacing = true;
      context.replyInfo('正在停止持续放置...');
      console.log(`[持续放置] 收到停止命令来自 ${context.label}`);
    } else {
      context.replyInfo('当前没有在持续放置');
    }
  } catch (error) {
    console.error('[持续放置] 停止命令执行失败:', error);
    context.replyError(`停止持续放置失败: ${error.message}`);
  }
}

// -------------------- 获取当前状态 --------------------
function getCplaceStatus() {
  return {
    isContinuousPlacing,
    stopContinuousPlacing,
    placingInterval,
    stopOnFailures,
    targetBlockName,
    targetBlockType,
    targetLabel: targetContext ? targetContext.label : null
  };
}

function stopContinuousPlacingNow() {
  stopContinuousPlacing = true;
  isContinuousPlacing = false;
  if (placingTimer) {
    clearInterval(placingTimer);
    placingTimer = null;
  }
  if (viewRestoreTimer) {
    clearInterval(viewRestoreTimer);
    viewRestoreTimer = null;
  }
}

function cleanupCplace() {
  stopContinuousPlacingNow();
  bot = null;
  originalYaw = 0;
  originalPitch = 0;
  placeCountSinceLastRestore = 0;
  targetBlockType = null;
  targetBlockMetadata = null;
  targetBlockName = '';
  targetContext = null;
}

// 导出所有函数
module.exports = {
  initCplace,
  handleCplaceCommand,
  handleStopCplaceCommand,
  getCplaceStatus,
  cleanupCplace,
  // 内部函数，供其他模块使用
  stopContinuousPlacing: stopContinuousPlacingNow,
  isContinuousPlacing: () => isContinuousPlacing
};
