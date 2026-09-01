const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SessionService } = require('../src/session/SessionService');

test('SessionService uses local session manager implementation', () => {
  const sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multibot-sessions-'));
  const service = new SessionService(sessionsDir);
  const email = 'bot@example.com';
  const session = {
    accessToken: 'token-123',
    selectedProfile: {
      id: 'profile-id',
      name: 'botName'
    }
  };

  assert.equal(service.save(email, session), true);

  const loaded = service.load(email);
  assert.equal(loaded.accessToken, 'token-123');
  assert.equal(loaded.selectedProfile.name, 'botName');
  assert.equal(service.getPath(email), path.join(sessionsDir, 'bot_example.com.json'));
  assert.equal(service.delete(email), true);
  assert.equal(fs.existsSync(service.getPath(email)), false);
});
