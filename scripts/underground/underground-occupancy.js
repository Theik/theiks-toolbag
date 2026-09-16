import {
  createUndergroundSource,
  DEFAULT_SUBDIVISION,
  getViewedLevelId
} from "./underground-data.js";

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
 * Return subcell indexes whose center is not covered by opaque Tile artwork.
 *
 * @param {object} scene
 * @param {{
 *   subdivision?: number,
 *   levelId?: string,
 *   sampleTileAlpha?: Function,
 *   getTextureSize?: Function
 * }} [options]
 * @returns {Promise<number[]>}
 */
export async function collectSceneUndergroundSubcellIndexes(scene, {
  subdivision = DEFAULT_SUBDIVISION,
  levelId,
  sampleTileAlpha = null,
  getTextureSize = null
} = {}) {
  const bounds = getSceneUndergroundBounds(scene);
  const sub = Number(subdivision) > 0 ? Number(subdivision) : DEFAULT_SUBDIVISION;
  const subWidth = bounds.width * sub;
  const subHeight = bounds.height * sub;
  const subGridSize = bounds.gridSize / sub;
  const occupied = new Uint8Array(subWidth * subHeight);
  const cache = new Map();
  const sample = sampleTileAlpha ?? defaultSampleTileAlpha;
  const sizeOf = getTextureSize ?? ((tile) => defaultGetTextureSize(tile, cache));

  for (const tile of getSceneTiles(scene)) {
    if (tile?.hidden === true || tile?._source?.hidden === true) continue;
    if (!tileIncludesLevel(tile, levelId)) continue;
    const src = tileSrc(tile);
    if (!src) continue;

    const textureSize = await sizeOf(tile, cache);
    if (!textureSize || !(textureSize.width > 0 && textureSize.height > 0)) {
      const fallback = getTileTextureTransform(tile, {
        width: Number(tile?._source?.width ?? tile?.width ?? 0) || bounds.gridSize,
        height: Number(tile?._source?.height ?? tile?.height ?? 0) || bounds.gridSize
      });
      markAabbOccupied(occupied, bounds, subWidth, subHeight, subGridSize, tileTextureAabb(fallback));
      continue;
    }

    const transform = getTileTextureTransform(tile, textureSize);
    if (!transform) continue;
    const aabb = tileTextureAabb(transform);
    const range = subcellRange(bounds, subWidth, subHeight, subGridSize, aabb);
    if (!range) continue;
    const threshold = Number(
      tile?._source?.texture?.alphaThreshold ?? tile?.texture?.alphaThreshold ?? 0.75
    );

    for (let sy = range.minY; sy < range.maxY; sy += 1) {
      for (let sx = range.minX; sx < range.maxX; sx += 1) {
        const index = (sy * subWidth) + sx;
        if (occupied[index]) continue;
        const uv = worldPointToTileUv(
          transform,
          bounds.origin.x + ((sx + 0.5) * subGridSize),
          bounds.origin.y + ((sy + 0.5) * subGridSize)
        );
        if (!uv) continue;
        const alpha = await sample(tile, uv.u, uv.v, cache);
        if (alpha >= threshold) occupied[index] = 1;
      }
    }
  }

  const cells = [];
  for (let index = 0; index < occupied.length; index += 1) {
    if (!occupied[index]) cells.push(index);
  }
  return cells;
}

/** Build a Scene underground flag from the current playable grid and Tile occupancy. */
export async function createUndergroundSourceFromScene(scene, options = {}) {
  const bounds = getSceneUndergroundBounds(scene);
  const levelId = resolveSceneLevelId(scene, options.levelId);
  const cells = options.cells ?? await collectSceneUndergroundSubcellIndexes(scene, {
    subdivision: options.subdivision,
    levelId,
    sampleTileAlpha: options.sampleTileAlpha,
    getTextureSize: options.getTextureSize
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
    blocksMovement: options.blocksMovement ?? true,
    blocksVision: options.blocksVision ?? true
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
  const u = ((localX / transform.scaleX) + transform.anchorX) / transform.textureWidth;
  const v = ((localY / transform.scaleY) + transform.anchorY) / transform.textureHeight;
  if (u < 0 || u > 1 || v < 0 || v > 1) return null;
  return {u, v};
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

function tileIncludesLevel(tile, levelId) {
  const selected = normalizeLevelIds(tile?.levels ?? tile?._source?.levels);
  if (!selected.length) return true;
  if (!levelId) return true;
  return selected.includes(String(levelId));
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
  let image = cache.get(src);
  if (image === undefined) {
    image = await loadAlphaImage(src);
    cache.set(src, image);
  }
  return image ? {width: image.width, height: image.height} : null;
}

async function defaultSampleTileAlpha(tile, u, v, cache) {
  const src = tileSrc(tile);
  if (!src) return 1;
  let image = cache.get(src);
  if (image === undefined) {
    image = await loadAlphaImage(src);
    cache.set(src, image);
  }
  if (!image) return 1;
  const x = Math.min(image.width - 1, Math.max(0, Math.floor(u * image.width)));
  const y = Math.min(image.height - 1, Math.max(0, Math.floor(v * image.height)));
  return image.data[(((y * image.width) + x) * 4) + 3] / 255;
}

async function loadAlphaImage(src) {
  try {
    if (typeof foundry?.canvas?.loadTexture === "function") {
      const texture = await foundry.canvas.loadTexture(src);
      const image = textureSource(texture);
      if (image) return rasterizeImage(image);
    }
    if (typeof fetch === "function") {
      const response = await fetch(src);
      if (!response.ok) return null;
      const blob = await response.blob();
      const bitmap = typeof createImageBitmap === "function"
        ? await createImageBitmap(blob)
        : await blobToImage(blob);
      return rasterizeImage(bitmap);
    }
  } catch (_error) {
    return null;
  }
  return null;
}

function textureSource(texture) {
  return texture?.baseTexture?.resource?.source
    ?? texture?.source?.resource?.source
    ?? texture?.source?.resource
    ?? texture?.source
    ?? null;
}

function rasterizeImage(image) {
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

function finiteNumber(value, field) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError(`${field} must be finite.`);
  return value;
}
