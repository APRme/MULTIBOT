const { pathfinder, goals: { GoalNear } } = require('mineflayer-pathfinder');
const { buildDefaultMovements } = require('../../util/pathfinding');

// 宝库和钥匙ID
const VAULT_BLOCK_ID = 'vault';
const TRIAL_KEY_ID = 'trial_key';
const OMINOUS_TRIAL_KEY_ID = 'ominous_trial_key';

let bot = null;
const cleanupCallbacks = new Set();
const trackedTimeouts = new Set();

function trackTimeout(callback, delayMs) {
  const timeoutId = setTimeout(() => {
    trackedTimeouts.delete(timeoutId);
    callback();
  }, delayMs);
  trackedTimeouts.add(timeoutId);
  return timeoutId;
}

function addTrackedBotListener(eventName, handler) {
  if (!bot || typeof bot.on !== 'function') {
    return () => {};
  }

  const target = bot;
  target.on(eventName, handler);
  const cleanup = () => {
    if (typeof target.removeListener === 'function') {
      target.removeListener(eventName, handler);
    }
    cleanupCallbacks.delete(cleanup);
  };
  cleanupCallbacks.add(cleanup);
  return cleanup;
}

function cleanupTrial() {
  for (const cleanup of Array.from(cleanupCallbacks)) {
    try {
      cleanup();
    } catch (error) {
    }
  }
  cleanupCallbacks.clear();

  for (const timeoutId of Array.from(trackedTimeouts)) {
    clearTimeout(timeoutId);
  }
  trackedTimeouts.clear();

  bot = null;
}

// 初始化模块
function initTrial(botInstance) {
  bot = botInstance;
  
  // 确保已加载pathfinder插件
  if (!bot.pathfinder) {
    bot.loadPlugin(pathfinder);
  }
}

// 查找最近的宝库方块
function findNearestVault(range = 10) {
  try {
    const vaultBlock = bot.findBlock({
      matching: (block) => {
        if (!block) return false;
        return block.name === VAULT_BLOCK_ID;
      },
      maxDistance: range
    });
    
    return vaultBlock;
  } catch (error) {
    console.error('[宝库] 查找宝库时出错:', error.message);
    return null;
  }
}

// 检查宝库是否为不详宝库
function isOminousVault(vaultBlock) {
  try {
    if (!vaultBlock) return false;
    
    // 获取方块状态
    const properties = vaultBlock.getProperties();
    
    // 检查是否有ominous属性
    if (properties && properties.ominous !== undefined) {
      return properties.ominous === 'true' || properties.ominous === true;
    }
    
    // 备选方案：检查方块元数据或特殊标记
    // 在1.21中，不详宝库可能有不同的纹理或外观
    return false;
  } catch (error) {
    console.error('[宝库] 检查宝库类型时出错:', error.message);
    return false;
  }
}

// 在背包中查找合适的钥匙
function findKeyForVault(isOminous) {
  const requiredKeyId = isOminous ? OMINOUS_TRIAL_KEY_ID : TRIAL_KEY_ID;
  
  const keys = bot.inventory.items().filter(item => 
    item.name === TRIAL_KEY_ID || item.name === OMINOUS_TRIAL_KEY_ID
  );
  
  return keys.find(key => key.name === requiredKeyId);
}

// 装备钥匙
async function equipKey(keyItem) {
  try {
    if (!keyItem) return false;
    
    await bot.equip(keyItem, 'hand');
    console.log(`[宝库] 已装备钥匙: ${keyItem.name}`);
    return true;
  } catch (error) {
    console.error('[宝库] 装备钥匙失败:', error.message);
    return false;
  }
}

// 移动到宝库附近
async function moveToVault(vaultBlock) {
  try {
    if (!bot.pathfinder) {
      console.error('[宝库] Pathfinder未加载');
      return false;
    }
    
    const targetPos = vaultBlock.position;
    const moveTarget = targetPos.offset(0.5, 0, 0.5);
    
    // 设置移动配置（默认仅普通走路）
    const defaultMove = buildDefaultMovements(bot);
    bot.pathfinder.setMovements(defaultMove);
    
    // 设置目标（宝库前2格位置）
    const goal = new GoalNear(moveTarget.x, moveTarget.y, moveTarget.z, 2);
    bot.pathfinder.setGoal(goal);
    
    console.log(`[宝库] 正在移动到宝库位置: (${targetPos.x}, ${targetPos.y}, ${targetPos.z})`);
    
    // 等待到达或超时
    return await waitForGoalReached(10000);
  } catch (error) {
    console.error('[宝库] 移动失败:', error.message);
    return false;
  }
}

// 等待目标到达
function waitForGoalReached(timeout = 10000) {
  return new Promise((resolve) => {
    let timeoutId = null;
    let reached = false;
    
    const goalReachedHandler = () => {
      if (reached) return;
      reached = true;
      
      if (timeoutId) {
        clearTimeout(timeoutId);
        trackedTimeouts.delete(timeoutId);
      }
      cleanupGoalReached();
      
      console.log('[宝库] 已到达宝库位置');
      resolve(true);
    };
    
    const cleanupGoalReached = addTrackedBotListener('goal_reached', goalReachedHandler);
    
    timeoutId = trackTimeout(() => {
      if (reached) return;
      
      cleanupGoalReached();
      console.log('[宝库] 移动超时');
      resolve(false);
    }, timeout);
  });
}

// 面向方块中心（与 afk.js 的 useblock 逻辑保持一致）
async function lookAtBlock(vaultBlock) {
  const blockCenter = vaultBlock.position.offset(0.5, 0.5, 0.5);
  const delta = blockCenter.minus(bot.entity.position);

  const yaw = Math.atan2(-delta.x, -delta.z);
  const horizontalDistance = Math.sqrt(delta.x * delta.x + delta.z * delta.z);
  const pitch = Math.atan2(delta.y, horizontalDistance);

  await bot.look(yaw, pitch, false);
}

// 激活宝库（使用钥匙打开） - 改为 useblock 同款逻辑
async function activateVault(vaultBlock) {
  try {
    await lookAtBlock(vaultBlock);
    await new Promise(resolve => setTimeout(resolve, 200));
    await bot.activateBlock(vaultBlock);
    console.log('[宝库] 成功打开宝库！');
    return true;
  } catch (error) {
    console.error('[宝库] 打开宝库失败:', error.message);
    return false;
  }
}

// 替代方案：使用简单的右键点击
async function activateVaultSimple(vaultBlock) {
  try {
    // 使用bot.activateItem()来右键点击（假设已经装备了钥匙）
    console.log('[宝库] 使用激活物品方法...');
    
    // 确保面向宝库
    await lookAtBlock(vaultBlock);
    await new Promise(resolve => setTimeout(resolve, 200));
    
    // 激活物品（右键）
    bot.activateItem();
    
    // 等待一小段时间
    await new Promise(resolve => setTimeout(resolve, 500));
    
    return true;
  } catch (error) {
    console.error('[宝库] 激活物品方法失败:', error.message);
    return false;
  }
}

// 监听宝库打开后的物品掉落
function setupVaultLootListener(vaultPosition) {
  // 监听实体生成事件（战利品会以物品实体形式出现）
  const entitySpawnHandler = (entity) => {
    // 检查是否为物品实体且在宝库附近
    if (entity.entityType === 2 && entity.position.distanceTo(vaultPosition) < 5) {
      const itemName = entity.name || '未知物品';
      console.log(`[宝库] 宝库掉落物品: ${itemName}`);
    }
  };
  
  const cleanupEntitySpawn = addTrackedBotListener('entitySpawn', entitySpawnHandler);
  
  // 返回清理函数
  return () => {
    cleanupEntitySpawn();
  };
}

// 主函数：自动打开最近的宝库
async function openNearestVault() {
  try {
    console.log('[宝库] 开始寻找并打开最近的宝库...');
    
    // 1. 查找最近的宝库
    const vaultBlock = findNearestVault(30);
    if (!vaultBlock) {
      console.log('[宝库] 附近没有找到宝库');
      return {
        success: false,
        message: '附近没有找到宝库'
      };
    }
    
    const vaultPos = vaultBlock.position;
    console.log(`[宝库] 找到宝库于位置: (${vaultPos.x}, ${vaultPos.y}, ${vaultPos.z})`);
    
    // 2. 检查宝库类型
    const isOminous = isOminousVault(vaultBlock);
    const vaultType = isOminous ? '不详宝库' : '普通宝库';
    console.log(`[宝库] 宝库类型: ${vaultType}`);
    
    // 3. 查找合适的钥匙
    const keyItem = findKeyForVault(isOminous);
    if (!keyItem) {
      console.log(`[宝库] 没有找到${isOminous ? '不详钥匙' : '普通钥匙'}`);
      return {
        success: false,
        message: `没有找到${isOminous ? '不详钥匙' : '普通钥匙'}`
      };
    }
    
    console.log(`[宝库] 找到钥匙: ${keyItem.name}`);
    
    // 4. 装备钥匙
    const equipped = await equipKey(keyItem);
    if (!equipped) {
      return {
        success: false,
        message: '装备钥匙失败'
      };
    }
    
    // 5. 移动到宝库前
    const moved = await moveToVault(vaultBlock);
    if (!moved) {
      return {
        success: false,
        message: '无法移动到宝库位置'
      };
    }
    
    // 6. 看向宝库（与 useblock 相同的朝向逻辑）
    await lookAtBlock(vaultBlock);
    
    // 7. 稍微延迟确保朝向完成
    await new Promise(resolve => setTimeout(resolve, 300));
    
    // 8. 设置战利品监听器
    const cleanupListener = setupVaultLootListener(vaultPos);
    
    // 9. 激活宝库 - 尝试多种方法
    let activated = false;
    
    // 方法1：使用激活方块
    activated = await activateVault(vaultBlock);
    
    // 如果方法1失败，尝试方法2：使用激活物品
    if (!activated) {
      console.log('[宝库] 方法1失败，尝试方法2...');
      activated = await activateVaultSimple(vaultBlock);
    }
    
    // 10. 清理监听器
    trackTimeout(() => {
      cleanupListener();
    }, 5000); // 5秒后清理监听器
    
    if (activated) {
      console.log('[宝库] 宝库打开流程完成');
      return {
        success: true,
        message: `成功打开${vaultType}`,
        position: vaultPos,
        type: vaultType
      };
    } else {
      return {
        success: false,
        message: '打开宝库失败'
      };
    }
    
  } catch (error) {
    console.error('[宝库] 打开宝库过程中出错:', error.message);
    return {
      success: false,
      message: `出错: ${error.message}`
    };
  }
}

// 处理私聊命令
function handleVaultCommand(context) {
  console.log(`[宝库] 收到来自 ${context.label} 的宝库命令`);
  
  // 异步执行，不阻塞主线程
  openNearestVault().then(result => {
    if (result.success) {
      const pos = result.position;
      context.replyInfo(`已成功打开${result.type}，位置: (${pos.x}, ${pos.y}, ${pos.z})`);
    } else {
      context.replyInfo(result.message);
    }
  }).catch(error => {
    console.error('[宝库] 宝库命令执行异常:', error);
    context.replyError(`宝库命令执行出错: ${error.message}`);
  });
}

// 导出模块
module.exports = {
  initTrial,
  cleanupTrial,
  handleVaultCommand,
  openNearestVault,
  findNearestVault,
  isOminousVault
};
