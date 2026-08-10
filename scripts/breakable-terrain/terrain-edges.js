import {MODULE_ID, getBreakableTerrainData, getTerrainKey} from "./terrain-config.js";
import {
  FEATURES,
  FEATURE_SETTING_CHANGED_HOOK,
  isFeatureEnabled
} from "../settings.js";

const ALPHA_RESOLUTION = 0.25;
const MAX_EDGE_SEGMENTS = 256;
const alphaCache = new Map();
const contourCache = new Map();
const warnedTraces = new WeakSet();
const installedByTile = new Map();
const pendingByTile = new Map();
let pendingSequence = 0;
let refreshQueued = false;

/** Register Foundry v14's runtime edge lifecycle for blocking Tiles. */
export function registerBreakableTerrainEdges() {
  Hooks.on("initializeEdges", initializeSceneTerrainEdges);
  Hooks.on("canvasReady", synchronizeCurrentSceneTerrainEdges);
  Hooks.on("canvasTearDown", clearTerrainEdges);
  Hooks.on("createTile", synchronizeChangedTile);
  Hooks.on("updateTile", synchronizeChangedTile);
  Hooks.on("deleteTile", removeDeletedTile);
  Hooks.on(FEATURE_SETTING_CHANGED_HOOK, handleFeatureSettingChange);
}

/**
 * Load a texture and optionally cache its alpha map before a document transition.
 *
 * @param {string} src
 * @param {{extractAlpha?: boolean}} [options]
 * @returns {Promise<PIXI.Texture>}
 */
export async function prepareTerrainTexture(src, {extractAlpha = true} = {}) {
  let texture;
  try {
    texture = await foundry.canvas.loadTexture(src);
  } catch (cause) {
    throw new Error(localize("Errors.ImageLoad", {src}), {cause});
  }
  if (!texture?.valid || !(texture.width > 0) || !(texture.height > 0)) {
    throw new Error(localize("Errors.ImageLoad", {src}));
  }
  if (extractAlpha) cacheTextureAlpha(src, texture);
  return texture;
}

/**
 * Convert sampled texture alpha into closed pixel-boundary contours.
 *
 * @param {{width:number,height:number,minX:number,minY:number,maxX:number,maxY:number,data:Uint8Array}} alphaData
 * @param {number} threshold Foundry alpha threshold in the range 0..1.
 * @param {{maxSegments?: number}} [options]
 * @returns {{width:number,height:number,contours:Array<Array<{x:number,y:number}>>,truncated:boolean}}
 */
export function traceAlphaContours(alphaData, threshold, {maxSegments = MAX_EDGE_SEGMENTS} = {}) {
  const width = Math.max(0, Math.trunc(alphaData?.width ?? 0));
  const height = Math.max(0, Math.trunc(alphaData?.height ?? 0));
  if (!width || !height) return {width, height, contours: [], truncated: false};

  if (!(threshold > 0)) {
    return {
      width,
      height,
      contours: [[{x: 0, y: 0}, {x: width, y: 0}, {x: width, y: height}, {x: 0, y: height}]],
      truncated: false
    };
  }
  if (threshold > 1) return {width, height, contours: [], truncated: false};

  const cutoff = Math.ceil(threshold * 255);
  const minX = Math.max(0, Math.trunc(alphaData.minX ?? 0));
  const minY = Math.max(0, Math.trunc(alphaData.minY ?? 0));
  const maxX = Math.min(width, Math.trunc(alphaData.maxX ?? width));
  const maxY = Math.min(height, Math.trunc(alphaData.maxY ?? height));
  const dataWidth = Math.max(0, maxX - minX);
  const isSolid = (x, y) => {
    if (x < minX || y < minY || x >= maxX || y >= maxY || !dataWidth) return false;
    return (alphaData.data?.[((y - minY) * dataWidth) + (x - minX)] ?? 0) >= cutoff;
  };

  const outgoing = new Map();
  let edgeCount = 0;
  const add = (ax, ay, bx, by) => {
    const key = pointKey(ax, ay);
    const edges = outgoing.get(key) ?? [];
    edges.push({a: {x: ax, y: ay}, b: {x: bx, y: by}, used: false});
    outgoing.set(key, edges);
    edgeCount += 1;
  };

  for (let y = minY; y < maxY; y += 1) {
    for (let x = minX; x < maxX; x += 1) {
      if (!isSolid(x, y)) continue;
      if (!isSolid(x, y - 1)) add(x, y, x + 1, y);
      if (!isSolid(x + 1, y)) add(x + 1, y, x + 1, y + 1);
      if (!isSolid(x, y + 1)) add(x + 1, y + 1, x, y + 1);
      if (!isSolid(x - 1, y)) add(x, y + 1, x, y);
    }
  }

  if (!edgeCount) return {width, height, contours: [], truncated: false};
  const contours = [];
  for (const edges of outgoing.values()) {
    for (const first of edges) {
      if (first.used) continue;
      const contour = followContour(first, outgoing, edgeCount);
      const cleaned = removeCollinearPoints(contour);
      if (cleaned.length >= 3 && Math.abs(polygonArea(cleaned)) > 0) contours.push(cleaned);
    }
  }

  const bounded = boundContourComplexity(contours, maxSegments);
  return {width, height, contours: bounded.contours, truncated: bounded.truncated};
}

function followContour(first, outgoing, maximumSteps) {
  const points = [];
  const startKey = pointKey(first.a.x, first.a.y);
  let edge = first;
  let steps = 0;
  while (edge && !edge.used && steps <= maximumSteps) {
    edge.used = true;
    points.push(edge.a);
    steps += 1;
    const nextKey = pointKey(edge.b.x, edge.b.y);
    if (nextKey === startKey) break;
    const candidates = (outgoing.get(nextKey) ?? []).filter(candidate => !candidate.used);
    edge = chooseContinuation(edge, candidates);
  }
  return points;
}

function chooseContinuation(previous, candidates) {
  if (!candidates.length) return null;
  if (candidates.length === 1) return candidates[0];
  const priorDirection = edgeDirection(previous);
  const preference = new Map([[1, 0], [0, 1], [3, 2], [2, 3]]); // right, straight, left, reverse
  return candidates.toSorted((a, b) => {
    const turnA = (edgeDirection(a) - priorDirection + 4) % 4;
    const turnB = (edgeDirection(b) - priorDirection + 4) % 4;
    return preference.get(turnA) - preference.get(turnB);
  })[0];
}

function edgeDirection(edge) {
  const dx = edge.b.x - edge.a.x;
  const dy = edge.b.y - edge.a.y;
  if (dx > 0) return 0;
  if (dy > 0) return 1;
  if (dx < 0) return 2;
  return 3;
}

function removeCollinearPoints(points) {
  if (points.length < 3) return points;
  let result = points;
  let changed = true;
  while (changed && result.length >= 3) {
    changed = false;
    const next = [];
    for (let index = 0; index < result.length; index += 1) {
      const a = result[(index - 1 + result.length) % result.length];
      const b = result[index];
      const c = result[(index + 1) % result.length];
      if (((b.x - a.x) * (c.y - b.y)) === ((b.y - a.y) * (c.x - b.x))) {
        changed = true;
        continue;
      }
      next.push(b);
    }
    result = next;
  }
  return result;
}

function boundContourComplexity(contours, maxSegments) {
  let result = contours.map(contour => [...contour]);
  let total = countSegments(result);
  if (total <= maxSegments) return {contours: result, truncated: false};

  let tolerance = 0.5;
  while (total > maxSegments && tolerance <= 64) {
    result = contours.map(contour => simplifyClosedContour(contour, tolerance));
    total = countSegments(result);
    tolerance *= 2;
  }
  if (total <= maxSegments) return {contours: result, truncated: true};

  result.sort((a, b) => Math.abs(polygonArea(b)) - Math.abs(polygonArea(a)));
  const retained = [];
  let retainedSegments = 0;
  for (const contour of result) {
    if (retainedSegments + contour.length > maxSegments) continue;
    retained.push(contour);
    retainedSegments += contour.length;
  }
  return {contours: retained, truncated: true};
}

function simplifyClosedContour(points, tolerance) {
  if (points.length <= 4) return points;
  const split = Math.floor(points.length / 2);
  const first = simplifyOpenPolyline([...points.slice(0, split + 1)], tolerance);
  const second = simplifyOpenPolyline([...points.slice(split), ...points.slice(0, 1)], tolerance);
  const combined = [...first.slice(0, -1), ...second.slice(0, -1)];
  return combined.length >= 3 ? removeCollinearPoints(combined) : points;
}

function simplifyOpenPolyline(points, tolerance) {
  if (points.length <= 2) return points;
  const first = points[0];
  const last = points.at(-1);
  let farthest = -1;
  let maximum = 0;
  for (let index = 1; index < points.length - 1; index += 1) {
    const distance = squaredDistanceToSegment(points[index], first, last);
    if (distance > maximum) {
      maximum = distance;
      farthest = index;
    }
  }
  if (maximum <= tolerance * tolerance || farthest < 0) return [first, last];
  const left = simplifyOpenPolyline(points.slice(0, farthest + 1), tolerance);
  const right = simplifyOpenPolyline(points.slice(farthest), tolerance);
  return [...left.slice(0, -1), ...right];
}

function squaredDistanceToSegment(point, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (!dx && !dy) return ((point.x - a.x) ** 2) + ((point.y - a.y) ** 2);
  const t = Math.max(0, Math.min(1, (((point.x - a.x) * dx) + ((point.y - a.y) * dy)) / ((dx * dx) + (dy * dy))));
  const x = a.x + (t * dx);
  const y = a.y + (t * dy);
  return ((point.x - x) ** 2) + ((point.y - y) ** 2);
}

function polygonArea(points) {
  let area = 0;
  for (let index = 0; index < points.length; index += 1) {
    const a = points[index];
    const b = points[(index + 1) % points.length];
    area += (a.x * b.y) - (b.x * a.y);
  }
  return area / 2;
}

function countSegments(contours) {
  return contours.reduce((total, contour) => total + contour.length, 0);
}

/**
 * Transform sampled alpha contours into Canvas coordinates using Tile texture semantics.
 *
 * @param {{width:number,height:number,contours:Array<Array<{x:number,y:number}>>}} traced
 * @param {TileDocument|object} tile
 * @param {{width:number,height:number}} textureDimensions
 * @returns {Array<Array<{x:number,y:number}>>}
 */
export function transformTerrainContours(traced, tile, textureDimensions) {
  const source = tile?._source ?? tile ?? {};
  const texture = source.texture ?? tile?.texture ?? {};
  const textureWidth = Number(textureDimensions?.width ?? 0);
  const textureHeight = Number(textureDimensions?.height ?? 0);
  const sampleWidth = Number(traced?.width ?? 0);
  const sampleHeight = Number(traced?.height ?? 0);
  if (!(textureWidth > 0 && textureHeight > 0 && sampleWidth > 0 && sampleHeight > 0)) return [];

  const baseWidth = Number(source.width ?? tile?.width ?? 0);
  const baseHeight = Number(source.height ?? tile?.height ?? 0);
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

  const anchorX = Number(texture.anchorX ?? 0.5) * textureWidth;
  const anchorY = Number(texture.anchorY ?? 0.5) * textureHeight;
  const originX = Number(source.x ?? tile?.x ?? 0);
  const originY = Number(source.y ?? tile?.y ?? 0);
  const radians = Number(source.rotation ?? tile?.rotation ?? 0) * Math.PI / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);

  return traced.contours.map(contour => contour.map(point => {
    const localX = (((point.x / sampleWidth) * textureWidth) - anchorX) * scaleX;
    const localY = (((point.y / sampleHeight) * textureHeight) - anchorY) * scaleY;
    return {
      x: originX + (cos * localX) - (sin * localY),
      y: originY + (sin * localX) + (cos * localY)
    };
  }));
}

/**
 * Enclose every opaque area in one convex terrain-wall boundary.
 *
 * A limited wall permits vision through its first boundary and stops vision at its second. Using one convex envelope
 * ensures that disconnected fragments and concavities cannot consume both crossings before the rest of the Tile is
 * visible. Movement continues to use the exact opaque contours instead.
 *
 * @param {Array<Array<{x:number,y:number}>>} contours
 * @returns {Array<Array<{x:number,y:number}>>}
 */
export function createTerrainVisionContours(contours) {
  const unique = new Map();
  for (const point of contours.flat()) unique.set(pointKey(point.x, point.y), point);
  const points = Array.from(unique.values()).sort((a, b) => (a.x - b.x) || (a.y - b.y));
  if (points.length < 3) return [];

  const lower = [];
  for (const point of points) {
    while (lower.length >= 2 && crossProduct(lower.at(-2), lower.at(-1), point) <= 0) lower.pop();
    lower.push(point);
  }

  const upper = [];
  for (let index = points.length - 1; index >= 0; index -= 1) {
    const point = points[index];
    while (upper.length >= 2 && crossProduct(upper.at(-2), upper.at(-1), point) <= 0) upper.pop();
    upper.push(point);
  }

  const hull = [...lower.slice(0, -1), ...upper.slice(0, -1)];
  return hull.length >= 3 ? [hull] : [];
}

function crossProduct(a, b, c) {
  return ((b.x - a.x) * (c.y - a.y)) - ((b.y - a.y) * (c.x - a.x));
}

/** Return the visual center of cached opaque contours, falling back to the native Tile center. */
export function getTerrainMarkerPosition(tile) {
  const record = getCachedTerrainTrace(tile);
  if (record) {
    const contours = transformTerrainContours(record.traced, tile, record.textureDimensions);
    const points = contours.flat();
    if (points.length) {
      const xs = points.map(point => point.x);
      const ys = points.map(point => point.y);
      return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
    }
  }
  const center = tile?.shape?.center ?? tile?.document?.shape?.center;
  if (center) return [center.x, center.y];
  const source = tile?._source ?? tile ?? {};
  return [Number(source.x ?? 0), Number(source.y ?? 0)];
}

function initializeSceneTerrainEdges(scene) {
  if (scene !== canvas.scene) return;
  for (const [key, entry] of installedByTile) {
    if (entry.sceneId === scene.id) installedByTile.delete(key);
  }
  for (const tile of getSceneTiles(scene)) synchronizeTileEdges(tile);
}

function synchronizeCurrentSceneTerrainEdges() {
  if (!canvas.scene) return;
  for (const tile of getSceneTiles(canvas.scene)) synchronizeTileEdges(tile);
}

function synchronizeChangedTile(tile) {
  if (tile?.parent === canvas.scene) synchronizeTileEdges(tile);
}

function removeDeletedTile(tile) {
  cancelPending(tile);
  removeInstalledTerrainEdges(getTerrainKey(tile), {notify: tile?.parent === canvas.scene});
}

function synchronizeTileEdges(tile) {
  const key = getTerrainKey(tile);
  const data = getBreakableTerrainData(tile);
  if (!isFeatureEnabled(FEATURES.breakableTerrain) || tile?.parent !== canvas.scene || !data.blocks) {
    cancelPending(tile);
    removeInstalledTerrainEdges(key, {notify: tile?.parent === canvas.scene});
    return;
  }

  const src = tile?._source?.texture?.src ?? tile?.texture?.src;
  if (!src) {
    cancelPending(tile);
    removeInstalledTerrainEdges(key, {notify: true});
    return;
  }
  const signature = getTerrainSignature(tile, data, src);
  if (installedByTile.get(key)?.signature === signature) return;

  cachePlaceableTexture(tile, src);
  const cached = getCachedTerrainTrace(tile);
  if (cached) {
    installTerrainEdges(tile, data, signature, cached);
    return;
  }

  const pendingId = ++pendingSequence;
  pendingByTile.set(key, pendingId);
  void prepareTerrainTexture(src).then(() => {
    if (pendingByTile.get(key) !== pendingId) return;
    pendingByTile.delete(key);
    if (tile.parent !== canvas.scene) return;
    const currentData = getBreakableTerrainData(tile);
    const currentSrc = tile?._source?.texture?.src ?? tile?.texture?.src;
    if (!currentData.blocks || currentSrc !== src || getTerrainSignature(tile, currentData, src) !== signature) return;
    const record = getCachedTerrainTrace(tile);
    if (record) installTerrainEdges(tile, currentData, signature, record);
  }).catch(error => {
    if (pendingByTile.get(key) === pendingId) pendingByTile.delete(key);
    console.error(`${MODULE_ID} | Failed to prepare blocking terrain texture for ${tile.id}`, error);
  });
}

function installTerrainEdges(tile, data, signature, record) {
  const key = getTerrainKey(tile);
  cancelPending(tile);
  const contours = transformTerrainContours(record.traced, tile, record.textureDimensions);
  const levels = getIncludingLevels(tile);
  const edges = [];
  const Edge = foundry.canvas.geometry.edges.Edge;
  const NONE = CONST.EDGE_SENSE_TYPES.NONE;
  const NORMAL = CONST.EDGE_SENSE_TYPES.NORMAL;
  const LIMITED = CONST.EDGE_SENSE_TYPES.LIMITED;
  const direction = CONST.EDGE_DIRECTIONS.BOTH;

  const addEdges = (edgeContours, kind, restrictions) => edgeContours.forEach((contour, contourIndex) => {
    contour.forEach((a, segmentIndex) => {
      const b = contour[(segmentIndex + 1) % contour.length];
      if (a.x === b.x && a.y === b.y) return;
      edges.push(new Edge(a, b, {
        id: `${MODULE_ID}.terrain.${tile.id}.${kind}.${contourIndex}.${segmentIndex}`,
        object: tile,
        type: "wall",
        direction,
        ...restrictions,
        sound: NONE
      }));
    });
  });

  if (data.blocksMovement) addEdges(contours, "movement", {
    move: NORMAL,
    light: NONE,
    darkness: NONE,
    sight: NONE
  });
  if (data.blocksVision) addEdges(createTerrainVisionContours(contours), "vision", {
    move: NONE,
    light: LIMITED,
    darkness: LIMITED,
    sight: LIMITED
  });

  removeInstalledTerrainEdges(key, {notify: false});
  for (const edge of edges) for (const level of levels) level.edges.set(edge.id, edge);
  installedByTile.set(key, {sceneId: tile.parent.id, signature, levels, edges});
  if (record.traced.truncated && !warnedTraces.has(record.traced)) {
    warnedTraces.add(record.traced);
    console.warn(`${MODULE_ID} | Simplified opaque terrain contours to ${MAX_EDGE_SEGMENTS} segments for Tile ${tile.id}`);
  }
  queueCanvasRestrictionRefresh();
}

function removeInstalledTerrainEdges(key, {notify = false} = {}) {
  const entry = installedByTile.get(key);
  if (!entry) return;
  installedByTile.delete(key);
  for (const edge of entry.edges) for (const level of entry.levels) level.edges.delete(edge.id);
  if (notify) queueCanvasRestrictionRefresh();
}

function clearTerrainEdges() {
  pendingSequence += 1;
  pendingByTile.clear();
  installedByTile.clear();
  alphaCache.clear();
  contourCache.clear();
  refreshQueued = false;
}

function handleFeatureSettingChange(feature, enabled) {
  if (feature !== FEATURES.breakableTerrain) return;
  if (enabled) {
    synchronizeCurrentSceneTerrainEdges();
    return;
  }

  pendingSequence += 1;
  pendingByTile.clear();
  const keys = Array.from(installedByTile.keys());
  for (const key of keys) removeInstalledTerrainEdges(key, {notify: false});
  if (keys.length) queueCanvasRestrictionRefresh();
}

function cancelPending(tile) {
  pendingByTile.delete(getTerrainKey(tile));
}

function cachePlaceableTexture(tile, src) {
  const texture = tile?.object?.mesh?.texture ?? tile?.mesh?.texture;
  const textureSrc = texture?.baseTexture?.resource?.url
    ?? texture?.baseTexture?.resource?.src
    ?? texture?.src;
  if (!texture?.valid || !textureSrc || !sameTextureSource(textureSrc, src)) return;
  cacheTextureAlpha(src, texture);
}

function sameTextureSource(textureSrc, documentSrc) {
  const normalize = source => {
    const value = String(source);
    try {
      return decodeURIComponent(value).replaceAll("\\", "/");
    } catch (_error) {
      return value.replaceAll("\\", "/");
    }
  };
  const left = normalize(textureSrc);
  const right = normalize(documentSrc);
  return left === right || left.endsWith(`/${right.replace(/^\/+/, "")}`);
}

function cacheTextureAlpha(src, texture) {
  const cached = alphaCache.get(src);
  if (cached?.texture === texture) return cached;
  let alphaData;
  try {
    alphaData = foundry.canvas.TextureLoader.getTextureAlphaData(texture, ALPHA_RESOLUTION);
  } catch (cause) {
    throw new Error(localize("Errors.ImageLoad", {src}), {cause});
  }
  if (!alphaData) throw new Error(localize("Errors.ImageLoad", {src}));
  const record = {
    texture,
    alphaData,
    textureDimensions: {width: texture.width, height: texture.height}
  };
  alphaCache.set(src, record);
  for (const key of contourCache.keys()) if (key.startsWith(`${src}\u0000`)) contourCache.delete(key);
  return record;
}

function getCachedTerrainTrace(tile) {
  const src = tile?._source?.texture?.src ?? tile?.texture?.src;
  const alpha = alphaCache.get(src);
  if (!src || !alpha) return null;
  const threshold = Number(tile?._source?.texture?.alphaThreshold ?? tile?.texture?.alphaThreshold ?? 0.75);
  const cacheKey = `${src}\u0000${threshold}`;
  let traced = contourCache.get(cacheKey);
  if (!traced) {
    traced = traceAlphaContours(alpha.alphaData, threshold);
    contourCache.set(cacheKey, traced);
  }
  return {traced, textureDimensions: alpha.textureDimensions};
}

function getIncludingLevels(tile) {
  const scene = tile.parent;
  const selected = normalizeLevelIds(tile.levels ?? tile?._source?.levels);
  if (!selected.length) return scene.levels?.contents ?? Array.from(scene.levels ?? []);
  return selected.map(id => scene.levels?.get?.(id)).filter(Boolean);
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

function getTerrainSignature(tile, data, src) {
  const source = tile?._source ?? tile;
  const texture = source?.texture ?? tile?.texture ?? {};
  return JSON.stringify({
    src,
    threshold: texture.alphaThreshold,
    x: source?.x,
    y: source?.y,
    width: source?.width,
    height: source?.height,
    rotation: source?.rotation,
    anchorX: texture.anchorX,
    anchorY: texture.anchorY,
    fit: texture.fit,
    scaleX: texture.scaleX,
    scaleY: texture.scaleY,
    levels: normalizeLevelIds(tile.levels ?? source?.levels).toSorted(),
    stage: data.stage,
    movement: data.blocksMovement,
    vision: data.blocksVision
  });
}

function getSceneTiles(scene) {
  return scene.tiles?.contents ?? Array.from(scene.tiles?.values?.() ?? scene.tiles ?? []);
}

function queueCanvasRestrictionRefresh() {
  if (refreshQueued || !canvas.ready) return;
  refreshQueued = true;
  queueMicrotask(() => {
    refreshQueued = false;
    if (!canvas.ready || !canvas.scene) return;
    canvas.perception?.update?.({initializeLighting: true, initializeVision: true});
    canvas.tokens?.recalculatePlannedMovementPaths?.();
    canvas.scene.updateRegionShapeConstraints?.(new Set(["light", "darkness", "sight", "move"]));
  });
}

function pointKey(x, y) {
  return `${x},${y}`;
}

function localize(key, data) {
  const path = `THEIKS_TOOLBAG.BreakableTerrain.${key}`;
  return data ? game.i18n.format(path, data) : game.i18n.localize(path);
}
