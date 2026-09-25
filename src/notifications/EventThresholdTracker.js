// 窗口阈值计数器: "窗口内发生次数 >= 阈值" 时返回 exceeded, 供事件推送判定。
// 调用方负责去重/冷却(通知层已有 key 冷却), 这里只做计数, 便于单测。
//
// 内存设计: 采用"整窗(tumbling window) + 计数", 窗口内只保留最多 maxSamples 个时间戳样本,
// 计数用单独的 totalCount 累加。这样即使请求量极大(如公网端口被刷认证失败),
// 单实例内存也是 O(maxSamples) 而不是 O(请求数)。
class EventThresholdTracker {
  constructor(options = {}) {
    this.threshold = Number.isFinite(Number(options.threshold)) && Number(options.threshold) > 0
      ? Number(options.threshold)
      : 1;
    this.windowMs = Number.isFinite(Number(options.windowMs)) && Number(options.windowMs) > 0
      ? Number(options.windowMs)
      : 3600000;
    this.maxSamples = Number.isFinite(Number(options.maxSamples)) && Number(options.maxSamples) > 0
      ? Number(options.maxSamples)
      : Math.max(this.threshold * 2, 16);
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
    this.samples = [];
    this.totalCount = 0;
    this.windowStartedAt = 0;
  }

  // 窗口到期(整窗重置): 返回 true 表示本次调用前已重置
  resetIfExpired(now) {
    if (!this.windowStartedAt || now - this.windowStartedAt >= this.windowMs) {
      this.samples = [];
      this.totalCount = 0;
      this.windowStartedAt = now;
      return true;
    }
    return false;
  }

  // 返回 { count, exceeded }, count 为当前窗口内(含本次)的次数
  record(timestamp) {
    const now = Number.isFinite(Number(timestamp)) ? Number(timestamp) : this.now();
    this.resetIfExpired(now);
    this.totalCount += 1;
    if (this.samples.length < this.maxSamples) {
      this.samples.push(now);
    }
    return { count: this.totalCount, exceeded: this.totalCount >= this.threshold };
  }

  getCount(timestamp) {
    const now = Number.isFinite(Number(timestamp)) ? Number(timestamp) : this.now();
    if (!this.windowStartedAt || now - this.windowStartedAt >= this.windowMs) {
      return 0;
    }
    return this.totalCount;
  }

  reset() {
    this.samples = [];
    this.totalCount = 0;
    this.windowStartedAt = 0;
  }
}

module.exports = { EventThresholdTracker };
