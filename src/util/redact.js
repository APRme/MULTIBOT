// 文本脱敏: 用于把错误信息放进手机推送/日志前, 去掉 URL 与长 token, 并截断长度。
// 目的: 推送内容可能离开本机, 不能带任何凭据/地址前缀。
const DEFAULT_MAX_LENGTH = 120;
const URL_PATTERN = /https?:\/\/\S+/gi;
const LONG_TOKEN_PATTERN = /[A-Za-z0-9_\-]{24,}/g;
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

function redactText(value, maxLength = DEFAULT_MAX_LENGTH) {
  if (value === null || value === undefined) {
    return '';
  }

  let text = String(value)
    .replace(/\s+/g, ' ')
    .replace(URL_PATTERN, '<url>')
    .replace(EMAIL_PATTERN, '<email>')
    .replace(LONG_TOKEN_PATTERN, '<redacted>')
    .trim();

  const limit = Number.isFinite(Number(maxLength)) && Number(maxLength) > 0
    ? Number(maxLength)
    : DEFAULT_MAX_LENGTH;

  if (text.length > limit) {
    text = `${text.slice(0, limit)}…`;
  }

  return text;
}

// 错误摘要: "TypeError: message" 形式, 已脱敏; 无 message 时只返回错误名
function summarizeError(error, maxLength = DEFAULT_MAX_LENGTH) {
  if (!error) {
    return 'unknown';
  }

  const name = error.name || (error.constructor && error.constructor.name) || 'Error';
  const rawMessage = typeof error.message === 'string'
    ? error.message
    : (typeof error === 'string' ? error : '');
  const message = redactText(rawMessage, maxLength);
  return message ? `${name}: ${message}` : name;
}

module.exports = {
  redactText,
  summarizeError,
  DEFAULT_MAX_LENGTH
};
