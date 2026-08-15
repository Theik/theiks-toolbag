import assert from "node:assert/strict";

const hookCallbacks = new Map();
globalThis.Hooks = {
  on: (hook, callback) => hookCallbacks.set(hook, callback)
};

globalThis.game = {
  settings: {get: (_namespace, key) => key === "enableVisibleLights"}
};

class FakeMesh {
  static instances = [];

  constructor(options) {
    this.options = options;
    this.anchor = {set: value => { this.anchorValue = value; }};
    this.position = {set: (x, y) => { this.positionValue = {x, y}; }};
    this.destroyed = false;
    FakeMesh.instances.push(this);
  }

  resize(width, height, options) {
    this.resizeValue = {width, height, options};
  }

  removeFromParent() {
    if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this);
    this.parent = null;
  }

  destroy(options) {
    this.destroyed = true;
    this.destroyOptions = options;
  }
}

class FakePrimary {
  static SORT_LAYERS = {DRAWINGS: 7};

  constructor() {
    this.children = [];
    this.renderDirty = false;
  }

  addChild(child) {
    child.parent = this;
    this.children.push(child);
  }

  sortChildren() {}
  update() {}
}

globalThis.foundry = {
  canvas: {
    loadTexture: async src => ({src}),
    primary: {PrimarySpriteMesh: FakeMesh}
  }
};

const scene = {id: "scene"};
const primary = new FakePrimary();
const flag = {
  destroyed: false,
  images: {on: "on.webp", off: "off.webp", destroyed: "broken.webp"}
};
const document = {
  id: "light-1",
  x: 150,
  y: 250,
  elevation: 12,
  rotation: 35,
  hidden: false,
  parent: scene,
  getFlag: () => flag
};
const light = {
  id: document.id,
  center: {x: document.x, y: document.y},
  document
};
document.object = light;

globalThis.canvas = {
  ready: true,
  scene,
  dimensions: {size: 100},
  primary,
  lighting: {placeables: [light]}
};

const {registerVisibleLightArt} = await import("../scripts/visible-lights/light-art.js");
registerVisibleLightArt();

for (const hook of [
  "canvasReady",
  "canvasTearDown",
  "createAmbientLight",
  "updateAmbientLight",
  "deleteAmbientLight",
  "refreshAmbientLight",
  "destroyAmbientLight",
  "updateScene"
]) assert.equal(typeof hookCallbacks.get(hook), "function", `${hook} hook is registered`);

hookCallbacks.get("canvasReady")();
await flushAsyncWork();

assert.equal(primary.children.length, 1);
let mesh = primary.children[0];
assert.equal(mesh.options.object, light);
assert.equal(mesh.options.texture.src, "on.webp");
assert.deepEqual(mesh.positionValue, {x: 150, y: 250});
assert.equal(mesh.angle, 35, "initial artwork uses the Ambient Light document rotation");
assert.deepEqual(mesh.resizeValue, {
  width: 100,
  height: 100,
  options: {fit: "fill"}
});
assert.equal(mesh.elevation, 12);
assert.equal(mesh.sortLayer, 7);
assert.equal(mesh.eventMode, "none");

const preview = {
  id: "preview",
  _original: light,
  _previewType: "controls",
  center: {x: 175, y: 275},
  document: {...document, x: 175, y: 275, rotation: 220}
};
light._preview = preview;
primary.renderDirty = false;
hookCallbacks.get("refreshAmbientLight")(preview);
assert.deepEqual(mesh.positionValue, {x: 175, y: 275});
assert.equal(mesh.angle, 220, "rotation previews update the existing artwork immediately");
assert.equal(primary.renderDirty, true);

hookCallbacks.get("refreshAmbientLight")(light);
assert.deepEqual(
  mesh.positionValue,
  {x: 175, y: 275},
  "an original-placeable refresh cannot pull artwork away from the active shape-control preview"
);
assert.equal(mesh.angle, 220);

preview.center = {x: 225, y: 325};
preview.document.x = 225;
preview.document.y = 325;
hookCallbacks.get("refreshAmbientLight")(preview);
hookCallbacks.get("refreshAmbientLight")(light);
assert.deepEqual(mesh.positionValue, {x: 225, y: 325}, "successive drag frames remain preview-authoritative");

const dragMesh = mesh;
hookCallbacks.get("updateScene")(scene);
await flushAsyncWork();
mesh = primary.children[0];
assert.equal(dragMesh.destroyed, true);
assert.deepEqual(
  mesh.positionValue,
  {x: 225, y: 325},
  "a full artwork redraw cannot replace an idle drag preview with the saved position"
);
assert.equal(mesh.angle, 220);
hookCallbacks.get("refreshAmbientLight")(light);
assert.deepEqual(mesh.positionValue, {x: 225, y: 325});

light._preview = undefined;
hookCallbacks.get("destroyAmbientLight")(preview);
await Promise.resolve();
assert.deepEqual(mesh.positionValue, {x: 150, y: 250}, "canceling a drag restores the saved position");
assert.equal(mesh.angle, 35, "canceling a drag restores the saved rotation");

const bodyPreview = {
  id: "body-preview",
  _original: light,
  _previewType: "dragging",
  center: {x: 185, y: 285},
  document: {...document, x: 185, y: 285, rotation: 75}
};
light._preview = bodyPreview;
hookCallbacks.get("refreshAmbientLight")(bodyPreview);
hookCallbacks.get("refreshAmbientLight")(light);
assert.deepEqual(mesh.positionValue, {x: 185, y: 285}, "body drags remain preview-authoritative too");
assert.equal(mesh.angle, 75);
light._preview = undefined;
hookCallbacks.get("destroyAmbientLight")(bodyPreview);
await Promise.resolve();
assert.deepEqual(mesh.positionValue, {x: 150, y: 250});
assert.equal(mesh.angle, 35);

document.rotation = 300;
hookCallbacks.get("updateAmbientLight")(document);
await flushAsyncWork();
assert.equal(primary.children.length, 1);
assert.equal(mesh.destroyed, true, "a saved update replaces the prior artwork mesh");
mesh = primary.children[0];
assert.equal(mesh.angle, 300, "redrawn artwork retains the saved rotation");

hookCallbacks.get("canvasTearDown")();
assert.equal(primary.children.length, 0);
assert.equal(mesh.destroyed, true);

console.log("visible light art tests passed");

async function flushAsyncWork() {
  for (let index = 0; index < 4; index += 1) await Promise.resolve();
  await new Promise(resolve => setImmediate(resolve));
}
