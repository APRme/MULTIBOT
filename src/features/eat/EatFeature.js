const EXTRA_EDIBLE_ITEM_IDS = new Set([
  'ominous_bottle'
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

    const matches = this.inventoryFeature && typeof this.inventoryFeature.findItem === 'function'
      ? this.inventoryFeature.findItem(normalizedItemId, true)
      : [];
    const match = matches[0];

    if (!match || !match.item) {
      context.replyError(`未在背包中找到物品: ${rawItemId}`);
      return true;
    }

    if (!this.isAllowedEatItem(normalizedItemId)) {
      context.replyError(`物品 ${rawItemId} 不可食用`);
      return true;
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
    const itemName = targetItem.displayName || targetItem.name || normalizedItemId;

    let restoreMode = 'none';
    let consumeError = null;
    let restoreError = null;

    try {
      if (this.logger) {
        this.logger.info(`[EAT] try item=${normalizedItemId}`);
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

      await this.consumeHeldItemWithWhitelistSupport(normalizedItemId);
    } catch (error) {
      consumeError = error;
      if (this.logger) {
        this.logger.warn(`[EAT] consume failed item=${normalizedItemId}: ${error.message}`);
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
          this.logger.warn(`[EAT] restore failed item=${normalizedItemId}: ${error.message}`);
        }
      }
    }

    if (!consumeError && !restoreError) {
      if (this.logger) {
        this.logger.info(`[EAT] completed item=${itemName}`);
      }
      return true;
    }

    if (consumeError && !restoreError) {
      context.replyError(`食用失败: ${consumeError.message}`);
      return true;
    }

    if (!consumeError && restoreError) {
      context.replyError(`已食用 ${itemName}，但主手恢复失败: ${restoreError.message}`);
      return true;
    }

    context.replyError(`食用失败: ${consumeError.message}；主手恢复失败: ${restoreError.message}`);
    return true;
  }
}

module.exports = {
  EatFeature
};
