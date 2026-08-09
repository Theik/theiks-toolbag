import { registerBreakableWallConfig } from "./breakable-walls/wall-config.js";
import {
  destroyWall,
  promptWallDestruction
} from "./breakable-walls/wall-destruction.js";
import { registerWallDestructionMode } from "./breakable-walls/destruction-mode.js";

export const MODULE_ID = "theiks-toolbag";

Hooks.once("init", () => {
  registerBreakableWallConfig();
  registerWallDestructionMode();

  const module = game.modules.get(MODULE_ID);
  module.api = {
    ...module.api,
    breakableWalls: {
      prompt: promptWallDestruction,
      destroy: destroyWall
    }
  };

  console.info(`${MODULE_ID} | Initialized`);
});
