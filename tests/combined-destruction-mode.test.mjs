import assert from "node:assert/strict";

const registeredHooks = new Map();
globalThis.Hooks = {
  on: (name, callback) => {
    const callbacks = registeredHooks.get(name) ?? [];
    callbacks.push(callback);
    registeredHooks.set(name, callbacks);
  }
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

globalThis.PIXI = {Container};
globalThis.foundry = {canvas: {containers: {ControlIcon}}};
const featureSettings = {
  enableBreakableWalls: true,
  enableBreakableTerrain: true
};
globalThis.game = {
  user: {isGM: true},
  settings: {get: (_namespace, key) => featureSettings[key]}
};

const controlsLayer = new Container();
controlsLayer.doors = {visible: true};
const wallFlag = {
  enabled: true,
  destroyed: false,
  images: {both: "rubble.webp", single: "rubble.webp"},
  destruction: null,
  restore: null
};
const tileFlag = {
  enabled: true,
  blocksMovement: false,
  blocksVision: false,
  states: ["rubble.webp"],
  stage: 0,
  restoreSrc: null
};
const scene = {
  id: "scene",
  walls: new Map(),
  tiles: new Map()
};
const wallDocument = {
  documentName: "Wall",
  id: "wall",
  parent: scene,
  levels: new Set(),
  getFlag: () => wallFlag
};
const tileDocument = {
  documentName: "Tile",
  id: "tile",
  parent: scene,
  levels: new Set(),
  shape: {center: {x: 150, y: 100}},
  getFlag: () => tileFlag
};
scene.walls.set(wallDocument.id, wallDocument);
scene.tiles.set(tileDocument.id, tileDocument);

globalThis.canvas = {
  ready: true,
  scene,
  controls: controlsLayer,
  dimensions: {uiScale: 1},
  level: {id: "ground"},
  walls: {placeables: [{id: "wall", document: wallDocument, midpoint: [50, 100]}]},
  tiles: {placeables: [{id: "tile", document: tileDocument}]}
};

const {registerCombinedDestructionMode} = await import("../scripts/combined-destruction-mode.js");
registerCombinedDestructionMode();

const controls = {tokens: {name: "tokens", order: 1, tools: {}}};
for (const callback of registeredHooks.get("getSceneControlButtons") ?? []) callback(controls);
const combined = controls.theiksToolbagDestruction;
assert.ok(combined, "a GM receives the top-level combined destruction control");
assert.equal(combined.order, 100, "the combined control is placed after Foundry's normal layer controls");
assert.equal(combined.icon, "fa-solid fa-hammer", "the combined control uses the destruction hammer icon");
assert.deepEqual(
  Object.keys(combined.tools),
  ["theiksToolbagDestructionMode", "theiksToolbagResetDestructables"],
  "the combined control exposes destruction mode and the one-shot reset button"
);
assert.equal(combined.activeTool, "theiksToolbagDestructionMode", "destruction mode remains the default tool");
const mode = combined.tools.theiksToolbagDestructionMode;
const reset = combined.tools.theiksToolbagResetDestructables;
assert.equal(mode.button, undefined, "destruction mode is a selectable tool");
assert.equal(reset.button, true, "reset is a one-shot button which does not replace the active tool");
assert.equal(reset.icon, "fa-solid fa-arrow-rotate-left");

mode.onChange(null, true);
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(controlsLayer.doors.visible, false, "combined destruction mode hides native door controls");
assert.deepEqual(
  controlsLayer.children.map(container => container.name).sort(),
  ["theiks-toolbag.breakableTerrainMarkers", "theiks-toolbag.breakableWallMarkers"],
  "the combined control activates wall and terrain markers together"
);
assert.ok(controlsLayer.children.every(container => container.children.length === 1));

mode.onChange(null, false);
assert.equal(controlsLayer.children.length, 0, "leaving the combined control removes both marker sets");
assert.equal(controlsLayer.doors.visible, true, "leaving the combined control restores native door controls");

game.user.isGM = false;
const nonGmControls = {};
for (const callback of registeredHooks.get("getSceneControlButtons") ?? []) callback(nonGmControls);
assert.equal(nonGmControls.theiksToolbagDestruction, undefined);

game.user.isGM = true;
featureSettings.enableBreakableWalls = false;
featureSettings.enableBreakableTerrain = false;
const disabledControls = {};
for (const callback of registeredHooks.get("getSceneControlButtons") ?? []) callback(disabledControls);
assert.equal(disabledControls.theiksToolbagDestruction, undefined, "the combined mode is hidden when both features are off");

console.log("combined destruction-mode tests passed");
