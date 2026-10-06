function renderChatMessage(value) {
  if (!value) return '';

  if (typeof value === 'string') {
    return removeMinecraftFormatting(value);
  }

  if (value.json) {
    // ChatMessage 实例形态: mineflayer 的 Team.displayName() 是 prefix.clone() 后 append(玩家名, 后缀),
    // 而 append() 只写进实例自身的结构, .json 仍停在根组件(只有前缀) —— 直接递归 .json 会把玩家名丢掉。
    // 因此实例自带 extra 时以"实例的 text + extra"为准。
    if (Array.isArray(value.extra) && value.extra.length > 0) {
      const head = typeof value.text === 'string'
        ? removeMinecraftFormatting(value.text)
        : renderChatMessage(value.json);
      return `${head}${renderChatExtra(value.extra)}`;
    }

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

// 部分服务端(TrChat 一类)把"模板本身"当作 translate 键发来, 例如 '<%s> %s'。
// 这类值没有可读的键名(不含命名空间点号), 渲染后若再把键缀在末尾, 只会得到 '[<%s> %s]' 这种噪音。
function looksLikeTranslateTemplate(value) {
  return typeof value === 'string' && value.includes('%s') && !value.includes('.');
}

// 取行首的玩家名(私聊行与玩家聊天行都以玩家名开头)。
// 兼容两种形态: '<name> msg'(原版模板渲染后带尖括号) 与 'name msg' / 'name whispers to you: ...'。
// 返回名字在行内的区间, 便于只替换名字本身、保留外层尖括号与其余文本。
function matchLeadingSenderName(plainText) {
  const match = String(plainText || '').match(/^(?:<)?([A-Za-z0-9_]{1,16})(?=\s|>|$)/);
  if (!match) {
    return null;
  }

  const name = match[1];
  return {
    name,
    start: match[0].length - name.length,
    end: match[0].length
  };
}

// 只有"玩家公屏聊天"这一类消息(<名字> 内容)才给发送者套 team 称号/组织前缀。
// 其他消息(死亡、进退游戏、私聊、成就、TPA 提示、系统公告等)名字位置与格式各不相同,
// 套前缀既不符合游戏内显示, 也会让日志更难读。
function isPlayerChatMessage(message, plainText) {
  const key = (message && typeof message.translate === 'string' && message.translate)
    || (message && message.json && typeof message.json.translate === 'string' ? message.json.translate : '');

  // 原版键, 以及"模板当键"的服务端(如 '<%s> %s')都代表玩家公屏聊天
  if (key === 'chat.type.text') return true;
  if (looksLikeTranslateTemplate(key) && key.trim().startsWith('<')) return true;

  // 没有键信息时(部分服务端直接发系统消息文本): 只有行首确实是 <名字> 才算玩家聊天
  return /^<[A-Za-z0-9_]{1,16}>/.test(String(plainText || ''));
}

function renderChatExtra(extra) {
  if (!Array.isArray(extra)) return '';
  return extra.map(renderChatMessage).join('');
}

function renderChatArgument(value) {
  if (!value) return '';
  if (typeof value === 'string') return removeMinecraftFormatting(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);

  // 带 extra 或实例形态(json)的参数必须整体渲染: 只取 text 会丢掉 extra 里的内容,
  // 例如 { text: '「铃」', extra: [{ text: '真实名' }] } 或 ChatMessage 实例。
  if (value.json || Array.isArray(value.extra)) {
    const rendered = renderChatMessage(value);
    if (rendered) return rendered;
  }

  if (typeof value.text === 'string' && value.text.length > 0) {
    return removeMinecraftFormatting(value.text);
  }

  if (typeof value[''] === 'string' && value[''].length > 0) {
    return removeMinecraftFormatting(value['']);
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
  } else if (message.translate === 'chat.type.text') {
    // 原版玩家聊天的命名键: 不映射的话会渲染成 'chat.type.text [chat.type.text]'(键名当正文)。
    // 多数服务端直接发模板 '<%s> %s'(已由 looksLikeTranslateTemplate 处理), 但发原版键的也要正确显示。
    template = '<%s> %s';
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
  } else if (looksLikeTranslateTemplate(message.translate)) {
    // 模板当键: 保留模板本身用于填充参数, 但不把键缀在末尾
    appendTranslateKey = false;
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

// 服务端自定义私聊格式(server.json 的 whisperMatchers.incoming):
// 只在内置原版形态不匹配时启用; 规则必须由配置方自行全行锚定, 否则公屏内容可能被误判为私聊。
function compileWhisperMatchers(config = {}) {
  const rules = Array.isArray(config && config.incoming) ? config.incoming : [];
  return rules.map((source) => new RegExp(`^(?:${source})$`, 'i'));
}

function matchWhisperMatchers(plainText, matchers) {
  const text = String(plainText || '');
  for (const matcher of matchers) {
    const match = text.match(matcher);
    if (!match) continue;
    const groups = match.groups || {};
    const sender = String(groups.sender || '').trim();
    const content = String(groups.content === undefined ? '' : groups.content).trim();
    if (!sender) continue;
    return { sender, content };
  }
  return null;
}

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
    this.whisperMatchers = compileWhisperMatchers(options.whisperMatchers);
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

  // 服务端常用 scoreboard team 的 prefix/suffix 给玩家名加"称号/组织"前缀:
  // 这些前缀不在聊天包里(聊天包的发送者只有纯名), 而是客户端本地用 team 数据贴上去的,
  // 所以游戏里看得到、我们的日志里却没有。mineflayer 的 team 插件已经维护了
  // bot.teamMap(按玩家名 -> Team) 与 Team.displayName()(prefix + 名字 + suffix)。
  // 注意: 这里的结果只用于"显示/日志", 解析仍旧使用未装饰的原始文本 ——
  // 否则带前缀的名字会破坏私聊信任校验与传送提示的正则匹配。
  decorateSenderWithTeam(plainText) {
    const bot = this.bot;
    const teamMap = bot && bot.teamMap;
    if (!teamMap || typeof plainText !== 'string' || !plainText) {
      return plainText;
    }

    const sender = matchLeadingSenderName(plainText);
    if (!sender) {
      return plainText;
    }

    const team = teamMap[sender.name];
    if (!team || typeof team.displayName !== 'function') {
      return plainText;
    }

    let decorated = '';
    try {
      decorated = renderChatMessage(team.displayName(sender.name));
    } catch (error) {
      return plainText;
    }

    // 装饰失败、或装饰结果与纯名相同(该队没有前缀/后缀)时不改动
    if (!decorated || decorated === sender.name) {
      return plainText;
    }

    return `${plainText.slice(0, sender.start)}${decorated}${plainText.slice(sender.end)}`;
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

    // 日志/活动日志: 只有玩家公屏聊天才套 team 称号前缀(与游戏内显示一致);
    // 解析一律继续用未装饰的原始文本, 否则带前缀的名字会破坏私聊信任校验与传送提示匹配。
    const displayText = isPlayerChatMessage(message, plainText)
      ? this.decorateSenderWithTeam(plainText)
      : plainText;
    this.logChatMessage(displayText);

    if (this.activityLogFeature) {
      this.activityLogFeature.logChatMessage(displayText);
    }

    const builtinWhisperMatch = plainText.match(/^(.+?) whispers to you:\s*(.*)$/);
    const whisper = builtinWhisperMatch
      ? { sender: builtinWhisperMatch[1].trim(), content: builtinWhisperMatch[2].trim() }
      : matchWhisperMatchers(plainText, this.whisperMatchers);
    if (whisper) {
      const sender = whisper.sender;
      const content = whisper.content;

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
