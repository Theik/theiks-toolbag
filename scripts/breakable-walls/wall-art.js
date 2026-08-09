import {MODULE_ID, getBreakableWallData} from "./wall-config.js";
import {calculateRubbleGeometry} from "./wall-destruction.js";

const artwork = new Map();
let refreshId = 0;
let refreshQueued = false;

/** Register the destroyed-wall artwork and native Wall visibility lifecycle hooks. */
export function registerDestroyedWallArt() {
  Hooks.on("canvasReady", handleCanvasReady);
  Hooks.on("canvasTearDown", clearArtwork);
  Hooks.on("createWall", refreshForWallChange);
  Hooks.on("updateWall", refreshForWallChange);
  Hooks.on("deleteWall", refreshForWallChange);
  Hooks.on("updateScene", refreshForSceneChange);
  Hooks.on("refreshWall", refreshWallArtwork);
  Hooks.on("drawWall", reapplyVisibilityAfterDraw);
}

/** Coalesce bulk Wall changes into one artwork redraw. */
export function queueDestroyedWallArtRefresh() {
  if (refreshQueued) return;
  refreshQueued = true;
  queueMicrotask(() => {
    refreshQueued = false;
    void refreshArtwork();
  });
}

function handleCanvasReady() {
  synchronizeAllNativeWalls();
  queueDestroyedWallArtRefresh();
}

/** @param {WallDocument} wall */
function refreshForWallChange(wall) {
  if (wall?.parent !== canvas.scene && !artwork.has(wall?.id)) return;

  const placeable = wall?.object ?? findWallPlaceable(wall?.id);
  if (placeable) synchronizeNativeWall(placeable, {restore: true});
  queueDestroyedWallArtRefresh();
}

/** @param {Scene} scene */
function refreshForSceneChange(scene) {
  if (scene === canvas.scene) queueDestroyedWallArtRefresh();
}

/** Draw destroyed-state artwork for every eligible Wall in the viewed Scene and level. */
async function refreshArtwork() {
  const currentRefresh = ++refreshId;
  if (!canvas.ready || !canvas.primary || !canvas.walls) {
    clearArtwork();
    return;
  }

  const walls = Array.from(canvas.walls.placeables ?? []);
  for (const wall of walls) synchronizeNativeWall(wall);

  const meshes = await Promise.all(walls.map(async wall => {
    const selection = getArtworkSelection(wall.document);
    if (!selection) return null;

    try {
      const texture = await foundry.canvas.loadTexture(selection.src);
      if (!texture) throw new Error(`The image could not be loaded: ${selection.src}`);
      return createArtworkMesh(wall, texture, selection);
    } catch (error) {
      console.error(`${MODULE_ID} | Failed to draw destroyed-wall artwork for ${wall.id}`, error);
      return null;
    }
  }));

  if (currentRefresh !== refreshId || !canvas.ready || !canvas.primary) {
    for (const entry of meshes) destroyMesh(entry?.mesh);
    return;
  }

  destroyAllMeshes();
  for (const entry of meshes) {
    if (!entry) continue;
    canvas.primary.addChild(entry.mesh);
    artwork.set(entry.wallId, entry.mesh);
  }
  canvas.primary.sortChildren?.();
  canvas.primary.update?.();
  canvas.primary.renderDirty = true;
}

/**
 * Resolve the configured image and directional flip for a destroyed Wall.
 *
 * @param {WallDocument} wall
 * @returns {{src: string, scaleY: 1|-1}|null}
 */
function getArtworkSelection(wall) {
  const data = getBreakableWallData(wall);
  if (!data.destroyed || !isWallOnViewedLevel(wall)) return null;

  const destruction = data.destruction;
  let src = "";
  let scaleY = 1;
  if (destruction?.kind === "both") src = data.images.both;
  else if (destruction?.kind === "single" && ["positive", "negative"].includes(destruction.side)) {
    src = data.images.single;
    scaleY = destruction.side === "negative" ? -1 : 1;
  } else {
    console.warn(`${MODULE_ID} | Destroyed Wall ${wall.id} has an invalid artwork selection`);
    return null;
  }

  if (!src) {
    console.warn(`${MODULE_ID} | Destroyed Wall ${wall.id} has no configured ${destruction.kind} artwork`);
    return null;
  }
  return {src, scaleY};
}

/**
 * Whether a Wall belongs to the level currently viewed on the Canvas.
 * Walls without explicit level assignments are visible on every level.
 *
 * @param {WallDocument} wall
 * @returns {boolean}
 */
function isWallOnViewedLevel(wall) {
  const levels = normalizeLevelIds(wall?.levels);
  if (!levels.length) return true;

  const currentLevelId = canvas.level?.id ?? canvas.level?._id;
  return currentLevelId != null && levels.includes(String(currentLevelId));
}

/** @param {unknown} levels */
function normalizeLevelIds(levels) {
  if (levels == null) return [];

  let values;
  if (typeof levels === "string") values = [levels];
  else {
    try {
      values = Array.from(levels);
    } catch (_error) {
      return [];
    }
  }

  return values
    .map(level => typeof level === "string" ? level : level?.id ?? level?._id)
    .filter(level => level != null && level !== "")
    .map(String);
}

/**
 * @param {foundry.canvas.placeables.Wall} wall
 * @param {PIXI.Texture} texture
 * @param {{scaleY: 1|-1}} selection
 */
function createArtworkMesh(wall, texture, selection) {
  const geometry = calculateRubbleGeometry(wall.document.c);
  const mesh = new foundry.canvas.primary.PrimarySpriteMesh({
    name: `${MODULE_ID}.destroyedWall.${wall.id}`,
    object: wall,
    texture
  });

  const elevation = Number(canvas.level?.elevation?.base ?? 0);
  mesh.elevation = Number.isFinite(elevation) ? elevation : 0;
  mesh.sortLayer = canvas.primary.constructor.SORT_LAYERS.DRAWINGS;
  mesh.sort = Number.MAX_SAFE_INTEGER;
  mesh.zIndex = 0;
  mesh.anchor.set(0.5);
  applyMeshGeometry(mesh, geometry, selection.scaleY);
  mesh.eventMode = "none";
  mesh.name = `${MODULE_ID}.destroyedWall.${wall.id}`;
  return {wallId: wall.id, mesh};
}

/**
 * Keep destroyed artwork attached to a Wall drag preview, including its size and angle.
 *
 * @param {foundry.canvas.placeables.Wall} wall
 */
function refreshWallArtwork(wall) {
  const source = wall?._original ?? wall;
  if (!source) return;

  synchronizeNativeWall(source);
  if (wall !== source) synchronizeNativeWall(wall, {document: source.document});

  const mesh = artwork.get(source.id);
  if (!mesh) return;

  const data = getBreakableWallData(source.document);
  if (!data.destroyed) return;

  try {
    const geometry = calculateRubbleGeometry(wall.document?.c ?? source.document?.c);
    const scaleY = data.destruction?.kind === "single" && data.destruction.side === "negative" ? -1 : 1;
    applyMeshGeometry(mesh, geometry, scaleY);
    if (canvas.primary) canvas.primary.renderDirty = true;
  } catch (error) {
    console.error(`${MODULE_ID} | Failed to update destroyed-wall artwork for ${source.id}`, error);
  }
}

/**
 * @param {foundry.canvas.primary.PrimarySpriteMesh} mesh
 * @param {ReturnType<calculateRubbleGeometry>} geometry
 * @param {1|-1} scaleY
 */
function applyMeshGeometry(mesh, geometry, scaleY) {
  mesh.position.set(geometry.x, geometry.y);
  mesh.angle = geometry.rotation;
  mesh.resize(geometry.width, geometry.height, {fit: "fill", scaleY});
}

/** Re-hide a destroyed Wall after its asynchronous draw has completed. */
function reapplyVisibilityAfterDraw(wall) {
  queueMicrotask(() => {
    if (wall?.destroyed || wall?.document?.parent !== canvas.scene) return;
    synchronizeNativeWall(wall);
  });
}

function synchronizeAllNativeWalls() {
  for (const wall of canvas.walls?.placeables ?? []) synchronizeNativeWall(wall);
}

/**
 * Suppress core Wall rendering while destroyed, or ask Foundry to restore its own
 * layer-aware visibility after a repair.
 *
 * @param {foundry.canvas.placeables.Wall} wall
 * @param {{document?: WallDocument, restore?: boolean}} [options]
 */
function synchronizeNativeWall(wall, {document = wall?.document, restore = false} = {}) {
  if (!wall || wall.destroyed || !document) return;
  const destroyed = getBreakableWallData(document).destroyed;

  if (destroyed) {
    if (wall.controlled && typeof wall.release === "function") {
      try {
        wall.release();
      } catch (error) {
        console.error(`${MODULE_ID} | Failed to release destroyed Wall ${wall.id}`, error);
      }
    }
    wall.visible = false;
    return;
  }

  if (!restore) return;
  queueMicrotask(() => {
    if (wall.destroyed || getBreakableWallData(wall.document).destroyed) return;
    if (typeof wall.refreshVisibility === "function") wall.refreshVisibility();
    else if (typeof wall.refresh === "function") wall.refresh();
  });
}

/** @param {string|undefined} wallId */
function findWallPlaceable(wallId) {
  if (!wallId) return null;
  return canvas.walls?.get?.(wallId)
    ?? canvas.walls?.placeables?.find?.(wall => wall.id === wallId)
    ?? null;
}

function clearArtwork() {
  ++refreshId;
  refreshQueued = false;
  destroyAllMeshes();
  if (canvas.primary && canvas.ready) canvas.primary.update?.();
}

function destroyAllMeshes() {
  for (const mesh of artwork.values()) destroyMesh(mesh);
  artwork.clear();
  if (canvas.primary) canvas.primary.renderDirty = true;
}

/** @param {PIXI.DisplayObject|null|undefined} mesh */
function destroyMesh(mesh) {
  if (!mesh || mesh.destroyed) return;
  mesh.removeFromParent();
  mesh.destroy({children: true, texture: false, baseTexture: false});
}
