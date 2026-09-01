const path = require('path');

function createNoopFlashbackRecorder(reason = 'disabled') {
  const status = {
    state: reason === 'missing_dependency' ? 'unavailable' : 'disabled',
    activeArchives: 0,
    totalTicks: 0,
    currentChunkIndex: 0,
    flushedChunkCount: 0,
    loadedColumns: 0,
    currentDimension: null,
    loginCaptured: false,
    cachedConfigurationPackets: 0,
    cachedChunkLoads: 0,
    cachedBlockEntities: 0,
    trackedEntities: 0,
    cachedEntitySpawns: 0,
    cachedEntitySupplementals: 0,
    chunkCacheEntries: 0,
    chunkCacheFiles: 0,
    memory: null,
    timeCaptured: false,
    weatherEventsCaptured: 0,
    scoreboardObjectives: 0,
    teamsTracked: 0,
    bossBarsTracked: 0,
    mapsTracked: 0,
    primaryArchiveId: null,
    primaryArchiveStartAt: null,
    primaryArchiveEndAt: null,
    overlapArchiveId: null,
    overlapArchiveStartAt: null,
    overlapArchiveEndAt: null,
    pendingExportJobs: 0,
    lastExportedArchive: null,
    lastExportError: reason === 'missing_dependency'
      ? 'flashback-recorder dependencies missing'
      : null,
    pendingRolloverReason: null,
    finishReason: null,
    abortReason: null,
    droppedPacketKinds: {},
    outputPath: null
  };

  return {
    onPhysicsTick() {},
    onEntityMoved() {},
    onLocalPlayerMove() {},
    onEntitySpawn() {},
    onEntityGone() {},
    getStatus() {
      return { ...status };
    },
    async finish(finishReason) {
      status.finishReason = finishReason || null;
      return null;
    },
    async abort(abortReason) {
      status.abortReason = abortReason || null;
      return null;
    }
  };
}

function formatRecorderStatusText(recorder) {
  const status = recorder && typeof recorder.getStatus === 'function'
    ? recorder.getStatus()
    : {};

  const parts = [
    `state=${status.state}`,
    `spawnSeen=${status.spawnSeen}`,
    `bootstrapTicks=${status.bootstrapPhysicsTicks}`,
    `activeArchives=${status.activeArchives}`,
    `ticks=${status.totalTicks}`,
    `chunk=${status.currentChunkIndex}`,
    `flushed=${status.flushedChunkCount}`,
    `columns=${status.loadedColumns}`,
    `dimension=${status.currentDimension}`,
    `login=${status.loginCaptured}`,
    `configPackets=${status.cachedConfigurationPackets}`,
    `mapChunks=${status.cachedChunkLoads}`,
    `blockEntities=${status.cachedBlockEntities}`,
    `trackedEntities=${status.trackedEntities}`,
    `entitySpawns=${status.cachedEntitySpawns}`,
    `entitySupplementals=${status.cachedEntitySupplementals}`,
    `chunkCacheEntries=${status.chunkCacheEntries}`,
    `chunkCacheFiles=${status.chunkCacheFiles}`,
    `timeCaptured=${status.timeCaptured}`,
    `weatherEvents=${status.weatherEventsCaptured}`,
    `objectives=${status.scoreboardObjectives}`,
    `teams=${status.teamsTracked}`,
    `bossBars=${status.bossBarsTracked}`,
    `maps=${status.mapsTracked}`
  ];

  if (status.primaryArchiveId) parts.push(`primary=${status.primaryArchiveId}`);
  if (status.primaryArchiveStartAt) parts.push(`primaryStart=${status.primaryArchiveStartAt}`);
  if (status.primaryArchiveEndAt) parts.push(`primaryEnd=${status.primaryArchiveEndAt}`);
  if (status.overlapArchiveId) parts.push(`overlap=${status.overlapArchiveId}`);
  if (status.overlapArchiveStartAt) parts.push(`overlapStart=${status.overlapArchiveStartAt}`);
  if (status.overlapArchiveEndAt) parts.push(`overlapEnd=${status.overlapArchiveEndAt}`);
  if (status.pendingExportJobs) parts.push(`pendingExports=${status.pendingExportJobs}`);
  if (status.lastExportedArchive) parts.push(`lastExport=${status.lastExportedArchive}`);
  if (status.lastExportError) parts.push(`exportError=${status.lastExportError}`);
  if (status.pendingRolloverReason) parts.push(`rollover=${status.pendingRolloverReason}`);
  if (status.finishReason) parts.push(`finish=${status.finishReason}`);
  if (status.abortReason) parts.push(`abort=${status.abortReason}`);
  if (status.lastError) parts.push(`lastError=${status.lastError}`);
  if (status.droppedPacketKinds && Object.keys(status.droppedPacketKinds).length > 0) {
    parts.push(`dropped=${Object.keys(status.droppedPacketKinds).length}`);
  }
  if (status.outputPath) parts.push(`file=${status.outputPath}`);

  return `[recording] ${parts.join(' | ')}`;
}

let recorderModuleCache = null;

function resolveOptionalModule(modulePathCandidates) {
  for (const candidate of modulePathCandidates) {
    try {
      return require(candidate);
    } catch (error) {
      if (error && error.code !== 'MODULE_NOT_FOUND') {
        throw error;
      }
    }
  }

  return null;
}

function getRecorderModuleApi() {
  if (recorderModuleCache) {
    return recorderModuleCache;
  }

  const baseCandidates = [
    path.resolve(__dirname, '../../../flashback-recorder'),
    path.resolve(__dirname, '../../../../../flashback-recorder'),
    path.resolve(process.cwd(), 'flashback-recorder')
  ];
  const runtimeCandidates = [
    path.resolve(__dirname, '../../../flashback-recorder/runtime.js'),
    path.resolve(__dirname, '../../../../../flashback-recorder/runtime.js'),
    path.resolve(process.cwd(), 'flashback-recorder', 'runtime.js')
  ];

  const recorderModule = resolveOptionalModule(baseCandidates);
  const runtimeModule = resolveOptionalModule(runtimeCandidates);

  recorderModuleCache = {
    attachFlashbackRecorder: recorderModule && typeof recorderModule.attachFlashbackRecorder === 'function'
      ? recorderModule.attachFlashbackRecorder
      : null,
    createNoopFlashbackRecorder: runtimeModule && typeof runtimeModule.createNoopFlashbackRecorder === 'function'
      ? runtimeModule.createNoopFlashbackRecorder
      : createNoopFlashbackRecorder,
    formatRecorderStatusText: runtimeModule && typeof runtimeModule.formatRecorderStatusText === 'function'
      ? runtimeModule.formatRecorderStatusText
      : formatRecorderStatusText
  };

  return recorderModuleCache;
}

class RecorderFeature {
  constructor(options = {}) {
    this.paths = options.paths || {};
    this.config = options.config || {};
    this.logger = options.logger;
    this.botConfig = options.botConfig || {};
    this.capabilities = {
      entityHandling: options.capabilities?.entityHandling !== false,
      terrainHandling: options.capabilities?.terrainHandling !== false
    };
    this.effectiveRecorderOptions = null;
    this.recorder = createNoopFlashbackRecorder('disabled');
    this.bot = null;
    this.listeners = [];
  }

  addListener(target, eventName, handler) {
    if (!target || typeof target.on !== 'function') {
      return;
    }

    target.on(eventName, handler);
    this.listeners.push({ target, eventName, handler });
  }

  resolveOutputDir() {
    if (typeof this.config.outputDir === 'string' && this.config.outputDir.trim()) {
      return path.resolve(this.paths.accountDir, this.config.outputDir);
    }

    if (this.paths.appRoot) {
      return path.join(this.paths.appRoot, 'replays');
    }

    return path.resolve(this.paths.accountDir, '../replays');
  }

  getCapabilities() {
    return {
      entityHandling: this.capabilities.entityHandling !== false,
      terrainHandling: this.capabilities.terrainHandling !== false
    };
  }

  buildEffectiveRecorderOptions() {
    const capabilities = this.getCapabilities();
    const effectiveOptions = {
      enabled: true,
      version: this.botConfig.version || '1.21.11',
      outputDir: this.resolveOutputDir(),
      bootstrapWindowTicks: this.config.bootstrapWindowTicks ?? 20,
      bootstrapTimeoutMs: this.config.bootstrapTimeoutMs ?? 5000,
      includeWorldSnapshot: this.config.includeWorldSnapshot !== false,
      includeMinimalLocalPlayer: this.config.includeMinimalLocalPlayer !== false,
      entityScope: this.config.entityScope || 'all_visible',
      equipmentScope: this.config.equipmentScope || 'all_with_equipment',
      includeTimeUpdates: this.config.includeTimeUpdates !== false,
      includeWeatherState: this.config.includeWeatherState !== false,
      includeDifficulty: this.config.includeDifficulty !== false,
      includeSpawnPosition: this.config.includeSpawnPosition !== false,
      includeWorldBorder: this.config.includeWorldBorder !== false,
      includeBlockEntityUpdates: this.config.includeBlockEntityUpdates !== false,
      includeLaterChunkLoads: this.config.includeLaterChunkLoads !== false,
      includeParticles: this.config.includeParticles !== false,
      includeCollectAnimation: this.config.includeCollectAnimation !== false,
      includeHurtAnimation: this.config.includeHurtAnimation !== false,
      includeBossBar: this.config.includeBossBar !== false,
      includeScoreboard: this.config.includeScoreboard !== false,
      includeTabListHeaderFooter: this.config.includeTabListHeaderFooter !== false,
      includeMapData: this.config.includeMapData !== false,
      chunkDurationTicks: this.config.chunkDurationTicks ?? 6000,
      archiveRotationEnabled: this.config.archiveRotationEnabled !== false,
      archiveNominalMinutes: this.config.archiveNominalMinutes ?? 60,
      archiveOverlapMinutes: this.config.archiveOverlapMinutes ?? 5,
      recoverPendingArchivesOnStart: this.config.recoverPendingArchivesOnStart !== false,
      shutdownExportTimeoutMs: this.config.shutdownExportTimeoutMs ?? 60000,
      enableChunkCache: this.config.enableChunkCache !== false,
      continueAcrossDimensions: this.config.continueAcrossDimensions !== false,
      autoStartOnSpawn: true,
      autoFinishOnEnd: true,
      debug: this.config.debug === true,
      debugChunkCapture: this.config.debugChunkCapture === true,
      debugChunkCaptureLimit: this.config.debugChunkCaptureLimit ?? 20,
      debugDroppedPackets: this.config.debugDroppedPackets === true,
      memoryMonitor: this.config.memoryMonitor || undefined,
      serverHost: this.botConfig.host,
      serverPort: this.botConfig.port,
      entityHandlingEnabled: capabilities.entityHandling,
      terrainHandlingEnabled: capabilities.terrainHandling
    };

    if (!capabilities.entityHandling) {
      effectiveOptions.entityScope = 'self_only';
      effectiveOptions.includeCollectAnimation = false;
      effectiveOptions.includeHurtAnimation = false;
    }

    if (!capabilities.terrainHandling) {
      effectiveOptions.includeWorldSnapshot = false;
      effectiveOptions.includeLaterChunkLoads = false;
      effectiveOptions.includeBlockEntityUpdates = false;
      effectiveOptions.enableChunkCache = false;
    }

    return effectiveOptions;
  }

  attach(bot) {
    this.detach();

    const {
      attachFlashbackRecorder,
      createNoopFlashbackRecorder: createNoopRecorder
    } = getRecorderModuleApi();

    if (this.config.enabled !== true) {
      this.effectiveRecorderOptions = null;
      this.recorder = createNoopRecorder('disabled');
      return;
    }

    this.bot = bot;

    try {
      if (typeof attachFlashbackRecorder !== 'function') {
        throw new Error('flashback-recorder module not found');
      }

      this.effectiveRecorderOptions = this.buildEffectiveRecorderOptions();
      this.recorder = attachFlashbackRecorder(bot, this.effectiveRecorderOptions);
    } catch (error) {
      this.effectiveRecorderOptions = null;
      this.recorder = createNoopRecorder('missing_dependency');
      if (this.logger) {
        this.logger.error('[RECORDING] attach failed', error);
      }
    }

    this.addListener(bot, 'physicsTick', () => {
      this.recorder.onPhysicsTick();
    });
    this.addListener(bot, 'move', () => {
      this.recorder.onLocalPlayerMove();
    });
    this.addListener(bot, 'forcedMove', () => {
      this.recorder.onLocalPlayerMove();
    });

    if (this.capabilities.entityHandling !== false) {
      this.addListener(bot, 'entityMoved', (entity) => {
        this.recorder.onEntityMoved(entity);
      });
      this.addListener(bot, 'entitySpawn', (entity) => {
        this.recorder.onEntitySpawn(entity);
      });
      this.addListener(bot, 'entityGone', (entity) => {
        this.recorder.onEntityGone(entity);
      });
    }
  }

  detach() {
    for (const listener of this.listeners) {
      if (listener.target && typeof listener.target.removeListener === 'function') {
        listener.target.removeListener(listener.eventName, listener.handler);
      }
    }

    this.listeners = [];
    this.bot = null;
  }

  getStatusText() {
    return getRecorderModuleApi().formatRecorderStatusText(this.recorder);
  }

  async finish(reason = 'manual_finish') {
    return this.recorder.finish(reason);
  }

  async abort(reason = 'manual_abort') {
    return this.recorder.abort(reason);
  }

  async shutdown(reason = 'shutdown') {
    try {
      await this.finish(reason);
    } catch (error) {
      if (this.logger) {
        this.logger.warn('[RECORDING] graceful finish failed, aborting', error);
      }
      await this.abort(reason);
    }
  }
}

module.exports = {
  RecorderFeature
};
