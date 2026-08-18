class CommandContext {
  constructor(options = {}) {
    this.source = options.source || 'whisper';
    this.sender = options.sender || null;
    this.label = options.label || this.sender || this.source;
    this.messages = [];
    this.replyFn = typeof options.replyFn === 'function' ? options.replyFn : null;
  }

  reply(message, mode = 'tell') {
    if (message === undefined || message === null) return;

    const entry = {
      mode,
      message: String(message)
    };

    this.messages.push(entry);

    if (this.replyFn) {
      this.replyFn(entry);
    }
  }

  replyInfo(message) {
    this.reply(message, 'whisper');
  }

  replyError(message) {
    this.reply(message, 'tell');
  }

  getMessages() {
    return this.messages.slice();
  }
}

module.exports = {
  CommandContext
};
