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
import {
  countViewedDestroyables,
  getDestructionMarkerCursor,
  getDestructionMarkerGridSize,
  isDestroyableOnViewedLevel,
  selectNearbyDestroyables,
  subscribeDestructionMarkerPointer
} from "../destruction-marker-proximity.js";

const TOOL_NAME = "theiksToolbagDestroyTerrain";
const DESTROY_MARKER_TEXTURE = "icons/svg/explosion.svg";
const RESTORE_MARKER_TEXTURE = "icons/svg/regen.svg";
const DESTROY_MARKER_COLOR = 0xFF9829;
const RESTORE_MARKER_COLOR = 0x4CAF50;
export const TERRAIN_DESTRUCTION_MODE_CHANGED_HOOK = `${MODULE_ID}.terrainDestructionModeChanged`;

let active = false;
let markerContainer = null;
const markersByTileId = new Map();
let refreshId = 0;
let refreshQueued = false;
let pendingRebuild = false;
let visibleKey = "";
let unsubscribePointer = null;

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
  const previous = active;
  active = isActive && game.user.isGM && isFeatureEnabled(FEATURES.breakableTerrain);
  if (active !== previous) Hooks.callAll?.(TERRAIN_DESTRUCTION_MODE_CHANGED_HOOK, active);
  if (active) {
    unsubscribePointer ??= subscribeDestructionMarkerPointer(queueProximityRefresh);
    queueMarkerRefresh();
  } else {
    unsubscribePointer?.();
    unsubscribePointer = null;
    clearMarkers();
  }
}

export function isTerrainDestructionModeActive() {
  return active;
}

function refreshMarkersIfActive() {
  queueMarkerRefresh();
}

function refreshForTileChange(tile) {
  if (tile?.parent === canvas.scene) queueMarkerRefresh();
}

function queueMarkerRefresh() {
  pendingRebuild = true;
  queueMarkerSync();
}

function queueProximityRefresh() {
  queueMarkerSync();
}

function queueMarkerSync() {
  if (!active || refreshQueued) return;
  refreshQueued = true;
  queueMicrotask(() => {
    refreshQueued = false;
    if (!active) return;
    const rebuild = pendingRebuild;
    pendingRebuild = false;
    void refreshMarkers({rebuild});
  });
}

async function refreshMarkers({rebuild = true} = {}) {
  if (!active || !isFeatureEnabled(FEATURES.breakableTerrain)
    || !canvas.ready || !canvas.controls || !game.user.isGM) {
    if (rebuild) destroyMarkerContainer();
    return;
  }

  const tiles = visibleTiles();
  const signature = tiles.map(tile => tile.id).toSorted().join("\0");
  if (!rebuild && markerContainer && signature === visibleKey) return;

  const currentRefresh = ++refreshId;
  if (rebuild) destroyMarkerContainer();
  const container = ensureMarkerContainer();
  visibleKey = signature;

  if (!rebuild) {
    const visibleIds = new Set(tiles.map(tile => tile.id));
    for (const [id, marker] of [...markersByTileId]) {
      if (visibleIds.has(id)) continue;
      marker.destroy({children: true});
      markersByTileId.delete(id);
    }
  }

  const pending = rebuild ? tiles : tiles.filter(tile => !markersByTileId.has(tile.id));
  await Promise.all(pending.map(async tile => {
    try {
      const marker = await createMarker(tile);
      if (currentRefresh !== refreshId || markerContainer !== container || !container.parent) {
        marker.destroy({children: true});
        return;
      }
      if (markersByTileId.has(tile.id)) {
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

function visibleTiles() {
  const tiles = (canvas.tiles?.placeables ?? []).filter(tile => {
    const data = getBreakableTerrainData(tile.document);
    return isDestroyableOnViewedLevel(tile.document) && (data.enabled || data.damaged);
  });
  return selectNearbyDestroyables(tiles.map(tile => {
    const [x, y] = getTerrainMarkerPosition(tile.document);
    return {target: tile, x, y};
  }), {
    totalCount: countViewedDestroyables(),
    cursor: getDestructionMarkerCursor(),
    gridSize: getDestructionMarkerGridSize()
  }).map(item => item.target);
}

function ensureMarkerContainer() {
  if (markerContainer?.parent === canvas.controls) return markerContainer;
  destroyMarkerContainer();
  const container = new PIXI.Container();
  container.name = `${MODULE_ID}.breakableTerrainMarkers`;
  container.eventMode = "passive";
  canvas.controls.addChild(container);
  markerContainer = container;
  return container;
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
  visibleKey = "";
  if (!markerContainer) return;
  markerContainer.removeFromParent();
  markerContainer.destroy({children: true});
  markerContainer = null;
}
