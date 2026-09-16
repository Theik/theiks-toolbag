import assert from "node:assert/strict";
import test from "node:test";

const hooks = new Map();
globalThis.Hooks = {on: (name, callback) => {
  const list = hooks.get(name) ?? [];
  list.push(callback);
  hooks.set(name, list);
}};
globalThis.game = {
  user: {isGM: true}, settings: {get: () => true},
  i18n: {localize: key => key, format: (key, data) => `${key}:${data.size}`}
};
globalThis.ui = {notifications: {info() {}, error() {}}};
class Graphics {
  clear() { return this; }
  rect() { return this; }
  fill() { return this; }
  removeFromParent() {}
  destroy() {}
}
globalThis.PIXI = {Graphics};

const listeners = new Map();
const stage = {
  on: (name, callback) => listeners.set(name, callback),
  off: name => listeners.delete(name)
};
const controlsLayer = {addChild() {}};
const windowListeners = new Map();
globalThis.window = {
  addEventListener: (name, callback) => windowListeners.set(name, callback),
  removeEventListener: name => windowListeners.delete(name)
};

const {createUndergroundSource, subcellsForLogicalIndexes} = await import("../scripts/underground/underground-data.js");
const source = createUndergroundSource({
  levelId: "ground", origin: {x: 0, y: 0}, width: 3, height: 3, gridSize: 100,
  cells: subcellsForLogicalIndexes([0, 1, 2, 3, 4, 5, 6, 7, 8], 3, 3),
  intactSrc: "earth.webp", dugSrc: "rubble.webp", blocksMovement: true, blocksVision: true
});
const scene = {
  documentName: "Scene", flags: {"theiks-toolbag": {undergroundTerrain: source}}, updates: [],
  getFlag(module, key) { return this.flags[module]?.[key]; },
  async update(change) {
    this.updates.push(change);
    this.flags["theiks-toolbag"].undergroundTerrain.dugMask = change["flags.theiks-toolbag.undergroundTerrain.dugMask"];
    return this;
  }
};
globalThis.canvas = {
  ready: true, scene, level: {id: "ground"}, stage, controls: controlsLayer,
  canvasCoordinatesFromClient: point => point,
  mousePosition: {x: 0, y: 0}
};

const {registerUndergroundControls} = await import("../scripts/underground/underground-controls.js");
registerUndergroundControls();

function pointer(x, y) {
  return {
    button: 0, clientX: x, clientY: y,
    getLocalPosition: () => ({x, y}),
    stopPropagation() {}, preventDefault() {}
  };
}

test("a dragged stroke deduplicates cells and commits one Scene update", async () => {
  const controls = {theiksToolbagDestruction: {tools: {}}};
  hooks.get("getSceneControlButtons")[0](controls);
  const tools = controls.theiksToolbagDestruction.tools;
  tools.theiksToolbagExcavate.onChange(null, true);
  listeners.get("pointerdown")(pointer(50, 50));
  listeners.get("pointermove")(pointer(50, 50));
  listeners.get("pointermove")(pointer(150, 50));
  await listeners.get("pointerup")(pointer(150, 50));
  assert.equal(scene.updates.length, 1);
});

test("Escape cancels a pending excavation stroke", async () => {
  listeners.get("pointerdown")(pointer(250, 250));
  windowListeners.get("keydown")({key: "Escape", preventDefault() {}});
  await listeners.get("pointerup")(pointer(250, 250));
  assert.equal(scene.updates.length, 1);
});

test("excavation tools stay hidden when underground is disabled", () => {
  scene.flags["theiks-toolbag"].undergroundTerrain.enabled = false;
  const controls = {theiksToolbagDestruction: {tools: {}}};
  hooks.get("getSceneControlButtons")[0](controls);
  assert.equal("theiksToolbagExcavate" in controls.theiksToolbagDestruction.tools, false);
  scene.flags["theiks-toolbag"].undergroundTerrain.enabled = true;
});

test("excavation does not register a brush-size control", () => {
  const controls = {theiksToolbagDestruction: {tools: {}}};
  hooks.get("getSceneControlButtons")[0](controls);
  const tools = controls.theiksToolbagDestruction.tools;
  assert.equal("theiksToolbagExcavateSize" in tools, false);
  assert.ok(tools.theiksToolbagExcavate);
  assert.ok(tools.theiksToolbagExcavateRepair);
});
