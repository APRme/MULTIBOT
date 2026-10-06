// 原版 alwaysEdible(满饱食度也能吃/喝)的物品与可饮用液体; 它们不受"饱食度已满就拒绝"的限制。
const EXTRA_EDIBLE_ITEM_IDS = new Set([
  'ominous_bottle',
  'golden_apple',
  'enchanted_golden_apple',
  'honey_bottle',
  'milk_bucket',
  'potion',
  'chorus_fruit'
]);

const MANUAL_CONSUME_TIMEOUT = 2500;
const PI = Math.PI;
const TO_DEG = 180 / PI;

function toDegrees(radians) {
  return radians * TO_DEG;
}

function toNotchianYaw(yaw) {
  return toDegrees(PI - yaw);
}

function toNotchianPitch(pitch) {
  return toDegrees(-pitch);
}

class EatFeature {
  constructor(options = {}) {
    this.logger = options.logger;
    this.inventoryFeature = options.inventoryFeature;
    this.fishFeature = options.fishFeature;
    this.bot = null;
    this.getRotation = options.getRotation || null;
    this.getSequence = typeof options.getSequence === 'function' ? options.getSequence : null;
    this.useItemSequence = 0;
    this.autoEatController = null;
  }

  attach(bot) {
    this.bot = bot;
  }

  stop() {
  }

  detach() {
    this.stop();
    this.bot = null;
  }

  ensureReady() {
    if (!this.bot) {
      throw new Error('eat feature not attached');
    }
  }

  normalizeEatItemId(raw) {
    const input = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    if (!input) return null;

    if (/^\d+$/.test(input)) {
      const itemId = Number.parseInt(input, 10);
      return this.bot.registry.items[itemId]?.name || null;
    }

    if (input.startsWith('minecraft:')) {
      const normalized = input.slice('minecraft:'.length).trim();
      return normalized || null;
    }

    return input;
  }

  isExtraEdibleItem(itemId) {
    return EXTRA_EDIBLE_ITEM_IDS.has(itemId);
  }

  isAllowedEatItem(itemId) {
    return Boolean(this.bot.registry.foodsByName?.[itemId] || this.isExtraEdibleItem(itemId));
  }

  isFishingActive() {
    if (!this.fishFeature) return false;
    if (typeof this.fishFeature.getState === 'function') {
      return this.fishFeature.getState().isFishing === true;
    }
    return this.fishFeature.isFishing === true;
  }

  getCurrentUseItemRotation() {
    const yaw = Number.isFinite(this.bot?.entity?.yaw) ? this.bot.entity.yaw : 0;
    const pitch = Number.isFinite(this.bot?.entity?.pitch) ? this.bot.entity.pitch : 0;
    return {
      x: Math.fround(toNotchianPitch(pitch)),
      y: Math.fround(toNotchianYaw(yaw))
    };
  }

  async withPreservedUseItemRotation(action) {
    if (!this.bot?._client || typeof this.bot._client.write !== 'function') {
      return await action();
    }

    const client = this.bot._client;
    const originalWrite = client.write;
    const boundOriginalWrite = originalWrite.bind(client);
    let restored = false;

    const restore = () => {
      if (restored) return;
      restored = true;
      client.write = originalWrite;
    };

    client.write = (name, payload) => {
      if (
        name === 'use_item' &&
        payload &&
        typeof payload === 'object' &&
        Object.prototype.hasOwnProperty.call(payload, 'rotation')
      ) {
        restore();
        return boundOriginalWrite(name, {
          ...payload,
          rotation: this.getCurrentUseItemRotation()
        });
      }

      return boundOriginalWrite(name, payload);
    };

    try {
      return await action();
    } finally {
      restore();
    }
  }

  async consumeHeldItemWithWhitelistSupport(itemId) {
    const isWhitelistFullFoodCase = (
      this.bot.game?.gameMode !== 'creative' &&
      this.bot.food === 20 &&
      this.isExtraEdibleItem(itemId)
    );

    if (!isWhitelistFullFoodCase || !this.bot._client || typeof this.bot.consume === 'function' && typeof this.bot.activateItem !== 'function') {
      await this.withPreservedUseItemRotation(() => this.bot.consume());
      return;
    }

    if (typeof this.bot.activateItem !== 'function') {
      await this.withPreservedUseItemRotation(() => this.bot.consume());
      return;
    }

    await new Promise((resolve, reject) => {
      const initialHeldItem = this.bot.heldItem;
      const initialHeldItemType = initialHeldItem?.type ?? null;
      const initialHeldItemCount = initialHeldItem?.count ?? null;

      if (!initialHeldItem) {
        reject(new Error('当前手中没有可食用物品'));
        return;
      }

      let settled = false;
      let timeoutId = null;

      const cleanup = () => {
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
        this.bot._client.removeListener('entity_status', onEntityStatus);
        this.bot.removeListener('heldItemChanged', onHeldItemChanged);
        this.bot._client.removeListener('set_cooldown', onSetCooldown);
      };

      const finish = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };

      const fail = (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };

      const onEntityStatus = (packet) => {
        if (packet.entityId === this.bot.entity?.id && packet.entityStatus === 9) {
          finish();
        }
      };

      const onHeldItemChanged = (heldItem) => {
        const typeChanged = (heldItem?.type ?? null) !== initialHeldItemType;
        const countChanged = (heldItem?.count ?? null) !== initialHeldItemCount;

        if (typeChanged || countChanged) {
          finish();
        }
      };

      const onSetCooldown = (packet) => {
        if (packet.itemID === initialHeldItemType) {
          finish();
        }
      };

      timeoutId = setTimeout(() => {
        if (this.bot.usingHeldItem && typeof this.bot.deactivateItem === 'function') {
          try {
            this.bot.deactivateItem();
          } catch (error) {
          }
        }

        fail(new Error('Consume timeout'));
      }, MANUAL_CONSUME_TIMEOUT);

      this.bot._client.on('entity_status', onEntityStatus);
      this.bot.on('heldItemChanged', onHeldItemChanged);
      this.bot._client.on('set_cooldown', onSetCooldown);

      try {
        this.withPreservedUseItemRotation(() => this.bot.activateItem()).catch(fail);
      } catch (error) {
        fail(error);
      }
    });
  }

  // ===== 轻量模式进食: 没有 mineflayer inventory 插件, 自建"使用物品"这一步 =====

  isFullConsumeAvailable() {
    return typeof this.bot?.consume === 'function';
  }

  nextUseItemSequence() {
    if (this.getSequence) return this.getSequence();

    this.useItemSequence = (this.useItemSequence + 1) % 32767;
    return this.useItemSequence;
  }

  resolveUseItemRotation() {
    if (Number.isFinite(this.bot?.entity?.yaw)) {
      return {
        x: Math.fround(toNotchianPitch(this.bot.entity.pitch)),
        y: Math.fround(toNotchianYaw(this.bot.entity.yaw))
      };
    }

    if (typeof this.getRotation === 'function') {
      const raw = this.getRotation();
      if (raw && Number.isFinite(raw.yaw) && Number.isFinite(raw.pitch)) {
        return {
          x: Math.fround(toNotchianPitch(raw.pitch)),
          y: Math.fround(toNotchianYaw(raw.yaw))
        };
      }
    }

    return { x: 0, y: 0 };
  }

  async consumeHeldItemLightweight(timeoutMs = MANUAL_CONSUME_TIMEOUT) {
    const client = this.bot && this.bot._client;
    if (!client || typeof client.write !== 'function') {
      throw new Error('当前连接不支持轻量进食');
    }

    await new Promise((resolve, reject) => {
      let settled = false;
      let timeoutId = null;
      const initialFood = this.bot.food;
      const initialHeldType = this.bot.heldItem ? this.bot.heldItem.type : null;

      const cleanup = () => {
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
        client.removeListener('entity_status', onEntityStatus);
        client.removeListener('set_slot', onSlotChanged);
        client.removeListener('window_items', onSlotChanged);
        client.removeListener('set_cooldown', onCooldown);
        this.bot.removeListener('health', onHealth);
      };

      const finish = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };

      const fail = (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };

      // 轻量模式没有 bot.entity: 用"我们自己刚发的 use_item"作为前提, 收到 9(进食完成) 即成功
      const onEntityStatus = (packet) => {
        if (!packet || packet.entityStatus !== 9) return;
        const selfId = this.bot.entity?.id;
        if (selfId === undefined || packet.entityId === selfId) {
          finish();
        }
      };

      const onSlotChanged = () => finish();
      const onCooldown = () => finish();
      const onHealth = () => {
        if (Number.isFinite(initialFood) && Number.isFinite(this.bot.food) && this.bot.food > initialFood) {
          finish();
          return;
        }
        const heldType = this.bot.heldItem ? this.bot.heldItem.type : null;
        if (heldType !== initialHeldType) {
          finish();
        }
      };

      client.on('entity_status', onEntityStatus);
      client.on('set_slot', onSlotChanged);
      client.on('window_items', onSlotChanged);
      client.on('set_cooldown', onCooldown);
      this.bot.on('health', onHealth);

      timeoutId = setTimeout(() => fail(new Error('Consume timeout')), timeoutMs);

      try {
        client.write('use_item', {
          hand: 0,
          sequence: this.nextUseItemSequence(),
          rotation: this.resolveUseItemRotation()
        });
      } catch (error) {
        fail(error);
      }
    });
  }

  async consumeHeldItem(itemId) {
    if (this.isFullConsumeAvailable()) {
      await this.consumeHeldItemWithWhitelistSupport(itemId);
      return;
    }

    await this.consumeHeldItemLightweight();
  }

  // 命令与自动进食共用: 找到物品 -> 弄到主手 -> 吃 -> 还原, 返回结构化结果(不回复消息)
  async consumeFromInventory(itemId) {
    const matches = this.inventoryFeature && typeof this.inventoryFeature.findItem === 'function'
      ? this.inventoryFeature.findItem(itemId, true)
      : [];
    const match = matches[0];

    if (!match || !match.item) {
      return { ok: false, stage: 'find', itemId, itemName: itemId };
    }

    if (!this.isAllowedEatItem(itemId)) {
      return { ok: false, stage: 'validate', itemId, itemName: itemId };
    }

    // 普通食物在满饱食度时原版拒绝进食(白名单物品如不详之瓶不受限), 提前给出清晰错误而不是等超时
    const isWhitelistItem = this.isExtraEdibleItem(itemId);
    if (!isWhitelistItem && this.bot.game?.gameMode !== 'creative' && this.bot.food === 20) {
      return { ok: false, stage: 'full', itemId, itemName: itemId };
    }

    const inventory = this.bot.inventory;
    const hotbarStart = inventory.hotbarStart ?? 36;
    const handSlot = hotbarStart + this.bot.quickBarSlot;
    const previousQuickBarSlot = this.bot.quickBarSlot;
    const originalHandItem = inventory.slots[handSlot];
    const targetItem = match.item;
    const sourceSlot = targetItem.slot;
    const isTargetInCurrentHand = sourceSlot === handSlot;
    const isTargetInHotbar = sourceSlot >= hotbarStart && sourceSlot < hotbarStart + 9;
    const itemName = targetItem.displayName || targetItem.name || itemId;

    let restoreMode = 'none';
    let consumeError = null;
    let restoreError = null;

    try {
      if (this.logger) {
        this.logger.info(`[EAT] try item=${itemId} mode=${this.isFullConsumeAvailable() ? 'full' : 'lightweight'}`);
      }

      if (isTargetInCurrentHand) {
        restoreMode = 'none';
      } else if (isTargetInHotbar) {
        await this.bot.setQuickBarSlot(sourceSlot - hotbarStart);
        restoreMode = 'quickbar';
      } else {
        await this.bot.moveSlotItem(sourceSlot, handSlot);
        restoreMode = originalHandItem ? 'swap-back' : 'move-back';
      }

      await this.consumeHeldItem(itemId);
    } catch (error) {
      consumeError = error;
      if (this.logger) {
        this.logger.warn(`[EAT] consume failed item=${itemId}: ${error.message}`);
      }
    } finally {
      try {
        if (restoreMode === 'quickbar') {
          await this.bot.setQuickBarSlot(previousQuickBarSlot);
        } else if (restoreMode === 'swap-back') {
          await this.bot.moveSlotItem(sourceSlot, handSlot);
        } else if (restoreMode === 'move-back') {
          if (this.bot.inventory.slots[handSlot]) {
            await this.bot.moveSlotItem(handSlot, sourceSlot);
          }
        }
      } catch (error) {
        restoreError = error;
        if (this.logger) {
          this.logger.warn(`[EAT] restore failed item=${itemId}: ${error.message}`);
        }
      }
    }

    if (!consumeError && !restoreError) {
      if (this.logger) {
        this.logger.info(`[EAT] completed item=${itemName}`);
      }
      return { ok: true, itemId, itemName };
    }

    return { ok: false, stage: 'consume', itemId, itemName, consumeError, restoreError };
  }

  async handleAutoEatCommand(context, arg) {
    this.ensureReady();

    if (!this.autoEatController) {
      context.replyError('自动进食不可用(需要背包处理能力)');
      return true;
    }

    const action = String(arg || 'status').trim().toLowerCase();

    if (action === 'on' || action === 'off') {
      const enabled = action === 'on';
      this.autoEatController.setEnabled(enabled);
      context.replyInfo(`自动进食已${enabled ? '开启' : '关闭'}`);
      return true;
    }

    if (action === 'status' || action === '') {
      const state = this.autoEatController.getState();
      const foodText = state.items.length > 0 ? state.items.join(',') : '自动择优';
      const lastText = state.lastResult ? ` | 上次=${state.lastResult}` : '';
      context.replyInfo(`自动进食: ${state.enabled ? '开启' : '关闭'} | 阈值=${state.threshold} | 食物=${foodText} | 当前饱食=${this.bot.food}${lastText}`);
      return true;
    }

    context.replyError('用法: autoeat on|off|status');
    return true;
  }

  async handleEatCommand(context, itemArg) {
    this.ensureReady();

    const rawItemId = typeof itemArg === 'string' ? itemArg.trim() : '';
    if (!rawItemId) {
      context.replyError('用法: eat <物品id>');
      return true;
    }

    const normalizedItemId = this.normalizeEatItemId(rawItemId);
    if (!normalizedItemId) {
      context.replyError(`未知物品ID: ${rawItemId}`);
      return true;
    }

    if (this.bot.currentWindow !== null) {
      context.replyError('请先关闭当前容器界面');
      return true;
    }

    if (this.isFishingActive()) {
      context.replyError('当前正在钓鱼，请先使用 fish 停止钓鱼');
      return true;
    }

    if (this.bot.usingHeldItem) {
      context.replyError('当前正在使用手持物品，请稍后再试');
      return true;
    }

    const result = await this.consumeFromInventory(normalizedItemId);

    if (result.ok) {
      return true;
    }

    if (result.stage === 'find') {
      context.replyError(`未在背包中找到物品: ${rawItemId}`);
      return true;
    }

    if (result.stage === 'validate') {
      context.replyError(`物品 ${rawItemId} 不可食用`);
      return true;
    }

    if (result.stage === 'full') {
      context.replyError(`饱食度已满，无需进食 ${rawItemId}`);
      return true;
    }

    if (result.consumeError && !result.restoreError) {
      context.replyError(`食用失败: ${result.consumeError.message}`);
      return true;
    }

    if (!result.consumeError && result.restoreError) {
      context.replyError(`已食用 ${result.itemName}，但主手恢复失败: ${result.restoreError.message}`);
      return true;
    }

    context.replyError(`食用失败: ${result.consumeError.message}；主手恢复失败: ${result.restoreError.message}`);
    return true;
  }
}

module.exports = {
  EatFeature
};
