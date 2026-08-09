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
import { registerVisibleLightConfig } from "./visible-lights/light-config.js";
import { registerVisibleLightArt } from "./visible-lights/light-art.js";
import {
  destroyVisibleLight,
  registerVisibleLightControls,
  toggleVisibleLight
} from "./visible-lights/light-controls.js";

export const MODULE_ID = "theiks-toolbag";

Hooks.once("init", () => {
  registerBreakableWallConfig();
  registerBreakableWallState();
  registerWallDestructionMode();
  registerDestroyedWallArt();
  registerVisibleLightConfig();
  registerVisibleLightArt();
  registerVisibleLightControls();

  const module = game.modules.get(MODULE_ID);
  module.api = {
    ...module.api,
    breakableWalls: {
      prompt: promptWallDestruction,
      destroy: destroyWall,
      repair: repairWall,
      toggle: toggleWall
    },
    visibleLights: {
      toggle: toggleVisibleLight,
      destroy: destroyVisibleLight
    }
  };

  console.info(`${MODULE_ID} | Initialized`);
});
