import assert from "node:assert/strict";

const hooks = new Map();
globalThis.Hooks = {
  once: (name, callback) => {
    const callbacks = hooks.get(name) ?? [];
    callbacks.push(callback);
    hooks.set(name, callbacks);
  },
  on: (name, callback) => {
    const callbacks = hooks.get(name) ?? [];
    callbacks.push(callback);
    hooks.set(name, callbacks);
  }
};

class FakeContainer {
  constructor() {
    this.children = [];
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

  destroy({children} = {}) {
    if (children) for (const child of this.children) child.destroy?.({children: true});
    this.children = [];
    this.destroyed = true;
  }
}

class FakeControlIcon {
  constructor(options) {
    this.options = options;
    this.handlers = new Map();
    this.icon = {tint: null};
    this.position = {set: (x, y) => { this.positionValue = {x, y}; }};
    this.eventMode = "static";
  }

  async draw() {
    return this;
  }

  on(name, callback) {
    this.handlers.set(name, callback);
  }

  destroy() {
    this.destroyed = true;
    this.removeFromParent();
  }

  removeFromParent() {
    if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this);
    this.parent = null;
  }
}

globalThis.PIXI = {Container: FakeContainer};
globalThis.foundry = {
  utils: {
    hasProperty: () => false,
    getProperty: () => undefined
  },
  canvas: {
    containers: {ControlIcon: FakeControlIcon}
  }
};

const gm = {id: "gm", active: true, isGM: true};
const player = {id: "player", active: true, isGM: false};
let wallCollision = false;
globalThis.CONFIG = {
  Canvas: {
    polygonBackends: {
      move: {testCollision: () => wallCollision}
    }
  }
};
globalThis.game = {
  user: gm,
  users: {activeGM: gm},
  settings: {get: () => true},
  i18n: {localize: key => key}
};
globalThis.ui = {
  notifications: {warn: () => {}}
};

const flag = {
  destroyed: true,
  images: {on: "on.webp", off: "off.webp", destroyed: "broken.webp"}
};
const level = {id: "ground"};
const scene = {
  id: "scene",
  grid: {size: 100},
  levels: new Map([[level.id, level]]),
  lights: new Map(),
  initializeEdges: () => {}
};
const document = {
  documentName: "AmbientLight",
  id: "light",
  uuid: "Scene.scene.AmbientLight.light",
  x: 150,
  y: 250,
  _source: {x: 150, y: 250, elevation: 0, level: level.id},
  hidden: true,
  parent: scene,
  getFlag: () => flag,
  update: async changes => {
    if (Object.hasOwn(changes, "flags.theiks-toolbag.visibleLight.destroyed")) {
      flag.destroyed = changes["flags.theiks-toolbag.visibleLight.destroyed"];
    }
    if (Object.hasOwn(changes, "hidden")) document.hidden = changes.hidden;
    return document;
  }
};
scene.lights.set(document.id, document);
const light = {id: document.id, document};
const tokenLayer = {controlled: []};
const controls = new FakeContainer();
globalThis.canvas = {
  ready: true,
  scene,
  level,
  activeLayer: tokenLayer,
  tokens: tokenLayer,
  controls,
  lighting: {placeables: [light]},
  grid: {},
  dimensions: {size: 100, uiScale: 1}
};

const {registerVisibleLightControls} = await import("../scripts/visible-lights/light-controls.js");
registerVisibleLightControls();

for (const callback of hooks.get("canvasReady") ?? []) callback();
await flushAsyncWork();

assert.equal(controls.children.length, 1);
let markerContainer = controls.children[0];
assert.equal(markerContainer.children.length, 1, "a GM sees a marker for a destroyed fixture");
const repairMarker = markerContainer.children[0];
assert.equal(repairMarker.options.texture, "icons/svg/regen.svg");
assert.equal(repairMarker.options.borderColor, 0x4CAF50);
assert.equal(repairMarker.options.tint, 0x4CAF50);
assert.deepEqual(repairMarker.positionValue, {x: 150, y: 250});

let propagationStopped = false;
repairMarker.handlers.get("pointerdown")({
  button: 0,
  stopPropagation: () => { propagationStopped = true; }
});
await flushAsyncWork();
assert.equal(propagationStopped, true);
assert.equal(flag.destroyed, false, "left-clicking the green marker repairs the fixture");
assert.equal(document.hidden, true, "marker repair leaves the fixture switched off");

flag.destroyed = true;
game.user = player;
for (const callback of hooks.get("canvasReady") ?? []) callback();
await flushAsyncWork();
markerContainer = controls.children[0];
assert.equal(markerContainer.children.length, 0, "players do not see repair controls for destroyed fixtures");

flag.destroyed = false;
const tokenDocument = {
  parent: scene,
  _source: {
    x: 100,
    y: 300,
    width: 1,
    height: 1,
    depth: 1,
    elevation: 0,
    shape: 0,
    level: level.id
  },
  getMovementOrigin: source => ({x: source.x + 50, y: source.y + 50, elevation: 2.5}),
  getOccupiedGridSpaceOffsets: () => [{i: 3, j: 1, k: 0}],
  testUserPermission: user => user === player
};
canvas.grid = {
  size: 100,
  getOffset: ({x, y}) => ({i: Math.floor(y / 100), j: Math.floor(x / 100), k: 0}),
  testAdjacency: (a, b) => Math.max(Math.abs(a.i - b.i), Math.abs(a.j - b.j)) === 1
};
canvas.tokens.controlled = [{document: tokenDocument}];
wallCollision = true;
for (const callback of hooks.get("canvasReady") ?? []) callback();
await flushAsyncWork();
markerContainer = controls.children[0];
assert.equal(markerContainer.children.length, 0, "a wall hides the player's otherwise-adjacent control");

wallCollision = false;
for (const callback of hooks.get("updateWall") ?? []) callback({parent: scene});
await flushAsyncWork();
markerContainer = controls.children[0];
assert.equal(markerContainer.children.length, 1, "opening a route refreshes and reveals the player control");

console.log("visible light marker tests passed");

async function flushAsyncWork() {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
  await new Promise(resolve => setImmediate(resolve));
}
