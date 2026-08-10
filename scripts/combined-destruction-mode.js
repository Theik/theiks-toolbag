import {setWallDestructionModeActive} from "./breakable-walls/destruction-mode.js";
import {setTerrainDestructionModeActive} from "./breakable-terrain/destruction-mode.js";
import {FEATURES, isFeatureEnabled} from "./settings.js";

const CONTROL_NAME = "theiksToolbagDestruction";

/** Add one GM-only top-level control which displays both wall and terrain destruction markers. */
export function registerCombinedDestructionMode() {
  Hooks.on("getSceneControlButtons", addCombinedDestructionControl);
}

function addCombinedDestructionControl(controls) {
  const wallsEnabled = isFeatureEnabled(FEATURES.breakableWalls);
  const terrainEnabled = isFeatureEnabled(FEATURES.breakableTerrain);
  if (!game.user.isGM || (!wallsEnabled && !terrainEnabled)) return;
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
