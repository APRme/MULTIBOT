// 滑动窗口阈值计数器: "窗口内发生次数 >= 阈值" 时返回 exceeded, 供事件推送判定。
// 调用方负责去重/冷却(通知层已有 key 冷却), 这里只做计数, 便于单测。
class EventThresholdTracker {
  constructor(options = {}) {
    this.threshold = Number.isFinite(Number(options.threshold)) && Number(options.threshold) > 0
      ? Number(options.threshold)
      : 1;
    this.windowMs = Number.isFinite(Number(options.windowMs)) && Number(options.windowMs) > 0
      ? Number(options.windowMs)
      : 3600000;
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
    this.timestamps = [];
  }

  prune(now) {
    this.timestamps = this.timestamps.filter((ts) => now - ts < this.windowMs);
  }

  // 返回 { count, exceeded }, count 为窗口内(含本次)的次数
  record(timestamp) {
    const now = Number.isFinite(Number(timestamp)) ? Number(timestamp) : this.now();
    this.timestamps.push(now);
    this.prune(now);
    const count = this.timestamps.length;
    return { count, exceeded: count >= this.threshold };
  }

  getCount(timestamp) {
    const now = Number.isFinite(Number(timestamp)) ? Number(timestamp) : this.now();
    this.prune(now);
    return this.timestamps.length;
  }

  reset() {
    this.timestamps = [];
  }
}

module.exports = { EventThresholdTracker };
