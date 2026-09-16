import {getBreakableWallData} from "./breakable-walls/wall-config.js";
import {getBreakableTerrainData} from "./breakable-terrain/terrain-config.js";
import {FEATURES, isFeatureEnabled} from "./settings.js";

export const DESTRUCTION_MARKER_LIMIT = 200;
export const DESTRUCTION_MARKER_RADIUS_GRIDS = 20;

const pointerListeners = new Set();
let hooksAttached = false;
let attachedStage = null;
let pointerNotifyQueued = false;
let pointerNotifyId = 0;
let lastCursor = null;

/** Subscribe to cursor movement while a destruction-mode tool is drawing markers. */
export function subscribeDestructionMarkerPointer(callback) {
  pointerListeners.add(callback);
  attachDestructionMarkerHooks();
  attachDestructionMarkerPointer();
  return () => {
    pointerListeners.delete(callback);
    if (pointerListeners.size) return;
    detachDestructionMarkerPointer();
  };
}

export function attachDestructionMarkerPointer() {
  if (!pointerListeners.size) return;
  const stage = canvas?.stage;
  if (!stage || attachedStage === stage) return;
  detachDestructionMarkerPointer();
  attachedStage = stage;
  stage.on("pointermove", onPointerMove);
}

export function detachDestructionMarkerPointer() {
  attachedStage?.off?.("pointermove", onPointerMove);
  attachedStage = null;
  lastCursor = null;
  cancelPointerNotify();
}

/** Canvas-space cursor used to decide which destruction markers stay visible. */
export function getDestructionMarkerCursor() {
  if (Number.isFinite(lastCursor?.x) && Number.isFinite(lastCursor?.y)) {
    return {x: lastCursor.x, y: lastCursor.y};
  }
  const position = canvas?.mousePosition;
  if (Number.isFinite(position?.x) && Number.isFinite(position?.y)) {
    return {x: position.x, y: position.y};
  }
  return null;
}

export function getDestructionMarkerGridSize() {
  const size = Number(canvas?.grid?.size ?? canvas?.dimensions?.size);
  return size > 0 ? size : 100;
}

/** Count destroyable walls and tiles that would receive a marker on the viewed Level. */
export function countViewedDestroyables() {
  let count = 0;
  if (isFeatureEnabled(FEATURES.breakableWalls)) {
    for (const wall of canvas.walls?.placeables ?? []) {
      const data = getBreakableWallData(wall.document);
      if (isDestroyableOnViewedLevel(wall.document) && (data.destroyed || data.enabled)) count++;
    }
  }
  if (isFeatureEnabled(FEATURES.breakableTerrain)) {
    for (const tile of canvas.tiles?.placeables ?? []) {
      const data = getBreakableTerrainData(tile.document);
      if (isDestroyableOnViewedLevel(tile.document) && (data.enabled || data.damaged)) count++;
    }
  }
  return count;
}

/**
 * Keep every marker when the Scene is small. On crowded Scenes, keep only those near the cursor.
 *
 * @template {{x: number, y: number}} T
 * @param {T[]} items
 * @param {{
 *   totalCount?: number,
 *   cursor?: {x: number, y: number}|null,
 *   gridSize?: number
 * }} [options]
 * @returns {T[]}
 */
export function selectNearbyDestroyables(items, options = {}) {
  const totalCount = options.totalCount ?? countViewedDestroyables();
  if (totalCount < DESTRUCTION_MARKER_LIMIT) return items;

  const cursor = options.cursor !== undefined ? options.cursor : getDestructionMarkerCursor();
  const gridSize = options.gridSize ?? getDestructionMarkerGridSize();
  if (!cursor || !(gridSize > 0)) return [];

  const radius = DESTRUCTION_MARKER_RADIUS_GRIDS * gridSize;
  const radius2 = radius * radius;
  return items.filter(item => {
    const dx = item.x - cursor.x;
    const dy = item.y - cursor.y;
    return (dx * dx) + (dy * dy) <= radius2;
  });
}

export function isDestroyableOnViewedLevel(document) {
  const levels = normalizeLevelIds(document?.levels ?? document?._source?.levels);
  if (!levels.length) return true;
  const currentLevelId = canvas.level?.id ?? canvas.level?._id;
  return currentLevelId != null && levels.includes(String(currentLevelId));
}

function attachDestructionMarkerHooks() {
  if (hooksAttached) return;
  hooksAttached = true;
  Hooks.on("canvasReady", attachDestructionMarkerPointer);
  Hooks.on("canvasTearDown", detachDestructionMarkerPointer);
  Hooks.on("canvasPan", onCanvasPan);
}

function onPointerMove(event) {
  lastCursor = pointerCanvasPoint(event) ?? lastCursor;
  schedulePointerNotify();
}

function onCanvasPan() {
  lastCursor = null;
  schedulePointerNotify();
}

function schedulePointerNotify() {
  if (!pointerListeners.size || pointerNotifyQueued) return;
  pointerNotifyQueued = true;
  const schedule = globalThis.requestAnimationFrame ?? (callback => setTimeout(callback, 0));
  pointerNotifyId = schedule(() => {
    pointerNotifyQueued = false;
    pointerNotifyId = 0;
    const cursor = getDestructionMarkerCursor();
    for (const listener of pointerListeners) listener(cursor);
  });
}

function cancelPointerNotify() {
  if (!pointerNotifyQueued) return;
  const cancel = globalThis.cancelAnimationFrame ?? clearTimeout;
  cancel(pointerNotifyId);
  pointerNotifyQueued = false;
  pointerNotifyId = 0;
}

function pointerCanvasPoint(event) {
  const local = event?.getLocalPosition?.(canvas?.stage);
  if (Number.isFinite(local?.x) && Number.isFinite(local?.y)) return {x: local.x, y: local.y};

  const clientX = event?.clientX ?? event?.nativeEvent?.clientX;
  const clientY = event?.clientY ?? event?.nativeEvent?.clientY;
  if (Number.isFinite(clientX) && Number.isFinite(clientY)
    && typeof canvas?.canvasCoordinatesFromClient === "function") {
    return canvas.canvasCoordinatesFromClient({x: clientX, y: clientY});
  }

  if (Number.isFinite(canvas?.mousePosition?.x) && Number.isFinite(canvas?.mousePosition?.y)) {
    return {x: canvas.mousePosition.x, y: canvas.mousePosition.y};
  }
  return null;
}

function normalizeLevelIds(levels) {
  if (levels == null) return [];
  try {
    return Array.from(typeof levels === "string" ? [levels] : levels)
      .map(level => typeof level === "string" ? level : level?.id ?? level?._id)
      .filter(level => level != null && level !== "")
      .map(String);
  } catch (_error) {
    return [];
  }
}
