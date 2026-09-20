import assert from "node:assert/strict";
import test from "node:test";

const hooks = new Map();
globalThis.Hooks = {
  on(name, callback) { hooks.set(name, [...(hooks.get(name) ?? []), callback]); },
  callAll(name, ...args) { for (const callback of hooks.get(name) ?? []) callback(...args); }
};

class Graphics {
  operations = [];
  clear() { this.operations = []; }
  moveTo(x, y) { this.operations.push({type: "move", x, y}); return this; }
  lineTo(x, y) { this.operations.push({type: "line", x, y}); return this; }
  stroke(style) { this.operations.push({type: "stroke", ...style}); return this; }
  circle(x, y, radius) { this.operations.push({type: "circle", x, y, radius}); return this; }
  fill(style) { this.operations.push({type: "fill", ...style}); return this; }
  removeFromParent() {
    this.parent?.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
  }
  destroy() { this.destroyed = true; }
}

globalThis.PIXI = {Graphics};
globalThis.game = {user: {isGM: true}};
const interfaceLayer = {
  children: [], sortableChildren: false,
  addChild(child) { child.parent = this; this.children.push(child); }
};
const scene = {
  id: "scene", initialLevel: "ground",
  flags: {"theiks-toolbag": {footprintTrails: {version: 1, trails: {
    walker: {prints: [
      {x: 10, y: 15, groundX: 10, groundY: 10, levelId: "ground", side: 0, segmentId: "one"},
      {x: 40, y: 35, groundX: 40, groundY: 30, levelId: "ground", side: 1, segmentId: "one"},
      {x: 80, y: 80, levelId: "upper", side: 0, segmentId: "two"}
    ]}
  }}}},
  getFlag(_module, key) { return this.flags["theiks-toolbag"][key]; }
};
globalThis.canvas = {ready: true, scene, level: {id: "ground"}, interface: interfaceLayer};

const {
  FOOTPRINT_OVERLAY_NAME, isFootprintOverlayEnabled, recordFootprintDebug,
  registerFootprintDebug, toggleFootprintOverlay
} = await import("../scripts/footprints/footprint-debug.js");
registerFootprintDebug();
const graphics = () => interfaceLayer.children[0];

test("GM toggle draws saved footprint positions on the viewed Level", () => {
  assert.equal(toggleFootprintOverlay(true), true);
  assert.equal(isFootprintOverlayEnabled(), true);
  assert.equal(graphics().name, FOOTPRINT_OVERLAY_NAME);
  assert.equal(graphics().eventMode, "none");
  assert.ok(graphics().operations.some(op => op.type === "fill" && op.color === 0x4cf58a));
  assert.ok(graphics().operations.some(op => op.type === "fill" && op.color === 0xe87aff));
  assert.ok(graphics().operations.some(op => op.type === "stroke" && op.color === 0x5ccaff));
  assert.ok(!graphics().operations.some(op => op.type === "circle" && op.x === 80));
  assert.equal(toggleFootprintOverlay(false), false);
  assert.equal(interfaceLayer.children.length, 0);
});

test("live debug draws both paths and distinguishes placed and skipped prints", () => {
  toggleFootprintOverlay(true);
  recordFootprintDebug(scene, "move", [{
    levelId: "ground",
    raw: [{x: 0, y: 0}, {x: 100, y: 0}],
    corrected: [{x: 0, y: 0}, {x: 50, y: 20}, {x: 100, y: 0}],
    attempts: [
      {x: 25, y: 10, groundX: 25, groundY: 0, side: 0, result: "placed"},
      {x: 50, y: 10, side: 1, result: "blocked"},
      {x: 75, y: 10, side: 1, result: "overlap"}
    ]
  }]);
  for (const color of [0xffb347, 0x00e5e5, 0xff4d4d, 0xffd84d]) {
    assert.ok(graphics().operations.some(op => op.type === "stroke" && op.color === color));
  }
  canvas.level = {id: "upper"};
  Hooks.callAll("canvasReady");
  assert.ok(!graphics().operations.some(op => op.type === "stroke" && op.color === 0xffb347));
  assert.ok(graphics().operations.some(op => op.type === "circle" && op.x === 80));
  canvas.level = {id: "ground"};
  Hooks.callAll("canvasTearDown");
  assert.equal(interfaceLayer.children.length, 0);
  Hooks.callAll("canvasReady");
  assert.ok(!graphics().operations.some(op => op.type === "stroke" && op.color === 0xffb347));
  toggleFootprintOverlay(false);
});

test("players cannot enable the footprint debug overlay", () => {
  game.user = {isGM: false};
  assert.equal(toggleFootprintOverlay(true), false);
  assert.equal(isFootprintOverlayEnabled(), false);
  assert.equal(interfaceLayer.children.length, 0);
  game.user = {isGM: true};
});
