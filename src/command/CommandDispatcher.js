const { parseMovementOptions } = require('../util/pathfinding');

class CommandDispatcher {
  constructor(options = {}) {
    this.runtime = options.runtime;
    this.logger = options.logger;
    this.lockFeature = options.lockFeature;
    this.inventoryFeature = options.inventoryFeature;
    this.movementFeature = options.movementFeature;
    this.rideFeature = options.rideFeature;
    this.fishFeature = options.fishFeature;
    this.vaultFeature = options.vaultFeature;
    this.attackFeature = options.attackFeature;
    this.entityInteractFeature = options.entityInteractFeature;
    this.blockUseFeature = options.blockUseFeature;
    this.digFeature = options.digFeature;
    this.cplaceFeature = options.cplaceFeature;
    this.scriptFeature = options.scriptFeature;
    this.recorderFeature = options.recorderFeature;
    this.teleportFeature = options.teleportFeature;
    this.eatFeature = options.eatFeature;
    this.windowFeature = options.windowFeature;
  }

  getCapabilities() {
    if (this.runtime && typeof this.runtime.getCapabilities === 'function') {
      return this.runtime.getCapabilities();
    }

    return {
      entityHandling: true,
      terrainHandling: true
    };
  }

  isEntityHandlingEnabled() {
    return this.getCapabilities().entityHandling !== false;
  }

  isTerrainHandlingEnabled() {
    return this.getCapabilities().terrainHandling !== false;
  }

  formatCapabilitySuffix(requirements = {}) {
    const disabled = [];

    if (requirements.entityHandling === true && !this.isEntityHandlingEnabled()) {
      disabled.push('entityHandling');
    }

    if (requirements.terrainHandling === true && !this.isTerrainHandlingEnabled()) {
      disabled.push('terrainHandling');
    }

    return disabled.length > 0 ? ` [已禁用: ${disabled.join('+')}]` : '';
  }

  ensureCapabilities(context, commandLabel, requirements = {}) {
    const disabled = [];

    if (requirements.entityHandling === true && !this.isEntityHandlingEnabled()) {
      disabled.push('实体处理');
    }

    if (requirements.terrainHandling === true && !this.isTerrainHandlingEnabled()) {
      disabled.push('地形处理');
    }

    if (disabled.length === 0) {
      return true;
    }

    context.replyError(`该实例已禁用${disabled.join('和')}，无法执行 ${commandLabel}`);
    return false;
  }

  ensureEntityHandling(context, commandLabel) {
    return this.ensureCapabilities(context, commandLabel, { entityHandling: true });
  }

  ensureTerrainHandling(context, commandLabel) {
    return this.ensureCapabilities(context, commandLabel, { terrainHandling: true });
  }

  ensureEntityAndTerrainHandling(context, commandLabel) {
    return this.ensureCapabilities(context, commandLabel, {
      entityHandling: true,
      terrainHandling: true
    });
  }

  getHelpLines() {
    const capabilities = this.getCapabilities();
    const withCapability = (line, requirements) => `  ${line}${this.formatCapabilitySuffix(requirements)}`;

    return [
      '可用命令:',
      '  health',
      '  getpos',
      '  send <内容>',
      '  broadcast send <内容> | broadcast inv <子命令> | broadcast eat <物品id>',
      '  inv ...',
      '  chest <info|move|close|help>',
      '  changeslot <1-9|info>',
      '  look <yaw> <pitch>',
      withCapability('goto <x> <y> <z> [选项...]', { terrainHandling: true }),
      '  shift',
      '  circle',
      withCapability('ride | ride player | ride w [a]', { entityHandling: true, terrainHandling: true }),
      withCapability('fish', { entityHandling: true }),
      '  eat <物品id>',
      withCapability('attack @n', { entityHandling: true }),
      withCapability('interact @n', { entityHandling: true }),
      withCapability('useblock <x> <y> <z>', { terrainHandling: true }),
      withCapability('cuseblock <x> <y> <z>', { terrainHandling: true }),
      '  stopplace',
      withCapability('dig <x> <y> <z>', { terrainHandling: true }),
      withCapability('dig <x1> <y1> <z1> <x2> <y2> <z2>', { terrainHandling: true }),
      '  stopdig',
      withCapability('cplace [间隔ms] [stop|nostop]', { terrainHandling: true }),
      '  stopcplace',
      withCapability('vault', { terrainHandling: true }),
      '  script <文件>',
      '  stopscript',
      '  reloadwhitelist',
      '  recordstatus',
      '  finishrecord',
      '  abortrecord',
      withCapability('entity list', { entityHandling: true }),
      '  lock / unlock',
      `当前能力: entityHandling=${capabilities.entityHandling ? 'on' : 'off'} terrainHandling=${capabilities.terrainHandling ? 'on' : 'off'}`
    ];
  }

  async dispatch(content, context) {
    const trimmed = String(content || '').trim();
    if (!trimmed) {
      return true;
    }

    const rawParts = trimmed.split(/\s+/).filter(Boolean);
    const lowerParts = rawParts.map((part) => part.toLowerCase());
    const command = lowerParts[0] || '';

    if (await this.lockFeature.handleLockCommand(context, rawParts)) {
      return true;
    }

    if (await this.lockFeature.handleUnlockCommand(context, rawParts)) {
      return true;
    }

    if (
      this.lockFeature.shouldEnforceWhisperLock(context) &&
      !this.lockFeature.isAllowedWhisperCommandDuringLock(trimmed, rawParts)
    ) {
      this.lockFeature.replyTeleportLockBlocked(context);
      return true;
    }

    if (await this.scriptFeature.tryHandleScriptControlCommand(context, trimmed)) {
      return true;
    }

    if (command === 'help') {
      this.getHelpLines().forEach((line) => context.replyInfo(line));
      return true;
    }

    if (command === 'health' && rawParts.length === 1) {
      context.replyInfo(this.runtime.getHealthText());
      return true;
    }

    if (command === 'getpos' && rawParts.length === 1) {
      context.replyInfo(this.runtime.getPositionText());
      return true;
    }

    if (command === 'recordstatus' && rawParts.length === 1) {
      context.replyInfo(this.recorderFeature.getStatusText());
      return true;
    }

    if (command === 'finishrecord' && rawParts.length === 1) {
      await this.recorderFeature.finish('manual_finish');
      context.replyInfo(this.recorderFeature.getStatusText());
      return true;
    }

    if (command === 'abortrecord' && rawParts.length === 1) {
      await this.recorderFeature.abort('manual_abort');
      context.replyInfo('录制已中止');
      return true;
    }

    if (command === 'send') {
      const message = trimmed.slice(rawParts[0].length).trim();
      if (!message) {
        context.replyError('用法: send <内容>');
        return true;
      }

      this.runtime.sendChat(message);
      context.replyInfo(`已发送: ${message}`);
      return true;
    }

    if (command === 'broadcast') {
      const broadcastBody = trimmed.slice(rawParts[0].length).trim();
      if (!broadcastBody) {
        context.replyError('用法: broadcast send <内容> | broadcast inv <子命令> | broadcast eat <物品id>');
        return true;
      }

      if (/^send(\s+|$)/i.test(broadcastBody)) {
        const message = broadcastBody.replace(/^send\s*/i, '').trim();
        if (!message) {
          context.replyError('用法: broadcast send <内容>');
          return true;
        }

        this.runtime.broadcastSend(message);
        context.replyInfo(`已发送广播请求: send ${message}`);
        return true;
      }

      if (/^inv(\s+|$)/i.test(broadcastBody)) {
        const inventoryCommand = broadcastBody.trim();
        const inventoryBody = inventoryCommand.replace(/^inv\s*/i, '').trim();
        if (!inventoryBody) {
          context.replyError('用法: broadcast inv <子命令>');
          return true;
        }

        const result = await this.runtime.broadcastCommand(inventoryCommand, {
          source: context ? context.source : null,
          sender: context ? context.sender : null
        });

        context.replyInfo(
          `已广播执行: ${inventoryCommand}（成功 ${result.successBotIds.length}，失败 ${result.failed.length}，跳过 ${result.skippedBotIds.length}）`
        );
        return true;
      }

      if (/^eat(\s+|$)/i.test(broadcastBody)) {
        const eatCommand = broadcastBody.trim();
        const eatArg = eatCommand.replace(/^eat\s*/i, '').trim();
        if (!eatArg) {
          context.replyError('用法: broadcast eat <物品id>');
          return true;
        }

        const result = await this.runtime.broadcastCommand(eatCommand, {
          source: context ? context.source : null,
          sender: context ? context.sender : null
        });

        context.replyInfo(
          `已广播执行: ${eatCommand}（成功 ${result.successBotIds.length}，失败 ${result.failed.length}，跳过 ${result.skippedBotIds.length}）`
        );
        return true;
      }

      context.replyError('广播目前仅支持 send、inv ... 和 eat ...');
      return true;
    }

    if (command === 'inv') {
      await this.inventoryFeature.handleCommand(context, trimmed);
      return true;
    }

    if (command === 'chest') {
      if (!this.windowFeature || typeof this.windowFeature.handleChestCommand !== 'function') {
        context.replyError('窗口模块未初始化');
        return true;
      }

      await this.windowFeature.handleChestCommand(context, trimmed);
      return true;
    }

    if (command === 'changeslot') {
      if (lowerParts[1] === 'info' && rawParts.length === 2) {
        context.replyInfo(this.inventoryFeature.getQuickbarText());
        return true;
      }

      const slotNumber = Number.parseInt(rawParts[1], 10);
      if (!Number.isInteger(slotNumber) || slotNumber < 1 || slotNumber > 9 || rawParts.length !== 2) {
        context.replyError('用法: changeslot <1-9|info>');
        return true;
      }

      await this.runtime.changeSlot(slotNumber);
      context.replyInfo(`已切换到快捷栏 ${slotNumber}`);
      return true;
    }

    if (command === 'look') {
      if (rawParts.length !== 3) {
        context.replyError('用法: look <yaw> <pitch>');
        return true;
      }

      const yaw = Number.parseFloat(rawParts[1]);
      const pitch = Number.parseFloat(rawParts[2]);
      if (Number.isNaN(yaw) || Number.isNaN(pitch)) {
        context.replyError('yaw 和 pitch 必须是数字');
        return true;
      }

      await this.movementFeature.lookDegrees(context, yaw, pitch);
      context.replyInfo(`已转向 yaw=${yaw} pitch=${pitch}`);
      return true;
    }

    if (command === 'goto') {
      if (!this.ensureTerrainHandling(context, 'goto')) {
        return true;
      }

      if (rawParts.length < 4) {
        context.replyError('用法: goto <x> <y> <z> [选项...]（选项: sprint/dig/tower/parkour，可组合；默认仅普通走路）');
        return true;
      }

      const x = Number.parseFloat(rawParts[1]);
      const y = Number.parseFloat(rawParts[2]);
      const z = Number.parseFloat(rawParts[3]);

      if ([x, y, z].some((value) => Number.isNaN(value))) {
        context.replyError('坐标必须是数字');
        return true;
      }

      const movementOptions = parseMovementOptions(rawParts.slice(4));
      if (movementOptions === null) {
        context.replyError('无效的移动选项，可用: sprint/dig/tower/parkour（可组合，例如 "goto 10 64 20 dig sprint"）');
        return true;
      }

      this.movementFeature.goto(x, y, z, movementOptions);
      context.replyInfo(
        `正在移动到 (${x}, ${y}, ${z})${movementOptions.length > 0 ? ` (${movementOptions.join('+')})` : ' (仅走路)'}`
      );
      return true;
    }

    if (command === 'shift' && rawParts.length === 1) {
      return this.movementFeature.toggleSneak(context);
    }

    if (command === 'circle' && rawParts.length === 1) {
      return this.movementFeature.toggleCircle(context);
    }

    if (command === 'ride') {
      if (!this.ensureEntityAndTerrainHandling(context, 'ride')) {
        return true;
      }

      if (this.movementFeature && typeof this.movementFeature.stopCircle === 'function') {
        this.movementFeature.stopCircle();
      }
      return this.rideFeature.handleRideCommand(context, rawParts);
    }

    if (command === 'fish' && rawParts.length === 1) {
      if (!this.ensureEntityHandling(context, 'fish')) {
        return true;
      }

      return this.fishFeature.handleFishCommand(context);
    }

    if (command === 'eat') {
      const itemArg = trimmed.slice(rawParts[0].length).trim();
      return this.eatFeature.handleEatCommand(context, itemArg);
    }

    if (command === 'attack' && lowerParts[1] === '@n' && rawParts.length === 2) {
      if (!this.ensureEntityHandling(context, 'attack @n')) {
        return true;
      }

      return this.attackFeature.handleAttackNearestCommand(context);
    }

    if ((command === 'interact' || command === 'activate') && lowerParts[1] === '@n' && rawParts.length === 2) {
      if (!this.ensureEntityHandling(context, `${command} @n`)) {
        return true;
      }

      return this.entityInteractFeature.handleInteractNearestCommand(context);
    }

    if (command === 'useblock') {
      if (!this.ensureTerrainHandling(context, 'useblock')) {
        return true;
      }

      if (rawParts.length !== 4) {
        context.replyError('用法: useblock x y z');
        return true;
      }

      const x = Number.parseInt(rawParts[1], 10);
      const y = Number.parseInt(rawParts[2], 10);
      const z = Number.parseInt(rawParts[3], 10);
      if ([x, y, z].some((value) => Number.isNaN(value))) {
        context.replyError('坐标必须是数字');
        return true;
      }

      return this.blockUseFeature.handleUseBlockCommand(context, x, y, z);
    }

    if (command === 'cuseblock') {
      if (!this.ensureTerrainHandling(context, 'cuseblock')) {
        return true;
      }

      if (rawParts.length !== 4) {
        context.replyError('用法: cuseblock x y z');
        return true;
      }

      const x = Number.parseInt(rawParts[1], 10);
      const y = Number.parseInt(rawParts[2], 10);
      const z = Number.parseInt(rawParts[3], 10);
      if ([x, y, z].some((value) => Number.isNaN(value))) {
        context.replyError('坐标必须是数字');
        return true;
      }

      return this.blockUseFeature.handleContinuousUseBlockCommand(context, x, y, z);
    }

    if (command === 'stopplace' && rawParts.length === 1) {
      return this.blockUseFeature.stopContinuousPlacement(context);
    }

    if (command === 'stop' && lowerParts[1] === 'cuseblock' && rawParts.length === 2) {
      return this.blockUseFeature.stopContinuousPlacement(context);
    }

    if (command === 'stopdig' && rawParts.length === 1) {
      return this.digFeature.stopDigging(context);
    }

    if (command === 'dig') {
      if (!this.ensureTerrainHandling(context, 'dig')) {
        return true;
      }

      if (rawParts.length === 7) {
        const x1 = Number.parseInt(rawParts[1], 10);
        const y1 = Number.parseInt(rawParts[2], 10);
        const z1 = Number.parseInt(rawParts[3], 10);
        const x2 = Number.parseInt(rawParts[4], 10);
        const y2 = Number.parseInt(rawParts[5], 10);
        const z2 = Number.parseInt(rawParts[6], 10);
        if ([x1, y1, z1, x2, y2, z2].some((value) => Number.isNaN(value))) {
          context.replyError('坐标必须是数字');
          return true;
        }

        return this.digFeature.handleAreaDigCommand(context, x1, y1, z1, x2, y2, z2);
      }

      if (rawParts.length !== 4) {
        context.replyError('用法: dig x y z | dig x1 y1 z1 x2 y2 z2');
        return true;
      }

      const x = Number.parseInt(rawParts[1], 10);
      const y = Number.parseInt(rawParts[2], 10);
      const z = Number.parseInt(rawParts[3], 10);
      if ([x, y, z].some((value) => Number.isNaN(value))) {
        context.replyError('坐标必须是数字');
        return true;
      }

      return this.digFeature.handleDigCommand(context, x, y, z);
    }

    if (command === 'cplace') {
      if (!this.ensureTerrainHandling(context, 'cplace')) {
        return true;
      }

      return this.cplaceFeature.handleCommand(context, trimmed);
    }

    if (command === 'stopcplace' && rawParts.length === 1) {
      return this.cplaceFeature.handleStopCommand(context);
    }

    if (command === 'vault' && rawParts.length === 1) {
      if (!this.ensureTerrainHandling(context, 'vault')) {
        return true;
      }

      this.vaultFeature.handleCommand(context);
      return true;
    }

    if (command === 'reloadwhitelist' && rawParts.length === 1) {
      const info = this.teleportFeature.refreshWhitelist();
      context.replyInfo(`白名单已刷新，当前共有 ${info.count} 个玩家`);
      return true;
    }

    if (command === 'stop' && rawParts.length === 1) {
      this.runtime.stopAllActions();
      const scriptStopped = this.scriptFeature.stopActiveScript({
        context,
        silentIfNotRunning: true,
        silentRequesterAck: false
      });
      if (!scriptStopped) {
        context.replyInfo('已停止当前动作');
      }
      return true;
    }

    if (command === 'entity' && lowerParts[1] === 'list' && rawParts.length === 2) {
      if (!this.ensureEntityHandling(context, 'entity list')) {
        return true;
      }

      context.replyInfo(this.runtime.getEntityListText());
      return true;
    }

    if (context && context.source !== 'console') {
      context.replyInfo(`命令未迁移或未识别: ${trimmed}`);
    }

    return false;
  }
}

module.exports = {
  CommandDispatcher
};
