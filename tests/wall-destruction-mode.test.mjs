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
    this.eventMode = "static";
    this.alpha = 1;
    this.icon = {tint: options.tint ?? 0xFFFFFF};
    this.parent = null;
    this.handlers = new Map();
    this.position = {
      x: 0,
      y: 0,
      set: (x, y) => {
        this.position.x = x;
        this.position.y = y;
      }
    };
  }

  async draw() {
    return this;
  }

  on(name, callback) {
    this.handlers.set(name, callback);
    return this;
  }

  destroy() {
    this.removeFromParent();
  }

  removeFromParent() {
    if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this);
    this.parent = null;
  }
}

globalThis.PIXI = {Container};
globalThis.CONST = {
  EDGE_SENSE_TYPES: {NONE: 0},
  WALL_MOVEMENT_TYPES: {NONE: 0},
  WALL_DOOR_TYPES: {NONE: 0}
};

let dialogCalls = 0;
let resolveDialog;
const notifications = [];
globalThis.foundry = {
  applications: {
    api: {
      DialogV2: {
        wait: async () => {
          ++dialogCalls;
          return await new Promise(resolve => { resolveDialog = resolve; });
        }
      }
    }
  },
  canvas: {
    containers: {ControlIcon},
    loadTexture: async src => ({src})
  }
};
globalThis.game = {
  user: {isGM: true},
  i18n: {
    localize: key => key,
    format: (key, data) => `${key}:${JSON.stringify(data)}`
  }
};
globalThis.ui = {notifications: {error: message => notifications.push(message)}};

const controlsLayer = new Container();
const scene = {walls: new Map()};
globalThis.canvas = {
  ready: true,
  scene,
  controls: controlsLayer,
  dimensions: {uiScale: 1},
  level: {id: "level-a"},
  walls: {placeables: []}
};

function deferred() {
  let resolve;
  const promise = new Promise(resolver => { resolve = resolver; });
  return {promise, resolve};
}

function createWall({id, enabled, destroyed, midpoint, restore = null, levels = new Set()}) {
  const flag = {
    enabled,
    destroyed,
    images: {both: "both.webp", single: "single.webp"},
    destruction: destroyed ? {kind: "both", side: null} : null,
    restore
  };
  const updateGate = deferred();
  const state = {changes: null, updateGate};
  const document = {
    documentName: "Wall",
    id,
    uuid: `Scene.scene.Wall.${id}`,
    parent: scene,
    c: [0, 0, 100, 0],
    levels,
    light: 10,
    sight: 11,
    sound: 12,
    move: 13,
    door: 14,
    ds: 15,
    getFlag: () => flag,
    update: async changes => {
      state.changes = changes;
      await updateGate.promise;
      return document;
    }
  };
  const placeable = {id, document, midpoint};
  scene.walls.set(id, document);
  canvas.walls.placeables.push(placeable);
  return {document, flag, placeable, state};
}

const intact = createWall({
  id: "intact",
  enabled: true,
  destroyed: false,
  midpoint: [50, 25]
});
const destroyed = createWall({
  id: "destroyed",
  enabled: false,
  destroyed: true,
  midpoint: [150, 75],
  restore: {light: 1, sight: 2, sound: 3, move: 4, door: 5, ds: 6}
});
createWall({
  id: "disabled",
  enabled: false,
  destroyed: false,
  midpoint: [250, 125]
});
createWall({
  id: "other-level",
  enabled: false,
  destroyed: true,
  midpoint: [350, 175],
  restore: {light: 1, sight: 2, sound: 3, move: 4, door: 5, ds: 6},
  levels: new Set(["level-b"])
});
const corrupt = createWall({
  id: "corrupt",
  enabled: false,
  destroyed: true,
  midpoint: [450, 225]
});

const {registerWallDestructionMode} = await import("../scripts/breakable-walls/destruction-mode.js");
registerWallDestructionMode();

const sceneControls = {walls: {tools: {}}};
for (const callback of registeredHooks.get("getSceneControlButtons") ?? []) callback(sceneControls);
const tool = sceneControls.walls.tools.theiksToolbagDestroyWalls;
assert.ok(tool, "the destruction mode is available to GMs");
tool.onChange(null, true);
await new Promise(resolve => setTimeout(resolve, 0));

assert.equal(controlsLayer.children.length, 1);
const markerContainer = controlsLayer.children[0];
assert.equal(
  markerContainer.children.length,
  3,
  "disabled intact and other-level walls are excluded, but disabled destroyed walls remain repairable"
);

const destroyMarker = markerContainer.children.find(marker => marker.options.texture === "icons/svg/explosion.svg");
const repairMarkers = markerContainer.children.filter(marker => marker.options.texture === "icons/svg/regen.svg");
const repairMarker = repairMarkers.find(marker => marker.position.x === destroyed.placeable.midpoint[0]);
const corruptRepairMarker = repairMarkers.find(marker => marker.position.x === corrupt.placeable.midpoint[0]);
assert.ok(destroyMarker);
assert.ok(repairMarker);
assert.ok(corruptRepairMarker);
assert.equal(destroyMarker.options.borderColor, 0xFF9829);
assert.equal(repairMarker.options.borderColor, 0x4CAF50);
assert.deepEqual([destroyMarker.position.x, destroyMarker.position.y], intact.placeable.midpoint);
assert.deepEqual([repairMarker.position.x, repairMarker.position.y], destroyed.placeable.midpoint);

for (const callback of registeredHooks.get("refreshWall") ?? []) {
  callback({_original: destroyed.placeable, id: "preview", midpoint: [175, 95]});
}
assert.deepEqual(
  [repairMarker.position.x, repairMarker.position.y],
  [175, 95],
  "the repair marker follows a Wall drag-preview midpoint"
);

repairMarker.handlers.get("pointerdown")({stopPropagation() {}});
assert.equal(repairMarker.eventMode, "none", "the repair marker is disabled while its update is pending");
assert.deepEqual(
  {
    light: destroyed.state.changes.light,
    sight: destroyed.state.changes.sight,
    sound: destroyed.state.changes.sound,
    move: destroyed.state.changes.move,
    door: destroyed.state.changes.door,
    ds: destroyed.state.changes.ds
  },
  destroyed.flag.restore,
  "clicking the green marker immediately invokes exact repair"
);
destroyed.state.updateGate.resolve();
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(repairMarker.eventMode, "static");

destroyMarker.handlers.get("pointerdown")({stopPropagation() {}});
assert.equal(destroyMarker.eventMode, "none", "the destruction marker is disabled while its prompt is open");
assert.equal(dialogCalls, 1, "clicking the orange marker opens the existing destruction prompt");
resolveDialog("cancel");
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(destroyMarker.eventMode, "static");
assert.deepEqual(notifications, []);

const originalConsoleError = console.error;
const loggedErrors = [];
console.error = (...args) => loggedErrors.push(args);
try {
  corruptRepairMarker.handlers.get("pointerdown")({stopPropagation() {}});
  await new Promise(resolve => setTimeout(resolve, 0));
} finally {
  console.error = originalConsoleError;
}
assert.equal(corruptRepairMarker.eventMode, "static", "a failed repair re-enables its marker");
assert.match(notifications.at(-1), /InvalidRestore/);
assert.equal(loggedErrors.length, 1, "repair errors are logged as well as shown to the GM");

tool.onChange(null, false);
assert.equal(controlsLayer.children.length, 0, "leaving destruction mode removes every external marker");

const nonGmControls = {walls: {tools: {}}};
game.user.isGM = false;
for (const callback of registeredHooks.get("getSceneControlButtons") ?? []) callback(nonGmControls);
assert.equal(nonGmControls.walls.tools.theiksToolbagDestroyWalls, undefined);

console.log("wall destruction-mode tests passed");
