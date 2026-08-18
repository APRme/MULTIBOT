function renderChatMessage(value) {
  if (!value) return '';

  if (typeof value === 'string') {
    return removeMinecraftFormatting(value);
  }

  if (value.json) {
    return renderChatMessage(value.json);
  }

  if (value.translate) {
    return renderTranslateMessage(value);
  }

  let result = '';
  if (typeof value[''] === 'string') {
    result += removeMinecraftFormatting(value['']);
  }

  if (typeof value.text === 'string') {
    result += removeMinecraftFormatting(value.text);
  }

  if (Array.isArray(value.extra)) {
    result += renderChatExtra(value.extra);
  }

  if (Array.isArray(value.with)) {
    result += value.with.map(renderChatArgument).filter((part) => part !== '').join(' ');
  }

  if (!result && typeof value.toString === 'function') {
    const rendered = value.toString();
    if (rendered && rendered !== '[object Object]') {
      return removeMinecraftFormatting(rendered);
    }
  }

  return result;
}

function parseChatMessage(value) {
  return renderChatMessage(value).trim();
}

function removeMinecraftFormatting(text) {
  return String(text || '')
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/§[0-9a-fk-or]/gi, '')
    .replace(/#([0-9a-fA-F]{6})/g, '');
}

function renderChatExtra(extra) {
  if (!Array.isArray(extra)) return '';
  return extra.map(renderChatMessage).join('');
}

function renderChatArgument(value) {
  if (!value) return '';
  if (typeof value === 'string') return removeMinecraftFormatting(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);

  if (typeof value.text === 'string' && value.text.length > 0) {
    return removeMinecraftFormatting(value.text);
  }

  if (typeof value[''] === 'string' && value[''].length > 0) {
    return removeMinecraftFormatting(value['']);
  }

  if (Array.isArray(value.extra)) {
    const rendered = renderChatExtra(value.extra);
    if (rendered) return rendered;
  }

  if (value.json) {
    const rendered = renderChatMessage(value.json);
    if (rendered) return rendered;
  }

  if (value.translate === 'chat.square_brackets' && Array.isArray(value.with) && value.with.length > 0) {
    const inner = renderChatArgument(value.with[0]);
    return inner ? `[${inner}]` : '[chat.square_brackets]';
  }

  if (value.translate) {
    return renderTranslateMessage(value);
  }

  return '';
}

function renderUnknownCommandContext(message) {
  const parts = Array.isArray(message.extra) ? message.extra : [];
  let hasCommandContext = false;
  let errorCommand = '';

  for (const part of parts) {
    if (!part) continue;

    if (part.translate === 'command.context.here' || part.json?.translate === 'command.context.here') {
      hasCommandContext = true;
    }

    if (Array.isArray(part.extra)) {
      for (const subPart of part.extra) {
        if (!subPart) continue;
        if (typeof subPart.text === 'string' && subPart.text !== '\n') {
          errorCommand += subPart.text;
        } else if (subPart.translate === 'command.context.here' || subPart.json?.translate === 'command.context.here') {
          hasCommandContext = true;
        }
      }
    }

    if (typeof part.text === 'string' && part.text !== '\n') {
      errorCommand += part.text;
    }
  }

  return hasCommandContext && errorCommand ? `${errorCommand}<--[此处]` : null;
}

function renderTranslateMessage(message) {
  if (message.translate === 'command.unknown.command') {
    return '未知或不完整的命令';
  }

  const unknownCommandContext = renderUnknownCommandContext(message);
  if (unknownCommandContext) return unknownCommandContext;

  if (message.translate === 'commands.message.display.incoming') {
    const sender = message.with?.[0] ? renderChatArgument(message.with[0]) : '未知玩家';
    const content = message.with?.[1] ? renderChatArgument(message.with[1]) : '';
    return `${sender} whispers to you: ${content}`;
  }

  if (message.translate === 'chat.type.admin') {
    const admin = message.with?.[0] ? renderChatArgument(message.with[0]) : '未知管理员';
    const command = message.with?.[1] ? renderChatArgument(message.with[1]) : '未知命令';
    return `[${admin}: ${command}]`;
  }

  if (message.translate === 'sleep.players_sleeping') {
    const current = message.with?.[0] ? renderChatArgument(message.with[0]) : '0';
    const total = message.with?.[1] ? renderChatArgument(message.with[1]) : '0';
    return `${current}/${total}名玩家已入睡`;
  }

  if (message.translate === 'gameMode.changed') {
    const mode = message.with?.[0] ? renderChatArgument(message.with[0]) : message.translate;
    return `${mode} [${message.translate}]`;
  }

  let template = message.translate;
  let appendTranslateKey = true;

  if (message.translate === '%s whispers to you: %s') {
    template = '%s whispers to you: %s';
    appendTranslateKey = false;
  } else if (message.translate === 'multiplayer.player.joined') {
    template = '%s加入了游戏';
    appendTranslateKey = false;
  } else if (message.translate === 'multiplayer.player.left') {
    template = '%s退出了游戏';
    appendTranslateKey = false;
  } else if (message.translate === 'multiplayer.player.joined.renamed') {
    const newName = message.with?.[0] ? renderChatArgument(message.with[0]) : '未知玩家';
    const oldName = message.with?.[1] ? renderChatArgument(message.with[1]) : '未知玩家';
    return `${newName}（之前被称为${oldName}）加入了游戏`;
  } else if (message.translate && message.translate.startsWith('death.')) {
    template = message.with && message.with.length > 1 ? '%s 被 %s 杀死了' : '%s 死了';
  } else if (message.translate && message.translate.startsWith('chat.type.advancement')) {
    template = '%s 获得了 %s';
  } else if (message.translate && message.translate.startsWith('chat.type.achievement')) {
    template = '%s 获得了成就 %s';
  }

  if (Array.isArray(message.with)) {
    for (const argument of message.with) {
      template = template.replace('%s', renderChatArgument(argument));
    }
  }

  return appendTranslateKey ? `${template} [${message.translate}]` : template;
}

const BUILTIN_TELEPORT_PROMPT_MATCHERS = {
  stripLines: [
    '^Type\\s+/tpaccept\\s+to\\s+accept\\s+or\\s+/tpdeny\\s+to\\s+deny\\.?$',
    '^输入\\s*/tpaccept\\s*接受或\\s*/tpdeny\\s*拒绝[。.]?$'
  ],
  tpa: [
    '^(?:EssC\\s*[»>]\\s*)?(?<sender>[A-Za-z0-9_]{1,16})\\s+(?:请求传送到你的位置|想要传送到你这里[。.]?|wants to teleport to you\\.)$'
  ],
  tpahere: [
    '^(?:EssC\\s*[»>]\\s*)?(?<sender>[A-Za-z0-9_]{1,16})\\s+(?:请求你传送到他的位置|想要你传送到他们那里[。.]?|想要你传送到该玩家位置[。.]?|wants you to teleport to them\\.)$'
  ]
};

function compileTeleportPromptMatchers(config = {}) {
  const compileList = (key) => [
    ...BUILTIN_TELEPORT_PROMPT_MATCHERS[key],
    ...(Array.isArray(config[key]) ? config[key] : [])
  ].map((source) => new RegExp(`^(?:${source})$`, 'i'));

  return {
    stripLines: compileList('stripLines'),
    tpa: compileList('tpa'),
    tpahere: compileList('tpahere')
  };
}

function normalizeTeleportPromptMessage(plainText, matchers) {
  const stripLines = matchers && Array.isArray(matchers.stripLines)
    ? matchers.stripLines
    : compileTeleportPromptMatchers().stripLines;

  return String(plainText || '')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !stripLines.some((matcher) => matcher.test(line)))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseTeleportPrompt(plainText, matchers = compileTeleportPromptMatchers()) {
  const text = normalizeTeleportPromptMessage(plainText, matchers);
  if (!text) return null;

  for (const type of ['tpahere', 'tpa']) {
    for (const matcher of matchers[type]) {
      const result = matcher.exec(text);
      const sender = result && result.groups ? String(result.groups.sender || '').trim() : '';
      if (sender) return { type, sender };
    }
  }

  return null;
}

class ChatFeature {
  constructor(options = {}) {
    this.runtime = options.runtime;
    this.logger = options.logger;
    this.chatConsoleCoordinator = options.chatConsoleCoordinator || null;
    this.teleportFeature = options.teleportFeature;
    this.teleportPromptMatchers = compileTeleportPromptMatchers(options.teleportPromptMatchers);
    this.trustedPlayers = Array.isArray(options.trustedPlayers) ? options.trustedPlayers : [];
    this.trustedPlayersStore = options.trustedPlayersStore || null;
    this.activityLogFeature = options.activityLogFeature || null;
    this.bot = null;
    this.messageHandler = null;
  }

  attach(bot) {
    this.detach();
    this.bot = bot;
    this.messageHandler = (message) => {
      void this.handleMessage(message);
    };
    bot.on('message', this.messageHandler);
  }

  detach() {
    if (this.bot && this.messageHandler) {
      this.bot.removeListener('message', this.messageHandler);
    }

    this.bot = null;
    this.messageHandler = null;
  }

  isTrustedPlayer(sender) {
    if (this.trustedPlayersStore && typeof this.trustedPlayersStore.isTrustedPlayer === 'function') {
      return this.trustedPlayersStore.isTrustedPlayer(sender);
    }

    const name = String(sender || '').toLowerCase();
    return this.trustedPlayers.some((player) => String(player).toLowerCase() === name);
  }

  logChatMessage(plainText) {
    if (!this.logger) return;

    const formattedMessage = `[CHAT] ${plainText}`;
    if (this.chatConsoleCoordinator && typeof this.chatConsoleCoordinator.submit === 'function') {
      this.chatConsoleCoordinator.submit({
        runtime: this.runtime,
        logger: this.logger,
        level: 'info',
        message: formattedMessage
      });
      return;
    }

    this.logger.info(formattedMessage);
  }

  async handleMessage(message) {
    const plainText = parseChatMessage(message);
    if (!plainText) return;

    this.logChatMessage(plainText);

    if (this.activityLogFeature) {
      this.activityLogFeature.logChatMessage(plainText);
    }

    const whisperMatch = plainText.match(/^(.+?) whispers to you:\s*(.*)$/);
    if (whisperMatch) {
      const sender = whisperMatch[1].trim();
      const content = whisperMatch[2].trim();

      if (this.isTrustedPlayer(sender)) {
        const context = this.runtime.createCommandContext({
          source: 'whisper',
          sender
        });
        await this.runtime.executeCommand(content, context);
      }

      return;
    }

    const teleportPrompt = parseTeleportPrompt(plainText, this.teleportPromptMatchers);
    if (teleportPrompt && teleportPrompt.type === 'tpa') {
      if (this.logger) {
        this.logger.info(`[TPA] 收到来自 ${teleportPrompt.sender} 的传送请求`);
      }
      this.teleportFeature.handleTeleportRequest(teleportPrompt.sender);
      return;
    }

    if (teleportPrompt && teleportPrompt.type === 'tpahere') {
      if (this.logger) {
        this.logger.info(`[TPAHERE] 收到来自 ${teleportPrompt.sender} 的传送至此请求`);
      }
      this.teleportFeature.handleTeleportHereRequest(teleportPrompt.sender);
      return;
    }

  }
}

module.exports = {
  ChatFeature,
  parseChatMessage,
  parseTeleportPrompt,
  compileTeleportPromptMatchers
};
