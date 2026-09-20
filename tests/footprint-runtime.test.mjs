import assert from "node:assert/strict";
import test from "node:test";

const hooks = new Map();
globalThis.Hooks = {
  on: (name, callback) => hooks.set(name, [...(hooks.get(name) ?? []), callback]),
  callAll: (name, ...args) => { for (const callback of hooks.get(name) ?? []) callback(...args); }
};
const gm = {id: "gm", isGM: true};
const player = {id: "player", isGM: false};
let cutoff = 5;
globalThis.game = {
  user: gm, users: {activeGM: gm},
  settings: {get: (_namespace, key) => key === "footprintCutoff" ? cutoff
    : key === "defaultFootprintImage" ? "foot.png" : true}
};

class Mesh {
  constructor(options) {
    this.options = options;
    this.anchor = {set() {}};
    this.scale = {x: 1};
    this.position = {set: (x, y) => { this.x = x; this.y = y; }};
  }
  resize(width, height) { this.width = width; this.height = height; }
  removeFromParent() { this.parent?.children.splice(this.parent.children.indexOf(this), 1); }
  destroy() { this.destroyed = true; }
}
class Primary {
  static SORT_LAYERS = {DRAWINGS: 1};
  children = [];
  addChild(mesh) { mesh.parent = this; this.children.push(mesh); }
  sortChildren() {}
  update() {}
}
globalThis.foundry = {
  canvas: {primary: {PrimarySpriteMesh: Mesh}, loadTexture: async src => ({src, valid: true})}
};

const level = {id: "ground"};
function mergeFlag(existing, value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return value;
  const merged = {...(existing ?? {})};
  for (const [key, field] of Object.entries(value)) merged[key] = mergeFlag(merged[key], field);
  return merged;
}
const scene = {
  id: "scene", initialLevel: "ground", tokenVision: true,
  grid: {size: 100}, levels: new Map([[level.id, level]]), regions: [],
  flags: {"theiks-toolbag": {footprintConfig: {enabled: true}}},
  getFlag(_module, key) { return this.flags["theiks-toolbag"][key]; },
  async setFlag(_module, key, value) {
    await Promise.resolve();
    this.flags["theiks-toolbag"][key] = mergeFlag(this.flags["theiks-toolbag"][key], value);
    Hooks.callAll("updateScene", this, {flags: {"theiks-toolbag": {[key]: value}}});
  },
  async unsetFlag(_module, key) {
    await Promise.resolve();
    delete this.flags["theiks-toolbag"][key];
    Hooks.callAll("updateScene", this, {flags: {"theiks-toolbag": {[`-=${key}`]: null}}});
  }
};
level.parent = scene;
const primary = new Primary();
globalThis.canvas = {
  ready: true, scene, level, primary,
  visibility: {testVisibility: () => true}
};

const {registerFootprintRuntime, clearSceneFootprints} = await import("../scripts/footprints/footprint-runtime.js");
registerFootprintRuntime();
const fire = (name, ...args) => Hooks.callAll(name, ...args);
const settle = async () => { await new Promise(resolve => setTimeout(resolve, 0)); };
const token = id => ({id, parent: scene, width: 1, height: 1, level: "ground"});
const waypoint = (x, y = 0) => ({x, y, width: 1, height: 1, level: "ground", elevation: 0});
const movement = (id, x0, x1) => ({
  id, method: "dragging", animation: {duration: 0, started: Promise.resolve(), ended: Promise.resolve()},
  origin: waypoint(x0), passed: {waypoints: [waypoint(x1)]}
});

test("GM saves and renders shared footprints, including after canvas reload", async () => {
  fire("moveToken", token("a"), movement("move-a", 0, 200));
  await settle();
  await settle();
  const stored = scene.getFlag("theiks-toolbag", "footprintTrails");
  assert.ok(stored.trails.a.prints.length > 0);
  assert.ok(primary.children.length > 0);
  fire("canvasTearDown");
  assert.equal(primary.children.length, 0);
  fire("canvasReady");
  await settle();
  assert.ok(primary.children.length > 0);
});

test("player vision and local cutoff control rendering independently", async () => {
  game.user = player;
  canvas.visibility.testVisibility = point => point.x < 100;
  fire("sightRefresh");
  await settle();
  assert.ok(primary.children.length > 0);
  assert.ok(primary.children.every(mesh => mesh.x < 100));
  cutoff = 0;
  fire("theiks-toolbag.footprintCutoffChanged");
  await settle();
  assert.equal(primary.children.length, 0);
  cutoff = 5;
  scene.tokenVision = false;
  fire("sightRefresh");
  await settle();
  assert.ok(primary.children.some(mesh => mesh.x >= 100));
  game.user = gm;
});

test("simultaneous token movement serializes scene writes and GM clear removes all trails", async () => {
  scene.tokenVision = true;
  fire("moveToken", token("b"), movement("move-b", 0, 200));
  fire("moveToken", token("c"), movement("move-c", 0, 300));
  await settle();
  await settle();
  assert.ok(scene.getFlag("theiks-toolbag", "footprintTrails").trails.b.prints.length);
  assert.ok(scene.getFlag("theiks-toolbag", "footprintTrails").trails.c.prints.length);
  await scene.setFlag("theiks-toolbag", "footprintTrails", {version: 1, trails: {}});
  assert.ok(scene.getFlag("theiks-toolbag", "footprintTrails").trails.b.prints.length,
    "Foundry merges an empty nested flag instead of deleting old token trails");
  await clearSceneFootprints(scene);
  await settle();
  assert.equal(scene.getFlag("theiks-toolbag", "footprintTrails"), undefined);
  assert.equal(primary.children.length, 0);
});

test("repeated diagonal moves with one passed waypoint leave visible prints", async () => {
  const walker = token("diagonal");
  for (let i = 0; i < 5; i += 1) {
    fire("moveToken", walker, {
      id: `diagonal-${i}`, method: "dragging",
      animation: {duration: 0, started: Promise.resolve(), ended: Promise.resolve()},
      origin: waypoint(i * 100, i * 100),
      passed: {waypoints: [waypoint((i + 1) * 100, (i + 1) * 100)]}
    });
  }
  await settle();
  await settle();
  const prints = scene.getFlag("theiks-toolbag", "footprintTrails").trails.diagonal.prints;
  assert.ok(prints.length >= 15);
  assert.ok(prints.every(print => Math.abs(print.rotation - 135) < 0.001));
  assert.ok(prints.at(-1).groundX > prints[0].groundX);
  assert.ok(prints.at(-1).groundY > prints[0].groundY);
  assert.ok(primary.children.length > 0);
});

test("cumulative updates for one move add only new portions of its path", async () => {
  const walker = token("cumulative");
  const update = end => ({
    id: "one-move", method: "dragging",
    animation: {duration: 0, started: Promise.resolve(), ended: Promise.resolve()},
    origin: waypoint(0),
    passed: {waypoints: [100, 200, 300].filter(x => x <= end).map(x => waypoint(x))}
  });
  fire("moveToken", walker, update(100));
  fire("moveToken", walker, update(200));
  fire("moveToken", walker, update(300));
  await settle();
  await settle();
  const prints = scene.getFlag("theiks-toolbag", "footprintTrails").trails.cumulative.prints;
  assert.ok(prints.length >= 8 && prints.length <= 10);
  assert.equal(new Set(prints.map(print => print.id)).size, prints.length);
  fire("moveToken", walker, update(300));
  await settle();
  assert.equal(scene.getFlag("theiks-toolbag", "footprintTrails").trails.cumulative.prints.length, prints.length);
});

test("five-grid cutoff follows the newest prints through separate moves", async () => {
  await clearSceneFootprints(scene);
  for (let i = 0; i < 12; i += 1) {
    fire("moveToken", token("walker"), movement(`walk-${i}`, i * 100, (i + 1) * 100));
  }
  await settle();
  await settle();
  const prints = scene.getFlag("theiks-toolbag", "footprintTrails").trails.walker.prints;
  assert.ok(prints.length > 20);
  assert.ok(primary.children.length > 0);
  assert.ok(primary.children.every(mesh => mesh.x > 700));
  assert.ok(primary.children.length < prints.length);

  cutoff = 0;
  fire("theiks-toolbag.footprintCutoffChanged");
  await settle();
  assert.equal(primary.children.length, 0);
  cutoff = 100;
  fire("theiks-toolbag.footprintCutoffChanged");
  await settle();
  assert.equal(primary.children.length, prints.length);
  cutoff = 5;
});

test("planned animation prints do not make the older trail vanish early", async () => {
  await clearSceneFootprints(scene);
  for (let i = 0; i < 12; i += 1) {
    fire("moveToken", token("animated"), movement(`prior-${i}`, i * 100, (i + 1) * 100));
  }
  await settle();
  await settle();
  const before = new Map(primary.children.map(mesh => [mesh.options.name, mesh.alpha]));
  assert.ok(before.size > 0);

  const frames = [];
  const originalFrame = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = callback => { frames.push(callback); return frames.length; };
  let finish;
  const ended = new Promise(resolve => { finish = resolve; });
  const animated = {...token("animated"), object: {center: {x: 1250, y: 50}}};
  fire("moveToken", animated, {
    id: "animated-future", method: "dragging",
    animation: {duration: 1000, started: Promise.resolve(), ended},
    origin: waypoint(1200), passed: {waypoints: [waypoint(2000)]}
  });
  await settle();
  assert.ok([...before.keys()].every(name => primary.children.some(mesh => mesh.options.name === name)));

  animated.object.center = {x: 1450, y: 50};
  frames.shift()?.();
  await settle();
  const remaining = primary.children.filter(mesh => before.has(mesh.options.name));
  assert.ok(remaining.length > 0 && remaining.length < before.size);
  assert.ok(remaining.some(mesh => mesh.alpha < before.get(mesh.options.name)));
  assert.ok(primary.children.some(mesh => mesh.options.name.includes("animated-future")));

  finish();
  await settle();
  globalThis.requestAnimationFrame = originalFrame;
});

test("a 100-print trail fades at its stored end when the client cutoff is farther away", async () => {
  await clearSceneFootprints(scene);
  cutoff = 30;
  fire("theiks-toolbag.footprintCutoffChanged");
  const half = x => ({...waypoint(x), width: 0.5, height: 0.5});
  fire("moveToken", {...token("capped"), width: 0.5, height: 0.5}, {
    id: "capped-walk", method: "dragging",
    animation: {duration: 0, started: Promise.resolve(), ended: Promise.resolve()},
    origin: half(0), passed: {waypoints: [half(2000)]}
  });
  await settle();
  await settle();
  const prints = scene.getFlag("theiks-toolbag", "footprintTrails").trails.capped.prints;
  assert.equal(prints.length, 100);
  assert.ok(primary.children.length > 0);
  const newestX = prints.at(-1).groundX;
  const span = (newestX - prints[0].groundX) / scene.grid.size;
  const age = mesh => (newestX - mesh.x) / scene.grid.size;
  const firstHalf = primary.children.filter(mesh => age(mesh) <= span / 2);
  const finalQuarter = primary.children.filter(mesh => age(mesh) >= span * 0.75);
  assert.ok(firstHalf.length > 0 && firstHalf.every(mesh => mesh.alpha === 1));
  assert.ok(finalQuarter.length > 0 && finalQuarter.every(mesh => mesh.alpha < 0.26));
  assert.ok(finalQuarter.some(mesh => mesh.alpha < 0.01));
  cutoff = 5;
});

test("a remote clear removes unsaved live prints on a player client", async () => {
  await clearSceneFootprints(scene);
  await scene.setFlag("theiks-toolbag", "footprintTrails", {version: 1, trails: {}});
  game.user = player;
  fire("moveToken", token("remote"), movement("remote-move", 0, 200));
  await settle();
  assert.ok(primary.children.length > 0);
  await scene.unsetFlag("theiks-toolbag", "footprintTrails");
  await settle();
  assert.equal(primary.children.length, 0);
  game.user = gm;
});

test("without a GM, connected clients see live prints but nothing persists", async () => {
  await clearSceneFootprints(scene);
  game.user = player;
  game.users.activeGM = null;
  fire("moveToken", token("d"), movement("move-d", 0, 200));
  await settle();
  assert.ok(primary.children.length > 0);
  assert.equal(scene.getFlag("theiks-toolbag", "footprintTrails"), undefined);
  fire("canvasTearDown");
  fire("canvasReady");
  await settle();
  assert.equal(primary.children.length, 0);
});
