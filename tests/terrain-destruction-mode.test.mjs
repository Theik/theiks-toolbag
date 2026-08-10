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
globalThis.foundry = {
  canvas: {
    containers: {ControlIcon},
    loadTexture: async src => ({src, valid: true, width: 2, height: 2}),
    TextureLoader: {
      getTextureAlphaData: () => ({
        width: 2,
        height: 2,
        minX: 0,
        minY: 0,
        maxX: 2,
        maxY: 2,
        data: new Uint8Array([255, 255, 255, 255])
      })
    }
  }
};

const notifications = [];
globalThis.game = {
  user: {id: "gm", isGM: true},
  i18n: {
    localize: key => key,
    format: (key, data) => `${key}:${JSON.stringify(data)}`
  }
};
globalThis.ui = {notifications: {error: message => notifications.push(message)}};

const controlsLayer = new Container();
const scene = {id: "scene", tiles: new Map()};
globalThis.canvas = {
  ready: true,
  scene,
  controls: controlsLayer,
  dimensions: {uiScale: 1},
  level: {id: "level-a"},
  tiles: {placeables: []}
};

function deferred() {
  let resolve;
  const promise = new Promise(resolver => { resolve = resolver; });
  return {promise, resolve};
}

function createTile({
  id,
  x,
  enabled = true,
  states = ["cracked.webp", "rubble.webp"],
  stage = 0,
  restoreSrc = null,
  src = "statue.webp",
  levels = new Set(),
  updateGate = null
}) {
  const flag = {
    enabled,
    blocksMovement: false,
    blocksVision: false,
    states,
    stage,
    restoreSrc
  };
  const updateCalls = [];
  const document = {
    documentName: "Tile",
    id,
    uuid: `Scene.scene.Tile.${id}`,
    parent: scene,
    levels,
    shape: {center: {x, y: 100}},
    _source: {texture: {src}},
    texture: {src},
    getFlag: () => flag,
    update: async changes => {
      updateCalls.push(structuredClone(changes));
      if (updateGate) await updateGate.promise;
      if (Object.hasOwn(changes, "texture.src")) {
        document.texture.src = changes["texture.src"];
        document._source.texture.src = changes["texture.src"];
      }
      if (Object.hasOwn(changes, "flags.theiks-toolbag.breakableTerrain.stage")) {
        flag.stage = changes["flags.theiks-toolbag.breakableTerrain.stage"];
      }
      if (Object.hasOwn(changes, "flags.theiks-toolbag.breakableTerrain.restoreSrc")) {
        flag.restoreSrc = changes["flags.theiks-toolbag.breakableTerrain.restoreSrc"];
      }
      return document;
    }
  };
  const placeable = {id, document};
  scene.tiles.set(id, document);
  canvas.tiles.placeables.push(placeable);
  return {document, flag, placeable, updateCalls};
}

const intactGate = deferred();
const intact = createTile({id: "intact", x: 50, updateGate: intactGate});
const partial = createTile({
  id: "partial",
  x: 150,
  stage: 1,
  restoreSrc: "statue.webp",
  src: "cracked.webp"
});
const final = createTile({
  id: "final",
  x: 250,
  stage: 2,
  restoreSrc: "statue.webp",
  src: "rubble.webp"
});
const finalStep = createTile({
  id: "final-step",
  x: 300,
  stage: 2,
  restoreSrc: "statue.webp",
  src: "rubble.webp"
});
const disabledDamaged = createTile({
  id: "disabled-damaged",
  x: 350,
  enabled: false,
  stage: 1,
  restoreSrc: "statue.webp",
  src: "cracked.webp"
});
createTile({id: "disabled", x: 450, enabled: false});
createTile({id: "other-level", x: 550, levels: new Set(["level-b"])});

const {registerTerrainDestructionMode} = await import("../scripts/breakable-terrain/destruction-mode.js");
registerTerrainDestructionMode();

const sceneControls = {tiles: {tools: {}}};
for (const callback of registeredHooks.get("getSceneControlButtons") ?? []) callback(sceneControls);
const tool = sceneControls.tiles.tools.theiksToolbagDestroyTerrain;
assert.ok(tool, "the terrain destruction mode is available to GMs");
assert.equal(tool.order, 5);
tool.onChange(null, true);
await new Promise(resolve => setTimeout(resolve, 0));

assert.equal(controlsLayer.children.length, 1);
const markerContainer = controlsLayer.children[0];
assert.equal(
  markerContainer.children.length,
  5,
  "enabled same-level tiles and disabled damaged tiles receive markers"
);

const markerAt = x => markerContainer.children.find(marker => marker.position.x === x);
const intactMarker = markerAt(50);
const partialMarker = markerAt(150);
const finalMarker = markerAt(250);
const finalStepMarker = markerAt(300);
const disabledDamagedMarker = markerAt(350);
assert.ok(intactMarker);
assert.ok(partialMarker);
assert.ok(finalMarker);
assert.ok(finalStepMarker);
assert.ok(disabledDamagedMarker);
assert.equal(intactMarker.options.texture, "icons/svg/explosion.svg");
assert.equal(partialMarker.options.texture, "icons/svg/explosion.svg");
assert.equal(finalMarker.options.texture, "icons/svg/regen.svg");
assert.equal(finalStepMarker.options.texture, "icons/svg/regen.svg");
assert.equal(intactMarker.options.borderColor, 0xFF9829);
assert.equal(finalMarker.options.borderColor, 0x4CAF50);

intactMarker.handlers.get("pointerdown")({
  button: 0,
  stopPropagation() {},
  preventDefault() {}
});
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(intactMarker.eventMode, "none", "a marker locks while its image transition is pending");
assert.equal(intact.updateCalls.length, 1);
assert.equal(intact.updateCalls[0]["texture.src"], "cracked.webp");
assert.equal(intact.updateCalls[0]["flags.theiks-toolbag.breakableTerrain.stage"], 1);
assert.equal(intact.updateCalls[0]["flags.theiks-toolbag.breakableTerrain.restoreSrc"], "statue.webp");
intactGate.resolve();
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(intactMarker.eventMode, "static");

partialMarker.handlers.get("pointerdown")({button: 2, stopPropagation() {}, preventDefault() {}});
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(partial.updateCalls.length, 1, "right-click moves an intermediate stage back once");
assert.equal(partial.document.texture.src, "statue.webp");
assert.equal(partial.flag.stage, 0);
assert.equal(partial.flag.restoreSrc, null);

finalMarker.handlers.get("pointerdown")({button: 0, stopPropagation() {}, preventDefault() {}});
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(final.flag.stage, 0, "left-clicking the green marker fully restores the tile");
assert.equal(final.document.texture.src, "statue.webp");

finalStepMarker.handlers.get("pointerdown")({button: 2, stopPropagation() {}, preventDefault() {}});
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(finalStep.flag.stage, 1, "right-click moves a fully destroyed tile back one stage");
assert.equal(finalStep.document.texture.src, "cracked.webp");
assert.equal(finalStep.flag.restoreSrc, "statue.webp");

const partialCalls = partial.updateCalls.length;
partialMarker.handlers.get("pointerdown")({button: 2, stopPropagation() {}, preventDefault() {}});
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(partial.updateCalls.length, partialCalls, "right-click does nothing on a restored tile");
assert.deepEqual(notifications, []);

tool.onChange(null, false);
assert.equal(controlsLayer.children.length, 0, "leaving destruction mode removes every marker");

const nonGmControls = {tiles: {tools: {}}};
game.user.isGM = false;
for (const callback of registeredHooks.get("getSceneControlButtons") ?? []) callback(nonGmControls);
assert.equal(nonGmControls.tiles.tools.theiksToolbagDestroyTerrain, undefined);

console.log("terrain destruction-mode tests passed");
