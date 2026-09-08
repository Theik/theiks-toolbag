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
  },
  callAll: (name, ...args) => {
    for (const callback of hooks.get(name) ?? []) callback(...args);
  }
};

class Container {
  constructor() { this.children = []; }
  addChild(child) { child.parent = this; this.children.push(child); return child; }
  removeFromParent() {
    if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this);
    this.parent = null;
  }
  destroy({children} = {}) {
    if (children) for (const child of this.children) child.destroy?.();
    this.children = [];
  }
}
class ControlIcon {
  constructor(options) {
    this.options = options;
    this.handlers = new Map();
    this.icon = {tint: null, scale: {x: 1, y: 1}, anchor: {x: 0, y: 0}};
    this.position = {set: (x, y) => { this.positionValue = {x, y}; }};
    this.eventMode = "static";
  }
  async draw() { return this; }
  on(name, callback) { this.handlers.set(name, callback); }
  removeFromParent() {
    if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this);
    this.parent = null;
  }
  destroy() { this.removeFromParent(); this.destroyed = true; }
}

globalThis.PIXI = {Container};
globalThis.foundry = {
  utils: {equals: (a, b) => JSON.stringify(a) === JSON.stringify(b)},
  canvas: {containers: {ControlIcon}}
};
const gm = {id: "gm", active: true, isGM: true};
globalThis.game = {
  user: gm,
  users: {activeGM: gm},
  settings: {get: () => true},
  i18n: {localize: key => key}
};
const usable = {enabled: true, states: ["off.webp", "on.webp"], index: 0, direction: "towardOn"};
const breakable = {enabled: true, states: ["broken.webp"], stage: 0};
const scene = {id: "scene", tiles: new Map(), grid: {size: 100}};
const document = {
  id: "tile",
  documentName: "Tile",
  parent: scene,
  shape: {center: {x: 150, y: 250}},
  _source: {x: 100, y: 200, width: 100, height: 100, elevation: 0},
  getFlag: (_module, key) => key === "usableTile" ? usable : (key === "breakableTerrain" ? breakable : undefined)
};
scene.tiles.set(document.id, document);
const tile = {id: document.id, document};
const tokenLayer = {controlled: []};
const controls = new Container();
globalThis.canvas = {
  ready: true,
  scene,
  activeLayer: tokenLayer,
  tokens: tokenLayer,
  tiles: {placeables: [tile]},
  controls,
  dimensions: {size: 100, uiScale: 1}
};

const {registerUsableTileControls} = await import("../scripts/usable-tiles/tile-controls.js");
const {setTerrainDestructionModeActive} = await import("../scripts/breakable-terrain/destruction-mode.js");
registerUsableTileControls();

for (const callback of hooks.get("canvasReady") ?? []) callback();
await flush();
assert.equal(controls.children.length, 1);
assert.equal(controls.children[0].children.length, 1);
const marker = controls.children[0].children[0];
assert.equal(marker.options.texture, "icons/svg/lever.svg");
assert.deepEqual(marker.positionValue, {x: 150, y: 250});
assert.equal(marker.icon.scale.x, -1, "the lever is mirrored while the Tile moves toward on");
assert.equal(marker.icon.anchor.x, 1, "mirroring keeps the lever inside its original horizontal bounds");

usable.direction = "towardOff";
usable.index = 1;
for (const callback of hooks.get("updateTile") ?? []) callback(document);
await flush();
assert.equal(
  controls.children.find(container => container.name === "theiks-toolbag.usableTileMarkers")?.children[0]?.icon.scale.x,
  1,
  "the lever uses its normal orientation while the Tile moves toward off"
);
assert.equal(
  controls.children.find(container => container.name === "theiks-toolbag.usableTileMarkers")?.children[0]?.icon.anchor.x,
  0,
  "the normal lever keeps Foundry's original anchor"
);

setTerrainDestructionModeActive(true);
await flush();
assert.equal(
  controls.children.some(container => container.name === "theiks-toolbag.usableTileMarkers"),
  false,
  "the destruction view suppresses lever markers"
);
setTerrainDestructionModeActive(false);
await flush();
assert.equal(
  controls.children.find(container => container.name === "theiks-toolbag.usableTileMarkers")?.children.length,
  1
);

document.hidden = true;
for (const callback of hooks.get("updateTile") ?? []) callback(document);
await flush();
assert.equal(
  controls.children.find(container => container.name === "theiks-toolbag.usableTileMarkers")?.children.length,
  0,
  "hidden Tiles never show lever markers"
);
document.hidden = false;
for (const callback of hooks.get("updateTile") ?? []) callback(document);
await flush();
assert.equal(
  controls.children.find(container => container.name === "theiks-toolbag.usableTileMarkers")?.children.length,
  1,
  "revealing a Tile restores its lever marker"
);

breakable.stage = 1;
for (const callback of hooks.get("updateTile") ?? []) callback(document);
await flush();
assert.equal(
  controls.children.find(container => container.name === "theiks-toolbag.usableTileMarkers")?.children.length,
  0,
  "damaged Tiles never show lever markers"
);

console.log("usable Tile marker tests passed");

async function flush() {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
  await new Promise(resolve => setImmediate(resolve));
}
