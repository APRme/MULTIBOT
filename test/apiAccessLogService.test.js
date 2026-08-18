const test = require('node:test');
const assert = require('node:assert/strict');
const { ApiAccessLogService, createBodyPreview } = require('../src/logging/ApiAccessLogService');

test('ApiAccessLogService omits request body previews by default', () => {
  const service = new ApiAccessLogService({ config: {} });
  const context = {};

  service.markRequestBody(context, JSON.stringify({ command: 'send secret message' }));

  assert.equal(context.requestBytes > 0, true);
  assert.equal(context.bodyPreview, undefined);
});

test('ApiAccessLogService redacts sensitive nested body fields when previews are enabled', () => {
  const preview = createBodyPreview(JSON.stringify({
    token: 'token-value',
    bot: {
      username: 'account@example.com',
      email: 'account@example.com',
      nested: {
        password: 'password-value'
      }
    },
    command: 'health'
  }));

  assert.deepEqual(JSON.parse(preview), {
    token: '***',
    bot: {
      username: '***',
      email: '***',
      nested: {
        password: '***'
      }
    },
    command: 'health'
  });
});
