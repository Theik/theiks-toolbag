import {
  MODULE_ID,
  UNDERGROUND_FLAG_PATH,
  changedLogicalCellIndexes,
  getUndergroundData,
  getViewedLevelId,
  isDugSubcell,
  isUndergroundAvailable,
  isUndergroundCell,
  isUndergroundSubcell,
  isViewedUndergroundLevel
} from "./underground-data.js";
import {buildUndergroundBoundarySegments} from "./underground-geometry.js";
import {queueSupportMaskRefresh} from "../breakable-walls/wall-art.js";
import {FEATURES, FEATURE_SETTING_CHANGED_HOOK} from "../settings.js";

const artwork = new Map();
let artworkRefresh = 0;
let installedEdges = null;
let viewedLevelId = null;
let previousDugBytes = null;
let previousSourceMask = null;
let previousIntactSrc = null;
let previousDugSrc = null;
let previousIntactGrid = null;
let previousDugGrid = null;
const reportedErrors = new Set();
const MASK_RESOLUTION = 32;
const FADE_RADIUS_SUBCELLS = 0.75;

export function registerUndergroundRuntime() {
  Hooks.on("initializeEdges", initializeEdges);
  Hooks.on("canvasReady", refreshRuntime);
  Hooks.on("canvasPan", refreshForCanvasPan);
  Hooks.on("canvasTearDown", clearRuntime);
  Hooks.on("updateScene", refreshForSceneUpdate);
  Hooks.on(FEATURE_SETTING_CHANGED_HOOK, handleFeatureChange);
}

function initializeEdges(scene) {
  if (scene === canvas.scene) synchronizeEdges(scene);
}

function refreshRuntime() {
  if (!canvas.scene) return;
  viewedLevelId = getViewedLevelId();
  synchronizeEdges(canvas.scene);
  void refreshArtwork(canvas.scene, {rebuildAll: true});
}

function refreshForCanvasPan() {
  const levelId = getViewedLevelId();
  if (levelId === viewedLevelId) return;
  viewedLevelId = levelId;
  if (canvas.scene) void refreshArtwork(canvas.scene, {rebuildAll: true});
}

function refreshForSceneUpdate(scene, changes) {
  if (scene !== canvas.scene || !hasUndergroundChange(changes)) return;
  synchronizeEdges(scene);
  void refreshArtwork(scene, {rebuildAll: !isDugMaskOnlyChange(changes)});
}

function handleFeatureChange(feature, enabled) {
  if (feature !== FEATURES.breakableTerrain) return;
  if (enabled) refreshRuntime();
  else clearRuntime();
}

function synchronizeEdges(scene) {
  const removed = removeEdges(false);
  if (!isUndergroundAvailable()) {
    if (removed) refreshRestrictions();
    return;
  }
  const data = safelyRead(scene);
  if (!data || !data.enabled || !isViewedUndergroundLevel(data, {scene, level: canvas.level})) {
    if (removed) refreshRestrictions();
    return;
  }
  const level = findSceneLevel(scene, data.levelId);
  if (!level) {
    if (removed) refreshRestrictions();
    return reportInvalid(scene, new Error(`Underground Level ${data.levelId} does not exist.`));
  }
  const Edge = foundry.canvas.geometry.edges.Edge;
  const NONE = CONST.EDGE_SENSE_TYPES.NONE;
  const NORMAL = CONST.EDGE_SENSE_TYPES.NORMAL;
  const LIMITED = CONST.EDGE_SENSE_TYPES.LIMITED;
  const direction = CONST.EDGE_DIRECTIONS.BOTH;
  const edges = [];
  buildUndergroundBoundarySegments(data).forEach((coordinates, index) => {
    const [x1, y1, x2, y2] = coordinates;
    const a = {x: x1, y: y1};
    const b = {x: x2, y: y2};
    if (data.blocksMovement) edges.push(new Edge(a, b, {
      id: `${MODULE_ID}.underground.move.${index}`,
      object: scene,
      type: "wall",
      direction,
      move: NORMAL,
      light: NONE,
      darkness: NONE,
      sight: NONE,
      sound: NONE
    }));
    if (data.blocksVision) edges.push(new Edge(a, b, {
      id: `${MODULE_ID}.underground.vision.${index}`,
      object: scene,
      type: "wall",
      direction,
      move: NONE,
      light: LIMITED,
      darkness: LIMITED,
      sight: LIMITED,
      sound: NONE
    }));
  });
  for (const edge of edges) level.edges.set(edge.id, edge);
  installedEdges = {level, edges};
  refreshRestrictions();
}

async function refreshArtwork(scene, {rebuildAll = false} = {}) {
  const refreshId = ++artworkRefresh;
  if (!isUndergroundAvailable() || !canvas.ready || scene !== canvas.scene || !canvas.primary) {
    destroyArtwork();
    resetArtworkCache();
    return;
  }
  const data = safelyRead(scene);
  if (!data?.enabled || !isViewedUndergroundLevel(data, {scene, level: canvas.level})) {
    destroyArtwork();
    resetArtworkCache();
    return;
  }
  try {
    const intactTexture = await foundry.canvas.loadTexture(data.intactSrc);
    const dugTexture = await foundry.canvas.loadTexture(data.dugSrc);
    if (refreshId !== artworkRefresh || scene !== canvas.scene) return;
    const sourceChanged = rebuildAll
      || previousSourceMask !== data.sourceMask
      || previousIntactSrc !== data.intactSrc
      || previousDugSrc !== data.dugSrc
      || previousIntactGrid !== data.intactGrid
      || previousDugGrid !== data.dugGrid
      || artwork.size === 0;
    const dirty = sourceChanged
      ? allUndergroundLogicalIndexes(data)
      : expandDirtyWithNeighbors(data, changedLogicalCellIndexes(data, previousDugBytes));
    if (sourceChanged) {
      for (const key of [...artwork.keys()]) {
        const logical = Number(key.split(":")[0]);
        if (!dirty.has(logical)) removeCellArtwork(logical);
      }
    }
    for (const logical of dirty) {
      removeCellArtwork(logical);
      addCellArtwork(data, logical, intactTexture, dugTexture);
    }
    previousDugBytes = Uint8Array.from(data.dugBytes);
    previousSourceMask = data.sourceMask;
    previousIntactSrc = data.intactSrc;
    previousDugSrc = data.dugSrc;
    previousIntactGrid = data.intactGrid;
    previousDugGrid = data.dugGrid;
    refreshPrimaryCanvas();
    queueSupportMaskRefresh();
  } catch (error) {
    reportInvalid(scene, error);
  }
}

function addCellArtwork(data, logicalIndex, intactTexture, dugTexture) {
  const intactAlphas = buildFadeAlphas(data, logicalIndex, "intact");
  const dugAlphas = buildFadeAlphas(data, logicalIndex, "dug");
  if (hasFadeCoverage(intactAlphas)) {
    artwork.set(
      artworkKey(logicalIndex, "intact"),
      createCellMesh(data, intactTexture, logicalIndex, "intact", intactAlphas)
    );
  }
  if (hasFadeCoverage(dugAlphas)) {
    artwork.set(artworkKey(logicalIndex, "dug"), createCellMesh(data, dugTexture, logicalIndex, "dug", dugAlphas));
  }
}

function createCellMesh(data, texture, logicalIndex, kind, alphas) {
  const lx = logicalIndex % data.width;
  const ly = Math.floor(logicalIndex / data.width);
  const x = data.origin.x + lx * data.gridSize;
  const y = data.origin.y + ly * data.gridSize;
  const seam = kind === "intact" ? 1 : 0;
  const period = kind === "intact" ? data.intactGrid : data.dugGrid;
  const sliced = sliceCellTexture(texture, lx, ly, period);
  const mesh = new foundry.canvas.primary.PrimarySpriteMesh({
    name: `${MODULE_ID}.undergroundTerrain.${kind}.${logicalIndex}`,
    object: canvas.scene,
    texture: sliced.texture
  });
  mesh.elevation = data.elevation;
  applyEarthSort(mesh, data, kind);
  mesh.zIndex = 0;
  mesh.anchor.set(0, 0);
  mesh.position.set(x - seam / 2, y - seam / 2);
  mesh.alpha = 1;
  mesh.tint = 0xFFFFFF;
  const size = data.gridSize + seam;
  if (typeof mesh.resize === "function") mesh.resize(size, size, {fit: "fill", scaleX: 1, scaleY: 1});
  else {
    mesh.width = size;
    mesh.height = size;
  }
  mesh.eventMode = "none";
  mesh.name = `${MODULE_ID}.undergroundTerrain.${kind}.${logicalIndex}`;
  const mask = isFullyOpaqueAlphas(alphas) ? null : createFadeMask(logicalIndex, kind, alphas, size);
  if (mask) {
    mesh.addChild?.(mask);
    mesh.mask = mask;
  }
  canvas.primary.addChild(mesh);
  mesh.updateCanvasTransform?.();
  return {mesh, mask, clonedTexture: sliced.cloned};
}

/** Slice one cell of an n-by-n repeating texture without mutating the shared loadTexture result. */
function sliceCellTexture(texture, lx, ly, period) {
  const n = Number(period);
  if (!Number.isSafeInteger(n) || n <= 1 || !texture) return {texture, cloned: false};
  const width = Number(texture.width ?? texture.orig?.width ?? 0);
  const height = Number(texture.height ?? texture.orig?.height ?? 0);
  if (!(width > 0 && height > 0)) return {texture, cloned: false};
  const sliceWidth = width / n;
  const sliceHeight = height / n;
  const column = ((lx % n) + n) % n;
  const row = ((ly % n) + n) % n;
  const Texture = globalThis.PIXI?.Texture;
  const Rectangle = globalThis.PIXI?.Rectangle;
  if (typeof Texture !== "function") return {texture, cloned: false};
  const frame = typeof Rectangle === "function"
    ? new Rectangle(column * sliceWidth, row * sliceHeight, sliceWidth, sliceHeight)
    : {x: column * sliceWidth, y: row * sliceHeight, width: sliceWidth, height: sliceHeight};
  const source = texture.source ?? texture.baseTexture ?? texture;
  try {
    return {texture: new Texture({source, frame}), cloned: true};
  } catch (_error) {
    try {
      return {texture: new Texture(source, frame), cloned: true};
    } catch (_fallback) {
      return {texture, cloned: false};
    }
  }
}

function applyEarthSort(mesh, data, kind) {
  const layers = canvas.primary.constructor.SORT_LAYERS ?? {};
  if (kind === "intact") {
    mesh.sortLayer = (Number(layers.DRAWINGS) || Number(layers.TILES) || 0) + 1;
    mesh.sort = Number.MAX_SAFE_INTEGER;
    return;
  }
  mesh.sortLayer = layers.TILES ?? layers.SCENE ?? 0;
  mesh.sort = data.sort;
}

function createFadeMask(logicalIndex, kind, alphas, size) {
  const Sprite = globalThis.PIXI?.Sprite;
  const Texture = globalThis.PIXI?.Texture;
  if (typeof Sprite !== "function" || typeof Texture?.from !== "function") return null;
  const texture = Texture.from(createMaskSource(alphas));
  const source = texture.source ?? texture.baseTexture;
  const linear = globalThis.PIXI?.SCALE_MODES?.LINEAR;
  if (source && linear != null) source.scaleMode = linear;
  const mask = new Sprite(texture);
  mask.eventMode = "none";
  mask.position?.set?.(0, 0);
  mask.width = size;
  mask.height = size;
  mask.name = `${MODULE_ID}.undergroundTerrain.mask.${kind}.${logicalIndex}`;
  return mask;
}

function createMaskSource(alphas) {
  const canvas = createMaskCanvas();
  if (canvas) {
    canvas.width = MASK_RESOLUTION;
    canvas.height = MASK_RESOLUTION;
    const context = canvas.getContext?.("2d");
    if (context?.createImageData && context.putImageData) {
      const image = context.createImageData(MASK_RESOLUTION, MASK_RESOLUTION);
      for (let i = 0; i < alphas.length; i += 1) {
        const offset = i * 4;
        image.data[offset] = 255;
        image.data[offset + 1] = 255;
        image.data[offset + 2] = 255;
        image.data[offset + 3] = alphas[i];
      }
      context.putImageData(image, 0, 0);
      return canvas;
    }
  }
  return {width: MASK_RESOLUTION, height: MASK_RESOLUTION, alphas};
}

function createMaskCanvas() {
  const adapter = globalThis.PIXI?.DOMAdapter?.get?.();
  return adapter?.createCanvas?.(MASK_RESOLUTION, MASK_RESOLUTION)
    ?? globalThis.document?.createElement?.("canvas")
    ?? (typeof globalThis.OffscreenCanvas === "function"
      ? new globalThis.OffscreenCanvas(MASK_RESOLUTION, MASK_RESOLUTION)
      : null);
}

/** Soft alpha for one cell: fade only where intact meets dug, including a 1-subcell neighbor halo. */
function buildFadeAlphas(data, logicalIndex, kind) {
  const sub = data.subdivision;
  const pixelsPerSub = MASK_RESOLUTION / sub;
  const pad = pixelsPerSub;
  const workSize = MASK_RESOLUTION + (pad * 2);
  const startX = (logicalIndex % data.width) * sub;
  const startY = Math.floor(logicalIndex / data.width) * sub;
  const source = new Uint8Array(workSize * workSize);
  const underground = new Uint8Array(workSize * workSize);
  for (let py = 0; py < workSize; py += 1) {
    for (let px = 0; px < workSize; px += 1) {
      const occupancy = classifySubcell(
        data,
        startX + Math.floor(px / pixelsPerSub) - 1,
        startY + Math.floor(py / pixelsPerSub) - 1
      );
      if (!occupancy) continue;
      const index = (py * workSize) + px;
      underground[index] = 1;
      const isDug = occupancy === 2;
      source[index] = kind === "dug" ? (isDug ? 255 : 0) : (isDug ? 0 : 255);
    }
  }
  const radius = Math.max(1, Math.round(FADE_RADIUS_SUBCELLS * pixelsPerSub));
  const blurred = boxBlurMasked(source, underground, workSize, radius);
  const alphas = new Uint8Array(MASK_RESOLUTION * MASK_RESOLUTION);
  for (let y = 0; y < MASK_RESOLUTION; y += 1) {
    for (let x = 0; x < MASK_RESOLUTION; x += 1) {
      alphas[(y * MASK_RESOLUTION) + x] = blurred[((y + pad) * workSize) + (x + pad)];
    }
  }
  return alphas;
}

function classifySubcell(data, sx, sy) {
  if (sx < 0 || sy < 0 || sx >= data.subWidth || sy >= data.subHeight) return 0;
  const index = (sy * data.subWidth) + sx;
  if (!isUndergroundSubcell(data, index)) return 0;
  return isDugSubcell(data, index) ? 2 : 1;
}

function boxBlurMasked(source, underground, size, radius) {
  const out = new Uint8Array(size * size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const index = (y * size) + x;
      if (!underground[index]) continue;
      let sum = 0;
      let count = 0;
      for (let dy = -radius; dy <= radius; dy += 1) {
        const ny = y + dy;
        if (ny < 0 || ny >= size) continue;
        for (let dx = -radius; dx <= radius; dx += 1) {
          const nx = x + dx;
          if (nx < 0 || nx >= size) continue;
          const sample = (ny * size) + nx;
          if (!underground[sample]) continue;
          sum += source[sample];
          count += 1;
        }
      }
      out[index] = count ? Math.round(sum / count) : 0;
    }
  }
  return out;
}

function hasFadeCoverage(alphas) {
  for (const alpha of alphas) {
    if (alpha > 0) return true;
  }
  return false;
}

function isFullyOpaqueAlphas(alphas) {
  if (!alphas.length) return false;
  for (const alpha of alphas) {
    if (alpha < 255) return false;
  }
  return true;
}

function expandDirtyWithNeighbors(data, dirty) {
  const expanded = new Set(dirty);
  for (const index of dirty) {
    const x = index % data.width;
    const y = Math.floor(index / data.width);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= data.width || ny >= data.height) continue;
      const neighbor = (ny * data.width) + nx;
      if (isUndergroundCell(data, neighbor)) expanded.add(neighbor);
    }
  }
  return expanded;
}

function allUndergroundLogicalIndexes(data) {
  const dirty = new Set();
  for (let index = 0; index < data.width * data.height; index += 1) {
    if (isUndergroundCell(data, index)) dirty.add(index);
  }
  return dirty;
}

function artworkKey(logicalIndex, kind) {
  return `${logicalIndex}:${kind}`;
}

function findSceneLevel(scene, levelId) {
  const levels = scene?.levels;
  if (!levels) return null;
  const direct = levels.get?.(levelId);
  if (direct) return direct;
  const iterable = typeof levels.values === "function" ? levels.values() : levels;
  for (const level of iterable) {
    if ((level?.id ?? level?._id) === levelId) return level;
  }
  return null;
}

function safelyRead(scene) {
  try {
    return getUndergroundData(scene);
  } catch (error) {
    reportInvalid(scene, error);
    return null;
  }
}

function reportInvalid(scene, error) {
  const key = `${scene?.id ?? "unknown"}:${error.message}`;
  if (reportedErrors.has(key)) return null;
  reportedErrors.add(key);
  console.error(`${MODULE_ID} | Invalid underground terrain on Scene ${scene?.id ?? "unknown"}`, error);
  if (game.user?.isGM) ui.notifications?.error?.(localize("Errors.Invalid"));
  return null;
}

function hasUndergroundChange(changes) {
  if (globalThis.foundry?.utils?.hasProperty?.(changes, UNDERGROUND_FLAG_PATH)) return true;
  if (Object.hasOwn(changes?.flags?.[MODULE_ID] ?? {}, "undergroundTerrain")) return true;
  const prefix = `${UNDERGROUND_FLAG_PATH}.`;
  return Object.keys(changes ?? {}).some(key => key === UNDERGROUND_FLAG_PATH || key.startsWith(prefix));
}

function isDugMaskOnlyChange(changes) {
  const dotted = `${UNDERGROUND_FLAG_PATH}.dugMask`;
  if (Object.hasOwn(changes ?? {}, dotted)) {
    const undergroundKeys = Object.keys(changes).filter(key => {
      return key === UNDERGROUND_FLAG_PATH || key.startsWith(`${UNDERGROUND_FLAG_PATH}.`);
    });
    return undergroundKeys.length === 1 && undergroundKeys[0] === dotted;
  }
  const flag = changes?.flags?.[MODULE_ID]?.undergroundTerrain;
  return Boolean(flag && typeof flag === "object" && Object.keys(flag).length === 1 && Object.hasOwn(flag, "dugMask"));
}

function clearRuntime() {
  viewedLevelId = null;
  ++artworkRefresh;
  destroyArtwork();
  resetArtworkCache();
  removeEdges(true);
}

function destroyArtwork() {
  if (!artwork.size) return;
  for (const logical of new Set([...artwork.keys()].map(key => Number(key.split(":")[0])))) {
    removeCellArtwork(logical);
  }
  refreshPrimaryCanvas();
}

function removeCellArtwork(logicalIndex) {
  for (const kind of ["intact", "dug"]) {
    const entry = artwork.get(artworkKey(logicalIndex, kind));
    if (!entry) continue;
    artwork.delete(artworkKey(logicalIndex, kind));
    destroyDisplayObject(entry.mask, {destroyTexture: true, destroyBaseTexture: true});
    destroyDisplayObject(entry.mesh, {destroyTexture: entry.clonedTexture === true});
  }
}

function destroyDisplayObject(object, {destroyTexture = false, destroyBaseTexture = false} = {}) {
  if (!object || object.destroyed) return;
  object.removeFromParent?.();
  object.destroy?.({children: true, texture: destroyTexture, baseTexture: destroyBaseTexture});
}

function resetArtworkCache() {
  previousDugBytes = null;
  previousSourceMask = null;
  previousIntactSrc = null;
  previousDugSrc = null;
  previousIntactGrid = null;
  previousDugGrid = null;
}

function refreshPrimaryCanvas() {
  if (!globalThis.canvas?.primary) return;
  canvas.primary.sortChildren?.();
  canvas.primary.update?.();
  canvas.primary.renderDirty = true;
}

function removeEdges(notify) {
  if (!installedEdges) return false;
  for (const edge of installedEdges.edges) installedEdges.level.edges.delete(edge.id);
  installedEdges = null;
  if (notify) refreshRestrictions();
  return true;
}

function refreshRestrictions() {
  if (!canvas.ready) return;
  canvas.perception?.update?.({initializeLighting: true, initializeVision: true});
  canvas.tokens?.recalculatePlannedMovementPaths?.();
  canvas.scene?.updateRegionShapeConstraints?.(new Set(["light", "darkness", "sight", "move"]));
}

function localize(key) {
  return game.i18n.localize(`THEIKS_TOOLBAG.Underground.${key}`);
}
