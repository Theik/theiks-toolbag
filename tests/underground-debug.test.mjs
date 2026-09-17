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

class Graphics {
  constructor() {
    this.rects = [];
    this.destroyed = false;
    this.parent = null;
    this.name = "";
    this.eventMode = "auto";
    this.interactive = true;
    this.zIndex = 0;
    this.pending = null;
  }
  beginFill(color, alpha) {
    this.pending = {color, alpha};
    return this;
  }
  drawRect(x, y, width, height) {
    this.rects.push({x, y, width, height, ...this.pending});
    return this;
  }
  endFill() {
    this.pending = null;
    return this;
  }
  clear() {
    this.rects = [];
    return this;
  }
  removeFromParent() {
    if (this.parent?.children) {
      this.parent.children = this.parent.children.filter(child => child !== this);
    }
    this.parent = null;
  }
  destroy() {
    this.destroyed = true;
    this.removeFromParent();
  }
}

class InterfaceLayer {
  constructor() {
    this.children = [];
    this.sortableChildren = false;
  }
  addChild(child) {
    child.parent = this;
    this.children.push(child);
    return child;
  }
}

globalThis.PIXI = {Graphics};

const {
  createUndergroundSource,
  getUndergroundData,
  subcellsForLogicalIndexes
} = await import("../scripts/underground/underground-data.js");
const {
  occupancyOverlayRects,
  registerUndergroundDebug,
  toggleUndergroundOverlay,
  isUndergroundOverlayEnabled,
  UNDERGROUND_OVERLAY_NAME
} = await import("../scripts/underground/underground-debug.js");

function flagForCells(logicalCells) {
  return createUndergroundSource({
    levelId: "ground",
    origin: {x: 0, y: 0},
    width: 2,
    height: 1,
    gridSize: 100,
    cells: subcellsForLogicalIndexes(logicalCells, 2, 1),
    intactSrc: "earth.webp",
    dugSrc: "rubble.webp"
  });
}

function createScene(flag) {
  const level = {id: "ground"};
  return {
    id: "scene",
    initialLevel: "ground",
    levels: new Map([["ground", level]]),
    level,
    flags: {"theiks-toolbag": {undergroundTerrain: flag}},
    getFlag(module, key) { return this.flags[module]?.[key]; }
  };
}

function covers(rects, x, y) {
  return rects.some(rect => x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height);
}

function overlayGraphics() {
  return globalThis.canvas?.interface?.children?.find(child => child.name === UNDERGROUND_OVERLAY_NAME)
    ?? null;
}

function installCanvas(scene) {
  const layer = new InterfaceLayer();
  globalThis.canvas = {scene, level: scene.level, interface: layer};
  return layer;
}

test("occupancy overlay rects cover sourceMask subcells and skip empty neighbors", () => {
  const scene = createScene(flagForCells([0]));
  const data = getUndergroundData(scene);
  const rects = occupancyOverlayRects(data);
  assert.ok(covers(rects, 12, 12), "an occupied subcell is painted");
  assert.ok(covers(rects, 87, 87), "the rest of the occupied logical cell is painted");
  assert.equal(covers(rects, 150, 50), false, "an empty neighboring cell is not painted");
});

test("toggleOverlay paints occupancy and clears when turned off", () => {
  const scene = createScene(flagForCells([0]));
  installCanvas(scene);
  assert.equal(toggleUndergroundOverlay(true), true);
  const graphics = overlayGraphics();
  assert.ok(graphics, "the overlay is added to the interface layer");
  assert.equal(graphics.eventMode, "none");
  assert.ok(covers(graphics.rects, 25, 25));
  assert.equal(covers(graphics.rects, 150, 50), false);
  assert.equal(toggleUndergroundOverlay(false), false);
  assert.equal(graphics.destroyed, true);
  assert.equal(overlayGraphics(), null);
  assert.equal(isUndergroundOverlayEnabled(), false);
});

test("an occupancy rebuild while the overlay is on redraws", () => {
  const scene = createScene(flagForCells([0]));
  installCanvas(scene);
  registerUndergroundDebug();
  toggleUndergroundOverlay(true);
  const first = overlayGraphics();
  assert.ok(covers(first.rects, 25, 25));
  assert.equal(covers(first.rects, 150, 50), false);

  scene.flags["theiks-toolbag"].undergroundTerrain = flagForCells([1]);
  hookCallbacks.get("updateScene").at(-1)(scene);
  const redrawn = overlayGraphics();
  assert.equal(covers(redrawn.rects, 25, 25), false, "the old occupancy is gone");
  assert.ok(covers(redrawn.rects, 150, 50), "the new occupancy is painted");
  toggleUndergroundOverlay(false);
});

test("non-GM callers cannot enable the occupancy overlay", () => {
  const scene = createScene(flagForCells([0]));
  installCanvas(scene);
  globalThis.game.user.isGM = false;
  assert.equal(toggleUndergroundOverlay(true), false);
  assert.equal(isUndergroundOverlayEnabled(), false);
  assert.equal(overlayGraphics(), null);
  globalThis.game.user.isGM = true;
});
