import assert from "node:assert/strict";

const hookCallbacks = new Map();
globalThis.Hooks = {
  on: (hook, callback) => hookCallbacks.set(hook, callback)
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
  level: {id: "ground", elevation: {base: 13}},
  primary,
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
  "drawWall"
]) assert.equal(typeof hookCallbacks.get(hook), "function", `${hook} hook is registered`);

hookCallbacks.get("canvasReady")();
assert.equal(wall.visible, false, "destroyed core Wall is hidden before its artwork loads");
assert.equal(wall.releaseCount, 1, "a controlled destroyed Wall is released");
await flushAsyncWork();

assert.equal(primary.children.length, 1);
const mesh = primary.children[0];
assert.equal(mesh.options.object, wall);
assert.equal(mesh.options.texture.src, "single.webp");
assert.deepEqual(mesh.positionValue, {x: 50, y: 0});
assert.equal(mesh.angle, 0);
assert.deepEqual(mesh.resizeValue, {
  width: 100,
  height: 200,
  options: {fit: "fill", scaleY: -1}
});
assert.equal(mesh.elevation, 13);
assert.equal(mesh.sortLayer, 7);
assert.equal(mesh.eventMode, "none");

const preview = {
  id: "preview",
  _original: wall,
  document: {...document, c: [0, 0, 0, 50]},
  visible: true,
  controlled: false
};
hookCallbacks.get("refreshWall")(preview);
assert.equal(preview.visible, false, "the drag preview is hidden too");
assert.deepEqual(mesh.positionValue, {x: 0, y: 25});
assert.equal(mesh.angle, 90);
assert.deepEqual(mesh.resizeValue, {
  width: 50,
  height: 100,
  options: {fit: "fill", scaleY: -1}
});

wall.visible = true;
hookCallbacks.get("drawWall")(wall);
await flushAsyncWork();
assert.equal(wall.visible, false, "the Wall remains hidden after Foundry redraws it");

canvas.level = {id: "upper", elevation: {base: 40}};
hookCallbacks.get("updateScene")(scene);
await flushAsyncWork();
assert.equal(primary.children.length, 0, "artwork is omitted outside the Wall's assigned level");

flag.destroyed = false;
hookCallbacks.get("updateWall")(document);
await flushAsyncWork();
assert.equal(wall.visible, true, "repair delegates visibility restoration to the core Wall");
assert.equal(wall.refreshVisibilityCount, 1);

let resolveTexture;
foundry.canvas.loadTexture = () => new Promise(resolve => { resolveTexture = resolve; });
flag.destroyed = true;
canvas.level = {id: "ground", elevation: {base: 13}};
hookCallbacks.get("canvasReady")();
for (let i = 0; i < 4; i++) await Promise.resolve();
hookCallbacks.get("canvasTearDown")();
canvas.ready = false;
resolveTexture({src: "single.webp"});
await flushAsyncWork();
assert.equal(primary.children.length, 0, "a stale texture load cannot attach artwork after teardown");
assert.equal(FakeMesh.instances.at(-1).destroyed, true, "a stale mesh is destroyed without destroying its texture");
assert.deepEqual(FakeMesh.instances.at(-1).destroyOptions, {
  children: true,
  texture: false,
  baseTexture: false
});

console.log("wall art tests passed");

async function flushAsyncWork() {
  for (let i = 0; i < 4; i++) await Promise.resolve();
  await new Promise(resolve => setImmediate(resolve));
}
