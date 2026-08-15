import {MODULE_ID, getBreakableWallData} from "./wall-config.js";
import {calculateRubbleGeometry} from "./wall-destruction.js";
import {
  FEATURES,
  FEATURE_SETTING_CHANGED_HOOK,
  isFeatureEnabled
} from "../settings.js";

const artwork = new Map();
const SPILL_RADIUS_RATIO = 0.18;
const MIN_SPILL_RADIUS = 12;
const MAX_SPILL_RADIUS = 36;
const SPILL_BLUR_QUALITY = 3;
const SPILL_BLUR_KERNEL_SIZE = 9;
const SPILL_OPACITY_GAIN = 1.3;
const SPILL_FADE_EXPONENT = 0.65;
const SPILL_MAX_ALPHA = 0.8;
const SPILL_EDGE_BRIGHTNESS = 0.78;
const SPILL_OUTER_BRIGHTNESS = 0.25;
const SUPPORT_MASK_VERTEX_SHADER = `
attribute vec2 aVertexPosition;
attribute vec2 aTextureCoord;

uniform mat3 projectionMatrix;
uniform mat3 otherMatrix;

varying vec2 vMaskCoord;
varying vec2 vTextureCoord;

void main(void) {
  gl_Position = vec4((projectionMatrix * vec3(aVertexPosition, 1.0)).xy, 0.0, 1.0);
  vTextureCoord = aTextureCoord;
  vMaskCoord = (otherMatrix * vec3(aTextureCoord, 1.0)).xy;
}`;
const SUPPORT_MASK_FRAGMENT_SHADER = `
varying vec2 vMaskCoord;
varying vec2 vTextureCoord;

uniform sampler2D uSampler;
uniform sampler2D mask;
uniform sampler2D spillMask;
uniform float alpha;
uniform vec2 supportTexelSize;
uniform float spillOpacityGain;
uniform float spillFadeExponent;
uniform float spillMaxAlpha;
uniform float spillEdgeBrightness;
uniform float spillOuterBrightness;
uniform vec4 maskClamp;

void main(void) {
  float clip = step(3.5,
    step(maskClamp.x, vMaskCoord.x)
    + step(maskClamp.y, vMaskCoord.y)
    + step(vMaskCoord.x, maskClamp.z)
    + step(vMaskCoord.y, maskClamp.w));
  vec4 color = texture2D(uSampler, vTextureCoord);
  float supportAlpha = texture2D(mask, vMaskCoord).a;
  float spillAlpha = texture2D(spillMask, vMaskCoord).a;

  float supportLeft = texture2D(mask, vMaskCoord - vec2(supportTexelSize.x, 0.0)).a;
  float supportRight = texture2D(mask, vMaskCoord + vec2(supportTexelSize.x, 0.0)).a;
  float supportUp = texture2D(mask, vMaskCoord - vec2(0.0, supportTexelSize.y)).a;
  float supportDown = texture2D(mask, vMaskCoord + vec2(0.0, supportTexelSize.y)).a;
  float localSupportMin = min(min(supportLeft, supportRight), min(supportUp, supportDown));
  float localSupportMax = max(max(supportLeft, supportRight), max(supportUp, supportDown));
  float edgeTransition = smoothstep(0.01, 0.15, localSupportMax - localSupportMin);
  float unsupported = 1.0 - smoothstep(0.0, 0.05, supportAlpha);
  float featherInfluence = max(unsupported, edgeTransition);
  float featherAlpha = min(
    pow(spillAlpha, spillFadeExponent) * spillOpacityGain,
    spillMaxAlpha
  ) * featherInfluence;
  float finalSupportAlpha = max(supportAlpha, featherAlpha);
  float fringe = clamp(
    (finalSupportAlpha - supportAlpha) / max(finalSupportAlpha, 0.0001),
    0.0,
    1.0
  );
  float fadeProgress = 1.0 - smoothstep(0.0, 0.5, spillAlpha);
  float spillBrightness = mix(spillEdgeBrightness, spillOuterBrightness, fadeProgress);
  color.rgb *= mix(1.0, spillBrightness, fringe);

  gl_FragColor = color * finalSupportAlpha * alpha * clip;
}`;
let refreshId = 0;
let refreshQueued = false;
let supportRefreshQueued = false;

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
  Hooks.on("createTile", refreshForTileChange);
  Hooks.on("updateTile", refreshForTileChange);
  Hooks.on("deleteTile", refreshForTileChange);
  Hooks.on("drawTile", queueSupportMaskRefresh);
  Hooks.on("refreshTile", queueSupportMaskRefresh);
  Hooks.on("destroyTile", queueSupportMaskRefresh);
  Hooks.on(FEATURE_SETTING_CHANGED_HOOK, handleFeatureSettingChange);
}

/** Coalesce bulk Wall changes into one artwork redraw. */
export function queueDestroyedWallArtRefresh() {
  if (!isFeatureEnabled(FEATURES.breakableWalls)) {
    disableDestroyedWallArt();
    return;
  }
  if (refreshQueued) return;
  refreshQueued = true;
  queueMicrotask(() => {
    refreshQueued = false;
    void refreshArtwork();
  });
}

function handleCanvasReady() {
  if (!isFeatureEnabled(FEATURES.breakableWalls)) {
    disableDestroyedWallArt();
    return;
  }
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

/** @param {TileDocument} tile */
function refreshForTileChange(tile) {
  if (tile?.parent === canvas.scene) queueSupportMaskRefresh();
}

/** Draw destroyed-state artwork for every eligible Wall in the viewed Scene and level. */
async function refreshArtwork() {
  const currentRefresh = ++refreshId;
  if (!isFeatureEnabled(FEATURES.breakableWalls) || !canvas.ready || !canvas.primary || !canvas.walls) {
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

  if (currentRefresh !== refreshId || !isFeatureEnabled(FEATURES.breakableWalls)
    || !canvas.ready || !canvas.primary) {
    for (const entry of meshes) destroyMesh(entry?.mesh);
    return;
  }

  destroyAllArtwork();
  let supportSources;
  try {
    supportSources = createSupportSources();
    for (const entry of meshes) {
      if (!entry) continue;
      try {
        attachSupportMask(entry, supportSources);
        canvas.primary.addChild(entry.mesh);
        artwork.set(entry.wallId, entry);
      } catch (error) {
        destroyArtworkEntry(entry);
        console.error(`${MODULE_ID} | Failed to mask destroyed-wall artwork for ${entry.wallId}`, error);
      }
    }
  } catch (error) {
    for (const entry of meshes) {
      if (entry && !artwork.has(entry.wallId)) destroyArtworkEntry(entry);
    }
    console.error(`${MODULE_ID} | Failed to compose destroyed-wall support artwork`, error);
  } finally {
    destroySupportSources(supportSources);
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
  return {wallId: wall.id, mesh, geometry, support: null};
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

  const entry = artwork.get(source.id);
  if (!entry) return;

  const data = getBreakableWallData(source.document);
  if (!data.destroyed) return;

  try {
    const geometry = calculateRubbleGeometry(wall.document?.c ?? source.document?.c);
    const scaleY = data.destruction?.kind === "single" && data.destruction.side === "negative" ? -1 : 1;
    entry.geometry = geometry;
    applyMeshGeometry(entry.mesh, geometry, scaleY);
    applySupportSpriteGeometry(entry.support?.sprite, geometry);
    queueSupportMaskRefresh();
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

/**
 * Create lightweight sprite copies of artwork which can physically support rubble on the viewed Level.
 * The foreground and artwork belonging exclusively to other Levels are intentionally excluded.
 *
 * @returns {PIXI.Container}
 */
function createSupportSources() {
  const container = new PIXI.Container();
  container.eventMode = "none";
  try {
    const background = canvas.primary?.background;
    if (isUsableSupportMesh(background)) {
      const alpha = Number(background.alpha ?? 1);
      if (alpha > 0) container.addChild(cloneSupportSprite(background, Math.min(alpha, 1)));
    }

    for (const tile of canvas.tiles?.placeables ?? []) {
      const document = tile?.document;
      const mesh = tile?.mesh;
      if (!document || tile.destroyed || document.hidden || !isUsableSupportMesh(mesh)) continue;
      if (!isDocumentOnViewedLevel(document)) continue;

      const alpha = Number(document.alpha ?? mesh.unoccludedAlpha ?? mesh.alpha ?? 1);
      if (!(alpha > 0)) continue;
      container.addChild(cloneSupportSprite(mesh, Math.min(alpha, 1)));
    }
    return container;
  } catch (error) {
    destroySupportSources(container);
    throw error;
  }
}

/** @param {foundry.canvas.primary.PrimarySpriteMesh|PIXI.Sprite|null|undefined} mesh */
function isUsableSupportMesh(mesh) {
  return Boolean(mesh && !mesh.destroyed && mesh.visible !== false && mesh.renderable !== false
    && mesh.texture?.valid && mesh.texture !== PIXI.Texture.EMPTY);
}

/** @param {TileDocument} document */
function isDocumentOnViewedLevel(document) {
  const level = canvas.level;
  if (!level) return false;
  if (typeof document.includedInLevel === "function") return document.includedInLevel(level);

  const levels = normalizeLevelIds(document.levels);
  if (!levels.length) return true;
  const levelId = level.id ?? level._id;
  return levelId != null && levels.includes(String(levelId));
}

/**
 * Copy only texture geometry and alpha. Color, occlusion, filters, and other display effects do not affect support.
 *
 * @param {foundry.canvas.primary.PrimarySpriteMesh|PIXI.Sprite} source
 * @param {number} alpha
 */
function cloneSupportSprite(source, alpha) {
  const sprite = new PIXI.Sprite(source.texture);
  copyPoint(sprite.anchor, source.anchor);
  copyPoint(sprite.position, source.position);
  copyPoint(sprite.scale, source.scale);
  copyPoint(sprite.skew, source.skew);
  copyPoint(sprite.pivot, source.pivot);
  sprite.rotation = Number(source.rotation ?? 0);
  sprite.alpha = alpha;
  sprite.eventMode = "none";
  return sprite;
}

function copyPoint(target, source) {
  if (!target || !source) return;
  if (typeof target.copyFrom === "function") target.copyFrom(source);
  else target.set?.(Number(source.x ?? 0), Number(source.y ?? 0));
}

/**
 * Render the support sources into a wall-local alpha texture and attach it to the rubble mesh.
 *
 * @param {{wallId:string, mesh:foundry.canvas.primary.PrimarySpriteMesh,
 *   geometry:ReturnType<calculateRubbleGeometry>, support:object|null}} entry
 * @param {PIXI.Container} supportSources
 */
function attachSupportMask(entry, supportSources) {
  const support = createSupportMask(entry.wallId, entry.geometry, supportSources);
  canvas.primary.addChild(support.sprite);
  entry.mesh.filters = [support.filter];
  entry.support = support;
}

function createSupportMask(wallId, geometry, supportSources) {
  const renderer = canvas.app?.renderer;
  if (!renderer || typeof renderer.render !== "function") throw new Error("The Canvas renderer is unavailable.");

  const resolution = getSupportMaskResolution(renderer, geometry.width, geometry.height);
  const texture = createSupportRenderTexture(geometry, resolution);
  const sprite = new PIXI.Sprite(texture);
  sprite.name = `${MODULE_ID}.destroyedWallMask.${wallId}`;
  sprite.anchor.set(0.5);
  sprite.eventMode = "none";
  sprite.elevation = Number(canvas.level?.elevation?.base ?? 0);
  sprite.sortLayer = canvas.primary.constructor.SORT_LAYERS.SCENE;
  sprite.sort = Number.MAX_SAFE_INTEGER;
  sprite.zIndex = 0;
  applySupportSpriteGeometry(sprite, geometry);

  let filter;
  let spillTexture;
  try {
    renderer.render(supportSources, {
      renderTexture: texture,
      clear: true,
      transform: createSupportRenderTransform(geometry)
    });
    const spillRadius = getSpillRadius(geometry.width);
    spillTexture = createSpillTexture(renderer, texture, geometry, resolution, spillRadius);
    filter = new PIXI.SpriteMaskFilter(SUPPORT_MASK_VERTEX_SHADER, SUPPORT_MASK_FRAGMENT_SHADER, {
      spillMask: spillTexture,
      supportTexelSize: new Float32Array([
        1 / Math.max(1, geometry.width * resolution),
        1 / Math.max(1, geometry.height * resolution)
      ]),
      spillOpacityGain: SPILL_OPACITY_GAIN,
      spillFadeExponent: SPILL_FADE_EXPONENT,
      spillMaxAlpha: SPILL_MAX_ALPHA,
      spillEdgeBrightness: SPILL_EDGE_BRIGHTNESS,
      spillOuterBrightness: SPILL_OUTER_BRIGHTNESS
    });
    filter.maskSprite = sprite;
    return {filter, sprite, spillTexture, spillRadius};
  } catch (error) {
    filter?.destroy?.();
    destroyRenderTexture(spillTexture);
    sprite.destroy({children: true, texture: true, baseTexture: true});
    throw error;
  }
}

function createSupportRenderTexture(geometry, resolution) {
  return PIXI.RenderTexture.create({
    width: geometry.width,
    height: geometry.height,
    resolution,
    scaleMode: PIXI.SCALE_MODES.LINEAR
  });
}

/** Bake the soft unsupported fringe once, rather than sampling a blur kernel every rendered frame. */
function createSpillTexture(renderer, supportTexture, geometry, resolution, spillRadius) {
  const spillTexture = createSupportRenderTexture(geometry, resolution);
  const source = new PIXI.Sprite(supportTexture);
  const blur = new PIXI.BlurFilter(
    spillRadius / 2,
    SPILL_BLUR_QUALITY,
    resolution,
    SPILL_BLUR_KERNEL_SIZE
  );
  source.filters = [blur];

  try {
    renderer.render(source, {renderTexture: spillTexture, clear: true});
    return spillTexture;
  } catch (error) {
    destroyRenderTexture(spillTexture);
    throw error;
  } finally {
    source.filters = null;
    blur.destroy?.();
    source.destroy({children: true, texture: false, baseTexture: false});
  }
}

function getSpillRadius(wallLength) {
  return Math.min(MAX_SPILL_RADIUS, Math.max(MIN_SPILL_RADIUS, Math.round(wallLength * SPILL_RADIUS_RATIO)));
}

function applySupportSpriteGeometry(sprite, geometry) {
  if (!sprite) return;
  sprite.position.set(geometry.x, geometry.y);
  sprite.angle = geometry.rotation;
  sprite.width = geometry.width;
  sprite.height = geometry.height;
}

/** Map Canvas coordinates into a RenderTexture centered on and aligned with the rubble rectangle. */
function createSupportRenderTransform(geometry) {
  const radians = geometry.rotation * Math.PI / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return new PIXI.Matrix(
    cos,
    -sin,
    sin,
    cos,
    (geometry.width / 2) - (cos * geometry.x) - (sin * geometry.y),
    (geometry.height / 2) + (sin * geometry.x) - (cos * geometry.y)
  );
}

function getSupportMaskResolution(renderer, width, height) {
  const gl = renderer.gl ?? renderer.context?.gl;
  let maximum = Infinity;
  try {
    const value = Number(gl?.getParameter?.(gl.MAX_TEXTURE_SIZE));
    if (Number.isFinite(value) && value > 0) maximum = value;
  } catch (_error) {
    // Use native resolution when the renderer does not expose a readable WebGL limit.
  }
  return Math.min(1, maximum / Math.max(width, height));
}

/** Coalesce support-only changes without reloading every rubble texture. */
function queueSupportMaskRefresh() {
  if (supportRefreshQueued || !artwork.size) return;
  supportRefreshQueued = true;
  const refresh = () => {
    supportRefreshQueued = false;
    refreshSupportMasks();
  };
  if (typeof canvas.app?.ticker?.addOnce === "function") canvas.app.ticker.addOnce(refresh);
  else queueMicrotask(refresh);
}

function refreshSupportMasks() {
  if (!isFeatureEnabled(FEATURES.breakableWalls) || !canvas.ready || !canvas.primary || !artwork.size) return;
  let supportSources;
  try {
    supportSources = createSupportSources();
    for (const [wallId, entry] of artwork) {
      try {
        const support = createSupportMask(wallId, entry.geometry, supportSources);
        canvas.primary.addChild(support.sprite);
        entry.mesh.filters = [support.filter];
        destroySupportMask(entry.support);
        entry.support = support;
      } catch (error) {
        artwork.delete(wallId);
        destroyArtworkEntry(entry);
        console.error(`${MODULE_ID} | Failed to refresh destroyed-wall support mask for ${wallId}`, error);
      }
    }
  } catch (error) {
    destroyAllArtwork();
    console.error(`${MODULE_ID} | Failed to compose destroyed-wall support artwork`, error);
  } finally {
    destroySupportSources(supportSources);
  }
  canvas.primary.sortChildren?.();
  canvas.primary.update?.();
  canvas.primary.renderDirty = true;
}

function destroySupportSources(supportSources) {
  supportSources?.destroy?.({children: true, texture: false, baseTexture: false});
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
  if (!isFeatureEnabled(FEATURES.breakableWalls)) {
    restoreNativeWallVisibility(wall);
    return;
  }
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
  supportRefreshQueued = false;
  destroyAllArtwork();
  if (canvas.primary && canvas.ready) canvas.primary.update?.();
}

function handleFeatureSettingChange(feature, enabled) {
  if (feature !== FEATURES.breakableWalls) return;
  if (enabled) handleCanvasReady();
  else disableDestroyedWallArt();
}

function disableDestroyedWallArt() {
  clearArtwork();
  for (const wall of canvas.walls?.placeables ?? []) restoreNativeWallVisibility(wall);
}

function restoreNativeWallVisibility(wall) {
  queueMicrotask(() => {
    if (wall?.destroyed) return;
    if (typeof wall?.refreshVisibility === "function") wall.refreshVisibility();
    else if (typeof wall?.refresh === "function") wall.refresh();
  });
}

function destroyAllArtwork() {
  for (const entry of artwork.values()) destroyArtworkEntry(entry);
  artwork.clear();
  if (canvas.primary) canvas.primary.renderDirty = true;
}

function destroyArtworkEntry(entry) {
  if (!entry) return;
  if (entry.mesh) entry.mesh.filters = null;
  destroySupportMask(entry.support);
  destroyMesh(entry.mesh ?? entry);
}

function destroySupportMask(support) {
  if (!support) return;
  if (support.filter) {
    support.filter.maskSprite = null;
    support.filter.destroy?.();
  }
  destroyRenderTexture(support.spillTexture);
  if (support.sprite && !support.sprite.destroyed) {
    support.sprite.removeFromParent?.();
    support.sprite.destroy({children: true, texture: true, baseTexture: true});
  }
}

function destroyRenderTexture(texture) {
  if (texture && !texture.destroyed) texture.destroy(true);
}

/** @param {PIXI.DisplayObject|null|undefined} mesh */
function destroyMesh(mesh) {
  if (!mesh || mesh.destroyed) return;
  mesh.removeFromParent();
  mesh.destroy({children: true, texture: false, baseTexture: false});
}
