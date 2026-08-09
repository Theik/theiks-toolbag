import { MODULE_ID, getBreakableWallData } from "./wall-config.js";
import { promptWallDestruction } from "./wall-destruction.js";

const TOOL_NAME = "theiksToolbagDestroyWalls";
const MARKER_TEXTURE = "icons/svg/explosion.svg";

let active = false;
let markerContainer = null;
let refreshId = 0;
let refreshQueued = false;

/** Register the Walls toolbar tool and marker lifecycle hooks. */
export function registerWallDestructionMode() {
  Hooks.on("getSceneControlButtons", addSceneControlTool);
  Hooks.on("canvasReady", refreshMarkersIfActive);
  Hooks.on("canvasTearDown", clearMarkers);
  Hooks.on("createWall", refreshForWallChange);
  Hooks.on("updateWall", refreshForWallChange);
  Hooks.on("deleteWall", refreshForWallChange);
}

/** @param {Record<string, foundry.SceneControl>} controls */
function addSceneControlTool(controls) {
  if (!controls.walls || !game.user.isGM) return;
  controls.walls.tools[TOOL_NAME] = {
    name: TOOL_NAME,
    order: 12,
    title: "THEIKS_TOOLBAG.BreakableWalls.Tool.Title",
    icon: "fa-solid fa-hammer",
    visible: game.user.isGM,
    interaction: false,
    control: false,
    onChange: (_event, isActive) => setActive(isActive)
  };
}

/** @param {boolean} isActive */
function setActive(isActive) {
  active = isActive && game.user.isGM;
  if (active) queueMarkerRefresh();
  else clearMarkers();
}

function refreshMarkersIfActive() {
  queueMarkerRefresh();
}

/** @param {WallDocument} wall */
function refreshForWallChange(wall) {
  if (wall.parent === canvas.scene) queueMarkerRefresh();
}

/** Coalesce bulk Wall updates into one marker redraw. */
function queueMarkerRefresh() {
  if (!active || refreshQueued) return;
  refreshQueued = true;
  queueMicrotask(() => {
    refreshQueued = false;
    if (active) void refreshMarkers();
  });
}

/** Draw one destruction marker for each breakable Wall on the viewed level. */
async function refreshMarkers() {
  const currentRefresh = ++refreshId;
  destroyMarkerContainer();
  if (!active || !canvas.ready || !canvas.controls || !game.user.isGM) return;

  const container = new PIXI.Container();
  container.name = `${MODULE_ID}.breakableWallMarkers`;
  container.eventMode = "passive";
  canvas.controls.addChild(container);
  markerContainer = container;

  const walls = canvas.walls.placeables.filter(wall => getBreakableWallData(wall.document).enabled);
  await Promise.all(walls.map(async wall => {
    try {
      const marker = await createMarker(wall);
      if (currentRefresh !== refreshId || markerContainer !== container || !container.parent) {
        marker.destroy({children: true});
        return;
      }
      container.addChild(marker);
    } catch (error) {
      console.error(`${MODULE_ID} | Failed to draw a wall destruction marker`, error);
    }
  }));
}

/**
 * @param {foundry.canvas.placeables.Wall} wall
 * @returns {Promise<foundry.canvas.containers.ControlIcon>}
 */
async function createMarker(wall) {
  const size = 32 * canvas.dimensions.uiScale;
  const marker = new foundry.canvas.containers.ControlIcon({
    texture: MARKER_TEXTURE,
    size,
    borderColor: 0xFF9829
  });
  await marker.draw();
  marker.position.set(...wall.midpoint);
  marker.alpha = 0.8;

  marker.on("pointerover", event => {
    event.stopPropagation();
    marker.alpha = 1;
    marker.icon.tint = 0xFF9829;
  });
  marker.on("pointerout", event => {
    event.stopPropagation();
    marker.alpha = 0.8;
    marker.icon.tint = 0xFFFFFF;
  });
  marker.on("pointerdown", event => {
    event.stopPropagation();
    void activateMarker(marker, wall.id);
  });

  return marker;
}

/**
 * @param {foundry.canvas.containers.ControlIcon} marker
 * @param {string} wallId
 */
async function activateMarker(marker, wallId) {
  if (marker.eventMode === "none") return;
  marker.eventMode = "none";
  marker.alpha = 0.45;

  try {
    const wall = canvas.scene?.walls.get(wallId);
    await promptWallDestruction(wall);
  } finally {
    if (marker.parent) {
      marker.eventMode = "static";
      marker.alpha = 0.8;
    }
  }
}

function clearMarkers() {
  ++refreshId;
  destroyMarkerContainer();
}

function destroyMarkerContainer() {
  if (!markerContainer) return;
  markerContainer.removeFromParent();
  markerContainer.destroy({children: true});
  markerContainer = null;
}
