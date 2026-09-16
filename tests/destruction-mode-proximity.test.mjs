import assert from "node:assert/strict";

const registeredHooks = new Map();
globalThis.Hooks = {
  on: (name, callback) => {
    const callbacks = registeredHooks.get(name) ?? [];
    callbacks.push(callback);
    registeredHooks.set(name, callbacks);
  },
  callAll() {}
};

class Container {
  constructor() {
    this.children = [];
    this.parent = null;
    this.name = "";
  }

  addChild(child) {
    child.parent = this;
    this.children.push(child);
    return child;
  }

  removeFromParent() {
    if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this);
    this.parent = null;
  }

  destroy({children = false} = {}) {
    if (children) {
      for (const child of [...this.children]) child.destroy?.({children: true});
      this.children = [];
    }
    this.removeFromParent();
  }
}

class ControlIcon {
  constructor(options) {
    this.options = options;
    this.icon = {tint: options.tint ?? 0xFFFFFF};
    this.handlers = new Map();
    this.parent = null;
    this.position = {set: (x, y) => Object.assign(this.position, {x, y})};
  }

  async draw() { return this; }

  on(name, callback) {
    this.handlers.set(name, callback);
    return this;
  }

  destroy() { this.removeFromParent(); }

  removeFromParent() {
    if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this);
    this.parent = null;
  }
}

const pointerListeners = [];
const stage = {
  on(name, callback) {
    if (name === "pointermove") pointerListeners.push(callback);
  },
  off(name, callback) {
    if (name !== "pointermove") return;
    const index = pointerListeners.indexOf(callback);
    if (index >= 0) pointerListeners.splice(index, 1);
  }
};

globalThis.PIXI = {Container};
globalThis.CONST = {
  EDGE_SENSE_TYPES: {NONE: 0},
  WALL_MOVEMENT_TYPES: {NONE: 0},
  WALL_DOOR_TYPES: {NONE: 0}
};
globalThis.foundry = {
  applications: {api: {DialogV2: {wait: async () => "cancel"}}},
  canvas: {
    containers: {ControlIcon},
    loadTexture: async src => ({src, valid: true, width: 2, height: 2})
  }
};
const featureSettings = {
  enableBreakableWalls: true,
  enableBreakableTerrain: true
};
globalThis.game = {
  user: {isGM: true},
  settings: {get: (_namespace, key) => featureSettings[key]},
  i18n: {localize: key => key, format: (key, data) => `${key}:${JSON.stringify(data)}`}
};
globalThis.ui = {notifications: {error() {}}};
globalThis.requestAnimationFrame = callback => setTimeout(callback, 0);
globalThis.cancelAnimationFrame = id => clearTimeout(id);

const controlsLayer = new Container();
controlsLayer.doors = {visible: true};
const scene = {id: "scene", walls: new Map(), tiles: new Map()};
globalThis.canvas = {
  ready: true,
  scene,
  stage,
  controls: controlsLayer,
  mousePosition: {x: 50, y: 0},
  grid: {size: 100},
  dimensions: {uiScale: 1, size: 100},
  level: {id: "ground"},
  walls: {placeables: []},
  tiles: {placeables: []}
};

function tick() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

function createWall(id, x) {
  const document = {
    documentName: "Wall",
    id,
    parent: scene,
    levels: new Set(),
    getFlag: () => ({enabled: true, destroyed: false, images: {both: "", single: ""}})
  };
  const placeable = {id, document, midpoint: [x, 0]};
  scene.walls.set(id, document);
  canvas.walls.placeables.push(placeable);
  return placeable;
}

function createTile(id, x) {
  const document = {
    documentName: "Tile",
    id,
    parent: scene,
    levels: new Set(),
    shape: {center: {x, y: 0}},
    getFlag: () => ({enabled: true, states: ["rubble.webp"], stage: 0})
  };
  const placeable = {id, document};
  scene.tiles.set(id, document);
  canvas.tiles.placeables.push(placeable);
  return placeable;
}

for (let index = 0; index < 150; index++) {
  createWall(`wall-${index}`, index * 100);
  createTile(`tile-${index}`, index * 100);
}

const {registerWallDestructionMode} = await import("../scripts/breakable-walls/destruction-mode.js");
const {registerTerrainDestructionMode} = await import("../scripts/breakable-terrain/destruction-mode.js");
registerWallDestructionMode();
registerTerrainDestructionMode();

const {DESTRUCTION_MARKER_LIMIT} = await import("../scripts/destruction-marker-proximity.js");
assert.equal(canvas.walls.placeables.length + canvas.tiles.placeables.length, 300);
assert.ok(300 >= DESTRUCTION_MARKER_LIMIT);

const controls = {walls: {tools: {}}, tiles: {tools: {}}};
for (const callback of registeredHooks.get("getSceneControlButtons") ?? []) callback(controls);
controls.walls.tools.theiksToolbagDestroyWalls.onChange(null, true);
controls.tiles.tools.theiksToolbagDestroyTerrain.onChange(null, true);
await tick();

function markerXs(name) {
  const container = controlsLayer.children.find(child => child.name === name);
  return (container?.children ?? []).map(marker => marker.position.x).toSorted((a, b) => a - b);
}

assert.deepEqual(
  markerXs("theiks-toolbag.breakableWallMarkers"),
  [0, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 1100, 1200, 1300, 1400, 1500, 1600, 1700, 1800, 1900, 2000],
  "crowded wall markers stay inside a 20-grid cursor radius"
);
assert.deepEqual(
  markerXs("theiks-toolbag.breakableTerrainMarkers"),
  [0, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 1100, 1200, 1300, 1400, 1500, 1600, 1700, 1800, 1900, 2000],
  "crowded terrain markers stay inside the same cursor radius"
);
assert.equal(pointerListeners.length, 1, "wall and terrain modes share one cursor listener");

canvas.mousePosition = {x: 5000, y: 0};
pointerListeners[0]({getLocalPosition: () => ({x: 5000, y: 0})});
await tick();
await tick();

assert.deepEqual(
  markerXs("theiks-toolbag.breakableWallMarkers"),
  [3000, 3100, 3200, 3300, 3400, 3500, 3600, 3700, 3800, 3900, 4000, 4100, 4200, 4300, 4400, 4500, 4600, 4700, 4800, 4900, 5000, 5100, 5200, 5300, 5400, 5500, 5600, 5700, 5800, 5900, 6000, 6100, 6200, 6300, 6400, 6500, 6600, 6700, 6800, 6900, 7000],
  "moving the cursor replaces distant wall markers instead of drawing the whole Scene"
);
assert.deepEqual(
  markerXs("theiks-toolbag.breakableTerrainMarkers"),
  [3000, 3100, 3200, 3300, 3400, 3500, 3600, 3700, 3800, 3900, 4000, 4100, 4200, 4300, 4400, 4500, 4600, 4700, 4800, 4900, 5000, 5100, 5200, 5300, 5400, 5500, 5600, 5700, 5800, 5900, 6000, 6100, 6200, 6300, 6400, 6500, 6600, 6700, 6800, 6900, 7000],
  "terrain markers follow the cursor the same way"
);

controls.walls.tools.theiksToolbagDestroyWalls.onChange(null, false);
controls.tiles.tools.theiksToolbagDestroyTerrain.onChange(null, false);
assert.equal(controlsLayer.children.length, 0);
assert.equal(pointerListeners.length, 0);

console.log("destruction-mode proximity tests passed");
