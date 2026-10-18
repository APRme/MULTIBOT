// 逐条回复, 但带最小间隔, 避免短时间内大量私聊被服务器判定 spam
const DEFAULT_REPLY_GAP_MS = 450;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function replyLinesSpaced(context, lines, options = {}) {
  const gapMs = Number.isFinite(options.gapMs) ? Math.max(50, options.gapMs) : DEFAULT_REPLY_GAP_MS;
  const list = (Array.isArray(lines) ? lines : [])
    .filter((line) => typeof line === 'string' && line.trim().length > 0);

  for (let index = 0; index < list.length; index += 1) {
    if (context && typeof context.replyInfo === 'function') {
      context.replyInfo(list[index]);
    }
    if (index < list.length - 1) await sleep(gapMs);
  }
}

module.exports = { replyLinesSpaced, DEFAULT_REPLY_GAP_MS };
