import {
  MODULE_ID,
  getVisibleLightImage,
  isVisibleLightConfigured
} from "./light-config.js";

const artwork = new Map();
let refreshId = 0;
let refreshQueued = false;

/**
 * Calculate the centered, one-grid geometry for visible-light artwork.
 *
 * @param {{x: number, y: number}} light
 * @param {number} gridSize
 * @returns {{x: number, y: number, width: number, height: number}}
 */
export function calculateLightArtworkGeometry(light, gridSize) {
  const x = Number(light?.x);
  const y = Number(light?.y);
  const size = Number(gridSize);
  if (![x, y, size].every(Number.isFinite) || size <= 0) {
    throw new Error("Visible-light artwork requires finite coordinates and a positive grid size.");
  }
  return {x, y, width: size, height: size};
}

/** Register the visible-light artwork lifecycle hooks. */
export function registerVisibleLightArt() {
  Hooks.on("canvasReady", queueArtworkRefresh);
  Hooks.on("canvasTearDown", clearArtwork);
  Hooks.on("createAmbientLight", refreshForLightChange);
  Hooks.on("updateAmbientLight", refreshForLightChange);
  Hooks.on("deleteAmbientLight", refreshForLightChange);
  Hooks.on("refreshAmbientLight", updateArtworkPosition);
  Hooks.on("updateScene", refreshForSceneChange);
}

/** Coalesce bulk Ambient Light updates into one artwork redraw. */
export function queueArtworkRefresh() {
  if (refreshQueued) return;
  refreshQueued = true;
  queueMicrotask(() => {
    refreshQueued = false;
    void refreshArtwork();
  });
}

/** @param {AmbientLightDocument} light */
function refreshForLightChange(light) {
  if (light.parent === canvas.scene) queueArtworkRefresh();
}

/** @param {Scene} scene */
function refreshForSceneChange(scene) {
  if (scene === canvas.scene) queueArtworkRefresh();
}

/** Draw state artwork for every configured Ambient Light in the viewed Scene. */
async function refreshArtwork() {
  const currentRefresh = ++refreshId;
  if (!canvas.ready || !canvas.primary || !canvas.lighting) {
    clearArtwork();
    return;
  }

  const gridSize = canvas.dimensions?.size;
  if (!Number.isFinite(gridSize) || gridSize <= 0) {
    clearArtwork();
    return;
  }

  const meshes = await Promise.all(canvas.lighting.placeables.map(async light => {
    if (!isVisibleLightConfigured(light.document)) return null;
    const src = getVisibleLightImage(light.document);
    if (!src) return null;

    try {
      const texture = await foundry.canvas.loadTexture(src);
      if (!texture) throw new Error(`The image could not be loaded: ${src}`);
      return createArtworkMesh(light, texture, gridSize);
    } catch (error) {
      console.error(`${MODULE_ID} | Failed to draw visible-light artwork`, error);
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
    artwork.set(entry.lightId, entry.mesh);
  }
  canvas.primary.sortChildren();
  canvas.primary.update();
  canvas.primary.renderDirty = true;
}

/**
 * @param {foundry.canvas.placeables.AmbientLight} light
 * @param {PIXI.Texture} texture
 * @param {number} gridSize
 */
function createArtworkMesh(light, texture, gridSize) {
  const geometry = calculateLightArtworkGeometry(light.document, gridSize);
  const mesh = new foundry.canvas.primary.PrimarySpriteMesh({
    name: `${MODULE_ID}.visibleLight.${light.id}`,
    object: light,
    texture
  });
  const elevation = Number(light.document.elevation ?? 0);
  mesh.elevation = Number.isFinite(elevation) ? elevation : 0;
  mesh.sortLayer = canvas.primary.constructor.SORT_LAYERS.DRAWINGS;
  mesh.sort = Number.MAX_SAFE_INTEGER;
  mesh.zIndex = 0;
  mesh.anchor.set(0.5);
  mesh.position.set(geometry.x, geometry.y);
  mesh.resize(geometry.width, geometry.height, {fit: "fill"});
  mesh.eventMode = "none";
  mesh.name = `${MODULE_ID}.visibleLight.${light.id}`;
  return {lightId: light.id, mesh};
}

/** Keep the artwork attached to the light's drag preview as well as its saved position. */
function updateArtworkPosition(light) {
  const source = light._original ?? light;
  const mesh = artwork.get(source.id);
  if (!mesh) return;

  const position = light.center ?? light.document;
  if (!Number.isFinite(position?.x) || !Number.isFinite(position?.y)) return;
  mesh.position.set(position.x, position.y);
  if (canvas.primary) canvas.primary.renderDirty = true;
}

function clearArtwork() {
  ++refreshId;
  destroyAllMeshes();
  if (canvas.primary && canvas.ready) canvas.primary.update();
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
