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
  addEventListener: (name, callback) => {
    const list = windowListeners.get(name) ?? [];
    list.push(callback);
    windowListeners.set(name, list);
  },
  removeEventListener: (name, callback) => {
    const list = (windowListeners.get(name) ?? []).filter(entry => entry !== callback);
    windowListeners.set(name, list);
  }
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
      const full = change["flags.theiks-toolbag.undergroundTerrain"];
      if (full?.dugMask) this.flags["theiks-toolbag"].undergroundTerrain = full;
      else if (change["flags.theiks-toolbag.undergroundTerrain.dugMask"]) {
        this.flags["theiks-toolbag"].undergroundTerrain.dugMask = change["flags.theiks-toolbag.undergroundTerrain.dugMask"];
      }
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
  canvas.mousePosition = {x, y};
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
  assert.equal(typeof scene.updates[0]["flags.theiks-toolbag.undergroundTerrain"]?.dugMask, "string");
});

test("moving the pointer does not commit until the mouse is released", async () => {
  const before = scene.updates.length;
  listeners.get("pointerdown")(pointer(250, 50));
  const move = pointer(250, 50);
  move.buttons = 0;
  listeners.get("pointermove")(move);
  assert.equal(scene.updates.length, before);
  await listeners.get("pointerup")(move);
  assert.equal(scene.updates.length, before + 1);
});

test("a second press during a stroke keeps painting until release", async () => {
  const before = scene.updates.length;
  listeners.get("pointerdown")(pointer(50, 150));
  listeners.get("pointermove")(pointer(150, 150));
  listeners.get("pointerdown")(pointer(50, 150));
  assert.equal(scene.updates.length, before);
  await listeners.get("pointerup")(pointer(50, 150));
  assert.equal(scene.updates.length, before + 1);
});

test("Escape cancels a pending excavation stroke", async () => {
  const before = scene.updates.length;
  listeners.get("pointerdown")(pointer(250, 250));
  windowListeners.get("keydown")[0]({key: "Escape", preventDefault() {}});
  await listeners.get("pointerup")(pointer(250, 250));
  assert.equal(scene.updates.length, before);
});

test("a stroke that starts off earth still commits after dragging onto a cell", async () => {
  const before = scene.updates.length;
  listeners.get("pointerdown")(pointer(500, 500));
  listeners.get("pointermove")(pointer(250, 250));
  await listeners.get("pointerup")(pointer(250, 250));
  assert.equal(scene.updates.length, before + 1);
});

test("a window pointerup still commits when the canvas loses the release", async () => {
  const before = scene.updates.length;
  listeners.get("pointerdown")(pointer(50, 250));
  const release = pointer(50, 250);
  release.button = -1;
  await windowListeners.get("pointerup")[0](release);
  assert.equal(scene.updates.length, before + 1);
});

test("dig and undig never stay enabled at the same time", () => {
  const controls = {theiksToolbagDestruction: {tools: {}}};
  hooks.get("getSceneControlButtons")[0](controls);
  const tools = controls.theiksToolbagDestruction.tools;
  tools.theiksToolbagExcavate.onChange(null, true);
  assert.equal(tools.theiksToolbagExcavate.active, true);
  assert.equal(tools.theiksToolbagExcavateRepair.active, false);
  tools.theiksToolbagExcavateRepair.onChange(null, true);
  assert.equal(tools.theiksToolbagExcavate.active, false);
  assert.equal(tools.theiksToolbagExcavateRepair.active, true);
  tools.theiksToolbagExcavate.onChange(null, true);
  assert.equal(tools.theiksToolbagExcavate.active, true);
  assert.equal(tools.theiksToolbagExcavateRepair.active, false);
});

test("staying in Destruction Mode keeps excavation on", () => {
  const controls = {theiksToolbagDestruction: {tools: {}}};
  hooks.get("getSceneControlButtons")[0](controls);
  controls.theiksToolbagDestruction.tools.theiksToolbagExcavate.onChange(null, true);
  globalThis.ui.controls = {
    control: {
      name: "theiksToolbagDestructionMode",
      tools: {theiksToolbagExcavate: {name: "theiksToolbagExcavate"}}
    }
  };
  hooks.get("renderSceneControls")[0]();
  assert.equal(listeners.has("pointermove"), true);
});

test("leaving Destruction Mode turns excavation off", () => {
  const controls = {theiksToolbagDestruction: {tools: {}}};
  hooks.get("getSceneControlButtons")[0](controls);
  controls.theiksToolbagDestruction.tools.theiksToolbagExcavate.onChange(null, true);
  assert.equal(Boolean(listeners.get("pointermove")), true);
  globalThis.ui.controls = {control: {name: "tokens"}};
  hooks.get("renderSceneControls")[0]();
  assert.equal(listeners.has("pointermove"), false);
  controls.theiksToolbagDestruction.tools.theiksToolbagExcavate.onChange(null, true);
  hooks.get("activateSceneControls")[0]();
  assert.equal(listeners.has("pointermove"), false);
  globalThis.ui.controls = {};
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
  assert.equal(tools.theiksToolbagExcavate.toggle, true);
  assert.ok(tools.theiksToolbagExcavate);
  assert.ok(tools.theiksToolbagExcavateRepair);
});
