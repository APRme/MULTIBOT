const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { RecorderFeature } = require('../src/features/recording/RecorderFeature');

test('RecorderFeature defaults replay output to MULTIBOT root replays directory', () => {
  const feature = new RecorderFeature({
    paths: {
      appRoot: path.join('D:', 'MULTIBOT'),
      accountDir: path.join('D:', 'MULTIBOT', 'BOTS', 'my_server', 'example_bot')
    },
    config: {
      enabled: true
    }
  });

  assert.equal(feature.resolveOutputDir(), path.join('D:', 'MULTIBOT', 'replays'));
});

test('RecorderFeature keeps explicit outputDir relative to account directory', () => {
  const feature = new RecorderFeature({
    paths: {
      appRoot: path.join('D:', 'MULTIBOT'),
      accountDir: path.join('D:', 'MULTIBOT', 'BOTS', 'my_server', 'example_bot')
    },
    config: {
      enabled: true,
      outputDir: '../custom-replays'
    }
  });

  assert.equal(
    feature.resolveOutputDir(),
    path.join('D:', 'MULTIBOT', 'BOTS', 'my_server', 'custom-replays')
  );
});

test('RecorderFeature derives self-only entity recording when entityHandling is disabled', () => {
  const feature = new RecorderFeature({
    paths: {
      appRoot: path.join('D:', 'MULTIBOT'),
      accountDir: path.join('D:', 'MULTIBOT', 'BOTS', 'my_server', 'example_bot')
    },
    config: {
      enabled: true,
      includeCollectAnimation: true,
      includeHurtAnimation: true
    },
    botConfig: {
      host: '127.0.0.1',
      port: 25565
    },
    capabilities: {
      entityHandling: false,
      terrainHandling: true
    }
  });

  const options = feature.buildEffectiveRecorderOptions();

  assert.equal(options.entityHandlingEnabled, false);
  assert.equal(options.terrainHandlingEnabled, true);
  assert.equal(options.entityScope, 'self_only');
  assert.equal(options.includeCollectAnimation, false);
  assert.equal(options.includeHurtAnimation, false);
});

test('RecorderFeature disables world snapshot options when terrainHandling is disabled', () => {
  const feature = new RecorderFeature({
    paths: {
      appRoot: path.join('D:', 'MULTIBOT'),
      accountDir: path.join('D:', 'MULTIBOT', 'BOTS', 'my_server', 'example_bot')
    },
    config: {
      enabled: true,
      includeWorldSnapshot: true,
      includeLaterChunkLoads: true,
      includeBlockEntityUpdates: true,
      enableChunkCache: true
    },
    botConfig: {
      host: '127.0.0.1',
      port: 25565
    },
    capabilities: {
      entityHandling: true,
      terrainHandling: false
    }
  });

  const options = feature.buildEffectiveRecorderOptions();

  assert.equal(options.entityHandlingEnabled, true);
  assert.equal(options.terrainHandlingEnabled, false);
  assert.equal(options.includeWorldSnapshot, false);
  assert.equal(options.includeLaterChunkLoads, false);
  assert.equal(options.includeBlockEntityUpdates, false);
  assert.equal(options.enableChunkCache, false);
});
