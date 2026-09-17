import {
  createUndergroundSource,
  DEFAULT_SUBDIVISION,
  findSceneLevel,
  getViewedLevelId
} from "./underground-data.js";

const YIELD_EVERY_ROWS = 8;
const KTX2_MODULE_ID = "theiks-ktx2-renderer";

/** Read the playable Scene rectangle as a logical underground grid. */
export function getSceneUndergroundBounds(scene) {
  const gridSize = Number(scene?.grid?.size);
  if (!(gridSize > 0) || !Number.isFinite(gridSize)) {
    throw new TypeError("gridSize must be a positive finite number.");
  }
  const dimensions = scene?.dimensions ?? {};
  const origin = {
    x: finiteNumber(dimensions.sceneX, "origin.x"),
    y: finiteNumber(dimensions.sceneY, "origin.y")
  };
  const sceneWidth = Number(dimensions.sceneWidth);
  const sceneHeight = Number(dimensions.sceneHeight);
  if (!(sceneWidth > 0) || !Number.isFinite(sceneWidth)) {
    throw new TypeError("sceneWidth must be a positive finite number.");
  }
  if (!(sceneHeight > 0) || !Number.isFinite(sceneHeight)) {
    throw new TypeError("sceneHeight must be a positive finite number.");
  }
  return {
    origin,
    width: Math.max(1, Math.round(sceneWidth / gridSize)),
    height: Math.max(1, Math.round(sceneHeight / gridSize)),
    gridSize
  };
}

/**
 * Return a virtual Tile covering the playable Scene with this Level's background artwork.
 * Color-only fills and foreground overlays are ignored.
 */
export function getSceneBackgroundOccupancyTile(scene, {levelId, level} = {}) {
  const resolved = level ?? findSceneLevel(scene, levelId || scene?.initialLevel);
  const background = resolved?.background ?? resolved?._source?.background ?? {};
  const src = artworkSrc(background)
    || artworkSrc(scene?.background)
    || artworkSrc(scene?._source?.background);
  if (!src) return null;
  const threshold = Number(background.alphaThreshold ?? scene?.background?.alphaThreshold ?? 0.75);
  const fromCanvas = occupancyTileFromCanvasBackground(scene, resolved, src, threshold);
  if (fromCanvas) return fromCanvas;
  const bounds = getSceneUndergroundBounds(scene);
  const width = Number(scene?.dimensions?.sceneWidth) > 0
    ? Number(scene.dimensions.sceneWidth)
    : bounds.width * bounds.gridSize;
  const height = Number(scene?.dimensions?.sceneHeight) > 0
    ? Number(scene.dimensions.sceneHeight)
    : bounds.height * bounds.gridSize;
  const textures = resolved?.textures ?? resolved?._source?.textures ?? scene?.textures ?? {};
  return {
    x: bounds.origin.x + (width / 2),
    y: bounds.origin.y + (height / 2),
    width,
    height,
    rotation: Number(textures.rotation ?? 0),
    occupancyFallback: "empty",
    texture: {
      src,
      width: Number(background.width ?? textures.width ?? 0) || undefined,
      height: Number(background.height ?? textures.height ?? 0) || undefined,
      fit: textures.fit ?? "fill",
      scaleX: Number(textures.scaleX ?? 1),
      scaleY: Number(textures.scaleY ?? 1),
      anchorX: Number(textures.anchorX ?? 0.5),
      anchorY: Number(textures.anchorY ?? 0.5),
      offsetX: Number(textures.offsetX ?? 0),
      offsetY: Number(textures.offsetY ?? 0),
      alphaThreshold: threshold
    }
  };
}

/**
 * Return subcell indexes whose center is not covered by opaque Level background or Tile artwork.
 *
 * @param {object} scene
 * @param {{
 *   subdivision?: number,
 *   levelId?: string,
 *   level?: object,
 *   sampleTileAlpha?: Function,
 *   getTextureSize?: Function,
 *   signal?: AbortSignal
 * }} [options]
 * @returns {Promise<number[]>}
 */
export async function collectSceneUndergroundSubcellIndexes(scene, {
  subdivision = DEFAULT_SUBDIVISION,
  levelId,
  level,
  sampleTileAlpha = null,
  getTextureSize = null,
  signal = null
} = {}) {
  const bounds = getSceneUndergroundBounds(scene);
  const sub = Number(subdivision) > 0 ? Number(subdivision) : DEFAULT_SUBDIVISION;
  const subWidth = bounds.width * sub;
  const subHeight = bounds.height * sub;
  const subGridSize = bounds.gridSize / sub;
  const occupied = new Uint8Array(subWidth * subHeight);
  const cache = new Map();
  const useDefaultSample = sampleTileAlpha == null;
  const sample = sampleTileAlpha ?? sampleCachedAlpha;
  const sizeOf = getTextureSize ?? ((tile) => defaultGetTextureSize(tile, cache));
  const resolvedLevelId = levelId || (typeof scene?.initialLevel === "string" ? scene.initialLevel : "");
  const resolvedLevel = level ?? findSceneLevel(scene, resolvedLevelId);
  throwIfAborted(signal);
  await yieldToEventLoop();
  throwIfAborted(signal);
  const context = {
    bounds,
    subWidth,
    subHeight,
    subGridSize,
    cache,
    sample,
    sizeOf,
    useDefaultSample,
    signal,
    scene,
    levelId: resolvedLevelId
  };

  if (getMapPyramidFlag(scene)) {
    await markPyramidOccupied(occupied, scene, resolvedLevelId, context);
  } else {
    const background = getSceneBackgroundOccupancyTile(scene, {levelId: resolvedLevelId, level: resolvedLevel});
    if (background) await markArtworkOccupied(occupied, background, context);
  }

  for (const tile of getSceneTiles(scene)) {
    if (tile?.hidden === true || tile?._source?.hidden === true) continue;
    if (!tileIncludesLevel(tile, resolvedLevelId, resolvedLevel)) continue;
    if (!tileSrc(tile)) continue;
    await markArtworkOccupied(occupied, tile, context);
  }

  const cells = [];
  for (let index = 0; index < occupied.length; index += 1) {
    if (!occupied[index]) cells.push(index);
  }
  return cells;
}

/** Build a Scene underground flag from the current playable grid and artwork occupancy. */
export async function createUndergroundSourceFromScene(scene, options = {}) {
  const bounds = getSceneUndergroundBounds(scene);
  const levelId = resolveSceneLevelId(scene, options.levelId);
  const level = options.level ?? findSceneLevel(scene, levelId);
  const cells = options.cells ?? await collectSceneUndergroundSubcellIndexes(scene, {
    subdivision: options.subdivision,
    levelId,
    level,
    sampleTileAlpha: options.sampleTileAlpha,
    getTextureSize: options.getTextureSize,
    signal: options.signal
  });
  return createUndergroundSource({
    enabled: options.enabled !== false,
    levelId,
    origin: bounds.origin,
    width: bounds.width,
    height: bounds.height,
    gridSize: bounds.gridSize,
    subdivision: options.subdivision,
    cells,
    intactSrc: options.intactSrc,
    dugSrc: options.dugSrc,
    intactGrid: options.intactGrid,
    dugGrid: options.dugGrid,
    elevation: Number(options.elevation ?? level?.elevation?.bottom ?? level?.elevation?.base ?? 0),
    blocksMovement: true,
    blocksVision: true
  });
}

/** Texture transform matching breakable-terrain contour mapping. */
export function getTileTextureTransform(tile, textureDimensions) {
  const source = tile?._source ?? tile ?? {};
  const texture = source.texture ?? tile?.texture ?? {};
  const textureWidth = Number(textureDimensions?.width ?? 0);
  const textureHeight = Number(textureDimensions?.height ?? 0);
  const baseWidth = Number(source.width ?? tile?.width ?? 0);
  const baseHeight = Number(source.height ?? tile?.height ?? 0);
  if (!(textureWidth > 0 && textureHeight > 0 && baseWidth > 0 && baseHeight > 0)) return null;

  const fit = texture.fit ?? "fill";
  let scaleX;
  let scaleY;
  switch (fit) {
    case "cover":
      scaleX = scaleY = Math.max(baseWidth / textureWidth, baseHeight / textureHeight);
      break;
    case "contain":
      scaleX = scaleY = Math.min(baseWidth / textureWidth, baseHeight / textureHeight);
      break;
    case "width":
      scaleX = scaleY = baseWidth / textureWidth;
      break;
    case "height":
      scaleX = scaleY = baseHeight / textureHeight;
      break;
    default:
      scaleX = baseWidth / textureWidth;
      scaleY = baseHeight / textureHeight;
  }
  scaleX *= Number(texture.scaleX ?? 1);
  scaleY *= Number(texture.scaleY ?? 1);
  if (!Number.isFinite(scaleX) || !Number.isFinite(scaleY) || scaleX === 0 || scaleY === 0) return null;

  const radians = Number(source.rotation ?? tile?.rotation ?? 0) * Math.PI / 180;
  return {
    textureWidth,
    textureHeight,
    scaleX,
    scaleY,
    offsetX: Number(texture.offsetX ?? 0),
    offsetY: Number(texture.offsetY ?? 0),
    anchorX: Number(texture.anchorX ?? 0.5) * textureWidth,
    anchorY: Number(texture.anchorY ?? 0.5) * textureHeight,
    originX: Number(source.x ?? tile?.x ?? 0),
    originY: Number(source.y ?? tile?.y ?? 0),
    cos: Math.cos(radians),
    sin: Math.sin(radians)
  };
}

/** Convert a world point into Tile texture UVs, or null when it misses the texture. */
export function worldPointToTileUv(transform, worldX, worldY) {
  if (!transform) return null;
  const dx = worldX - transform.originX;
  const dy = worldY - transform.originY;
  const localX = (transform.cos * dx) + (transform.sin * dy);
  const localY = (-transform.sin * dx) + (transform.cos * dy);
  const u = ((localX / transform.scaleX) + transform.anchorX - (transform.offsetX ?? 0)) / transform.textureWidth;
  const v = ((localY / transform.scaleY) + transform.anchorY - (transform.offsetY ?? 0)) / transform.textureHeight;
  if (u < 0 || u > 1 || v < 0 || v > 1) return null;
  return {u, v};
}

/**
 * Occupancy in 0..1.
 * Transparent pixels receive earth. Authored tiles also treat inked-black cutouts as earth.
 * Scene / pyramid rasters must pass inkedBlack: false so dark stone and dirt stay floor.
 */
export function tilePixelOccupancy(red, green, blue, alpha, {inkedBlack = true} = {}) {
  if (!(alpha > 0)) return 0;
  if (inkedBlack && (red + green + blue) <= 24) return 0;
  return alpha;
}

function getMapPyramidFlag(scene) {
  const flag = scene?.getFlag?.(KTX2_MODULE_ID, "mapPyramid")
    ?? scene?.flags?.[KTX2_MODULE_ID]?.mapPyramid;
  return flag && typeof flag === "object" ? flag : null;
}

async function markPyramidOccupied(occupied, scene, levelId, context) {
  if (await markPyramidLiveMeshesOccupied(occupied, scene, levelId, context)) return true;
  const manifest = await loadPyramidManifest(scene);
  if (!manifest) return false;
  if (await markPyramidZ0Occupied(occupied, manifest, levelId, context)) return true;
  return markPyramidThumbnailOccupied(occupied, manifest, context);
}

async function markPyramidLiveMeshesOccupied(occupied, scene, levelId, context) {
  const view = globalThis.canvas;
  if (!view || view.scene !== scene) return false;
  const manager = view.manager;
  if (!manager?.manifest || !manager.containers) return false;
  const managerScene = manager.scene;
  if (managerScene && managerScene !== scene && managerScene.id !== scene.id) return false;
  const container = manager.containers.get?.(levelId)
    ?? manager.containers.get?.(String(levelId));
  const meshes = [...(container?.children ?? [])].filter(mesh => {
    return mesh && mesh.destroyed !== true
      && Number(mesh.width) > 0 && Number(mesh.height) > 0;
  });
  if (!meshes.length) return false;
  const threshold = pyramidThreshold(scene, levelId);
  let any = false;
  for (const mesh of meshes) {
    throwIfAborted(context.signal);
    const image = await extractTexturePixels(mesh, {preferCanvas: true});
    if (!image) continue;
    markRasterOccupied(occupied, context, image, {
      x: Number(mesh.position?.x ?? 0),
      y: Number(mesh.position?.y ?? 0),
      width: Number(mesh.width),
      height: Number(mesh.height)
    }, threshold);
    any = true;
  }
  return any;
}

async function markPyramidZ0Occupied(occupied, manifest, levelId, context) {
  const level = pyramidLevel(manifest, levelId);
  const tiles = (level?.tiers?.[0]?.tiles ?? []).filter(tile => tile && !tile.blank && tile.scene && tile.path);
  if (!tiles.length) return false;
  const threshold = pyramidThreshold(context.scene, levelId);
  let any = false;
  for (const tile of tiles) {
    throwIfAborted(context.signal);
    const image = await loadAlphaImage(tile.path);
    if (!image) continue;
    markRasterOccupied(occupied, context, image, sceneRectToWorld(context.bounds, tile.scene), threshold);
    any = true;
  }
  return any;
}

async function markPyramidThumbnailOccupied(occupied, manifest, context) {
  const path = manifest?.thumbnail?.path;
  if (typeof path !== "string" || !path.trim()) return false;
  const image = await loadAlphaImage(path.trim());
  if (!image) return false;
  markRasterOccupied(occupied, context, image, {
    x: context.bounds.origin.x,
    y: context.bounds.origin.y,
    width: context.bounds.width * context.bounds.gridSize,
    height: context.bounds.height * context.bounds.gridSize
  }, pyramidThreshold(context.scene, context.levelId));
  return true;
}

async function loadPyramidManifest(scene) {
  const manager = globalThis.canvas?.manager;
  if (manager?.manifest && (!manager.scene || manager.scene === scene || manager.scene.id === scene.id)) {
    return manager.manifest;
  }
  const flag = getMapPyramidFlag(scene);
  if (typeof flag?.manifest !== "string" || !flag.manifest.trim()) return null;
  try {
    if (typeof fetch !== "function") return null;
    const response = await fetch(mediaUrl(flag.manifest.trim()));
    if (!response.ok || typeof response.json !== "function") return null;
    return await response.json();
  } catch (_error) {
    return null;
  }
}

function pyramidLevel(manifest, levelId) {
  const id = String(levelId ?? "");
  return (manifest?.levels ?? []).find(level => String(level?.id ?? level?._id ?? "") === id) ?? null;
}

function pyramidThreshold(scene, levelId) {
  const level = findSceneLevel(scene, levelId);
  return Number(level?.background?.alphaThreshold ?? scene?.background?.alphaThreshold ?? 0.75);
}

function sceneRectToWorld(bounds, rect) {
  return {
    x: bounds.origin.x + Number(rect.x ?? 0),
    y: bounds.origin.y + Number(rect.y ?? 0),
    width: Number(rect.width ?? 0),
    height: Number(rect.height ?? 0)
  };
}

function markRasterOccupied(occupied, context, image, rect, threshold) {
  const {bounds, subWidth, subHeight, subGridSize} = context;
  if (!(rect.width > 0 && rect.height > 0)) return;
  const range = subcellRange(bounds, subWidth, subHeight, subGridSize, {
    minX: rect.x,
    minY: rect.y,
    maxX: rect.x + rect.width,
    maxY: rect.y + rect.height
  });
  if (!range) return;
  for (let sy = range.minY; sy < range.maxY; sy += 1) {
    for (let sx = range.minX; sx < range.maxX; sx += 1) {
      const index = (sy * subWidth) + sx;
      if (occupied[index]) continue;
      const x0 = bounds.origin.x + (sx * subGridSize);
      const y0 = bounds.origin.y + (sy * subGridSize);
      const u0 = (x0 - rect.x) / rect.width;
      const v0 = (y0 - rect.y) / rect.height;
      const u1 = (x0 + subGridSize - rect.x) / rect.width;
      const v1 = (y0 + subGridSize - rect.y) / rect.height;
      if (u1 <= 0 || v1 <= 0 || u0 >= 1 || v0 >= 1) continue;
      if (sampleImageRegionOccupancy(image, u0, v0, u1, v1) >= threshold) occupied[index] = 1;
    }
  }
}

/** Max occupancy inside a subcell so grout, shadows, and KTX2 speckles cannot flip the whole cell. */
function sampleImageRegionOccupancy(image, u0, v0, u1, v1) {
  const left = Math.min(u0, u1);
  const right = Math.max(u0, u1);
  const top = Math.min(v0, v1);
  const bottom = Math.max(v0, v1);
  let max = 0;
  for (let j = 0; j < 3; j += 1) {
    const v = top + (((j + 0.5) / 3) * (bottom - top));
    for (let i = 0; i < 3; i += 1) {
      const u = left + (((i + 0.5) / 3) * (right - left));
      max = Math.max(max, sampleImageOccupancy(image, u, v));
      if (max >= 1) return max;
    }
  }
  return max;
}

function sampleImageOccupancy(image, u, v) {
  if (u < 0 || u > 1 || v < 0 || v > 1) return 0;
  const x = Math.min(image.width - 1, Math.max(0, Math.floor(u * image.width)));
  const y = Math.min(image.height - 1, Math.max(0, Math.floor(v * image.height)));
  const index = ((y * image.width) + x) * 4;
  return tilePixelOccupancy(
    image.data[index],
    image.data[index + 1],
    image.data[index + 2],
    image.data[index + 3] / 255,
    {inkedBlack: false}
  );
}

async function rasterizeTextureWithSprite(texture) {
  const Sprite = globalThis.PIXI?.Sprite;
  if (typeof Sprite !== "function" || !texture) return null;
  const sprite = new Sprite(texture);
  sprite.anchor?.set?.(0, 0);
  try {
    return await extractTexturePixels(sprite, {preferCanvas: true});
  } catch (_error) {
    return null;
  } finally {
    sprite.destroy?.({children: true, texture: false, textureSource: false});
  }
}

async function markArtworkOccupied(occupied, tile, context) {
  const {bounds, subWidth, subHeight, subGridSize, cache, sample, sizeOf, useDefaultSample, signal} = context;
  throwIfAborted(signal);
  const textureSize = await sizeOf(tile, cache);
  if (!textureSize || !(textureSize.width > 0 && textureSize.height > 0)) {
    if (tile?.occupancyFallback === "empty") return;
    const fallback = getTileTextureTransform(tile, {
      width: Number(tile?._source?.width ?? tile?.width ?? 0) || bounds.gridSize,
      height: Number(tile?._source?.height ?? tile?.height ?? 0) || bounds.gridSize
    });
    if (fallback) markAabbOccupied(occupied, bounds, subWidth, subHeight, subGridSize, tileTextureAabb(fallback));
    return;
  }

  const transform = getTileTextureTransform(tile, textureSize);
  if (!transform) return;
  const aabb = tileTextureAabb(transform);
  const range = subcellRange(bounds, subWidth, subHeight, subGridSize, aabb);
  if (!range) return;
  const threshold = Number(
    tile?._source?.texture?.alphaThreshold ?? tile?.texture?.alphaThreshold ?? 0.75
  );
  if (useDefaultSample) await ensureAlphaImage(tile, cache);

  for (let sy = range.minY; sy < range.maxY; sy += 1) {
    throwIfAborted(signal);
    for (let sx = range.minX; sx < range.maxX; sx += 1) {
      const index = (sy * subWidth) + sx;
      if (occupied[index]) continue;
      const uv = worldPointToTileUv(
        transform,
        bounds.origin.x + ((sx + 0.5) * subGridSize),
        bounds.origin.y + ((sy + 0.5) * subGridSize)
      );
      if (!uv) continue;
      const value = sample(tile, uv.u, uv.v, cache);
      const alpha = typeof value?.then === "function" ? await value : Number(value);
      if (alpha >= threshold) occupied[index] = 1;
    }
    if ((sy - range.minY) % YIELD_EVERY_ROWS === YIELD_EVERY_ROWS - 1) {
      await yieldToEventLoop();
      throwIfAborted(signal);
    }
  }
}

function tileTextureAabb(transform) {
  const corners = [
    [0, 0],
    [transform.textureWidth, 0],
    [transform.textureWidth, transform.textureHeight],
    [0, transform.textureHeight]
  ];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [tx, ty] of corners) {
    const localX = (tx - transform.anchorX) * transform.scaleX;
    const localY = (ty - transform.anchorY) * transform.scaleY;
    const x = transform.originX + (transform.cos * localX) - (transform.sin * localY);
    const y = transform.originY + (transform.sin * localX) + (transform.cos * localY);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return {minX, minY, maxX, maxY};
}

function subcellRange(bounds, subWidth, subHeight, subGridSize, aabb) {
  const minX = Math.max(0, Math.floor((aabb.minX - bounds.origin.x) / subGridSize));
  const minY = Math.max(0, Math.floor((aabb.minY - bounds.origin.y) / subGridSize));
  const maxX = Math.min(subWidth, Math.ceil((aabb.maxX - bounds.origin.x) / subGridSize));
  const maxY = Math.min(subHeight, Math.ceil((aabb.maxY - bounds.origin.y) / subGridSize));
  if (maxX <= minX || maxY <= minY) return null;
  return {minX, minY, maxX, maxY};
}

function markAabbOccupied(occupied, bounds, subWidth, subHeight, subGridSize, aabb) {
  const range = subcellRange(bounds, subWidth, subHeight, subGridSize, aabb);
  if (!range) return;
  for (let sy = range.minY; sy < range.maxY; sy += 1) {
    for (let sx = range.minX; sx < range.maxX; sx += 1) occupied[(sy * subWidth) + sx] = 1;
  }
}

function getSceneTiles(scene) {
  return scene?.tiles?.contents ?? Array.from(scene?.tiles?.values?.() ?? scene?.tiles ?? []);
}

function tileSrc(tile) {
  const src = tile?._source?.texture?.src ?? tile?.texture?.src;
  return typeof src === "string" && src.trim() ? src.trim() : "";
}

function occupancyTileFromCanvasBackground(scene, level, src, threshold) {
  const view = globalThis.canvas;
  if (!view || view.scene !== scene) return null;
  const viewedId = view.level?.id ?? view.level?._id;
  const levelId = level?.id ?? level?._id;
  if (levelId && viewedId && String(viewedId) !== String(levelId)) return null;
  const mesh = view.primary?.background;
  if (!mesh || mesh.destroyed === true) return null;
  const width = Number(mesh.width ?? mesh.resized?.width ?? 0);
  const height = Number(mesh.height ?? mesh.resized?.height ?? 0);
  if (!(width > 0 && height > 0)) return null;
  return {
    x: Number(mesh.position?.x ?? 0),
    y: Number(mesh.position?.y ?? 0),
    width,
    height,
    rotation: Number(mesh.angle ?? 0),
    occupancyFallback: "empty",
    texture: {
      src,
      width: Number(mesh.texture?.width ?? 0) || undefined,
      height: Number(mesh.texture?.height ?? 0) || undefined,
      fit: "fill",
      scaleX: 1,
      scaleY: 1,
      anchorX: Number(mesh.anchor?.x ?? 0.5),
      anchorY: Number(mesh.anchor?.y ?? 0.5),
      offsetX: 0,
      offsetY: 0,
      alphaThreshold: threshold
    }
  };
}

function artworkSrc(texture) {
  if (typeof texture === "string" && texture.trim()) return texture.trim();
  const src = texture?.src ?? texture?._source?.src;
  return typeof src === "string" && src.trim() ? src.trim() : "";
}

function tileIncludesLevel(tile, levelId, level) {
  if (typeof tile?.includedInLevel === "function") {
    const query = level ?? (levelId ? {id: levelId, _id: levelId} : null);
    if (!query) return true;
    return tile.includedInLevel(query) === true;
  }
  const selected = normalizeLevelIds(tile?.levels ?? tile?._source?.levels);
  if (!selected.length) return true;
  if (!levelId) return true;
  return selected.includes(String(levelId));
}

function normalizeLevelIds(levels) {
  if (!levels) return [];
  try {
    return Array.from(levels)
      .map(entry => entry?.id ?? entry?._id ?? entry)
      .filter(value => value != null && value !== "")
      .map(String);
  } catch (_error) {
    return [];
  }
}

function resolveSceneLevelId(scene, explicit) {
  if (typeof explicit === "string" && explicit.trim()) return explicit.trim();
  if (typeof scene?.initialLevel === "string" && scene.initialLevel.trim()) return scene.initialLevel.trim();
  const viewed = getViewedLevelId();
  if (typeof viewed === "string" && viewed.trim()) return viewed.trim();
  const levels = scene?.levels;
  const first = levels?.contents?.[0]
    ?? (typeof levels?.values === "function" ? [...levels.values()][0] : null)
    ?? (Array.isArray(levels) ? levels[0] : null);
  const id = first?.id ?? first?._id;
  if (typeof id === "string" && id.trim()) return id.trim();
  throw new TypeError("levelId must be a non-empty string.");
}

async function defaultGetTextureSize(tile, cache) {
  const explicitWidth = Number(tile?._source?.texture?.width ?? tile?.texture?.width);
  const explicitHeight = Number(tile?._source?.texture?.height ?? tile?.texture?.height);
  if (explicitWidth > 0 && explicitHeight > 0) return {width: explicitWidth, height: explicitHeight};
  const src = tileSrc(tile);
  if (!src) return null;
  const image = await ensureAlphaImage(tile, cache);
  return image ? {width: image.width, height: image.height} : null;
}

async function ensureAlphaImage(tile, cache) {
  const src = tileSrc(tile);
  if (!src) return null;
  if (cache.get(src) === undefined) cache.set(src, await loadAlphaImage(src));
  return cache.get(src);
}

function sampleCachedAlpha(tile, u, v, cache) {
  const src = tileSrc(tile);
  if (!src) return occupancyFallbackValue(tile);
  const image = cache.get(src);
  if (!image) return occupancyFallbackValue(tile);
  const x = Math.min(image.width - 1, Math.max(0, Math.floor(u * image.width)));
  const y = Math.min(image.height - 1, Math.max(0, Math.floor(v * image.height)));
  const index = ((y * image.width) + x) * 4;
  return tilePixelOccupancy(
    image.data[index],
    image.data[index + 1],
    image.data[index + 2],
    image.data[index + 3] / 255,
    {inkedBlack: tile?.occupancyFallback !== "empty"}
  );
}

function occupancyFallbackValue(tile) {
  return tile?.occupancyFallback === "empty" ? 0 : 1;
}

async function loadAlphaImage(src) {
  const fromCanvas = await extractCanvasBackgroundPixels(src);
  if (fromCanvas) return fromCanvas;
  const fromTexture = await rasterizeLoadedTexture(src);
  if (fromTexture) return fromTexture;
  return fetchRasterizedImage(src);
}

async function rasterizeLoadedTexture(src) {
  try {
    if (typeof foundry?.canvas?.loadTexture !== "function") return null;
    const texture = await foundry.canvas.loadTexture(src);
    return rasterizeImage(drawableTextureSource(texture))
      ?? await rasterizeTextureWithSprite(texture)
      ?? await extractTexturePixels(texture);
  } catch (_error) {
    return null;
  }
}

async function fetchRasterizedImage(src) {
  try {
    if (typeof fetch !== "function") return null;
    const response = await fetch(mediaUrl(src));
    if (!response.ok) return null;
    const blob = await response.blob();
    const bitmap = typeof createImageBitmap === "function"
      ? await createImageBitmap(blob)
      : await blobToImage(blob);
    return rasterizeImage(bitmap);
  } catch (_error) {
    return null;
  }
}

async function extractCanvasBackgroundPixels(src) {
  const mesh = globalThis.canvas?.primary?.background;
  if (!mesh) return null;
  const texture = mesh.texture;
  const textureSrc = artworkSrc(texture)
    || artworkSrc(texture?.baseTexture?.resource)
    || artworkSrc(texture?.source?.resource);
  if (textureSrc && !sameMediaPath(textureSrc, src)) return null;
  return await extractTexturePixels(mesh) ?? await extractTexturePixels(texture);
}

async function extractTexturePixels(target, {preferCanvas = false} = {}) {
  if (!target) return null;
  try {
    const renderer = globalThis.canvas?.app?.renderer;
    const extract = renderer?.extract;
    if (!extract) return null;
    let extracted = callExtract(extract, target, preferCanvas);
    if (extracted && typeof extracted.then === "function") extracted = await extracted;
    if (!extracted) return null;
    return imageFromExtracted(extracted, target);
  } catch (_error) {
    return null;
  }
}

function imageFromExtracted(extracted, target) {
  if (typeof extracted.getContext === "function") {
    const width = Number(extracted.width);
    const height = Number(extracted.height);
    if (width > 0 && height > 0) {
      try {
        const data = extracted.getContext("2d", {willReadFrequently: true})?.getImageData?.(0, 0, width, height)?.data;
        if (data && data.length >= width * height * 4) return {width, height, data};
      } catch (_error) {}
    }
  }
  if (isDrawableImage(extracted)) return rasterizeImage(extracted);
  const data = extracted.pixels ?? extracted.data ?? extracted;
  const width = Number(
    extracted.width ?? target.width ?? target.orig?.width ?? target.texture?.width ?? 0
  );
  const height = Number(
    extracted.height ?? target.height ?? target.orig?.height ?? target.texture?.height ?? 0
  );
  if (!data || !(width > 0 && height > 0) || data.length < width * height * 4) return null;
  return {width, height, data};
}

function callExtract(extract, target, preferCanvas = false) {
  const attempts = [];
  const addCanvas = () => {
    if (typeof extract.canvas !== "function") return;
    attempts.push(() => extract.canvas({target}));
    attempts.push(() => extract.canvas(target));
  };
  const addPixels = () => {
    if (typeof extract.pixels !== "function") return;
    attempts.push(() => extract.pixels({target}));
    attempts.push(() => extract.pixels(target));
  };
  if (preferCanvas) {
    addCanvas();
    addPixels();
  } else {
    addPixels();
    addCanvas();
  }
  for (const attempt of attempts) {
    try {
      const extracted = attempt();
      if (extracted) return extracted;
    } catch (_error) {
      // PIXI 7 and 8 disagree on whether extract takes a target or an options object.
    }
  }
  return null;
}

function sameMediaPath(left, right) {
  const normalize = value => String(value)
    .replace(/\\/g, "/")
    .replace(/[?#].*$/, "")
    .replace(/^\/+/, "")
    .replace(/^(?:[^/]+\/)*(modules\/)/, "$1");
  return normalize(left) === normalize(right);
}

function mediaUrl(src) {
  if (typeof foundry?.utils?.getRoute === "function") return foundry.utils.getRoute(src);
  return src;
}

function drawableTextureSource(texture) {
  const candidates = [
    texture?.baseTexture?.resource?.source,
    texture?.source?.resource?.source,
    texture?.source?.resource,
    texture?.baseTexture?.resource,
    texture?.source?.source,
    texture?.source
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
  return typeof image.tagName === "string" && Number(image.naturalWidth ?? image.width) > 0;
}

function rasterizeImage(image) {
  try {
    if (!image) return null;
    const width = Number(image.naturalWidth ?? image.width);
    const height = Number(image.naturalHeight ?? image.height);
    if (!(width > 0 && height > 0)) return null;
    const canvasEl = typeof globalThis.document?.createElement === "function"
      ? globalThis.document.createElement("canvas")
      : (typeof globalThis.OffscreenCanvas === "function" ? new globalThis.OffscreenCanvas(width, height) : null);
    if (!canvasEl?.getContext) return null;
    canvasEl.width = width;
    canvasEl.height = height;
    const context = canvasEl.getContext("2d", {willReadFrequently: true});
    if (!context) return null;
    context.drawImage(image, 0, 0);
    return {width, height, data: context.getImageData(0, 0, width, height).data};
  } catch (_error) {
    return null;
  }
}

function blobToImage(blob) {
  return new Promise((resolve, reject) => {
    if (typeof globalThis.Image !== "function") {
      reject(new Error("Image is not available."));
      return;
    }
    const image = new globalThis.Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Failed to decode occupancy image."));
    image.src = URL.createObjectURL(blob);
  });
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const error = new Error("The occupancy scan was cancelled.");
  error.name = "AbortError";
  throw error;
}

function yieldToEventLoop() {
  return new Promise(resolve => {
    if (typeof globalThis.requestAnimationFrame === "function") {
      globalThis.requestAnimationFrame(() => resolve());
      return;
    }
    setTimeout(resolve, 0);
  });
}

function finiteNumber(value, field) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError(`${field} must be finite.`);
  return value;
}
