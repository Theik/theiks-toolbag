import {setWallDestructionModeActive} from "./breakable-walls/destruction-mode.js";
import {setTerrainDestructionModeActive} from "./breakable-terrain/destruction-mode.js";

const CONTROL_NAME = "theiksToolbagDestruction";

/** Add one GM-only top-level control which displays both wall and terrain destruction markers. */
export function registerCombinedDestructionMode() {
  Hooks.on("getSceneControlButtons", addCombinedDestructionControl);
}

function addCombinedDestructionControl(controls) {
  if (!game.user.isGM) return;
  controls[CONTROL_NAME] = {
    name: CONTROL_NAME,
    order: 100,
    title: "THEIKS_TOOLBAG.DestructionMode.Title",
    icon: "fa-solid fa-hammer",
    visible: true,
    tools: {},
    onChange: (_event, isActive) => {
      setWallDestructionModeActive(isActive);
      setTerrainDestructionModeActive(isActive);
    }
  };
}
