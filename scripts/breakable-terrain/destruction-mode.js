import {MODULE_ID, getBreakableTerrainData} from "./terrain-config.js";
import {
  advanceTerrainDestruction,
  restoreTerrain,
  retreatTerrainDestruction
} from "./terrain-destruction.js";
import {getTerrainMarkerPosition} from "./terrain-edges.js";
import {
  FEATURES,
  FEATURE_SETTING_CHANGED_HOOK,
  isFeatureEnabled
} from "../settings.js";

const TOOL_NAME = "theiksToolbagDestroyTerrain";
const DESTROY_MARKER_TEXTURE = "icons/svg/explosion.svg";
const RESTORE_MARKER_TEXTURE = "icons/svg/regen.svg";
const DESTROY_MARKER_COLOR = 0xFF9829;
const RESTORE_MARKER_COLOR = 0x4CAF50;

let active = false;
let markerContainer = null;
const markersByTileId = new Map();
let refreshId = 0;
let refreshQueued = false;

/** Register the GM-only Tiles toolbar destruction tool and its marker lifecycle. */
export function registerTerrainDestructionMode() {
  Hooks.on("getSceneControlButtons", addSceneControlTool);
  Hooks.on("canvasReady", refreshMarkersIfActive);
  Hooks.on("canvasTearDown", clearMarkers);
  Hooks.on("createTile", refreshForTileChange);
  Hooks.on("updateTile", refreshForTileChange);
  Hooks.on("deleteTile", refreshForTileChange);
  Hooks.on("refreshTile", refreshMarkerPosition);
  Hooks.on(FEATURE_SETTING_CHANGED_HOOK, (feature, enabled) => {
    if (feature === FEATURES.breakableTerrain && !enabled) setTerrainDestructionModeActive(false);
  });
}

function addSceneControlTool(controls) {
  if (!controls.tiles || !game.user.isGM || !isFeatureEnabled(FEATURES.breakableTerrain)) return;
  controls.tiles.tools[TOOL_NAME] = {
    name: TOOL_NAME,
    order: 5,
    title: "THEIKS_TOOLBAG.BreakableTerrain.Tool.Title",
    icon: "fa-solid fa-hammer",
    visible: game.user.isGM,
    interaction: false,
    control: false,
    onChange: (_event, isActive) => setTerrainDestructionModeActive(isActive)
  };
}

/** Allow the combined destruction control to activate or deactivate terrain markers. */
export function setTerrainDestructionModeActive(isActive) {
  active = isActive && game.user.isGM && isFeatureEnabled(FEATURES.breakableTerrain);
  if (active) queueMarkerRefresh();
  else clearMarkers();
}

function refreshMarkersIfActive() {
  queueMarkerRefresh();
}

function refreshForTileChange(tile) {
  if (tile?.parent === canvas.scene) queueMarkerRefresh();
}

function queueMarkerRefresh() {
  if (!active || refreshQueued) return;
  refreshQueued = true;
  queueMicrotask(() => {
    refreshQueued = false;
    if (active) void refreshMarkers();
  });
}

async function refreshMarkers() {
  const currentRefresh = ++refreshId;
  destroyMarkerContainer();
  if (!active || !isFeatureEnabled(FEATURES.breakableTerrain)
    || !canvas.ready || !canvas.controls || !game.user.isGM) return;

  const container = new PIXI.Container();
  container.name = `${MODULE_ID}.breakableTerrainMarkers`;
  container.eventMode = "passive";
  canvas.controls.addChild(container);
  markerContainer = container;

  const tiles = (canvas.tiles?.placeables ?? []).filter(tile => {
    const data = getBreakableTerrainData(tile.document);
    return isTileOnViewedLevel(tile.document) && (data.enabled || data.damaged);
  });
  await Promise.all(tiles.map(async tile => {
    try {
      const marker = await createMarker(tile);
      if (currentRefresh !== refreshId || markerContainer !== container || !container.parent) {
        marker.destroy({children: true});
        return;
      }
      container.addChild(marker);
      markersByTileId.set(tile.id, marker);
    } catch (error) {
      console.error(`${MODULE_ID} | Failed to draw a terrain destruction marker`, error);
    }
  }));
}

function isTileOnViewedLevel(tile) {
  const levels = normalizeLevelIds(tile?.levels ?? tile?._source?.levels);
  if (!levels.length) return true;
  const currentLevelId = canvas.level?.id ?? canvas.level?._id;
  return currentLevelId != null && levels.includes(String(currentLevelId));
}

function normalizeLevelIds(levels) {
  if (!levels) return [];
  try {
    return Array.from(levels)
      .map(level => level?.id ?? level?._id ?? level)
      .filter(value => value != null && value !== "")
      .map(String);
  } catch (_error) {
    return [];
  }
}

async function createMarker(tile) {
  const destroyed = getBreakableTerrainData(tile.document).fullyDestroyed;
  const color = destroyed ? RESTORE_MARKER_COLOR : DESTROY_MARKER_COLOR;
  const idleTint = destroyed ? color : 0xFFFFFF;
  const size = 32 * canvas.dimensions.uiScale;
  const marker = new foundry.canvas.containers.ControlIcon({
    texture: destroyed ? RESTORE_MARKER_TEXTURE : DESTROY_MARKER_TEXTURE,
    size,
    borderColor: color,
    tint: idleTint
  });
  await marker.draw();
  marker.position.set(...getTerrainMarkerPosition(tile.document));
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
    if (![0, 2].includes(event.button)) return;
    event.stopPropagation();
    event.preventDefault?.();
    void activateMarker(marker, tile.id, event.button);
  });
  return marker;
}

async function activateMarker(marker, tileId, button) {
  if (marker.eventMode === "none") return;
  const tile = canvas.scene?.tiles.get(tileId);
  const data = getBreakableTerrainData(tile);
  const action = button === 2
    ? (data.damaged ? retreatTerrainDestruction : null)
    : (data.fullyDestroyed ? restoreTerrain : (data.canAdvance ? advanceTerrainDestruction : null));
  if (!action) return;

  marker.eventMode = "none";
  marker.alpha = 0.45;
  try {
    await action(tile);
  } catch (error) {
    ui.notifications.error(error.message);
    console.error(`${MODULE_ID} | Terrain destruction-mode action failed`, error);
  } finally {
    if (marker.parent) {
      marker.eventMode = "static";
      marker.alpha = 0.8;
    }
  }
}

function refreshMarkerPosition(tile) {
  if (!active || !markerContainer) return;
  const source = tile?._original ?? tile;
  const marker = markersByTileId.get(source?.id);
  if (!marker || marker.parent !== markerContainer) return;
  marker.position.set(...getTerrainMarkerPosition(tile?.document ?? source.document));
}

function clearMarkers() {
  ++refreshId;
  refreshQueued = false;
  destroyMarkerContainer();
}

function destroyMarkerContainer() {
  markersByTileId.clear();
  if (!markerContainer) return;
  markerContainer.removeFromParent();
  markerContainer.destroy({children: true});
  markerContainer = null;
}
