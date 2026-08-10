import { MODULE_ID, getBreakableWallData } from "./wall-config.js";
import { promptWallDestruction, repairWall } from "./wall-destruction.js";

const TOOL_NAME = "theiksToolbagDestroyWalls";
const DESTROY_MARKER_TEXTURE = "icons/svg/explosion.svg";
const REPAIR_MARKER_TEXTURE = "icons/svg/regen.svg";
const DESTROY_MARKER_COLOR = 0xFF9829;
const REPAIR_MARKER_COLOR = 0x4CAF50;

let active = false;
let markerContainer = null;
const markersByWallId = new Map();
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
  Hooks.on("refreshWall", refreshMarkerPosition);
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
    onChange: (_event, isActive) => setWallDestructionModeActive(isActive)
  };
}

/** @param {boolean} isActive */
export function setWallDestructionModeActive(isActive) {
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

/** Draw an action marker for each intact breakable or destroyed Wall on the viewed level. */
async function refreshMarkers() {
  const currentRefresh = ++refreshId;
  destroyMarkerContainer();
  if (!active || !canvas.ready || !canvas.controls || !game.user.isGM) return;

  const container = new PIXI.Container();
  container.name = `${MODULE_ID}.breakableWallMarkers`;
  container.eventMode = "passive";
  canvas.controls.addChild(container);
  markerContainer = container;

  const walls = canvas.walls.placeables.filter(wall => {
    const data = getBreakableWallData(wall.document);
    return isWallOnViewedLevel(wall.document) && (data.destroyed || data.enabled);
  });
  await Promise.all(walls.map(async wall => {
    try {
      const marker = await createMarker(wall);
      if (currentRefresh !== refreshId || markerContainer !== container || !container.parent) {
        marker.destroy({children: true});
        return;
      }
      container.addChild(marker);
      markersByWallId.set(wall.id, marker);
    } catch (error) {
      console.error(`${MODULE_ID} | Failed to draw a wall destruction marker`, error);
    }
  }));
}

/** A Wall with no assigned levels is visible everywhere; assigned Walls only belong to the viewed level. */
function isWallOnViewedLevel(wall) {
  const levels = wall.levels;
  if (!levels || levels.size === 0 || levels.length === 0) return true;

  const levelId = canvas.level?.id ?? canvas.level?._id;
  if (!levelId) return false;
  return levels.has?.(levelId) ?? levels.includes?.(levelId) ?? false;
}

/**
 * @param {foundry.canvas.placeables.Wall} wall
 * @returns {Promise<foundry.canvas.containers.ControlIcon>}
 */
async function createMarker(wall) {
  const destroyed = getBreakableWallData(wall.document).destroyed;
  const color = destroyed ? REPAIR_MARKER_COLOR : DESTROY_MARKER_COLOR;
  const idleTint = destroyed ? color : 0xFFFFFF;
  const size = 32 * canvas.dimensions.uiScale;
  const marker = new foundry.canvas.containers.ControlIcon({
    texture: destroyed ? REPAIR_MARKER_TEXTURE : DESTROY_MARKER_TEXTURE,
    size,
    borderColor: color,
    tint: idleTint
  });
  await marker.draw();
  marker.position.set(...wall.midpoint);
  marker.icon.tint = idleTint;
  marker.alpha = 0.8;

  marker.on("pointerover", event => {
    event.stopPropagation();
    marker.alpha = 1;
    marker.icon.tint = color;
  });
  marker.on("pointerout", event => {
    event.stopPropagation();
    marker.alpha = 0.8;
    marker.icon.tint = idleTint;
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
    if (getBreakableWallData(wall).destroyed) await repairWall(wall);
    else await promptWallDestruction(wall);
  } catch (error) {
    ui.notifications.error(error.message);
    console.error(`${MODULE_ID} | Wall destruction-mode action failed`, error);
  } finally {
    if (marker.parent) {
      marker.eventMode = "static";
      marker.alpha = 0.8;
    }
  }
}

/** Keep a marker attached to the midpoint of a Wall or its drag-preview clone. */
function refreshMarkerPosition(wall) {
  if (!active || !markerContainer) return;
  const wallId = (wall._original ?? wall).id;
  const marker = markersByWallId.get(wallId);
  if (!marker || marker.parent !== markerContainer) return;
  marker.position.set(...wall.midpoint);
}

function clearMarkers() {
  ++refreshId;
  destroyMarkerContainer();
}

function destroyMarkerContainer() {
  markersByWallId.clear();
  if (!markerContainer) return;
  markerContainer.removeFromParent();
  markerContainer.destroy({children: true});
  markerContainer = null;
}
