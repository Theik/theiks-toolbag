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
  SCALE_MODES: {LINEAR: "linear", NEAREST: "nearest"},
  WRAP_MODES: {REPEAT: "repeat", CLAMP: "clamp"}
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
  constructor() {
    super();
    this.background = {
      elevation: 0,
      sort: 0,
      sortLayer: Primary.SORT_LAYERS.SCENE
    };
  }
  sortChildren() { this.sorted = (this.sorted ?? 0) + 1; }
  update() { this.updated = (this.updated ?? 0) + 1; }
}
Primary.SORT_LAYERS = {SCENE: 0, TILES: 2, DRAWINGS: 7};
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
    this.uvs = new Float32Array(8);
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
  getUndergroundData,
  subcellsForLogicalIndexes
} = await import("../scripts/underground/underground-data.js");
const {registerUndergroundRuntime, visibleLogicalIndexes, rockBevelShade} = await import("../scripts/underground/underground-runtime.js");

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
      const full = change["flags.theiks-toolbag.undergroundTerrain"];
      if (full?.dugMask) this.flags["theiks-toolbag"].undergroundTerrain = full;
      else if (change["flags.theiks-toolbag.undergroundTerrain.dugMask"]) {
        this.flags["theiks-toolbag"].undergroundTerrain.dugMask = change["flags.theiks-toolbag.undergroundTerrain.dugMask"];
      }
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
  return mesh?.texture?.alphas
    ?? maskAlphasFromCanvas(mesh?.texture?.source)
    ?? mesh?.mask?.texture?.alphas
    ?? maskAlphasFromCanvas(mesh?.mask?.texture?.source)
    ?? null;
}

function alphaAt(alphas, x, y, resolution = 32) {
  return alphas[(y * resolution) + x];
}

test("runtime creates a tiled undug sheet, coalesced edges, and follows viewed Levels", async () => {
  textureFromCalls = 0;
  const scene = createScene(source());
  const primary = new Primary();
  globalThis.canvas = canvasFor(scene, primary);
  registerUndergroundRuntime();
  hookCallbacks.get("canvasReady")[0]();
  await wait();
  assert.equal(primary.children.length, 1);
  assert.ok(primary.children.every(child => child instanceof PrimarySpriteMesh));
  assert.equal(primary.children[0].name, "theiks-toolbag.undergroundTerrain.intact.sheet");
  assert.equal(primary.children[0].object, scene);
  assert.equal(primary.children[0].sortLayer, Primary.SORT_LAYERS.SCENE);
  assert.equal(primary.children[0].sort, -2);
  assert.equal(primary.children[0].elevation, 0);
  assert.equal(primary.children[0].texture.src, "earth.webp");
  assert.deepEqual(primary.children[0].tileRepeat, [2, 1]);
  assert.equal(textureFromCalls, 0, "earth color comes from loadTexture, not a baked canvas");
  assert.deepEqual(primary.children[0].positionValue, [-0.5, -0.5]);
  assert.deepEqual(primary.children[0].resized, {
    width: 201, height: 101, options: {fit: "fill", scaleX: 1, scaleY: 1}
  });
  assert.ok(primary.updated >= 1, "the primary canvas is rebuilt after inserting the meshes");
  assert.equal(scene.level.edges.size, 8, "four coalesced sides are installed for movement and vision");
  const vision = [...scene.level.edges.values()].filter(edge => String(edge.id).includes(".vision."));
  assert.equal(vision.length, 4);
  assert.ok(vision.every(edge => (
    edge.sight === CONST.EDGE_SENSE_TYPES.NORMAL
    && edge.light === CONST.EDGE_SENSE_TYPES.NORMAL
    && edge.darkness === CONST.EDGE_SENSE_TYPES.NORMAL
  )));

  canvas.level = {id: "upper"};
  hookCallbacks.get("canvasPan")[0]();
  await wait();
  assert.equal(primary.children.length, 0);

  canvas.level = scene.level;
  hookCallbacks.get("canvasPan")[0]();
  await wait();
  assert.equal(primary.children.length, 1);
});

test("stored blocking flags cannot disable underground walls", async () => {
  const flag = source();
  flag.blocksMovement = false;
  flag.blocksVision = false;
  const scene = createScene(flag);
  const primary = new Primary();
  globalThis.canvas = canvasFor(scene, primary);
  hookCallbacks.get("canvasReady")[0]();
  await wait();
  const vision = [...scene.level.edges.values()].filter(edge => String(edge.id).includes(".vision."));
  assert.ok(vision.length > 0);
  assert.ok(vision.every(edge => (
    edge.sight === CONST.EDGE_SENSE_TYPES.NORMAL
    && edge.light === CONST.EDGE_SENSE_TYPES.NORMAL
  )));
});

test("earth sits behind the Level background on the same elevation", async () => {
  const scene = createScene(source());
  const primary = new Primary();
  primary.background = {elevation: -10, sort: 0, sortLayer: Primary.SORT_LAYERS.SCENE};
  globalThis.canvas = canvasFor(scene, primary);
  canvas.level = {id: "ground", elevation: {bottom: -10, top: 0}};
  hookCallbacks.get("canvasReady")[0]();
  await wait();
  assert.equal(primary.children[0].elevation, -10);
  assert.equal(primary.children[0].sortLayer, Primary.SORT_LAYERS.SCENE);
  assert.equal(primary.children[0].sort, -2);
});

test("forced earth draws above tiles", async () => {
  const scene = createScene(source({width: 2, height: 1, logicalCells: [0]}));
  scene.regions = {
    contents: [{
      hidden: false,
      levels: ["ground"],
      bounds: {x: 100, y: 0, width: 100, height: 100},
      behaviors: [{type: "theiks-toolbag.forceDiggable", disabled: false}],
      testPoint: point => point.x >= 100 && point.x < 200
    }]
  };
  const primary = new Primary();
  globalThis.canvas = canvasFor(scene, primary);
  hookCallbacks.get("canvasReady")[0]();
  await wait();
  const natural = primary.children.find(child => child.name.endsWith(".sheet"));
  const forced = primary.children.find(child => child.name.endsWith(".1"));
  assert.equal(natural.sortLayer, Primary.SORT_LAYERS.SCENE);
  assert.equal(natural.sort, -2);
  assert.equal(forced.sortLayer, Primary.SORT_LAYERS.TILES);
  assert.equal(forced.sort, 999998);
  assert.equal(forced.elevation, 0);
});

test("creating a force Region rebuilds earth on top of tiles", async () => {
  const scene = createScene(source({width: 2, height: 1, logicalCells: [0]}));
  scene.regions = {contents: []};
  const primary = new Primary();
  globalThis.canvas = canvasFor(scene, primary);
  hookCallbacks.get("canvasReady")[0]();
  await wait();
  const hole = primary.children.find(child => child.name.endsWith(".sheet"));
  assert.equal(hole.sortLayer, Primary.SORT_LAYERS.SCENE);
  const region = {
    documentName: "Region",
    parent: scene,
    hidden: false,
    levels: ["ground"],
    bounds: {x: 100, y: 0, width: 100, height: 100},
    behaviors: [{type: "theiks-toolbag.forceDiggable", disabled: false}],
    testPoint: point => point.x >= 100 && point.x < 200
  };
  scene.regions.contents.push(region);
  for (const callback of hookCallbacks.get("createRegion") ?? []) callback(region);
  await wait();
  const forced = primary.children.find(child => child.name.endsWith(".1"));
  assert.equal(forced.sortLayer, Primary.SORT_LAYERS.TILES);
});

test("runtime draws when the viewed Level only exposes _id", async () => {
  const level = {_id: "defaultLevel0000", edges: new Map()};
  const scene = createScene(source({levelId: "defaultLevel0000"}), level);
  const primary = new Primary();
  globalThis.canvas = canvasFor(scene, primary);
  canvas.level = {_id: "defaultLevel0000"};
  hookCallbacks.get("canvasReady")[0]();
  await wait();
  assert.equal(primary.children.length, 1);
  assert.ok(level.edges.size > 0);

  canvas.level = null;
  hookCallbacks.get("canvasPan")[0]();
  await wait();
  assert.equal(primary.children.length, 1, "missing viewed Level still draws when initialLevel matches");
});

test("alter Region retextures covered cells and leaves occupancy alone", async () => {
  const loaded = [];
  const previousLoad = foundry.canvas.loadTexture;
  foundry.canvas.loadTexture = async src => {
    loaded.push(src);
    return {src, width: 100, height: 100};
  };
  try {
    const scene = createScene(source({width: 2, height: 1, logicalCells: [0, 1], intactGrid: 1}));
    scene.regions = {
      contents: [{
        hidden: false,
        levels: ["ground"],
        bounds: {x: 0, y: 0, width: 100, height: 100},
        elevation: {bottom: 0, top: null},
        behaviors: [{
          type: "theiks-toolbag.alterDiggable",
          disabled: false,
          system: {intactSrc: "moss.webp", intactGrid: 2}
        }],
        testPoint(point) {
          if (!Number.isFinite(point?.elevation)) return false;
          return point.x >= 0 && point.x < 100 && point.y >= 0 && point.y < 100;
        }
      }]
    };
    const primary = new Primary();
    globalThis.canvas = canvasFor(scene, primary);
    hookCallbacks.get("canvasReady")[0]();
    await wait();
    const left = primary.children.find(child => child.name.endsWith(".0"));
    const sheet = primary.children.find(child => child.name.endsWith(".sheet"));
    assert.equal(left.texture.src, "moss.webp");
    assert.equal(left.texture.frame.width, 50);
    assert.equal(sheet.texture.src, "earth.webp");
    assert.ok(sheet.holeMask?.alphas, "the sheet is punched where Alter owns the undug texture");
    assert.equal(sheet.holeMask.alphas[0], 0);
    assert.equal(loaded.filter(src => src === "moss.webp").length, 1);
  } finally {
    foundry.canvas.loadTexture = previousLoad;
  }
});

test("alter can retexture forced earth and still cannot show suppressed meshes", async () => {
  const scene = createScene(source({width: 2, height: 1, logicalCells: [0]}));
  scene.regions = {
    contents: [
      {
        hidden: false,
        levels: ["ground"],
        bounds: {x: 100, y: 0, width: 100, height: 100},
        elevation: {bottom: 0, top: null},
        behaviors: [
          {type: "theiks-toolbag.forceDiggable", disabled: false},
          {
            type: "theiks-toolbag.alterDiggable",
            disabled: false,
            system: {intactSrc: "moss.webp"}
          }
        ],
        testPoint(point) {
          if (!Number.isFinite(point?.elevation)) return false;
          return point.x >= 100 && point.x < 200;
        }
      },
      {
        hidden: false,
        levels: ["ground"],
        bounds: {x: 0, y: 0, width: 100, height: 100},
        elevation: {bottom: 0, top: null},
        behaviors: [
          {type: "theiks-toolbag.suppressDiggable", disabled: false},
          {
            type: "theiks-toolbag.alterDiggable",
            disabled: false,
            system: {intactSrc: "ignored.webp"}
          }
        ],
        testPoint(point) {
          if (!Number.isFinite(point?.elevation)) return false;
          return point.x >= 0 && point.x < 100;
        }
      }
    ]
  };
  const previousLoad = foundry.canvas.loadTexture;
  foundry.canvas.loadTexture = async src => ({src, width: 100, height: 100});
  try {
    const primary = new Primary();
    globalThis.canvas = canvasFor(scene, primary);
    hookCallbacks.get("canvasReady")[0]();
    await wait();
    const names = primary.children.map(child => child.name).sort();
    assert.deepEqual(names, ["theiks-toolbag.undergroundTerrain.intact.1"]);
    const forced = primary.children[0];
    assert.equal(forced.texture.src, "moss.webp");
    assert.equal(forced.sortLayer, Primary.SORT_LAYERS.TILES);
  } finally {
    foundry.canvas.loadTexture = previousLoad;
  }
});

test("suppress hides earth meshes under tiles, not just occupancy", async () => {
  const scene = createScene(source({width: 2, height: 1, logicalCells: [0]}));
  scene.regions = {
    contents: [{
      hidden: false,
      levels: [],
      bounds: {x: 0, y: 0, width: 200, height: 100},
      elevation: {bottom: 0, top: null},
      behaviors: [{type: "theiks-toolbag.suppressDiggable", disabled: false}],
      testPoint(point) {
        if (!Number.isFinite(point?.elevation)) return false;
        return point.x >= 0 && point.x < 200 && point.y >= 0 && point.y < 100;
      }
    }]
  };
  const primary = new Primary();
  globalThis.canvas = canvasFor(scene, primary);
  hookCallbacks.get("canvasReady")[0]();
  await wait();
  assert.equal(primary.children.length, 0);
});

test("suppress punches holes in the undug sheet", async () => {
  const scene = createScene(source({width: 2, height: 1, logicalCells: [0, 1]}));
  scene.regions = {
    contents: [{
      hidden: false,
      levels: ["ground"],
      bounds: {x: 0, y: 0, width: 100, height: 100},
      elevation: {bottom: 0, top: null},
      behaviors: [{type: "theiks-toolbag.suppressDiggable", disabled: false}],
      testPoint(point) {
        if (!Number.isFinite(point?.elevation)) return false;
        return point.x >= 0 && point.x < 100 && point.y >= 0 && point.y < 100;
      }
    }]
  };
  const primary = new Primary();
  globalThis.canvas = canvasFor(scene, primary);
  hookCallbacks.get("canvasReady")[0]();
  await wait();
  const sheet = primary.children.find(child => child.name.endsWith(".sheet"));
  assert.ok(sheet, "unsuppressed cells still have the undug sheet");
  const alphas = sheet.holeMask.alphas;
  assert.equal(alphas[0], 0, "suppressed subcells are punched");
  assert.equal(alphas[4], 255, "the neighboring cell stays packed earth");
});

test("earth fills occupancy holes behind tiles instead of leaving black gaps", async () => {
  const flag = source({width: 3, height: 1, logicalCells: [0, 2]});
  const scene = createScene(flag);
  const primary = new Primary();
  globalThis.canvas = canvasFor(scene, primary);
  hookCallbacks.get("canvasReady")[0]();
  await wait();
  assert.deepEqual(primary.children.map(child => child.name).sort(), [
    "theiks-toolbag.undergroundTerrain.intact.sheet"
  ]);
  const hole = primary.children.find(child => child.name.endsWith(".sheet"));
  assert.equal(hole.sortLayer, Primary.SORT_LAYERS.SCENE);
  assert.equal(hole.sort, -2);
  assert.ok(scene.level.edges.size > 0);
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

test("a one-cell dig rebuilds rubble meshes without recreating the undug sheet", async () => {
  textureFromCalls = 0;
  const flag = source({width: 3, height: 1, logicalCells: [0, 1, 2]});
  const scene = createScene(flag);
  const primary = new Primary();
  globalThis.canvas = canvasFor(scene, primary);
  hookCallbacks.get("canvasReady")[0]();
  await wait();
  assert.equal(primary.children.length, 1);
  const constructedAfterReady = meshConstructs;
  const sheet = primary.children.find(child => child.name.endsWith(".sheet"));
  await digUnderground(scene, subcellsForLogicalIndexes([0], 3, 1));
  hookCallbacks.get("updateScene")[0](scene, {
    "flags.theiks-toolbag.undergroundTerrain.dugMask": scene.flags["theiks-toolbag"].undergroundTerrain.dugMask
  });
  await wait();
  assert.equal(meshConstructs - constructedAfterReady, 2, "the dug cell and its neighbor fringe are rebuilt");
  assert.equal(sheet.destroyed, false, "the undug sheet is not rebuilt for a dig");
  assert.equal(primary.children.includes(sheet), true);
  assert.ok(textureFromCalls > 0, "fade masks use Texture.from of a tiny canvas");
  assert.ok(primary.children.some(child => child.name.includes(".dug.")));
  const dug = primary.children.find(child => child.name.includes(".dug."));
  assert.equal(dug.sortLayer, Primary.SORT_LAYERS.SCENE);
  assert.equal(dug.sort, -1);
});

test("a mixed cell bakes a soft fade into a full-size mesh", async () => {
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
  const intact = primary.children.find(child => child.name.endsWith(".sheet"));
  const dug = primary.children.find(child => child.name.includes(".dug."));
  assert.equal(intact.mask, undefined);
  assert.equal(dug.mask, undefined);
  assert.equal(intact.texture.fromCanvas, undefined);
  assert.ok(dug.texture.fromCanvas);
  assert.deepEqual(dug.resized, {
    width: 101, height: 101, options: {fit: "fill", scaleX: 1, scaleY: 1}
  }, "faded dug cells still fill the whole grid square");
  const dugAlphas = maskAlphas(dug);
  assert.ok(dugAlphas.some(alpha => alpha > 0 && alpha < 255), "dug fade is soft");
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
  const sheet = primary.children.find(child => child.name.endsWith(".sheet"));
  const dugFringe = primary.children.find(child => child.name === "theiks-toolbag.undergroundTerrain.dug.1");
  const dug = primary.children.find(child => child.name === "theiks-toolbag.undergroundTerrain.dug.0");
  assert.ok(sheet, "packed earth stays on the undug sheet");
  assert.ok(dugFringe, "dug texture extends into the intact neighbor");
  assert.ok(dug, "the dug cell still draws rubble");
  const fringeAlphas = maskAlphas(dugFringe);
  assert.ok(alphaAt(fringeAlphas, 0, 16) > alphaAt(fringeAlphas, 31, 16),
    "dug fringe is stronger on the shared edge");
});

test("a rounded bevel darkens the rock lip without shading gravel", async () => {
  const scene = createScene(source({width: 2, height: 1, logicalCells: [0, 1]}));
  await digUnderground(scene, subcellsForLogicalIndexes([0], 2, 1));
  const data = getUndergroundData(scene);
  const dugSide = rockBevelShade(data, 0, 101, 50, 50);
  const mix = rockBevelShade(data, 1, 101, 2, 50);
  const lip = rockBevelShade(data, 1, 101, 8, 50);
  const deep = rockBevelShade(data, 1, 101, 25, 50);
  assert.equal(dugSide, 1, "gravel stays full color");
  assert.ok(mix < 1 && lip < mix, "the mix/rock-lip darkens toward the rounded wall");
  assert.ok(lip < 0.7 && lip > 0.5, "the rock lip darkens in a short band");
  assert.equal(deep, 1, "deep undug rock past the bevel is unchanged");
});

test("an interior intact cell with no dug neighbors stays fully opaque", async () => {
  const flag = source({width: 3, height: 1, logicalCells: [0, 1, 2]});
  const scene = createScene(flag);
  const primary = new Primary();
  globalThis.canvas = canvasFor(scene, primary);
  hookCallbacks.get("canvasReady")[0]();
  await wait();
  const far = primary.children.find(child => child.name.endsWith(".sheet"));
  assert.equal(far.mask, undefined);
  await digUnderground(scene, subcellsForLogicalIndexes([0], 3, 1));
  hookCallbacks.get("updateScene")[0](scene, {
    "flags.theiks-toolbag.undergroundTerrain.dugMask": scene.flags["theiks-toolbag"].undergroundTerrain.dugMask
  });
  await wait();
  const stillFar = primary.children.find(child => child.name.endsWith(".sheet"));
  assert.equal(stillFar.mask, undefined, "digging does not punch the undug sheet");
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

test("vision edges leave a lit fringe beside dug earth", async () => {
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
  const vertical = (kind) => [...scene.level.edges.values()]
    .filter(edge => String(edge.id).includes(`.${kind}.`) && edge.a.x === edge.b.x)
    .map(edge => edge.a.x);
  const moveXs = vertical("move");
  const visionXs = vertical("vision");
  assert.ok(moveXs.includes(100), "movement still stops at the dug face");
  assert.equal(visionXs.includes(100), false, "sight does not clip the fade at the dug face");
  assert.ok(visionXs.includes(150), "sight and light stop half a tile into intact earth");
});

test("the undug sheet tiles a 2x2 atlas across the Level", async () => {
  textureFromCalls = 0;
  const scene = createScene(source({intactGrid: 2, dugGrid: 1}));
  const primary = new Primary();
  globalThis.canvas = canvasFor(scene, primary);
  hookCallbacks.get("canvasReady")[0]();
  await wait();
  const sheet = primary.children.find(child => child.name.endsWith(".sheet"));
  assert.equal(sheet.texture.src, "earth.webp");
  assert.deepEqual(sheet.tileRepeat, [1, 0.5]);
  assert.equal(textureFromCalls, 0, "tiled earth still uses loadTexture, not Texture.from");
});

test("a 5x5 spanning texture uses 200px windows from a 1000px image", async () => {
  const previousLoad = foundry.canvas.loadTexture;
  foundry.canvas.loadTexture = async src => ({src, width: 1000, height: 1000});
  try {
    const scene = createScene(source({
      width: 5, height: 1, gridSize: 200, intactGrid: 5, dugGrid: 5,
      logicalCells: [0, 1, 2, 3, 4]
    }));
    const primary = new Primary();
    globalThis.canvas = canvasFor(scene, primary);
    hookCallbacks.get("canvasReady")[0]();
    await wait();
    const sheet = primary.children.find(child => child.name.endsWith(".sheet"));
    assert.deepEqual(sheet.tileRepeat, [1, 1 / 5]);
  } finally {
    foundry.canvas.loadTexture = previousLoad;
  }
});

test("the undug sheet covers every default cell with one mesh", async () => {
  const scene = createScene(source({
    width: 4, height: 1, intactGrid: 2, logicalCells: [0, 1, 2, 3]
  }));
  const primary = new Primary();
  globalThis.canvas = canvasFor(scene, primary);
  hookCallbacks.get("canvasReady")[0]();
  await wait();
  const sheets = primary.children.filter(child => child.name.endsWith(".sheet"));
  assert.equal(sheets.length, 1);
  assert.deepEqual(sheets[0].tileRepeat, [2, 0.5]);
});

test("visibleLogicalIndexes uses the view plus a 2-cell pad", () => {
  const scene = createScene(source({
    width: 8, height: 8, logicalCells: [...Array(64).keys()]
  }));
  const data = getUndergroundData(scene);
  const whole = visibleLogicalIndexes(data, null);
  assert.equal(whole.size, 64, "missing bounds keep the full grid");
  const nearby = visibleLogicalIndexes(data, {x: 0, y: 0, width: 100, height: 100});
  assert.deepEqual([...nearby].sort((a, b) => a - b), [0, 1, 2, 8, 9, 10, 16, 17, 18]);
  const center = visibleLogicalIndexes(data, {x: 400, y: 400, width: 100, height: 100});
  assert.equal(center.has(4 + (4 * 8)), true);
  assert.equal(center.has(2 + (2 * 8)), true);
  assert.equal(center.has(6 + (6 * 8)), true);
  assert.equal(center.has(1 + (4 * 8)), false);
  assert.equal(center.has(4 + (1 * 8)), false);
});

test("panning does not rebuild the undug sheet", async () => {
  const scene = createScene(source({
    width: 8, height: 1, intactGrid: 2, logicalCells: [0, 1, 2, 3, 4, 5, 6, 7]
  }));
  const primary = new Primary();
  globalThis.canvas = canvasFor(scene, primary);
  canvas.viewPosition = {x: 50, y: 50, scale: 1};
  canvas.screenDimensions = [100, 100];
  hookCallbacks.get("canvasReady")[0]();
  await wait();
  assert.deepEqual(primary.children.map(child => child.name), [
    "theiks-toolbag.undergroundTerrain.intact.sheet"
  ]);
  const sheet = primary.children[0];
  const constructed = meshConstructs;
  canvas.viewPosition = {x: 350, y: 50, scale: 1};
  hookCallbacks.get("canvasPan")[0]();
  await wait();
  assert.equal(primary.children[0], sheet);
  assert.equal(meshConstructs, constructed, "panning does not create earth meshes");
  canvas.viewPosition = {x: 650, y: 50, scale: 1};
  hookCallbacks.get("canvasPan")[0]();
  await wait();
  assert.equal(primary.children[0], sheet);
  assert.equal(primary.children.length, 1);
});

test("dug cells keep their meshes after they leave the view", async () => {
  const scene = createScene(source({
    width: 8, height: 1, logicalCells: [0, 1, 2, 3, 4, 5, 6, 7]
  }));
  const primary = new Primary();
  globalThis.canvas = canvasFor(scene, primary);
  canvas.viewPosition = {x: 50, y: 50, scale: 1};
  canvas.screenDimensions = [100, 100];
  hookCallbacks.get("canvasReady")[0]();
  await wait();
  await digUnderground(scene, subcellsForLogicalIndexes([0], 8, 1));
  hookCallbacks.get("updateScene")[0](scene, {
    "flags.theiks-toolbag.undergroundTerrain.dugMask": scene.flags["theiks-toolbag"].undergroundTerrain.dugMask
  });
  await wait();
  const dug = primary.children.find(child => child.name === "theiks-toolbag.undergroundTerrain.dug.0");
  const fringe = primary.children.find(child => child.name === "theiks-toolbag.undergroundTerrain.dug.1");
  assert.ok(dug);
  assert.ok(fringe);
  canvas.viewPosition = {x: 650, y: 50, scale: 1};
  hookCallbacks.get("canvasPan")[0]();
  await wait();
  assert.equal(primary.children.includes(dug), true, "baked dug earth is not torn down offscreen");
  assert.equal(primary.children.includes(fringe), true, "the fade neighbor stays ready");
  canvas.viewPosition = {x: 50, y: 50, scale: 1};
  hookCallbacks.get("canvasPan")[0]();
  await wait();
  assert.equal(
    primary.children.find(child => child.name === "theiks-toolbag.undergroundTerrain.dug.0"),
    dug,
    "returning to the hole does not rebake it"
  );
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
