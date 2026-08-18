const test = require('node:test');
const assert = require('node:assert/strict');
const { EntityInteractFeature } = require('../src/features/entityInteract/EntityInteractFeature');

function createPosition(x, y, z) {
  return {
    x,
    y,
    z,
    distanceTo(other) {
      const dx = x - other.x;
      const dy = y - other.y;
      const dz = z - other.z;
      return Math.sqrt((dx * dx) + (dy * dy) + (dz * dz));
    }
  };
}

function createBot(entities) {
  const activated = [];
  const lookTargets = [];

  return {
    entity: {
      id: 1,
      position: createPosition(0, 64, 0)
    },
    nearestEntity(predicate) {
      const candidates = entities.filter((entity) => predicate(entity));
      candidates.sort((left, right) => {
        const leftDistance = this.entity.position.distanceTo(left.position);
        const rightDistance = this.entity.position.distanceTo(right.position);
        return leftDistance - rightDistance;
      });
      return candidates[0] || null;
    },
    async lookAt(position) {
      lookTargets.push(position);
    },
    async activateEntity(target) {
      activated.push(target.id);
    },
    get activated() {
      return activated.slice();
    },
    get lookTargets() {
      return lookTargets.slice();
    }
  };
}

function createContext() {
  const messages = [];
  return {
    replyInfo(message) {
      messages.push({ type: 'info', message });
    },
    replyError(message) {
      messages.push({ type: 'error', message });
    },
    get messages() {
      return messages;
    }
  };
}

test('EntityInteractFeature interacts with nearest non-player entity', async () => {
  const bot = createBot([
    { id: 2, type: 'player', username: 'NearbyPlayer', position: createPosition(1, 64, 0) },
    { id: 3, type: 'mob', name: 'villager', position: createPosition(2, 64, 0) },
    { id: 4, type: 'object', name: 'boat', position: createPosition(3, 64, 0) }
  ]);
  const feature = new EntityInteractFeature();

  feature.attach(bot);
  const context = createContext();
  await feature.handleInteractNearestCommand(context);

  assert.deepEqual(bot.activated, [3]);
  assert.equal(bot.lookTargets.length, 1);
  assert.match(context.messages[0].message, /正在右键交互/);
  feature.stop();
});

test('EntityInteractFeature rejects when only players or dropped items are nearby', async () => {
  const bot = createBot([
    { id: 2, type: 'player', username: 'NearbyPlayer', position: createPosition(1, 64, 0) },
    { id: 3, type: 'item', name: 'diamond', position: createPosition(2, 64, 0) },
    { id: 4, type: 'orb', name: 'experience_orb', position: createPosition(3, 64, 0) }
  ]);
  const feature = new EntityInteractFeature();

  feature.attach(bot);
  const context = createContext();
  await feature.handleInteractNearestCommand(context);

  assert.deepEqual(bot.activated, []);
  assert.equal(context.messages[0].type, 'error');
  assert.match(context.messages[0].message, /非玩家实体/);
  feature.stop();
});
