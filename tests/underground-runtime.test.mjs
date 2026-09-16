import assert from "node:assert/strict";
import test from "node:test";

const hookCallbacks = new Map();
globalThis.Hooks = {on(name, callback) {
  const callbacks = hookCallbacks.get(name) ?? [];
  callbacks.push(callback);
  hookCallbacks.set(name, callbacks);
}};
globalThis.game = {
  user: {isGM: true},
  settings: {get: () => true},
  i18n: {localize: key => key}
};
const errors = [];
globalThis.ui = {notifications: {error: message => errors.push(message)}};
globalThis.CONST = {
  EDGE_SENSE_TYPES: {NONE: 0, NORMAL: 1, LIMITED: 2},
  EDGE_DIRECTIONS: {BOTH: 0}
};
let textureFromCalls = 0;
let meshConstructs = 0;
class MockCanvas {
  constructor() {
    this.width = 0;
    this.height = 0;
    this.imageData = null;
  }
  getContext() {
    return {
      createImageData: (width, height) => ({width, height, data: new Uint8ClampedArray(width * height * 4)}),
      putImageData: image => { this.imageData = image; }
    };
  }
}
class Sprite {
  constructor(texture) {
    this.texture = texture;
    this.destroyed = false;
    this.parent = null;
    this.width = 0;
    this.height = 0;
    this.position = {set: (x, y) => { this.positionValue = [x, y]; }};
  }
  removeFromParent() {
    if (this.parent?.children) this.parent.children = this.parent.children.filter(child => child !== this);
    this.parent = null;
  }
  destroy() { this.destroyed = true; }
}
class Texture {
  static from(source) {
    textureFromCalls += 1;
    return {fromCanvas: true, source, alphas: source?.alphas ?? maskAlphasFromCanvas(source)};
  }
  constructor(options, frameArg) {
    const frame = options?.frame ?? frameArg;
    this.source = options?.source ?? options;
    this.frame = frame;
    this.width = frame?.width;
    this.height = frame?.height;
  }
}
class Rectangle {
  constructor(x, y, width, height) {
    this.x = x;
    this.y = y;
    this.width = width;
    this.height = height;
  }
}
globalThis.PIXI = {
  Sprite,
  Rectangle,
  Texture,
  SCALE_MODES: {LINEAR: "linear"}
};
globalThis.document = {
  createElement: tag => tag === "canvas" ? new MockCanvas() : {}
};

class Container {
  constructor() { this.children = []; this.parent = null; }
  addChild(...children) {
    for (const child of children) {
      child.parent = this;
      this.children.push(child);
    }
    return children.at(-1);
  }
}
class Primary extends Container {
  sortChildren() { this.sorted = (this.sorted ?? 0) + 1; }
  update() { this.updated = (this.updated ?? 0) + 1; }
}
Primary.SORT_LAYERS = {TILES: 2, DRAWINGS: 7};
class PrimarySpriteMesh {
  constructor({name, object, texture} = {}) {
    meshConstructs += 1;
    this.name = name;
    this.object = object;
    this.texture = texture;
    this.parent = null;
    this.destroyed = false;
    this.children = [];
    this.anchor = {set: (x, y) => { this.anchorValue = [x, y]; }};
    this.position = {set: (x, y) => { this.positionValue = [x, y]; }};
  }
  addChild(child) {
    child.parent = this;
    this.children.push(child);
    return child;
  }
  resize(width, height, options) { this.resized = {width, height, options}; }
  removeFromParent() {
    if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this);
    this.parent = null;
  }
  destroy() { this.destroyed = true; }
}
class Edge { constructor(a, b, options) { Object.assign(this, options, {a, b}); } }
globalThis.foundry = {
  canvas: {
    geometry: {edges: {Edge}},
    primary: {PrimarySpriteMesh},
    loadTexture: async src => ({src, width: 100, height: 100})
  },
  utils: {hasProperty: (object, path) => path.split(".").every(part => (object = object?.[part]) !== undefined)}
};

const {
  createUndergroundSource,
  digUnderground,
  subcellsForLogicalIndexes
} = await import("../scripts/underground/underground-data.js");
const {registerUndergroundRuntime} = await import("../scripts/underground/underground-runtime.js");

function source(overrides = {}) {
  const width = overrides.width ?? 2;
  const height = overrides.height ?? 1;
  return createUndergroundSource({
    levelId: "ground", origin: {x: 0, y: 0}, width, height, gridSize: 100,
    cells: subcellsForLogicalIndexes(overrides.logicalCells ?? [0, 1], width, height),
    intactSrc: "earth.webp", dugSrc: "rubble.webp", blocksMovement: true, blocksVision: true,
    ...overrides,
    cells: overrides.cells ?? subcellsForLogicalIndexes(overrides.logicalCells ?? [0, 1], width, height)
  });
}

function createScene(flag, level = {id: "ground", edges: new Map()}) {
  const key = level.id ?? level._id;
  return {
    id: "scene",
    documentName: "Scene",
    initialLevel: key,
    levels: new Map([[key, level]]),
    level,
    flags: {"theiks-toolbag": {undergroundTerrain: flag}},
    getFlag(module, keyName) { return this.flags[module]?.[keyName]; },
    updateRegionShapeConstraints() {},
    async update(change) {
      const dugMask = change["flags.theiks-toolbag.undergroundTerrain.dugMask"];
      if (dugMask) this.flags["theiks-toolbag"].undergroundTerrain.dugMask = dugMask;
      return this;
    }
  };
}

function canvasFor(scene, primary = new Primary()) {
  return {
    ready: true, scene, level: scene.level, primary,
    perception: {update() {}}, tokens: {recalculatePlannedMovementPaths() {}}
  };
}

function wait() {
  return new Promise(resolve => setImmediate(resolve));
}

function maskAlphasFromCanvas(source) {
  const data = source?.imageData?.data;
  if (!data) return source?.alphas ?? null;
  const alphas = new Uint8Array(data.length / 4);
  for (let i = 0; i < alphas.length; i += 1) alphas[i] = data[(i * 4) + 3];
  return alphas;
}

function maskAlphas(mesh) {
  return mesh?.mask?.texture?.alphas ?? maskAlphasFromCanvas(mesh?.mask?.texture?.source) ?? null;
}

function alphaAt(alphas, x, y, resolution = 32) {
  return alphas[(y * resolution) + x];
}

test("runtime creates lit per-cell meshes, coalesced edges, and follows viewed Levels", async () => {
  textureFromCalls = 0;
  const scene = createScene(source());
  const primary = new Primary();
  globalThis.canvas = canvasFor(scene, primary);
  registerUndergroundRuntime();
  hookCallbacks.get("canvasReady")[0]();
  await wait();
  assert.equal(primary.children.length, 2);
  assert.ok(primary.children.every(child => child instanceof PrimarySpriteMesh));
  assert.deepEqual(primary.children.map(child => child.name).sort(), [
    "theiks-toolbag.undergroundTerrain.intact.0",
    "theiks-toolbag.undergroundTerrain.intact.1"
  ]);
  assert.equal(primary.children[0].object, scene);
  assert.equal(primary.children[0].sortLayer, Primary.SORT_LAYERS.DRAWINGS + 1);
  assert.equal(primary.children[0].sort, Number.MAX_SAFE_INTEGER);
  assert.equal(primary.children[0].texture.src, "earth.webp");
  assert.equal(textureFromCalls, 0, "earth color comes from loadTexture, not a baked canvas");
  assert.deepEqual(primary.children.find(child => child.name.endsWith(".0")).positionValue, [-0.5, -0.5]);
  assert.deepEqual(primary.children.find(child => child.name.endsWith(".1")).positionValue, [99.5, -0.5]);
  assert.deepEqual(primary.children[0].resized, {
    width: 101, height: 101, options: {fit: "fill", scaleX: 1, scaleY: 1}
  });
  assert.ok(primary.updated >= 1, "the primary canvas is rebuilt after inserting the meshes");
  assert.equal(scene.level.edges.size, 8, "four coalesced sides are installed for movement and vision");

  canvas.level = {id: "upper"};
  hookCallbacks.get("canvasPan")[0]();
  await wait();
  assert.equal(primary.children.length, 0);

  canvas.level = scene.level;
  hookCallbacks.get("canvasPan")[0]();
  await wait();
  assert.equal(primary.children.length, 2);
});

test("runtime draws when the viewed Level only exposes _id", async () => {
  const level = {_id: "defaultLevel0000", edges: new Map()};
  const scene = createScene(source({levelId: "defaultLevel0000"}), level);
  const primary = new Primary();
  globalThis.canvas = canvasFor(scene, primary);
  canvas.level = {_id: "defaultLevel0000"};
  hookCallbacks.get("canvasReady")[0]();
  await wait();
  assert.equal(primary.children.length, 2);
  assert.ok(level.edges.size > 0);

  canvas.level = null;
  hookCallbacks.get("canvasPan")[0]();
  await wait();
  assert.equal(primary.children.length, 2, "missing viewed Level still draws when initialLevel matches");
});

test("disabled underground sources create neither artwork nor collision edges", async () => {
  const scene = createScene({...source(), enabled: false});
  const primary = new Primary();
  globalThis.canvas = canvasFor(scene, primary);
  hookCallbacks.get("canvasReady")[0]();
  await wait();
  assert.equal(primary.children.length, 0);
  assert.equal(scene.level.edges.size, 0);
});

test("a dotted enabled flag update rebuilds artwork", async () => {
  const scene = canvas.scene;
  scene.flags["theiks-toolbag"].undergroundTerrain.enabled = true;
  const primary = canvas.primary;
  hookCallbacks.get("updateScene")[0](scene, {
    "flags.theiks-toolbag.undergroundTerrain.enabled": true
  });
  await wait();
  assert.ok(primary.children.length > 0);
});

test("a one-cell dig rebuilds the dug cell and its 4-neighbors", async () => {
  textureFromCalls = 0;
  const flag = source({width: 3, height: 1, logicalCells: [0, 1, 2]});
  const scene = createScene(flag);
  const primary = new Primary();
  globalThis.canvas = canvasFor(scene, primary);
  hookCallbacks.get("canvasReady")[0]();
  await wait();
  assert.equal(primary.children.length, 3);
  const constructedAfterReady = meshConstructs;
  const farIntact = primary.children.find(child => child.name.endsWith(".2"));
  await digUnderground(scene, subcellsForLogicalIndexes([0], 3, 1));
  hookCallbacks.get("updateScene")[0](scene, {
    "flags.theiks-toolbag.undergroundTerrain.dugMask": scene.flags["theiks-toolbag"].undergroundTerrain.dugMask
  });
  await wait();
  assert.equal(meshConstructs - constructedAfterReady, 4, "the dug cell and its neighbor are rebuilt");
  assert.equal(farIntact.destroyed, false, "a cell two steps away is not rebuilt");
  assert.equal(primary.children.includes(farIntact), true);
  assert.ok(textureFromCalls > 0, "fade masks use Texture.from of a tiny canvas");
  assert.ok(primary.children.some(child => child.texture.src === "rubble.webp"));
  const dug = primary.children.find(child => child.name.includes(".dug."));
  const neighborIntact = primary.children.find(child => child.name.endsWith(".1"));
  assert.equal(dug.sortLayer, Primary.SORT_LAYERS.TILES);
  assert.equal(dug.sort, -100001);
  assert.equal(neighborIntact.sortLayer, Primary.SORT_LAYERS.DRAWINGS + 1);
});

test("a mixed cell uses a sprite mask with intermediate alpha, not hard rects", async () => {
  const flag = source({width: 1, height: 1, logicalCells: [0]});
  const scene = createScene(flag);
  const primary = new Primary();
  globalThis.canvas = canvasFor(scene, primary);
  hookCallbacks.get("canvasReady")[0]();
  await wait();
  await digUnderground(scene, [0]);
  hookCallbacks.get("updateScene")[0](scene, {
    "flags.theiks-toolbag.undergroundTerrain.dugMask": scene.flags["theiks-toolbag"].undergroundTerrain.dugMask
  });
  await wait();
  const intact = primary.children.find(child => child.name.includes(".intact."));
  const dug = primary.children.find(child => child.name.includes(".dug."));
  assert.ok(intact.mask instanceof Sprite);
  assert.ok(dug.mask instanceof Sprite);
  const intactAlphas = maskAlphas(intact);
  const dugAlphas = maskAlphas(dug);
  assert.ok(intactAlphas.some(alpha => alpha > 0 && alpha < 255), "intact fade is soft");
  assert.ok(dugAlphas.some(alpha => alpha > 0 && alpha < 255), "dug fade is soft");
  assert.equal(intact.mask.rects, undefined);
});

test("a fully intact cell beside a dug neighbor gets a dug fringe and a soft shared edge", async () => {
  const flag = source({width: 2, height: 1, logicalCells: [0, 1]});
  const scene = createScene(flag);
  const primary = new Primary();
  globalThis.canvas = canvasFor(scene, primary);
  hookCallbacks.get("canvasReady")[0]();
  await wait();
  await digUnderground(scene, subcellsForLogicalIndexes([0], 2, 1));
  hookCallbacks.get("updateScene")[0](scene, {
    "flags.theiks-toolbag.undergroundTerrain.dugMask": scene.flags["theiks-toolbag"].undergroundTerrain.dugMask
  });
  await wait();
  const intact = primary.children.find(child => child.name === "theiks-toolbag.undergroundTerrain.intact.1");
  const dugFringe = primary.children.find(child => child.name === "theiks-toolbag.undergroundTerrain.dug.1");
  const intactFringe = primary.children.find(child => child.name === "theiks-toolbag.undergroundTerrain.intact.0");
  const dug = primary.children.find(child => child.name === "theiks-toolbag.undergroundTerrain.dug.0");
  assert.ok(intact, "the intact neighbor still draws");
  assert.ok(dugFringe, "dug texture extends into the intact neighbor");
  assert.ok(intactFringe, "intact texture extends into the dug cell");
  assert.ok(dug, "the dug cell still draws rubble");
  const intactAlphas = maskAlphas(intact);
  assert.ok(intact.mask instanceof Sprite);
  assert.ok(alphaAt(intactAlphas, 0, 16) < alphaAt(intactAlphas, 31, 16),
    "intact alpha is lower on the shared edge than on the far side");
  const fringeAlphas = maskAlphas(dugFringe);
  assert.ok(alphaAt(fringeAlphas, 0, 16) > alphaAt(fringeAlphas, 31, 16),
    "dug fringe is stronger on the shared edge");
});

test("an interior intact cell with no dug neighbors stays fully opaque", async () => {
  const flag = source({width: 3, height: 1, logicalCells: [0, 1, 2]});
  const scene = createScene(flag);
  const primary = new Primary();
  globalThis.canvas = canvasFor(scene, primary);
  hookCallbacks.get("canvasReady")[0]();
  await wait();
  const far = primary.children.find(child => child.name.endsWith(".2"));
  assert.equal(far.mask, undefined);
  await digUnderground(scene, subcellsForLogicalIndexes([0], 3, 1));
  hookCallbacks.get("updateScene")[0](scene, {
    "flags.theiks-toolbag.undergroundTerrain.dugMask": scene.flags["theiks-toolbag"].undergroundTerrain.dugMask
  });
  await wait();
  const stillFar = primary.children.find(child => child.name.endsWith(".2"));
  assert.equal(stillFar.mask, undefined, "cells away from the tunnel keep a hard outer silhouette");
  assert.equal(stillFar, far);
});

test("collision edges stay on the square subcell grid after a dig", async () => {
  const flag = source({width: 2, height: 1, logicalCells: [0, 1]});
  const scene = createScene(flag);
  const primary = new Primary();
  globalThis.canvas = canvasFor(scene, primary);
  hookCallbacks.get("canvasReady")[0]();
  await wait();
  const before = scene.level.edges.size;
  await digUnderground(scene, [0]);
  hookCallbacks.get("updateScene")[0](scene, {
    "flags.theiks-toolbag.undergroundTerrain.dugMask": scene.flags["theiks-toolbag"].undergroundTerrain.dugMask
  });
  await wait();
  assert.ok(scene.level.edges.size >= before);
  for (const edge of scene.level.edges.values()) {
    for (const value of [edge.a.x, edge.a.y, edge.b.x, edge.b.y]) {
      assert.equal(value % 25, 0, "collision vertices stay on the 25px subcell grid");
    }
  }
});

test("a 2x2 intact texture shows the right-hand slice on cell 1", async () => {
  textureFromCalls = 0;
  const scene = createScene(source({intactGrid: 2, dugGrid: 1}));
  const primary = new Primary();
  globalThis.canvas = canvasFor(scene, primary);
  hookCallbacks.get("canvasReady")[0]();
  await wait();
  const left = primary.children.find(child => child.name.endsWith(".0"));
  const right = primary.children.find(child => child.name.endsWith(".1"));
  assert.ok(left.texture instanceof Texture);
  assert.ok(right.texture instanceof Texture);
  assert.equal(left.texture.frame.x, 0);
  assert.equal(right.texture.frame.x, 50, "cell 1,0 uses the right half of a 2x2 texture");
  assert.equal(left.texture.frame.width, 50);
  assert.equal(right.texture.frame.width, 50);
  assert.equal(left.texture.frame.y, 0);
  assert.equal(right.texture.frame.y, 0);
  assert.equal(textureFromCalls, 0, "sliced earth still uses loadTexture, not Texture.from");
});

test("invalid Scene data removes runtime objects and notifies the GM once", async () => {
  const scene = canvas.scene;
  scene.flags["theiks-toolbag"].undergroundTerrain = {...source(), schemaVersion: 99};
  const changes = {flags: {"theiks-toolbag": {undergroundTerrain: {schemaVersion: 99}}}};
  const update = hookCallbacks.get("updateScene")[0];
  const originalError = console.error;
  console.error = () => {};
  try {
    update(scene, changes);
    update(scene, changes);
    await wait();
  } finally {
    console.error = originalError;
  }
  assert.equal(canvas.primary.children.length, 0);
  assert.equal(scene.level.edges.size, 0);
  assert.equal(errors.length, 1);
});
