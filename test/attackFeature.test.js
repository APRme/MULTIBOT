const test = require('node:test');
const assert = require('node:assert/strict');
const { AttackFeature } = require('../src/features/attack/AttackFeature');

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
  const attacks = [];
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
    attack(target) {
      attacks.push(target.id);
    },
    get attacks() {
      return attacks.slice();
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

test('AttackFeature attacks nearest allowed entity manually', async () => {
  const bot = createBot([
    { id: 2, type: 'player', username: 'NearbyPlayer', position: createPosition(1, 64, 0), health: 20 },
    { id: 3, type: 'mob', name: 'zombie', position: createPosition(2, 64, 0), health: 20 }
  ]);
  const feature = new AttackFeature({
    config: {
      autoAttack: false,
      attackRange: 4,
      targetFilter: {
        excludePlayers: true,
        excludeItems: true,
        targetTypes: ['mob']
      }
    }
  });

  feature.attach(bot);
  const context = createContext();
  await feature.handleAttackNearestCommand(context);

  assert.deepEqual(bot.attacks, [3]);
  assert.equal(bot.lookTargets.length, 1);
  assert.match(context.messages[0].message, /正在攻击/);
  feature.stop();
});

test('AttackFeature auto attack loop uses config interval', async () => {
  const bot = createBot([
    { id: 5, type: 'mob', name: 'skeleton', position: createPosition(2, 64, 0), health: 20 }
  ]);
  const feature = new AttackFeature({
    config: {
      autoAttack: true,
      attackRange: 4,
      attackInterval: 10,
      targetFilter: {
        excludePlayers: true,
        excludeItems: true,
        targetTypes: ['mob']
      }
    }
  });

  feature.attach(bot);
  await new Promise((resolve) => setTimeout(resolve, 35));
  feature.stop();

  assert.ok(bot.attacks.length >= 1);
  assert.ok(bot.attacks.every((id) => id === 5));
});
