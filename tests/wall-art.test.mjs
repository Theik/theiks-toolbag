import assert from "node:assert/strict";

const hookCallbacks = new Map();
globalThis.Hooks = {
  on: (hook, callback) => hookCallbacks.set(hook, callback)
};
let breakableWallsEnabled = true;
globalThis.game = {
  settings: {get: () => breakableWallsEnabled}
};

function point(x = 0, y = x) {
  return {
    x,
    y,
    set(nextX, nextY = nextX) {
      this.x = nextX;
      this.y = nextY;
    },
    copyFrom(other) {
      this.x = other.x;
      this.y = other.y;
    }
  };
}

class FakeTexture {
  constructor(src, {valid = true, width = 100, height = 100} = {}) {
    this.src = src;
    this.valid = valid;
    this.width = width;
    this.height = height;
  }

  destroy(baseTexture) {
    this.destroyed = true;
    this.baseTextureDestroyed = baseTexture;
  }
}

class FakeRenderTexture extends FakeTexture {
  static instances = [];

  static create(options) {
    const texture = new FakeRenderTexture("support-mask", options);
    texture.resolution = options.resolution;
    texture.scaleMode = options.scaleMode;
    FakeRenderTexture.instances.push(texture);
    return texture;
  }
}

class FakeDisplayObject {
  constructor(texture) {
    this.texture = texture;
    this.anchor = point();
    this.position = point();
    this.scale = point(1);
    this.skew = point();
    this.pivot = point();
    this.rotation = 0;
    this.alpha = 1;
    this.visible = true;
    this.renderable = true;
    this.destroyed = false;
  }

  get angle() {
    return this.rotation * 180 / Math.PI;
  }

  set angle(value) {
    this.rotation = value * Math.PI / 180;
  }

  removeFromParent() {
    if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this);
    this.parent = null;
  }

  destroy(options) {
    this.removeFromParent();
    this.destroyed = true;
    this.destroyOptions = options;
    if (options?.texture) this.texture?.destroy?.(options.baseTexture);
  }
}

class FakeSprite extends FakeDisplayObject {
  static instances = [];

  constructor(texture) {
    super(texture);
    this.width = texture?.width ?? 0;
    this.height = texture?.height ?? 0;
    FakeSprite.instances.push(this);
  }
}

class FakeContainer {
  constructor() {
    this.children = [];
  }

  addChild(child) {
    child.parent = this;
    this.children.push(child);
    return child;
  }

  destroy(options) {
    this.destroyed = true;
    if (options?.children) for (const child of [...this.children]) child.destroy?.(options);
    this.children.length = 0;
  }
}

class FakeMatrix {
  constructor(a, b, c, d, tx, ty) {
    Object.assign(this, {a, b, c, d, tx, ty});
  }
}

class FakeSpriteMaskFilter {
  static instances = [];

  constructor(vertex, fragment, uniforms = {}) {
    this.vertex = vertex;
    this.fragment = fragment;
    this.uniforms = uniforms;
    FakeSpriteMaskFilter.instances.push(this);
  }

  set maskSprite(sprite) {
    this._maskSprite = sprite;
    if (sprite) sprite.renderable = false;
  }

  get maskSprite() {
    return this._maskSprite;
  }

  destroy() {
    this.destroyed = true;
  }
}

class FakeBlurFilter {
  static instances = [];

  constructor(strength, quality, resolution, kernelSize) {
    Object.assign(this, {strength, quality, resolution, kernelSize});
    FakeBlurFilter.instances.push(this);
  }

  destroy() {
    this.destroyed = true;
  }
}

class FakeMesh extends FakeDisplayObject {
  static instances = [];

  constructor(options) {
    super(options.texture);
    this.options = options;
    FakeMesh.instances.push(this);
  }

  resize(width, height, options) {
    this.resizeValue = {width, height, options};
    this.width = width;
    this.height = height;
  }
}

class FakePrimary {
  static SORT_LAYERS = {SCENE: 1, DRAWINGS: 7};

  constructor() {
    this.children = [];
    this.renderDirty = false;
  }

  addChild(child) {
    child.parent = this;
    this.children.push(child);
    return child;
  }

  sortChildren() {}
  update() {}
}

const EMPTY_TEXTURE = new FakeTexture("empty", {valid: false, width: 1, height: 1});
globalThis.PIXI = {
  Container: FakeContainer,
  BlurFilter: FakeBlurFilter,
  Matrix: FakeMatrix,
  RenderTexture: FakeRenderTexture,
  Sprite: FakeSprite,
  SpriteMaskFilter: FakeSpriteMaskFilter,
  SCALE_MODES: {LINEAR: "linear"},
  Texture: {EMPTY: EMPTY_TEXTURE}
};

globalThis.foundry = {
  canvas: {
    loadTexture: async src => new FakeTexture(src),
    primary: {PrimarySpriteMesh: FakeMesh}
  }
};

function supportMesh(src, {
  x = 0,
  y = 0,
  anchorX = 0,
  anchorY = 0,
  scaleX = 1,
  scaleY = 1,
  rotation = 0,
  width = 500,
  height = 400,
  visible = true,
  renderable = true
} = {}) {
  const mesh = new FakeDisplayObject(new FakeTexture(src, {width, height}));
  mesh.position.set(x, y);
  mesh.anchor.set(anchorX, anchorY);
  mesh.scale.set(scaleX, scaleY);
  mesh.angle = rotation;
  mesh.visible = visible;
  mesh.renderable = renderable;
  return mesh;
}

const scene = {id: "scene"};
const primary = new FakePrimary();
primary.background = supportMesh("background.webp", {
  x: 500,
  y: 400,
  anchorX: 0.5,
  anchorY: 0.5,
  scaleX: 1.25,
  scaleY: 0.75,
  rotation: 15,
  width: 1000,
  height: 800
});
primary.foreground = supportMesh("foreground.webp", {width: 1000, height: 800});

function createTile({
  id,
  src,
  levels = new Set(["ground"]),
  hidden = false,
  alpha = 1,
  includedInLevel,
  visible = true,
  renderable = true,
  x = 0,
  y = 0,
  rotation = 0
}) {
  const document = {
    id,
    parent: scene,
    levels,
    hidden,
    alpha
  };
  if (includedInLevel !== undefined) document.includedInLevel = () => includedInLevel;
  const mesh = supportMesh(src, {x, y, rotation, visible, renderable, width: 80, height: 60});
  mesh.anchor.set(0.25, 0.75);
  mesh.scale.set(1.5, 0.5);
  return {id, document, mesh, destroyed: false};
}

const supportingTile = createTile({
  id: "supporting",
  src: "supporting-tile.webp",
  alpha: 0.65,
  includedInLevel: true,
  x: 75,
  y: 35,
  rotation: 30
});
const unrestrictedTile = createTile({
  id: "unrestricted",
  src: "unrestricted-tile.webp",
  levels: new Set(),
  alpha: 0.8
});
const hiddenTile = createTile({
  id: "hidden",
  src: "hidden-tile.webp",
  hidden: true,
  includedInLevel: true
});
const otherLevelTile = createTile({
  id: "other-level",
  src: "other-level-tile.webp",
  includedInLevel: false
});
const invisibleTile = createTile({
  id: "invisible",
  src: "invisible-tile.webp",
  visible: false,
  includedInLevel: true
});
const nonRenderedTile = createTile({
  id: "non-rendered",
  src: "non-rendered-tile.webp",
  renderable: false,
  includedInLevel: true
});

const renderCalls = [];
const renderer = {
  gl: {
    MAX_TEXTURE_SIZE: "MAX_TEXTURE_SIZE",
    getParameter: () => 4096
  },
  render(displayObject, options) {
    const kind = displayObject instanceof FakeContainer ? "support" : "spill";
    if (this.failNext === true || this.failNext === kind) {
      this.failNext = false;
      throw new Error(`${kind} render failed`);
    }
    renderCalls.push({
      kind,
      options,
      filter: displayObject.filters?.[0] ?? null,
      sourceTexture: displayObject.texture ?? null,
      sources: (displayObject.children ?? []).map(sprite => ({
        src: sprite.texture.src,
        alpha: sprite.alpha,
        anchor: {x: sprite.anchor.x, y: sprite.anchor.y},
        position: {x: sprite.position.x, y: sprite.position.y},
        scale: {x: sprite.scale.x, y: sprite.scale.y},
        rotation: sprite.angle
      }))
    });
  }
};

const flag = {
  enabled: true,
  images: {both: "both.webp", single: "single.webp"},
  destroyed: true,
  destruction: {kind: "single", side: "negative"},
  restore: {light: 1, sight: 1, sound: 1, move: 1, door: 0, ds: 0}
};
const document = {
  id: "wall-1",
  c: [0, 0, 100, 0],
  levels: new Set(["ground"]),
  parent: scene,
  getFlag: () => flag
};
const wall = {
  id: "wall-1",
  document,
  visible: true,
  controlled: true,
  release() {
    this.controlled = false;
    this.releaseCount = (this.releaseCount ?? 0) + 1;
  },
  refreshVisibility() {
    this.visible = true;
    this.refreshVisibilityCount = (this.refreshVisibilityCount ?? 0) + 1;
  }
};
document.object = wall;

globalThis.canvas = {
  ready: true,
  scene,
  app: {renderer},
  level: {id: "ground", elevation: {base: 13}},
  primary,
  tiles: {
    placeables: [
      supportingTile,
      unrestrictedTile,
      hiddenTile,
      otherLevelTile,
      invisibleTile,
      nonRenderedTile
    ]
  },
  walls: {
    placeables: [wall],
    get: id => id === wall.id ? wall : null
  }
};

const {registerDestroyedWallArt} = await import("../scripts/breakable-walls/wall-art.js");
registerDestroyedWallArt();

for (const hook of [
  "canvasReady",
  "canvasTearDown",
  "createWall",
  "updateWall",
  "deleteWall",
  "updateScene",
  "refreshWall",
  "drawWall",
  "createTile",
  "updateTile",
  "deleteTile",
  "drawTile",
  "refreshTile",
  "destroyTile"
]) assert.equal(typeof hookCallbacks.get(hook), "function", `${hook} hook is registered`);

hookCallbacks.get("canvasReady")();
assert.equal(wall.visible, false, "destroyed core Wall is hidden before its artwork loads");
assert.equal(wall.releaseCount, 1, "a controlled destroyed Wall is released");
await flushAsyncWork();

assert.equal(primary.children.length, 2, "the support mask and rubble mesh are attached");
const mesh = primary.children.find(child => child instanceof FakeMesh);
const firstMaskSprite = primary.children.find(child => child instanceof FakeSprite);
const firstFilter = mesh.filters[0];
const firstMaskTexture = firstMaskSprite.texture;
const firstSpillTexture = firstFilter.uniforms.spillMask;
assert.equal(mesh.options.object, wall);
assert.equal(mesh.options.texture.src, "single.webp");
assert.deepEqual({x: mesh.position.x, y: mesh.position.y}, {x: 50, y: 0});
assert.equal(mesh.angle, 0);
assert.deepEqual(mesh.resizeValue, {
  width: 100,
  height: 200,
  options: {fit: "fill", scaleY: -1}
});
assert.equal(mesh.elevation, 13);
assert.equal(mesh.sortLayer, 7);
assert.equal(mesh.eventMode, "none");
assert.match(firstFilter.fragment, /texture2D\(mask, vMaskCoord\)\.a/,
  "the filter samples support alpha rather than background color");
assert.match(firstFilter.fragment, /texture2D\(spillMask, vMaskCoord\)\.a/,
  "the filter samples the baked spill alpha at the same wall-local coordinate");
assert.doesNotMatch(firstFilter.fragment, /supportAlpha\s*=.*\.r/);
assert.match(firstFilter.fragment, /max\(supportAlpha, featherAlpha\)/,
  "exact support remains authoritative over the feather");
assert.match(firstFilter.fragment, /max\(unsupported, edgeTransition\)/,
  "the feather bridges antialiased support edges instead of leaving an alpha valley");
assert.match(firstFilter.fragment, /color\.rgb \*= mix\(1\.0, spillBrightness, fringe\)/,
  "darkening is restricted to the unsupported fringe");
assert.equal(firstFilter.maskSprite, firstMaskSprite);
assert.equal(firstFilter.uniforms.spillOpacityGain, 1.3);
assert.equal(firstFilter.uniforms.spillFadeExponent, 0.65);
assert.equal(firstFilter.uniforms.spillMaxAlpha, 0.8);
assert.equal(firstFilter.uniforms.spillEdgeBrightness, 0.78);
assert.equal(firstFilter.uniforms.spillOuterBrightness, 0.25);
assertNear(firstFilter.uniforms.supportTexelSize[0], 0.01, 1e-8);
assertNear(firstFilter.uniforms.supportTexelSize[1], 0.005, 1e-8);
assert.equal(firstMaskSprite.renderable, false);
assert.deepEqual({x: firstMaskSprite.position.x, y: firstMaskSprite.position.y}, {x: 50, y: 0});
assert.equal(firstMaskSprite.width, 100);
assert.equal(firstMaskSprite.height, 200);
assert.equal(firstMaskSprite.sortLayer, 1);
assert.equal(firstMaskTexture.resolution, 1);
assert.equal(firstMaskTexture.scaleMode, "linear", "mask edges use linear sampling for antialiased clipping");
assert.equal(firstSpillTexture.resolution, 1);
assert.equal(firstSpillTexture.scaleMode, "linear");

const opaqueAppearance = evaluateSpillAppearance(firstFilter.uniforms, 1, 1);
assert.deepEqual(opaqueAppearance, {alpha: 1, brightness: 1},
  "opaque support leaves rubble color and opacity unchanged");
const partialAppearance = evaluateSpillAppearance(firstFilter.uniforms, 0.65, 1);
assert.deepEqual(partialAppearance, {alpha: 0.65, brightness: 1},
  "partial Tile support keeps its document alpha instead of becoming opaque");
const antialiasedEdgeAppearance = evaluateSpillAppearance(firstFilter.uniforms, 0.05, 0.5, 0.5);
assertNear(antialiasedEdgeAppearance.alpha, 0.8);
assert.ok(antialiasedEdgeAppearance.brightness > 0.78,
  "the exact-mask edge blends into the spill without a transparent seam");
const edgeAppearance = evaluateSpillAppearance(firstFilter.uniforms, 0, 0.5);
assertNear(edgeAppearance.alpha, 0.8);
assertNear(edgeAppearance.brightness, 0.78);
const outerAppearance = evaluateSpillAppearance(firstFilter.uniforms, 0, 0.05);
assert.ok(outerAppearance.alpha < edgeAppearance.alpha, "spill opacity decreases away from support");
assert.ok(outerAppearance.alpha > 0.15, "low spill alpha is lifted so the wider fringe fades more slowly");
assert.ok(outerAppearance.brightness < edgeAppearance.brightness, "spill darkens as it fades");
assert.ok(outerAppearance.brightness < 0.3, "the outer fringe reaches the deeper edge shadow");
assert.equal(evaluateSpillAppearance(firstFilter.uniforms, 0, 0).alpha, 0,
  "pixels beyond the blurred feather remain fully transparent");

assert.equal(getSupportRenderCalls().length, 1);
assert.equal(getSpillRenderCalls().length, 1, "the soft fringe is baked once when the support mask is created");
const firstSupportRender = getSupportRenderCalls()[0];
const firstSpillRender = getSpillRenderCalls()[0];
assert.deepEqual(firstSupportRender.sources.map(source => source.src), [
  "background.webp",
  "supporting-tile.webp",
  "unrestricted-tile.webp"
], "only the viewed background and visible Tiles on the viewed Level support rubble");
assert.ok(!firstSupportRender.sources.some(source => source.src === "foreground.webp"),
  "the Level foreground is never a support source");
assert.equal(firstSupportRender.sources[0].src, "background.webp");
assert.equal(firstSupportRender.sources[0].alpha, 1);
assert.deepEqual(firstSupportRender.sources[0].anchor, {x: 0.5, y: 0.5});
assert.deepEqual(firstSupportRender.sources[0].position, {x: 500, y: 400});
assert.deepEqual(firstSupportRender.sources[0].scale, {x: 1.25, y: 0.75});
assertNear(firstSupportRender.sources[0].rotation, 15);
assert.equal(firstSupportRender.sources[1].alpha, 0.65, "Tile document opacity contributes to support alpha");
assert.deepEqual(firstSupportRender.sources[1].anchor, {x: 0.25, y: 0.75});
assert.deepEqual(firstSupportRender.sources[1].scale, {x: 1.5, y: 0.5});
assert.deepEqual(firstSupportRender.options.transform, new FakeMatrix(1, -0, 0, 1, 0, 100));
assert.equal(firstSpillRender.sourceTexture, firstMaskTexture);
assert.equal(firstSpillRender.options.renderTexture, firstSpillTexture);
assert.equal(firstSpillRender.filter.strength, 9, "a 100-pixel wall receives an 18-pixel feather radius");
assert.equal(firstSpillRender.filter.quality, 3);
assert.equal(firstSpillRender.filter.kernelSize, 9);
assert.equal(firstSpillRender.filter.destroyed, true, "the temporary blur filter is destroyed after baking");

const preview = {
  id: "preview",
  _original: wall,
  document: {...document, c: [0, 0, 0, 50]},
  visible: true,
  controlled: false
};
hookCallbacks.get("refreshWall")(preview);
assert.equal(preview.visible, false, "the drag preview is hidden too");
assert.deepEqual({x: mesh.position.x, y: mesh.position.y}, {x: 0, y: 25});
assert.equal(mesh.angle, 90);
assert.deepEqual(mesh.resizeValue, {
  width: 50,
  height: 100,
  options: {fit: "fill", scaleY: -1}
});
assert.deepEqual({x: firstMaskSprite.position.x, y: firstMaskSprite.position.y}, {x: 0, y: 25},
  "the existing support sprite follows the drag immediately");
assert.equal(firstMaskSprite.angle, 90);
await flushAsyncWork();
assert.equal(getSupportRenderCalls().length, 2, "the wall-local support texture is regenerated after a drag");
assert.equal(getSpillRenderCalls().length, 2, "the wall-local spill texture is regenerated after a drag");
assert.equal(firstFilter.destroyed, true);
assert.equal(firstMaskSprite.destroyed, true);
assert.equal(firstMaskTexture.destroyed, true);
assert.equal(firstSpillTexture.destroyed, true);
const verticalTransform = latestSupportRenderCall().options.transform;
assert.ok(Math.abs(verticalTransform.a) < 1e-12);
assert.equal(verticalTransform.b, -1);
assert.equal(verticalTransform.c, 1);
assert.ok(Math.abs(verticalTransform.d) < 1e-12);
assert.ok(Math.abs(verticalTransform.tx) < 1e-12);
assert.equal(verticalTransform.ty, 50);
assert.equal(latestSpillRenderCall().filter.strength, 6,
  "the minimum 12-pixel feather applies to short Walls");

const maskBeforeTileRefresh = primary.children.find(child => child instanceof FakeSprite);
renderer.gl.getParameter = () => 64;
hookCallbacks.get("refreshTile")(supportingTile);
hookCallbacks.get("refreshTile")(supportingTile);
await flushAsyncWork();
assert.equal(getSupportRenderCalls().length, 3, "multiple Tile refreshes are coalesced into one support redraw");
assert.equal(getSpillRenderCalls().length, 3, "coalesced Tile refreshes also bake only one spill texture");
assert.equal(maskBeforeTileRefresh.destroyed, true);
assert.equal(FakeRenderTexture.instances.at(-1).resolution, 0.64,
  "mask resolution is reduced only enough to fit the GPU texture limit");
assert.equal(latestSpillRenderCall().filter.resolution, 0.64,
  "the blur uses the same adaptive resolution as both mask textures");
renderer.gl.getParameter = () => 4096;

const diagonalPreview = {
  id: "diagonal-preview",
  _original: wall,
  document: {...document, c: [0, 0, 30, 40]},
  visible: true
};
hookCallbacks.get("refreshWall")(diagonalPreview);
assertNear(mesh.angle, 53.13010235415598);
assert.deepEqual({x: mesh.position.x, y: mesh.position.y}, {x: 15, y: 20});
assert.deepEqual(mesh.resizeValue, {
  width: 50,
  height: 100,
  options: {fit: "fill", scaleY: -1}
});
await flushAsyncWork();
const diagonalMask = primary.children.find(child => child instanceof FakeSprite);
assertNear(diagonalMask.angle, mesh.angle, 1e-12,
  "rotated rubble and its support mask use the same angle");
assert.deepEqual({x: diagonalMask.position.x, y: diagonalMask.position.y}, {x: 15, y: 20});
const diagonalTransform = latestSupportRenderCall().options.transform;
assertNear((diagonalTransform.a * 15) + (diagonalTransform.c * 20) + diagonalTransform.tx, 25);
assertNear((diagonalTransform.b * 15) + (diagonalTransform.d * 20) + diagonalTransform.ty, 50);
assert.equal(latestSpillRenderCall().sourceTexture, diagonalMask.texture,
  "the rotated mask is blurred in its wall-local orientation");

const longPreview = {
  id: "long-preview",
  _original: wall,
  document: {...document, c: [0, 0, 300, 0]},
  visible: true
};
hookCallbacks.get("refreshWall")(longPreview);
await flushAsyncWork();
assert.equal(latestSpillRenderCall().filter.strength, 18,
  "the feather radius is capped at 36 pixels for long Walls");

supportingTile.mesh.position.set(120, 90);
supportingTile.mesh.angle = 60;
supportingTile.document.alpha = 0.4;
hookCallbacks.get("refreshTile")(supportingTile);
await flushAsyncWork();
const transformedTileSource = latestSupportRenderCall().sources.find(source => source.src === "supporting-tile.webp");
assert.deepEqual(transformedTileSource.position, {x: 120, y: 90});
assertNear(transformedTileSource.rotation, 60);
assert.equal(transformedTileSource.alpha, 0.4,
  "Tile transforms and document opacity are captured again when the Tile refreshes");

supportingTile.document.hidden = true;
hookCallbacks.get("updateTile")(supportingTile.document);
await flushAsyncWork();
assert.deepEqual(latestSupportRenderCall().sources.map(source => source.src), [
  "background.webp",
  "unrestricted-tile.webp"
], "a newly hidden Tile stops supporting debris");

primary.background.visible = false;
unrestrictedTile.document.hidden = true;
hookCallbacks.get("refreshTile")(unrestrictedTile);
await flushAsyncWork();
assert.deepEqual(latestSupportRenderCall().sources, [], "an empty support composition stays fully transparent");
assert.equal(primary.children.length, 2,
  "empty support still leaves an alpha mask attached instead of falling back to unmasked debris");

primary.background.visible = true;
supportingTile.document.hidden = false;
unrestrictedTile.document.hidden = false;
hookCallbacks.get("refreshTile")(supportingTile);
await flushAsyncWork();

wall.visible = true;
hookCallbacks.get("drawWall")(wall);
await flushAsyncWork();
assert.equal(wall.visible, false, "the Wall remains hidden after Foundry redraws it");

const resourcesBeforeDisable = currentMaskResources(mesh, primary);
breakableWallsEnabled = false;
hookCallbacks.get("theiks-toolbag.featureSettingChanged")("breakableWalls", false);
await flushAsyncWork();
assert.equal(primary.children.length, 0, "disabling the feature removes all owned artwork resources");
assertDestroyedMaskResources(resourcesBeforeDisable);
assert.equal(primary.background.texture.destroyed, undefined);

breakableWallsEnabled = true;
hookCallbacks.get("theiks-toolbag.featureSettingChanged")("breakableWalls", true);
await flushAsyncWork();
assert.equal(primary.children.length, 2, "re-enabling the feature rebuilds masked artwork");
const rebuiltMesh = primary.children.find(child => child instanceof FakeMesh);
const resourcesBeforeTeardown = currentMaskResources(rebuiltMesh, primary);
hookCallbacks.get("canvasTearDown")();
assert.equal(primary.children.length, 0, "Canvas teardown removes rubble and its support mask");
assertDestroyedMaskResources(resourcesBeforeTeardown);
assert.equal(supportingTile.mesh.texture.destroyed, undefined);
hookCallbacks.get("canvasReady")();
await flushAsyncWork();
assert.equal(primary.children.length, 2, "the next Canvas draw rebuilds the mask");

const resourcesBeforeLevelChange = currentMaskResources(
  primary.children.find(child => child instanceof FakeMesh),
  primary
);
canvas.level = {id: "upper", elevation: {base: 40}};
hookCallbacks.get("updateScene")(scene);
await flushAsyncWork();
assert.equal(primary.children.length, 0, "artwork is omitted outside the Wall's assigned level");
assert.equal(resourcesBeforeLevelChange.filter.destroyed, true);
assert.equal(resourcesBeforeLevelChange.mask.destroyed, true);
assert.equal(resourcesBeforeLevelChange.texture.destroyed, true);
assert.equal(resourcesBeforeLevelChange.spillTexture.destroyed, true);
assert.equal(primary.background.texture.destroyed, undefined, "the shared background texture is preserved");
assert.equal(supportingTile.mesh.texture.destroyed, undefined, "shared Tile textures are preserved");

const refreshVisibilityBeforeRepair = wall.refreshVisibilityCount ?? 0;
flag.destroyed = false;
hookCallbacks.get("updateWall")(document);
await flushAsyncWork();
assert.equal(wall.visible, true, "repair delegates visibility restoration to the core Wall");
assert.equal(wall.refreshVisibilityCount, refreshVisibilityBeforeRepair + 1);

let resolveTexture;
foundry.canvas.loadTexture = () => new Promise(resolve => { resolveTexture = resolve; });
flag.destroyed = true;
canvas.level = {id: "ground", elevation: {base: 13}};
hookCallbacks.get("canvasReady")();
for (let i = 0; i < 4; i++) await Promise.resolve();
hookCallbacks.get("canvasTearDown")();
canvas.ready = false;
const staleTexture = new FakeTexture("single.webp");
resolveTexture(staleTexture);
await flushAsyncWork();
assert.equal(primary.children.length, 0, "a stale texture load cannot attach artwork after teardown");
assert.equal(FakeMesh.instances.at(-1).destroyed, true, "a stale mesh is destroyed without destroying its texture");
assert.deepEqual(FakeMesh.instances.at(-1).destroyOptions, {
  children: true,
  texture: false,
  baseTexture: false
});
assert.equal(staleTexture.destroyed, undefined);

foundry.canvas.loadTexture = async src => new FakeTexture(src);
canvas.ready = true;
hookCallbacks.get("canvasReady")();
await flushAsyncWork();
assert.equal(primary.children.length, 2);
const originalError = console.error;
const maskFailures = [];
console.error = message => { maskFailures.push(String(message)); };
const texturesBeforeSpillFailure = FakeRenderTexture.instances.length;
try {
  renderer.failNext = "spill";
  hookCallbacks.get("refreshTile")(supportingTile);
  await flushAsyncWork();
} finally {
  console.error = originalError;
}
assert.match(maskFailures.at(-1), /Failed to refresh destroyed-wall support mask/);
assert.equal(primary.children.length, 0, "a failed spill render removes debris rather than leaving it unmasked");
const failedSpillTextures = FakeRenderTexture.instances.slice(texturesBeforeSpillFailure);
assert.equal(failedSpillTextures.length, 2);
assert.ok(failedSpillTextures.every(texture => texture.destroyed),
  "both exact and spill textures are released when blur baking fails");

hookCallbacks.get("canvasReady")();
await flushAsyncWork();
assert.equal(primary.children.length, 2);
const texturesBeforeSupportFailure = FakeRenderTexture.instances.length;
console.error = message => { maskFailures.push(String(message)); };
try {
  renderer.failNext = "support";
  hookCallbacks.get("refreshTile")(supportingTile);
  await flushAsyncWork();
} finally {
  console.error = originalError;
}
assert.match(maskFailures.at(-1), /Failed to refresh destroyed-wall support mask/);
assert.equal(primary.children.length, 0, "a failed exact-mask render remains fail-closed");
const failedSupportTextures = FakeRenderTexture.instances.slice(texturesBeforeSupportFailure);
assert.equal(failedSupportTextures.length, 1);
assert.equal(failedSupportTextures[0].destroyed, true, "the failed exact support texture is released");

console.log("wall art tests passed");

async function flushAsyncWork() {
  for (let i = 0; i < 6; i++) await Promise.resolve();
  await new Promise(resolve => setImmediate(resolve));
}

function assertNear(actual, expected, tolerance = 1e-10, message) {
  assert.ok(Math.abs(actual - expected) <= tolerance,
    message ?? `expected ${actual} to be within ${tolerance} of ${expected}`);
}

function currentMaskResources(mesh, parent) {
  const mask = parent.children.find(child => child instanceof FakeSprite);
  const filter = mesh.filters[0];
  return {filter, mask, texture: mask.texture, spillTexture: filter.uniforms.spillMask};
}

function assertDestroyedMaskResources(resources) {
  assert.equal(resources.filter.destroyed, true);
  assert.equal(resources.mask.destroyed, true);
  assert.equal(resources.texture.destroyed, true);
  assert.equal(resources.spillTexture.destroyed, true);
}

function getSupportRenderCalls() {
  return renderCalls.filter(call => call.kind === "support");
}

function getSpillRenderCalls() {
  return renderCalls.filter(call => call.kind === "spill");
}

function latestSupportRenderCall() {
  return getSupportRenderCalls().at(-1);
}

function latestSpillRenderCall() {
  return getSpillRenderCalls().at(-1);
}

function evaluateSpillAppearance(uniforms, supportAlpha, spillAlpha, edgeContrast = 0) {
  const edgeTransition = smoothstep(0.01, 0.15, edgeContrast);
  const unsupported = 1 - smoothstep(0, 0.05, supportAlpha);
  const featherInfluence = Math.max(unsupported, edgeTransition);
  const featherAlpha = Math.min(
    (spillAlpha ** uniforms.spillFadeExponent) * uniforms.spillOpacityGain,
    uniforms.spillMaxAlpha
  ) * featherInfluence;
  const alpha = Math.max(supportAlpha, featherAlpha);
  const fringe = Math.min(1, Math.max(0, (alpha - supportAlpha) / Math.max(alpha, 0.0001)));
  const fadeProgress = 1 - smoothstep(0, 0.5, spillAlpha);
  const spillBrightness = uniforms.spillEdgeBrightness
    + ((uniforms.spillOuterBrightness - uniforms.spillEdgeBrightness) * fadeProgress);
  const brightness = 1 + ((spillBrightness - 1) * fringe);
  return {alpha, brightness};
}

function smoothstep(edge0, edge1, value) {
  const amount = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return amount * amount * (3 - (2 * amount));
}
