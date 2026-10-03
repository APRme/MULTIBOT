// 把原版 1.21.11 的 LastSeenMessagesValidator / LastSeenMessages.Update 判定照抄成 JS,
// 用来验证"恒定空更新"(offset=0 / acknowledged 全 0 / checksum=0) 在任意服务端窗口状态下都被接受。
// 依据:
//   net/minecraft/network/chat/LastSeenMessagesValidator.java  (applyOffset / applyUpdate)
//   net/minecraft/network/chat/LastSeenMessages.java           (Update.IGNORE_CHECKSUM / verifyChecksum)
const test = require('node:test');
const assert = require('node:assert/strict');

class ValidationException extends Error {}

// 复刻 LastSeenMessagesValidator
class LastSeenMessagesValidator {
  constructor(lastSeenCount) {
    this.lastSeenCount = lastSeenCount;
    this.trackedMessages = new Array(lastSeenCount).fill(null); // 初始化即预填 null
    this.lastPendingMessage = null;
  }

  // 服务端把"带签名的消息"记入窗口(ServerGamePacketListenerImpl: signature != null 时)
  addPending(signature) {
    if (signature === this.lastPendingMessage) return;
    this.trackedMessages.push({ signature, pending: true });
    this.lastPendingMessage = signature;
  }

  applyOffset(offset) {
    const maxOffset = this.trackedMessages.length - this.lastSeenCount;
    if (offset >= 0 && offset <= maxOffset) {
      this.trackedMessages.splice(0, offset);
    } else {
      throw new ValidationException(`Advanced last seen window by ${offset} messages, but expected at most ${maxOffset}`);
    }
  }

  // update = { offset, acknowledged: number[](0/1), checksum }
  applyUpdate(update) {
    this.applyOffset(update.offset);

    if (update.acknowledged.length > this.lastSeenCount) {
      throw new ValidationException(`Last seen update contained ${update.acknowledged.length} messages, but maximum window size is ${this.lastSeenCount}`);
    }

    const lastSeenEntries = [];
    for (let i = 0; i < this.lastSeenCount; i += 1) {
      const acknowledged = update.acknowledged[i] === 1;
      const message = this.trackedMessages[i];

      if (acknowledged) {
        if (message === null) {
          throw new ValidationException(`Last seen update acknowledged unknown or previously ignored message at index ${i}`);
        }
        this.trackedMessages[i] = { ...message, pending: false };
        lastSeenEntries.push(message.signature);
      } else {
        if (message !== null && message.pending === false) {
          throw new ValidationException(`Last seen update ignored previously acknowledged message at index ${i}`);
        }
        this.trackedMessages[i] = null;
      }
    }

    // verifyChecksum: checksum=0 表示 IGNORE_CHECKSUM
    const computeChecksum = (entries) => {
      let checksum = 1;
      for (const entry of entries) checksum = 31 * checksum + hashSignature(entry);
      const byte = checksum & 0xff;
      return byte === 0 ? 1 : byte;
    };
    if (!(update.checksum === 0 || update.checksum === computeChecksum(lastSeenEntries))) {
      throw new ValidationException('Checksum mismatch on last seen update: the client and server must have desynced');
    }

    return lastSeenEntries;
  }
}

function hashSignature(signature) {
  let hash = 1;
  for (const byte of signature) hash = (31 * hash + byte) & 0xffffffff;
  return hash;
}

// 我们发出去的恒定空更新
function ourUpdate() {
  return { offset: 0, acknowledged: new Array(20).fill(0), checksum: 0 };
}

test('constant empty update is accepted for an empty server window', () => {
  const validator = new LastSeenMessagesValidator(20);
  assert.doesNotThrow(() => validator.applyUpdate(ourUpdate()));
});

test('constant empty update is accepted after signed messages were tracked', () => {
  const validator = new LastSeenMessagesValidator(20);
  // 服务端收到/转发了 5 条正版玩家签名消息 => 窗口追加 5 条 pending
  for (let i = 0; i < 5; i += 1) validator.addPending(Buffer.from([i, i + 1, i + 2]));
  assert.equal(validator.trackedMessages.length, 25);

  assert.doesNotThrow(() => validator.applyUpdate(ourUpdate()));
  // 位图只覆盖前 20 槽: 5 条追加条目仍在窗口尾部(保持 pending, 未被确认)
  assert.equal(validator.trackedMessages.slice(0, 20).filter((entry) => entry !== null).length, 0);
  assert.equal(validator.trackedMessages.slice(20).filter((entry) => entry !== null).length, 5);
});

test('conservative trim (offset = pending - 40) is always within the server limit', () => {
  const validator = new LastSeenMessagesValidator(20);
  const total = 120;
  for (let i = 0; i < total; i += 1) validator.addPending(Buffer.from([i % 256, 1, 2]));

  // 守卫的修剪策略: 只推进到还剩 40 条
  const offset = Math.max(0, total - 40);
  assert.doesNotThrow(() => validator.applyUpdate({ offset, acknowledged: new Array(20).fill(0), checksum: 0 }));
  // 追加部分被裁剪, 不会无限增长
  assert.equal(validator.trackedMessages.length, 20 + 40);
});

test('constant empty update survives many windows and repeated sends', () => {
  const validator = new LastSeenMessagesValidator(20);
  let pending = 0;
  for (let round = 0; round < 30; round += 1) {
    validator.addPending(Buffer.from([round % 256, 7, 9]));
    pending += 1;
    const offset = Math.max(0, pending - 40);
    pending -= offset;
    assert.doesNotThrow(() => validator.applyUpdate({ offset, acknowledged: new Array(20).fill(0), checksum: 0 }), `第 ${round} 轮被拒`);
  }
});

test('upstream-style acknowledgement of an index the server does not have is rejected (the observed kick)', () => {
  const validator = new LastSeenMessagesValidator(20);
  validator.addPending(Buffer.from([1, 2, 3]));

  // 上游把"自己数组"的最低位当作最新消息 => 位图置 1 的位在服务端是 null
  const upstreamUpdate = { offset: 0, acknowledged: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], checksum: 0 };
  assert.throws(() => validator.applyUpdate(upstreamUpdate), /acknowledged unknown or previously ignored message/);
});

test('ignoring a previously acknowledged message is rejected', () => {
  const validator = new LastSeenMessagesValidator(20);
  validator.addPending(Buffer.from([4, 5, 6]));

  // 模拟"之前确实确认过一条"的窗口状态(非 pending)
  validator.trackedMessages[0] = { signature: Buffer.from([4, 5, 6]), pending: false };

  // 之后若全 0 忽略它 => 抛错; 我们的 guard 因为"从不确定任何消息", 不会进入这个状态
  assert.throws(() => validator.applyUpdate(ourUpdate()), /ignored previously acknowledged message/);
});
