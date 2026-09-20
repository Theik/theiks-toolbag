import { registerBreakableWallConfig } from "./breakable-walls/wall-config.js";
import {
  destroyWall,
  promptWallDestruction,
  registerBreakableWallState,
  repairWall,
  toggleWall
} from "./breakable-walls/wall-destruction.js";
import { registerWallDestructionMode } from "./breakable-walls/destruction-mode.js";
import { registerDestroyedWallArt } from "./breakable-walls/wall-art.js";
import { registerWallSplitting } from "./breakable-walls/wall-splitting.js";
import { registerVisibleLightConfig } from "./visible-lights/light-config.js";
import { registerVisibleLightArt } from "./visible-lights/light-art.js";
import {
  destroyVisibleLight,
  repairVisibleLight,
  registerVisibleLightControls,
  toggleVisibleLight
} from "./visible-lights/light-controls.js";
import {registerBreakableTerrainConfig} from "./breakable-terrain/terrain-config.js";
import {
  advanceTerrainDestruction,
  restoreTerrain,
  retreatTerrainDestruction
} from "./breakable-terrain/terrain-destruction.js";
import {registerBreakableTerrainEdges} from "./breakable-terrain/terrain-edges.js";
import {registerTerrainDestructionMode} from "./breakable-terrain/destruction-mode.js";
import {registerCombinedDestructionMode} from "./combined-destruction-mode.js";
import {
  UNDERGROUND_SCHEMA_VERSION,
  createUndergroundSource,
  digUnderground,
  isUndergroundAvailable,
  repairUnderground,
  resetUnderground
} from "./underground/underground-data.js";
import {createUndergroundSourceFromScene} from "./underground/underground-occupancy.js";
import {registerUndergroundRuntime} from "./underground/underground-runtime.js";
import {registerUndergroundRegionBehaviors} from "./underground/underground-regions.js";
import {registerUndergroundControls} from "./underground/underground-controls.js";
import {registerUndergroundSceneConfig} from "./underground/underground-scene-config.js";
import {registerUndergroundDebug, toggleUndergroundOverlay} from "./underground/underground-debug.js";
import {registerUsableTileConfig} from "./usable-tiles/tile-config.js";
import {registerUsableTileControls, useUsableTile} from "./usable-tiles/tile-controls.js";
import {registerFeatureSettings} from "./settings.js";
import {registerFootprintConfig} from "./footprints/footprint-config.js";
import {registerFootprintRuntime} from "./footprints/footprint-runtime.js";
import {registerFootprintDebug, toggleFootprintOverlay} from "./footprints/footprint-debug.js";
import {
  changeTokenLevels,
  promptTokenLevelChange,
  registerLevelTools,
  updateTokenElevation
} from "./levels/level-tools.js";

export const MODULE_ID = "theiks-toolbag";

Hooks.once("init", () => {
  registerFeatureSettings();
  registerBreakableWallConfig();
  registerBreakableWallState();
  registerWallDestructionMode();
  registerDestroyedWallArt();
  registerWallSplitting();
  registerVisibleLightConfig();
  registerVisibleLightArt();
  registerVisibleLightControls();
  registerBreakableTerrainConfig();
  registerBreakableTerrainEdges();
  registerTerrainDestructionMode();
  registerCombinedDestructionMode();
  registerUndergroundRuntime();
  registerUndergroundRegionBehaviors();
  registerUndergroundDebug();
  registerUndergroundControls();
  registerUndergroundSceneConfig();
  registerUsableTileConfig();
  registerUsableTileControls();
  registerLevelTools();
  registerFootprintConfig();
  registerFootprintRuntime();
  registerFootprintDebug();

  const module = game.modules.get(MODULE_ID);
  module.api = {
    ...module.api,
    updateElevation: updateTokenElevation,
    breakableWalls: {
      prompt: promptWallDestruction,
      destroy: destroyWall,
      repair: repairWall,
      toggle: toggleWall
    },
    visibleLights: {
      toggle: toggleVisibleLight,
      destroy: destroyVisibleLight,
      repair: repairVisibleLight
    },
    breakableTerrain: {
      advance: advanceTerrainDestruction,
      retreat: retreatTerrainDestruction,
      restore: restoreTerrain
    },
    undergroundTerrain: {
      schemaVersion: UNDERGROUND_SCHEMA_VERSION,
      isAvailable: isUndergroundAvailable,
      createSource: createUndergroundSource,
      createSourceFromScene: createUndergroundSourceFromScene,
      dig: digUnderground,
      repair: repairUnderground,
      reset: resetUnderground,
      toggleOverlay: toggleUndergroundOverlay
    },
    footprints: {
      toggleOverlay: toggleFootprintOverlay
    },
    usableTiles: {
      use: useUsableTile
    },
    levelTools: {
      prompt: promptTokenLevelChange,
      change: changeTokenLevels,
      updateElevation: updateTokenElevation
    }
  };

  console.info(`${MODULE_ID} | Initialized`);
});
