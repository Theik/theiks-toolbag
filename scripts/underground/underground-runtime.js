import {
  MODULE_ID,
  UNDERGROUND_FLAG_PATH,
  changedLogicalCellIndexes,
  getUndergroundData,
  getViewedLevelId,
  isDugSubcell,
  isUndergroundAvailable,
  isViewedUndergroundLevel
} from "./underground-data.js";
import {
  visionOverlapSubcells,
  buildUndergroundBoundarySegments,
  buildUndergroundVisionBoundarySegments
} from "./underground-geometry.js";
import {queueSupportMaskRefresh} from "../breakable-walls/wall-art.js";
import {FEATURES, FEATURE_SETTING_CHANGED_HOOK} from "../settings.js";
import {refreshUndergroundOverlay} from "./underground-debug.js";
import {cellAppearance, isForcedCell, isSuppressedCell, isSuppressedSubcell} from "./underground-regions.js";

const artwork = new Map();
const sliceCache = new Map();
let artworkRefresh = 0;
let installedEdges = null;
let viewedLevelId = null;
let intactSheet = null;
let previousDugBytes = null;
let previousSourceMask = null;
let previousIntactSrc = null;
let previousDugSrc = null;
let previousIntactGrid = null;
let previousDugGrid = null;
let previousAppearance = null;
let previousViewport = null;
let cachedIntactTexture = null;
let cachedDugTexture = null;
const reportedErrors = new Set();
const MASK_RESOLUTION = 32;
const FADE_RADIUS_SUBCELLS = 2;
const BEVEL_ROUND_RADIUS = 8;
const BEVEL_WIDTH = 14;
const BEVEL_FLOOR = 0.55;
const VIEWPORT_PAD_CELLS = 2;
const REBUILD_YIELD_EVERY = 50;
const OPAQUE_ALPHAS = new Uint8Array(MASK_RESOLUTION * MASK_RESOLUTION).fill(255);
const OPAQUE_FADE = {alphas: OPAQUE_ALPHAS};
const EMPTY_FADE = {alphas: new Uint8Array(MASK_RESOLUTION * MASK_RESOLUTION)};

export function registerUndergroundRuntime() {
  Hooks.on("initializeEdges", initializeEdges);
  Hooks.on("canvasReady", refreshRuntime);
  Hooks.on("canvasPan", refreshForCanvasPan);
  Hooks.on("canvasTearDown", clearRuntime);
  Hooks.on("updateScene", refreshForSceneUpdate);
  Hooks.on("updateLevel", refreshForLevelUpdate);
  Hooks.on("createRegion", refreshForRegionDocument);
  Hooks.on("updateRegion", refreshForRegionDocument);
  Hooks.on("deleteRegion", refreshForRegionDocument);
  Hooks.on("createRegionBehavior", refreshForRegionDocument);
  Hooks.on("updateRegionBehavior", refreshForRegionDocument);
  Hooks.on("deleteRegionBehavior", refreshForRegionDocument);
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
  if (levelId !== viewedLevelId) {
    viewedLevelId = levelId;
    previousViewport = null;
    if (canvas.scene) void refreshArtwork(canvas.scene, {rebuildAll: true});
    return;
  }
}

function refreshForSceneUpdate(scene, changes) {
  if (scene !== canvas.scene || !hasUndergroundChange(changes)) return;
  synchronizeEdges(scene);
  void refreshArtwork(scene, {rebuildAll: !isDugMaskOnlyChange(changes)});
}

function refreshForLevelUpdate(level, changes) {
  const scene = level?.parent ?? canvas.scene;
  if (!scene || scene !== canvas.scene || !hasUndergroundChange(changes)) return;
  synchronizeEdges(scene);
  void refreshArtwork(scene, {rebuildAll: !isDugMaskOnlyChange(changes)});
}

function handleFeatureChange(feature, enabled) {
  if (feature !== FEATURES.diggableTerrain) return;
  if (enabled) refreshRuntime();
  else clearRuntime();
}

function refreshForRegionDocument(document) {
  const scene = sceneFromEmbedded(document);
  if (!scene || scene !== globalThis.canvas?.scene || !isUndergroundAvailable()) return;
  refreshRuntime();
}

function sceneFromEmbedded(document) {
  if (!document) return null;
  if (document.documentName === "Scene") return document;
  if (document.documentName === "Region") return document.parent;
  if (document.documentName === "RegionBehavior") return document.parent?.parent;
  return document.parent?.parent ?? document.parent ?? null;
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
  const direction = CONST.EDGE_DIRECTIONS.BOTH;
  const edges = [];
  const pushEdges = (segments, kind, restrictions) => {
    segments.forEach((coordinates, index) => {
      const [x1, y1, x2, y2] = coordinates;
      edges.push(new Edge({x: x1, y: y1}, {x: x2, y: y2}, {
        id: `${MODULE_ID}.underground.${kind}.${index}`,
        object: scene,
        type: "wall",
        direction,
        sound: NONE,
        ...restrictions
      }));
    });
  };
  pushEdges(buildUndergroundBoundarySegments(data), "move", {
    move: NORMAL, light: NONE, darkness: NONE, sight: NONE
  });
  pushEdges(buildUndergroundVisionBoundarySegments(data), "vision", {
    move: NONE, light: NORMAL, darkness: NORMAL, sight: NORMAL
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
    refreshUndergroundOverlay();
    return;
  }
  const data = safelyRead(scene);
  if (!data?.enabled || !isViewedUndergroundLevel(data, {scene, level: canvas.level})) {
    destroyArtwork();
    resetArtworkCache();
    refreshUndergroundOverlay();
    return;
  }
  try {
    if (!data.intactSrc || !data.dugSrc) {
      throw new Error("Underground texture path is empty.");
    }
    const textureCache = new Map();
    const intactTexture = await loadCachedTexture(textureCache, data.intactSrc);
    const dugTexture = await loadCachedTexture(textureCache, data.dugSrc);
    if (refreshId !== artworkRefresh || scene !== canvas.scene) return;
    const appearanceKey = appearanceSignature(data);
    if (previousIntactSrc !== data.intactSrc || previousDugSrc !== data.dugSrc
      || previousIntactGrid !== data.intactGrid || previousDugGrid !== data.dugGrid
      || previousAppearance !== appearanceKey) {
      clearSliceCache();
    }
    cachedIntactTexture = intactTexture;
    cachedDugTexture = dugTexture;
    const sourceChanged = rebuildAll
      || previousSourceMask !== data.sourceMask
      || previousIntactSrc !== data.intactSrc
      || previousDugSrc !== data.dugSrc
      || previousIntactGrid !== data.intactGrid
      || previousDugGrid !== data.dugGrid
      || previousAppearance !== appearanceKey;
    if (sourceChanged || !intactSheet) {
      destroyIntactSheet();
      intactSheet = createIntactSheet(data, intactTexture);
    }
    const special = specialLogicalIndexes(data);
    const dirty = sourceChanged
      ? new Set(special)
      : expandDirtyWithNeighbors(data, changedLogicalCellIndexes(data, previousDugBytes));
    for (const logical of special) {
      if (!hasCellArtwork(logical)) dirty.add(logical);
    }
    for (const key of [...artwork.keys()]) {
      const logical = Number(key.split(":")[0]);
      if (special.has(logical) && !dirty.has(logical)) continue;
      removeCellArtwork(logical);
    }
    let built = 0;
    for (const logical of dirty) {
      if (refreshId !== artworkRefresh || scene !== canvas.scene) return;
      if (!special.has(logical)) continue;
      removeCellArtwork(logical);
      await addCellArtwork(data, logical, textureCache);
      if (refreshId !== artworkRefresh || scene !== canvas.scene) return;
      built += 1;
      if (built % REBUILD_YIELD_EVERY === 0) await yieldToCanvas();
    }
    previousDugBytes = Uint8Array.from(data.dugBytes);
    previousSourceMask = data.sourceMask;
    previousIntactSrc = data.intactSrc;
    previousDugSrc = data.dugSrc;
    previousIntactGrid = data.intactGrid;
    previousDugGrid = data.dugGrid;
    previousAppearance = appearanceKey;
    previousViewport = canvasVisibleBounds();
    refreshPrimaryCanvas();
    queueSupportMaskRefresh();
  } catch (error) {
    reportInvalid(scene, error);
  } finally {
    refreshUndergroundOverlay();
  }
}

async function addCellArtwork(data, logicalIndex, textureCache) {
  if (cellIsFullySuppressed(data, logicalIndex)) return;
  const appearance = cellAppearance(data, logicalIndex);
  if (cellNeedsIntactMesh(data, logicalIndex, appearance)) {
    const intactTexture = await loadCachedTexture(textureCache, appearance.intactSrc);
    const intactFade = cellFade(data, logicalIndex, "intact");
    if (hasFadeCoverage(intactFade.alphas)) {
      const intact = createCellMesh(data, intactTexture, logicalIndex, "intact", intactFade, appearance);
      if (intact) artwork.set(artworkKey(logicalIndex, "intact"), intact);
    }
  }
  const dugFade = cellFade(data, logicalIndex, "dug");
  if (hasFadeCoverage(dugFade.alphas)) {
    const dugTexture = await loadCachedTexture(textureCache, appearance.dugSrc);
    const dug = createCellMesh(data, dugTexture, logicalIndex, "dug", dugFade, appearance);
    if (dug) artwork.set(artworkKey(logicalIndex, "dug"), dug);
  }
}

function specialLogicalIndexes(data) {
  const total = data.width * data.height;
  const indexes = new Set();
  for (let index = 0; index < total; index += 1) {
    if (cellIsFullySuppressed(data, index)) continue;
    if (cellNeedsIntactMesh(data, index) || cellHasDugInPad(data, index)) indexes.add(index);
  }
  return indexes;
}

function cellNeedsIntactMesh(data, logicalIndex, appearance = cellAppearance(data, logicalIndex)) {
  if (cellIsFullySuppressed(data, logicalIndex)) return false;
  return isForcedCell(data, logicalIndex) || cellHasIntactOverride(data, logicalIndex, appearance);
}

function cellHasIntactOverride(data, logicalIndex, appearance = cellAppearance(data, logicalIndex)) {
  return appearance.intactSrc !== data.intactSrc || appearance.intactGrid !== data.intactGrid;
}

function createIntactSheet(data, texture) {
  if (!texture) return null;
  const mask = buildSheetMask(data);
  if (!mask.anyOpaque) return null;
  const period = Math.max(1, Number(data.intactGrid) || 1);
  const holeMask = mask.texture ?? globalThis.PIXI?.Texture?.WHITE ?? null;
  const mesh = new foundry.canvas.primary.PrimarySpriteMesh({
    name: `${MODULE_ID}.undergroundTerrain.intact.sheet`,
    object: canvas.scene,
    texture,
    shaderClass: sheetShaderClass()
  });
  applyEarthSort(mesh, data, "intact", 0, {forced: false});
  mesh.zIndex = 0;
  mesh.anchor.set(0, 0);
  mesh.position.set(data.origin.x - 0.5, data.origin.y - 0.5);
  mesh.alpha = 1;
  mesh.tint = 0xFFFFFF;
  mesh.pluginName = null;
  mesh.tileRepeat = [data.width / period, data.height / period];
  mesh.holeMask = holeMask;
  const width = data.width * data.gridSize + 1;
  const height = data.height * data.gridSize + 1;
  try {
    if (typeof mesh.resize === "function") mesh.resize(width, height, {fit: "fill", scaleX: 1, scaleY: 1});
    else {
      mesh.width = width;
      mesh.height = height;
    }
  } catch (_error) {
    mesh.width = width;
    mesh.height = height;
  }
  mesh.eventMode = "none";
  mesh.name = `${MODULE_ID}.undergroundTerrain.intact.sheet`;
  canvas.primary.addChild(mesh);
  mesh.updateCanvasTransform?.();
  return {
    mesh,
    clonedTexture: false,
    baked: false,
    maskTexture: mask.texture ?? null
  };
}

function sheetShaderClass() {
  const Base = globalThis.foundry?.canvas?.rendering?.shaders?.PrimaryBaseSamplerShader;
  if (typeof Base !== "function") return undefined;
  if (!sheetShaderClass.cached) {
    sheetShaderClass.cached = class IntactEarthSamplerShader extends Base {
      static classPluginName = null;
      static get defaultUniforms() {
        return {
          ...super.defaultUniforms,
          tileRepeat: [1, 1],
          holeMask: null
        };
      }
      static _fragmentShader = `
        uniform vec2 tileRepeat;
        uniform sampler2D holeMask;
        vec4 _main() {
          vec2 tiled = fract(vUvs * tileRepeat);
          float hole = texture(holeMask, vUvs).a;
          return texture(sampler, tiled) * tintAlpha * hole;
        }
      `;
      _preRender(mesh, renderer) {
        super._preRender(mesh, renderer);
        const uniforms = this.uniforms;
        uniforms.tileRepeat = mesh.tileRepeat ?? [1, 1];
        uniforms.holeMask = mesh.holeMask
          ?? globalThis.PIXI?.Texture?.WHITE
          ?? uniforms.sampler;
      }
    };
  }
  return sheetShaderClass.cached;
}

function buildSheetMask(data) {
  const width = data.subWidth;
  const height = data.subHeight;
  const alphas = new Uint8Array(width * height);
  let anyOpaque = false;
  let anyHole = false;
  for (let sy = 0; sy < height; sy += 1) {
    for (let sx = 0; sx < width; sx += 1) {
      const index = (sy * width) + sx;
      const opaque = sheetSubcellOpaque(data, sx, sy);
      alphas[index] = opaque ? 255 : 0;
      if (opaque) anyOpaque = true;
      else anyHole = true;
    }
  }
  if (!anyOpaque || !anyHole) return {anyOpaque, texture: null, alphas};
  const Texture = globalThis.PIXI?.Texture;
  if (typeof Texture?.from !== "function") return {anyOpaque, texture: null, alphas};
  const source = createSheetMaskSource(alphas, width, height);
  const texture = Texture.from(source);
  forgetTextureCache(texture);
  texture.alphas = alphas;
  const nearest = globalThis.PIXI?.SCALE_MODES?.NEAREST;
  const base = texture.source ?? texture.baseTexture;
  if (base && nearest != null) base.scaleMode = nearest;
  return {anyOpaque, texture, alphas};
}

function sheetSubcellOpaque(data, sx, sy) {
  const index = (sy * data.subWidth) + sx;
  if (isSuppressedSubcell(data, index)) return false;
  const lx = Math.floor(sx / data.subdivision);
  const ly = Math.floor(sy / data.subdivision);
  return !cellHasIntactOverride(data, (ly * data.width) + lx);
}

function createSheetMaskSource(alphas, width, height) {
  const canvas = createSizedCanvas(width, height);
  if (canvas) {
    const context = canvas.getContext?.("2d");
    if (context?.createImageData && context.putImageData) {
      const image = context.createImageData(width, height);
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
  return {width, height, alphas};
}

function loadCachedTexture(cache, src) {
  if (!src) return Promise.resolve(null);
  if (!cache.has(src)) cache.set(src, foundry.canvas.loadTexture(src));
  return cache.get(src);
}

function appearanceSignature(data) {
  const entries = data?.appearanceByCell;
  if (!entries?.size) return "";
  return [...entries.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([index, patch]) => [
      index,
      patch.intactSrc ?? "",
      patch.dugSrc ?? "",
      patch.intactGrid ?? "",
      patch.dugGrid ?? ""
    ].join(":"))
    .join("|");
}

function cellFade(data, logicalIndex, kind) {
  if (cellIsFullySuppressed(data, logicalIndex)) return EMPTY_FADE;
  if (!cellHasDugInPad(data, logicalIndex) && !isSuppressedCell(data, logicalIndex)) {
    return kind === "dug" ? EMPTY_FADE : OPAQUE_FADE;
  }
  return buildFadeAlphas(data, logicalIndex, kind);
}

function cellIsFullySuppressed(data, logicalIndex) {
  if (!Number.isSafeInteger(logicalIndex) || logicalIndex < 0) return false;
  if (logicalIndex >= data.width * data.height) return false;
  const sub = data.subdivision;
  const startX = (logicalIndex % data.width) * sub;
  const startY = Math.floor(logicalIndex / data.width) * sub;
  for (let y = 0; y < sub; y += 1) {
    for (let x = 0; x < sub; x += 1) {
      if (!isSuppressedSubcell(data, ((startY + y) * data.subWidth) + startX + x)) return false;
    }
  }
  return true;
}

function cellHasDugInPad(data, logicalIndex) {
  const sub = data.subdivision;
  const pad = Math.max(1, Math.ceil(Math.max(FADE_RADIUS_SUBCELLS, visionOverlapSubcells(data))));
  const startX = (logicalIndex % data.width) * sub;
  const startY = Math.floor(logicalIndex / data.width) * sub;
  const minX = Math.max(0, startX - pad);
  const maxX = Math.min(data.subWidth - 1, startX + sub + pad - 1);
  const minY = Math.max(0, startY - pad);
  const maxY = Math.min(data.subHeight - 1, startY + sub + pad - 1);
  for (let sy = minY; sy <= maxY; sy += 1) {
    for (let sx = minX; sx <= maxX; sx += 1) {
      if (isDugSubcell(data, (sy * data.subWidth) + sx)) return true;
    }
  }
  return false;
}

function createCellMesh(data, texture, logicalIndex, kind, fade, appearance = cellAppearance(data, logicalIndex)) {
  const alphas = fade.alphas;
  const lx = logicalIndex % data.width;
  const ly = Math.floor(logicalIndex / data.width);
  const x = data.origin.x + lx * data.gridSize;
  const y = data.origin.y + ly * data.gridSize;
  const seam = 1;
  const period = kind === "intact" ? appearance.intactGrid : appearance.dugGrid;
  const sliced = sliceCellTexture(texture, lx, ly, period);
  const sourceTexture = sliced.texture ?? texture;
  if (!sourceTexture) return null;
  const size = data.gridSize + seam;
  const frame = sliceFrame(texture, lx, ly, period);
  const bakedTexture = isFullyOpaqueAlphas(alphas)
    ? null
    : bakeFadedTexture(texture, alphas, size, frame, data, logicalIndex, kind);
  if (bakedTexture && sliced.cloned) destroySliceTexture(sliced.texture);
  const displayTexture = bakedTexture ?? sourceTexture;
  const mesh = new foundry.canvas.primary.PrimarySpriteMesh({
    name: `${MODULE_ID}.undergroundTerrain.${kind}.${logicalIndex}`,
    object: canvas.scene,
    texture: displayTexture
  });
  applyEarthSort(mesh, data, kind, logicalIndex);
  mesh.zIndex = 0;
  mesh.anchor.set(0, 0);
  mesh.position.set(x - seam / 2, y - seam / 2);
  mesh.alpha = 1;
  mesh.tint = 0xFFFFFF;
  try {
    if (typeof mesh.resize === "function") mesh.resize(size, size, {fit: "fill", scaleX: 1, scaleY: 1});
    else {
      mesh.width = size;
      mesh.height = size;
    }
  } catch (_error) {
    mesh.width = size;
    mesh.height = size;
  }
  mesh.eventMode = "none";
  mesh.name = `${MODULE_ID}.undergroundTerrain.${kind}.${logicalIndex}`;
  canvas.primary.addChild(mesh);
  mesh.updateCanvasTransform?.();
  return {
    mesh,
    clonedTexture: sliced.cloned === true && !bakedTexture,
    baked: Boolean(bakedTexture)
  };
}

/** One Texture wrapper per mesh, sharing the loaded source and cached frame. */
function sliceCellTexture(texture, lx, ly, period) {
  if (!texture) return {texture, cloned: false};
  const width = Number(texture.width ?? texture.orig?.width ?? 0);
  const height = Number(texture.height ?? texture.orig?.height ?? 0);
  if (!(width > 0 && height > 0)) return {texture, cloned: false};
  const n = Number(period);
  const useSlice = Number.isSafeInteger(n) && n > 1;
  const sliceWidth = useSlice ? width / n : width;
  const sliceHeight = useSlice ? height / n : height;
  const column = useSlice ? ((lx % n) + n) % n : 0;
  const row = useSlice ? ((ly % n) + n) % n : 0;
  const key = sliceCacheKey(texture, useSlice ? n : 1, column, row);
  let spec = sliceCache.get(key);
  if (!spec) {
    spec = {
      source: texture.source ?? texture.baseTexture ?? texture,
      frame: {
        x: column * sliceWidth,
        y: row * sliceHeight,
        width: sliceWidth,
        height: sliceHeight
      }
    };
    sliceCache.set(key, spec);
  }
  const Texture = globalThis.PIXI?.Texture;
  const Rectangle = globalThis.PIXI?.Rectangle;
  const frame = typeof Rectangle === "function"
    ? new Rectangle(spec.frame.x, spec.frame.y, spec.frame.width, spec.frame.height)
    : {...spec.frame};
  const sliced = cloneTextureForSlice(texture, frame, Texture);
  if (!sliced) return {texture, cloned: false};
  applyTextureFrame(sliced, frame);
  sliced.updateUvs?.();
  return {texture: sliced, cloned: true};
}

function sliceCacheKey(texture, period, column, row) {
  return `${texture.src ?? ""}:${texture.width}x${texture.height}:${period}:${column}:${row}`;
}

function cloneTextureForSlice(texture, frame, Texture) {
  const source = texture.source ?? texture.baseTexture ?? texture;
  let sliced = null;
  if (typeof Texture === "function") {
    try {
      sliced = new Texture({source, frame, dynamic: true});
    } catch (_error) {
      try {
        sliced = new Texture(source, frame);
      } catch (_fallback) {
        sliced = null;
      }
    }
  }
  if (!sliced && typeof texture.clone === "function") {
    try { sliced = texture.clone(); }
    catch (_error) { sliced = null; }
  }
  if (!sliced) return null;
  if (sliced.src == null && texture.src != null) sliced.src = texture.src;
  forgetTextureCache(sliced);
  return sliced;
}

function forgetTextureCache(texture) {
  const ids = texture?.textureCacheIds;
  if (Array.isArray(ids) && ids.length) {
    const cache = globalThis.PIXI?.utils?.TextureCache;
    for (const id of [...ids]) {
      if (cache && cache[id] === texture) delete cache[id];
    }
    ids.length = 0;
  }
  if (texture?.cacheId) {
    try { globalThis.PIXI?.Cache?.remove?.(texture.cacheId); }
    catch (_error) {}
    texture.cacheId = null;
  }
}

function applyTextureFrame(texture, frame) {
  if (texture.frame?.copyFrom) texture.frame.copyFrom(frame);
  else texture.frame = frame;
  if (texture.orig?.copyFrom) texture.orig.copyFrom(frame);
  else if (texture.orig) {
    texture.orig.x = frame.x;
    texture.orig.y = frame.y;
    texture.orig.width = frame.width;
    texture.orig.height = frame.height;
  }
}

function applyEarthSort(mesh, data, kind, logicalIndex, {forced} = {}) {
  const background = canvas.primary?.background;
  const layers = canvas.primary.constructor.SORT_LAYERS ?? {};
  const isForced = forced ?? isForcedCell(data, logicalIndex);
  if (isForced) {
    mesh.sortLayer = Number.isFinite(Number(layers.TILES))
      ? Number(layers.TILES)
      : (Number(background?.sortLayer) || 0) + 2;
    mesh.sort = 1000000 - (kind === "dug" ? 1 : 2);
  } else {
    mesh.sortLayer = Number.isFinite(Number(background?.sortLayer))
      ? Number(background.sortLayer)
      : (layers.SCENE ?? layers.TILES ?? 0);
    const backgroundSort = Number.isFinite(Number(background?.sort)) ? Number(background.sort) : 0;
    mesh.sort = backgroundSort - (kind === "dug" ? 1 : 2);
  }
  mesh.elevation = Number(
    background?.elevation
    ?? canvas.level?.elevation?.bottom
    ?? canvas.level?.elevation?.base
    ?? data.elevation
    ?? 0
  );
}

function sliceFrame(texture, lx, ly, period) {
  const width = Number(texture?.width ?? texture?.orig?.width ?? 0);
  const height = Number(texture?.height ?? texture?.orig?.height ?? 0);
  const n = Number(period);
  if (!(width > 0) || !(height > 0) || !Number.isSafeInteger(n) || n <= 1) {
    return {x: 0, y: 0, width, height};
  }
  const sliceWidth = width / n;
  const sliceHeight = height / n;
  const column = ((lx % n) + n) % n;
  const row = ((ly % n) + n) % n;
  return {x: column * sliceWidth, y: row * sliceHeight, width: sliceWidth, height: sliceHeight};
}

function bakeFadedTexture(texture, alphas, size, frame, data, logicalIndex, kind) {
  const Texture = globalThis.PIXI?.Texture;
  if (typeof Texture?.from !== "function") return null;
  const output = createSizedCanvas(size, size);
  const context = output?.getContext?.("2d");
  if (!context || typeof context.drawImage !== "function") {
    const fallback = Texture.from(createMaskSource(alphas));
    forgetTextureCache(fallback);
    return stampFadeAlphas(fallback, alphas);
  }
  const baked = bakeFadedCanvasTexture(
    Texture, texture, alphas, size, output, context, frame, data, logicalIndex, kind
  );
  forgetTextureCache(baked);
  return stampFadeAlphas(baked, alphas);
}

function stampFadeAlphas(texture, alphas) {
  if (!texture) return null;
  texture.alphas = alphas;
  return texture;
}

function bakeFadedCanvasTexture(Texture, texture, alphas, size, output, context, frame, data, logicalIndex, kind) {
  const sourceFrame = frame ?? texture.frame ?? texture.orig ?? {
    x: 0,
    y: 0,
    width: Number(texture.width) || size,
    height: Number(texture.height) || size
  };
  if (!drawTextureFrame(context, texture, sourceFrame, size)) return null;
  const maskSource = createMaskSource(alphas);
  context.globalCompositeOperation = "destination-in";
  context.drawImage(maskSource, 0, 0, size, size);
  if (kind === "intact") applyRockBevel(context, data, logicalIndex, size);
  const baked = Texture.from(output);
  forgetTextureCache(baked);
  const source = baked.source ?? baked.baseTexture;
  const linear = globalThis.PIXI?.SCALE_MODES?.LINEAR;
  if (source && linear != null) source.scaleMode = linear;
  return baked;
}

function applyRockBevel(context, data, logicalIndex, size) {
  if (!data || typeof context.getImageData !== "function" || typeof context.putImageData !== "function") return;
  try {
    const image = context.getImageData(0, 0, size, size);
    for (let py = 0; py < size; py += 1) {
      for (let px = 0; px < size; px += 1) {
        const shade = rockBevelShade(data, logicalIndex, size, px, py);
        if (!(shade < 1)) continue;
        const index = ((py * size) + px) * 4;
        image.data[index] = Math.round(image.data[index] * shade);
        image.data[index + 1] = Math.round(image.data[index + 1] * shade);
        image.data[index + 2] = Math.round(image.data[index + 2] * shade);
      }
    }
    context.putImageData(image, 0, 0);
  } catch (_error) {}
}

/** One-sided shade on intact rock. 1 is unchanged; lower values darken the wall lip. */
export function rockBevelShade(data, logicalIndex, size, px, py) {
  const dist = distanceToDug(data, logicalIndex, size, px, py);
  if (!(dist > 0)) return 1;
  if (dist >= BEVEL_ROUND_RADIUS + BEVEL_WIDTH) return 1;
  if (dist <= BEVEL_ROUND_RADIUS) {
    const t = dist / BEVEL_ROUND_RADIUS;
    return 1 - ((1 - BEVEL_FLOOR) * t * t * (3 - (2 * t)));
  }
  const lip = dist - BEVEL_ROUND_RADIUS;
  const t = lip / BEVEL_WIDTH;
  return BEVEL_FLOOR + ((1 - BEVEL_FLOOR) * t * t * (3 - (2 * t)));
}

function cellPixelWorld(data, logicalIndex, px, py) {
  const seam = 1;
  const lx = logicalIndex % data.width;
  const ly = Math.floor(logicalIndex / data.width);
  return {
    x: data.origin.x + lx * data.gridSize - seam / 2 + px + 0.5,
    y: data.origin.y + ly * data.gridSize - seam / 2 + py + 0.5
  };
}

function occupancySearchReach(data) {
  const fadePx = FADE_RADIUS_SUBCELLS * data.subGridSize;
  return Math.ceil((BEVEL_ROUND_RADIUS + BEVEL_WIDTH + fadePx) / data.subGridSize) + 1;
}

function distanceToDug(data, logicalIndex, size, px, py) {
  const world = cellPixelWorld(data, logicalIndex, px, py);
  if (classifyWorld(data, world.x, world.y) === 2) return 0;
  return distanceToClass(data, world.x, world.y, 2, occupancySearchReach(data));
}

function signedDistanceToDug(data, worldX, worldY, reach) {
  const occupancy = classifyWorld(data, worldX, worldY);
  if (occupancy === 2) return -distanceToClass(data, worldX, worldY, 1, reach);
  if (occupancy === 1) return distanceToClass(data, worldX, worldY, 2, reach);
  return Number.POSITIVE_INFINITY;
}

function distanceToClass(data, worldX, worldY, occupancy, reach) {
  const sub = data.subGridSize;
  const sx0 = Math.floor((worldX - data.origin.x) / sub);
  const sy0 = Math.floor((worldY - data.origin.y) / sub);
  let best = Number.POSITIVE_INFINITY;
  for (let sy = sy0 - reach; sy <= sy0 + reach; sy += 1) {
    for (let sx = sx0 - reach; sx <= sx0 + reach; sx += 1) {
      if (classifySubcell(data, sx, sy) !== occupancy) continue;
      const dist = distanceToRect(
        worldX, worldY,
        data.origin.x + sx * sub,
        data.origin.y + sy * sub,
        sub,
        sub
      );
      if (dist < best) best = dist;
      if (best === 0) return 0;
    }
  }
  return best;
}

function distanceToRect(px, py, x, y, width, height) {
  const dx = Math.max(x - px, 0, px - (x + width));
  const dy = Math.max(y - py, 0, py - (y + height));
  return Math.hypot(dx, dy);
}

function classifyWorld(data, worldX, worldY) {
  const sx = Math.floor((worldX - data.origin.x) / data.subGridSize);
  const sy = Math.floor((worldY - data.origin.y) / data.subGridSize);
  return classifySubcell(data, sx, sy);
}

function drawTextureFrame(context, texture, frame, size) {
  const image = getDrawableImage(texture);
  if (image) {
    try {
      context.drawImage(
        image,
        Number(frame.x) || 0,
        Number(frame.y) || 0,
        Number(frame.width) || size,
        Number(frame.height) || size,
        0,
        0,
        size,
        size
      );
      return true;
    } catch (_error) {}
  }
  const extracted = extractTextureImage(texture);
  if (!extracted) return false;
  try {
    context.drawImage(
      extracted,
      Number(frame.x) || 0,
      Number(frame.y) || 0,
      Number(frame.width) || extracted.width || size,
      Number(frame.height) || extracted.height || size,
      0,
      0,
      size,
      size
    );
    return true;
  } catch (_error) {
    return false;
  }
}

function getDrawableImage(texture) {
  const source = texture?.source ?? texture?.baseTexture;
  const candidates = [
    source?.resource?.source,
    source?.resource,
    texture?.resource?.source,
    source?.canvas,
    source?.source
  ];
  for (const candidate of candidates) {
    if (isDrawableImage(candidate)) return candidate;
  }
  return null;
}

function isDrawableImage(image) {
  if (!image || typeof image === "string") return false;
  if (typeof ImageBitmap === "function" && image instanceof ImageBitmap) return true;
  if (typeof OffscreenCanvas === "function" && image instanceof OffscreenCanvas) return true;
  if (typeof image.getContext === "function" && Number(image.width) > 0) return true;
  return typeof image.tagName === "string" && Number(image.naturalWidth ?? image.width) > 0;
}

function extractTextureImage(texture) {
  const renderer = globalThis.canvas?.app?.renderer;
  const extract = renderer?.extract;
  if (!extract) return null;
  const attempts = [];
  if (typeof extract.canvas === "function") {
    attempts.push(() => extract.canvas({target: texture}));
    attempts.push(() => extract.canvas(texture));
  }
  if (typeof extract.image === "function") {
    attempts.push(() => extract.image({target: texture}));
    attempts.push(() => extract.image(texture));
  }
  for (const attempt of attempts) {
    try {
      const extracted = attempt();
      if (extracted && typeof extracted.then !== "function" && isDrawableImage(extracted)) return extracted;
    } catch (_error) {}
  }
  return null;
}

function destroySliceTexture(texture) {
  if (!texture || texture.destroyed) return;
  forgetTextureCache(texture);
  try {
    texture.destroy(false);
  } catch (_error) {
    try {
      texture.destroy({destroyBaseTexture: false});
    } catch (_fallback) {
      texture.destroy?.();
    }
  }
}

function destroyOwnedTexture(texture) {
  if (!texture || texture.destroyed) return;
  forgetTextureCache(texture);
  try {
    texture.destroy(true);
  } catch (_error) {
    try {
      texture.destroy({destroyTexture: true, destroyBaseTexture: true});
    } catch (_fallback) {
      texture.destroy?.();
    }
  }
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
  return createSizedCanvas(MASK_RESOLUTION, MASK_RESOLUTION);
}

function createSizedCanvas(width, height) {
  const adapter = globalThis.PIXI?.DOMAdapter?.get?.();
  const canvas = adapter?.createCanvas?.(width, height)
    ?? globalThis.document?.createElement?.("canvas")
    ?? (typeof globalThis.OffscreenCanvas === "function"
      ? new globalThis.OffscreenCanvas(width, height)
      : null);
  if (canvas) {
    canvas.width = width;
    canvas.height = height;
  }
  return canvas;
}

/** Soft mix where intact earth meets dug rubble, on a rounded distance field. */
function buildFadeAlphas(data, logicalIndex, kind) {
  const seam = 1;
  const size = data.gridSize + seam;
  const reach = occupancySearchReach(data);
  const fadePx = FADE_RADIUS_SUBCELLS * data.subGridSize;
  const alphas = new Uint8Array(MASK_RESOLUTION * MASK_RESOLUTION);
  for (let my = 0; my < MASK_RESOLUTION; my += 1) {
    for (let mx = 0; mx < MASK_RESOLUTION; mx += 1) {
      const px = ((mx + 0.5) / MASK_RESOLUTION) * size - 0.5;
      const py = ((my + 0.5) / MASK_RESOLUTION) * size - 0.5;
      const world = cellPixelWorld(data, logicalIndex, px, py);
      const occupancy = classifyWorld(data, world.x, world.y);
      if (!occupancy) continue;
      const signed = signedDistanceToDug(data, world.x, world.y, reach) - BEVEL_ROUND_RADIUS;
      const t = Math.max(0, Math.min(1, (signed + fadePx) / (2 * fadePx)));
      const intact = Math.round(t * t * (3 - (2 * t)) * 255);
      alphas[(my * MASK_RESOLUTION) + mx] = kind === "intact" ? intact : 255 - intact;
    }
  }
  return {alphas};
}

function classifySubcell(data, sx, sy) {
  if (sx < 0 || sy < 0 || sx >= data.subWidth || sy >= data.subHeight) return 0;
  const index = (sy * data.subWidth) + sx;
  if (isSuppressedSubcell(data, index)) return 0;
  return isDugSubcell(data, index) ? 2 : 1;
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
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= data.width || ny >= data.height) continue;
      expanded.add((ny * data.width) + nx);
    }
  }
  return expanded;
}

/** Logical cells overlapping the view, or the whole grid when bounds are missing. */
export function visibleLogicalIndexes(data, bounds) {
  const total = data.width * data.height;
  if (!bounds || !(data.gridSize > 0)) {
    const indexes = new Set();
    for (let index = 0; index < total; index += 1) indexes.add(index);
    return indexes;
  }
  const pad = VIEWPORT_PAD_CELLS * data.gridSize;
  const minX = Number(bounds.x) - pad;
  const minY = Number(bounds.y) - pad;
  const maxX = Number(bounds.x) + Number(bounds.width) + pad;
  const maxY = Number(bounds.y) + Number(bounds.height) + pad;
  const startX = Math.max(0, Math.floor((minX - data.origin.x) / data.gridSize));
  const startY = Math.max(0, Math.floor((minY - data.origin.y) / data.gridSize));
  const endX = Math.min(data.width - 1, Math.ceil((maxX - data.origin.x) / data.gridSize) - 1);
  const endY = Math.min(data.height - 1, Math.ceil((maxY - data.origin.y) / data.gridSize) - 1);
  const indexes = new Set();
  if (endX < startX || endY < startY) return indexes;
  for (let ly = startY; ly <= endY; ly += 1) {
    for (let lx = startX; lx <= endX; lx += 1) {
      indexes.add((ly * data.width) + lx);
    }
  }
  return indexes;
}

function canvasVisibleBounds() {
  const current = globalThis.canvas;
  const view = current?.viewPosition;
  const screenWidth = Number(current?.screenDimensions?.[0]
    ?? current?.app?.renderer?.screen?.width
    ?? current?.app?.renderer?.width);
  const screenHeight = Number(current?.screenDimensions?.[1]
    ?? current?.app?.renderer?.screen?.height
    ?? current?.app?.renderer?.height);
  const scale = Number(view?.scale);
  if (view && screenWidth > 0 && screenHeight > 0 && scale > 0
    && Number.isFinite(Number(view.x)) && Number.isFinite(Number(view.y))) {
    const width = screenWidth / scale;
    const height = screenHeight / scale;
    return {
      x: Number(view.x) - (width / 2),
      y: Number(view.y) - (height / 2),
      width,
      height
    };
  }
  const screen = current?.app?.renderer?.screen;
  const stage = current?.stage;
  if (screen && typeof stage?.toLocal === "function") {
    const topLeft = stage.toLocal({x: 0, y: 0});
    const bottomRight = stage.toLocal({x: screen.width, y: screen.height});
    const x = Math.min(Number(topLeft?.x), Number(bottomRight?.x));
    const y = Math.min(Number(topLeft?.y), Number(bottomRight?.y));
    const width = Math.abs(Number(bottomRight?.x) - Number(topLeft?.x));
    const height = Math.abs(Number(bottomRight?.y) - Number(topLeft?.y));
    if (Number.isFinite(x) && Number.isFinite(y) && width > 0 && height > 0) {
      return {x, y, width, height};
    }
  }
  return previousViewport;
}

function sameViewport(left, right) {
  if (!left && !right) return true;
  if (!left || !right) return false;
  return left.x === right.x && left.y === right.y
    && left.width === right.width && left.height === right.height;
}

function intersectSets(left, right) {
  const intersection = new Set();
  for (const value of left) {
    if (right.has(value)) intersection.add(value);
  }
  return intersection;
}

function hasCellArtwork(logicalIndex) {
  return artwork.has(artworkKey(logicalIndex, "intact"))
    || artwork.has(artworkKey(logicalIndex, "dug"));
}

function yieldToCanvas() {
  if (typeof requestAnimationFrame !== "function") return Promise.resolve();
  return new Promise(resolve => requestAnimationFrame(resolve));
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
    return getUndergroundData(scene, {level: canvas?.level});
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
  destroyIntactSheet();
  if (!artwork.size) {
    refreshPrimaryCanvas();
    return;
  }
  for (const logical of new Set([...artwork.keys()].map(key => Number(key.split(":")[0])))) {
    removeCellArtwork(logical);
  }
  refreshPrimaryCanvas();
}

function destroyIntactSheet() {
  if (!intactSheet) return;
  const mask = intactSheet.mesh?.holeMask;
  destroyDisplayObject(intactSheet.mesh, {destroyTexture: false, destroyBaseTexture: false});
  if (intactSheet.maskTexture) destroyOwnedTexture(intactSheet.maskTexture);
  else if (mask && mask !== intactSheet.mesh?.texture) destroySliceTexture(mask);
  intactSheet = null;
}

function removeCellArtwork(logicalIndex) {
  for (const kind of ["intact", "dug"]) {
    const entry = artwork.get(artworkKey(logicalIndex, kind));
    if (!entry) continue;
    artwork.delete(artworkKey(logicalIndex, kind));
    const texture = entry.mesh?.texture;
    detachMeshTexture(entry.mesh);
    destroyDisplayObject(entry.mesh, {destroyTexture: false, destroyBaseTexture: false});
    if (entry.baked) destroyOwnedTexture(texture);
    else if (entry.clonedTexture && texture !== entry.mesh?.texture) destroySliceTexture(texture);
  }
}

function detachMeshTexture(mesh) {
  if (!mesh) return;
  const empty = globalThis.PIXI?.Texture?.EMPTY;
  try {
    if (empty) mesh.texture = empty;
  } catch (_error) {}
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
  previousAppearance = null;
  previousViewport = null;
  cachedIntactTexture = null;
  cachedDugTexture = null;
  destroyIntactSheet();
  clearSliceCache();
}

function clearSliceCache() {
  sliceCache.clear();
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
