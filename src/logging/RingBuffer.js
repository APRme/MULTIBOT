class RingBuffer {
  constructor(limit = 500) {
    this.limit = Math.max(1, limit);
    this.items = [];
  }

  push(value) {
    this.items.push(value);
    if (this.items.length > this.limit) {
      this.items.splice(0, this.items.length - this.limit);
    }
  }

  toArray() {
    return this.items.slice();
  }
}

module.exports = {
  RingBuffer
};
