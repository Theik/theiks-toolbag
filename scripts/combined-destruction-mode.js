import {setWallDestructionModeActive} from "./breakable-walls/destruction-mode.js";
import {setTerrainDestructionModeActive} from "./breakable-terrain/destruction-mode.js";
import {promptResetDestructables} from "./reset-destructables.js";
import {FEATURES, isFeatureEnabled} from "./settings.js";

const CONTROL_NAME = "theiksToolbagDestruction";
const MODE_TOOL_NAME = "theiksToolbagDestructionMode";
const RESET_TOOL_NAME = "theiksToolbagResetDestructables";

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
    activeTool: MODE_TOOL_NAME,
    tools: {
      [MODE_TOOL_NAME]: {
        name: MODE_TOOL_NAME,
        order: 1,
        title: "THEIKS_TOOLBAG.DestructionMode.Title",
        icon: "fa-solid fa-hammer",
        visible: true,
        interaction: false,
        control: false,
        onChange: (_event, isActive) => {
          setWallDestructionModeActive(isActive);
          setTerrainDestructionModeActive(isActive);
        }
      },
      [RESET_TOOL_NAME]: {
        name: RESET_TOOL_NAME,
        order: 2,
        title: "THEIKS_TOOLBAG.DestructionMode.Reset.Title",
        icon: "fa-solid fa-arrow-rotate-left",
        visible: true,
        button: true,
        onChange: () => void promptResetDestructables()
      }
    }
  };
}
