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

const level = {id: "ground", elevation: {bottom: 0, top: 10}};
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
const {sampleFootprints} = await import("../scripts/footprints/footprint-data.js");
const {registerFootprintDebug, toggleFootprintOverlay} = await import("../scripts/footprints/footprint-debug.js");
registerFootprintRuntime();
registerFootprintDebug();
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

test("doorway prints reveal as the Token moves and save their bent path", async () => {
  await clearSceneFootprints(scene);
  game.user = gm;
  game.users.activeGM = gm;
  scene.walls = [
    {c: [150, -1000, 150, 100], move: 20, includedInLevel: () => true},
    {c: [150, 200, 150, 1000], move: 20, includedInLevel: () => true}
  ];
  scene.initializeEdges = () => {};
  const originalConfig = globalThis.CONFIG;
  const originalFrame = globalThis.requestAnimationFrame;
  const crosses = (a, b, c) => {
    const t = (c[0] - a.x) / (b.x - a.x);
    if (!(t > 0 && t < 1)) return false;
    const y = a.y + t * (b.y - a.y);
    return y >= Math.min(c[1], c[3]) && y <= Math.max(c[1], c[3]);
  };
  globalThis.CONFIG = {Canvas: {polygonBackends: {move: {testCollision(a, b) {
    return scene.walls.some(wall => crosses(a, b, wall.c));
  }}}}};
  const frames = [];
  globalThis.requestAnimationFrame = callback => { frames.push(callback); return frames.length; };
  try {
    const walker = {...token("doorway-live"), object: {center: {x: 50, y: 60}}};
    const origin = waypoint(0, 10);
    const destination = waypoint(200, 70);
    const expected = sampleFootprints(scene, walker, [origin, destination], "expected").prints;
    assert.ok(expected.length > 0);
    let finish;
    const ended = new Promise(resolve => { finish = resolve; });
    fire("moveToken", walker, {id: "doorway-live", method: "dragging",
      animation: {duration: 1000, started: Promise.resolve(), ended},
      origin, passed: {waypoints: [destination]}});
    await settle();
    assert.equal(primary.children.length, 0);
    walker.object.center = {x: 150, y: 90};
    frames.shift()?.();
    await settle();
    assert.ok(primary.children.length > 0 && primary.children.length < expected.length);
    walker.object.center = {x: 250, y: 120};
    frames.shift()?.();
    await settle();
    assert.equal(primary.children.length, expected.length);
    finish();
    await settle();
    await settle();
    const stored = scene.getFlag("theiks-toolbag", "footprintTrails").trails[walker.id].prints;
    assert.equal(stored.length, expected.length);
    assert.ok(stored.some(print => print.groundY > 60 + (print.groundX - 50) * 0.3 + 10),
      "the saved trail must bend away from the recorded straight line");
    assert.ok(stored.some(print => print.groundX < 150));
    assert.ok(stored.some(print => print.groundX > 150));
  } finally {
    globalThis.requestAnimationFrame = originalFrame;
    globalThis.CONFIG = originalConfig;
    scene.walls = undefined;
    delete scene.initializeEdges;
  }
});

test("a blocked segment breaks an existing trail before the next move", async () => {
  await clearSceneFootprints(scene);
  game.user = gm;
  game.users.activeGM = gm;
  scene.walls = [{c: [150, -1000, 150, 1000], move: 20, includedInLevel: () => true}];
  scene.initializeEdges = () => {};
  const originalConfig = globalThis.CONFIG;
  globalThis.CONFIG = {Canvas: {polygonBackends: {move: {testCollision(a, b) {
    return a.x < 150 && b.x > 150;
  }}}}};
  try {
    fire("moveToken", token("blocked"), movement("before-wall", -100, 0));
    await settle();
    await settle();
    const earlier = scene.getFlag("theiks-toolbag", "footprintTrails").trails.blocked.prints;
    assert.ok(earlier.length > 0);
    fire("moveToken", token("blocked"), movement("blocked-crossing", 0, 200));
    await settle();
    await settle();
    const trail = scene.getFlag("theiks-toolbag", "footprintTrails").trails.blocked;
    assert.equal(trail.prints.length, earlier.length);
    assert.equal(trail.state, null);
    fire("moveToken", token("blocked"), movement("after-wall", 200, 300));
    await settle();
    await settle();
    const resumed = scene.getFlag("theiks-toolbag", "footprintTrails").trails.blocked.prints;
    assert.ok(resumed.length > earlier.length);
    assert.notEqual(resumed.at(-1).segmentId, earlier.at(-1).segmentId);
  } finally {
    globalThis.CONFIG = originalConfig;
    scene.walls = undefined;
    delete scene.initializeEdges;
  }
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

test("the movement hook feeds the local path overlay and clearing removes its traces", async () => {
  game.user = gm;
  game.users.activeGM = gm;
  const originalPixi = globalThis.PIXI;
  const originalInterface = canvas.interface;
  class Graphics {
    operations = [];
    clear() { this.operations = []; }
    moveTo() { return this; }
    lineTo() { return this; }
    stroke(style) { this.operations.push(style); return this; }
    circle() { return this; }
    fill() { return this; }
    removeFromParent() { this.parent.children.splice(this.parent.children.indexOf(this), 1); }
    destroy() { this.destroyed = true; }
  }
  const layer = {children: [], addChild(child) { child.parent = this; this.children.push(child); }};
  globalThis.PIXI = {Graphics};
  canvas.interface = layer;
  try {
    assert.equal(toggleFootprintOverlay(true), true);
    fire("moveToken", token("debug-walker"), movement("debug-move", 0, 200));
    await settle();
    assert.ok(layer.children[0].operations.some(style => style.color === 0xffb347));
    assert.ok(layer.children[0].operations.some(style => style.color === 0x00e5e5));
    await clearSceneFootprints(scene);
    await settle();
    assert.ok(!layer.children[0].operations.some(style => style.color === 0xffb347));
  } finally {
    toggleFootprintOverlay(false);
    globalThis.PIXI = originalPixi;
    canvas.interface = originalInterface;
  }
});

test("paste, teleport, and unconstrained movement leave no connecting prints", async () => {
  await clearSceneFootprints(scene);
  game.user = gm;
  game.users.activeGM = gm;
  const walker = token("skip-modes");
  fire("moveToken", walker, {...movement("walk-before", 0, 100), constrained: false});
  await settle();
  await settle();
  const original = scene.getFlag("theiks-toolbag", "footprintTrails").trails[walker.id].prints.length;
  assert.ok(original > 0);

  fire("moveToken", walker, {...movement("cut-paste", 100, 1000), method: "paste"});
  await settle();
  await settle();
  let trail = scene.getFlag("theiks-toolbag", "footprintTrails").trails[walker.id];
  assert.equal(trail.prints.length, original);
  assert.equal(trail.state, null);

  fire("moveToken", walker, movement("walk-after-paste", 1000, 1100));
  await settle();
  await settle();
  trail = scene.getFlag("theiks-toolbag", "footprintTrails").trails[walker.id];
  assert.ok(trail.prints.length > original);
  assert.ok(trail.prints.slice(original).every(print => print.groundX > 1000));
  const afterPaste = trail.prints.length;

  fire("moveToken", walker, {...movement("ghost", 1100, 2000),
    constrainOptions: {ignoreWalls: true, ignoreCost: true}});
  await settle();
  await settle();
  trail = scene.getFlag("theiks-toolbag", "footprintTrails").trails[walker.id];
  assert.equal(trail.prints.length, afterPaste);
  assert.equal(trail.state, null);

  const blink = movement("blink", 2000, 3000);
  blink.passed.waypoints[0].action = "blink";
  fire("moveToken", walker, blink);
  await settle();
  await settle();
  trail = scene.getFlag("theiks-toolbag", "footprintTrails").trails[walker.id];
  assert.equal(trail.prints.length, afterPaste);
  assert.equal(trail.state, null);
});

test("teleporting a token without a trail does not write an empty trail", async () => {
  await clearSceneFootprints(scene);
  game.user = gm;
  game.users.activeGM = gm;
  const blink = movement("fresh-blink", 0, 1000);
  blink.passed.waypoints[0].action = "blink";
  fire("moveToken", token("fresh-teleport"), blink);
  await settle();
  await settle();
  assert.equal(scene.getFlag("theiks-toolbag", "footprintTrails"), undefined);
});

test("a cumulative movement resumes after teleport without duplicating earlier prints", async () => {
  await clearSceneFootprints(scene);
  game.user = gm;
  game.users.activeGM = gm;
  const walker = token("mixed-teleport");
  const start = waypoint(0);
  const before = waypoint(100);
  const landing = {...waypoint(1000), action: "displace"};
  const after = waypoint(1100);
  const move = passed => ({
    id: "mixed-teleport-move", method: "dragging",
    animation: {duration: 0, started: Promise.resolve(), ended: Promise.resolve()},
    origin: start, passed: {waypoints: passed}
  });
  fire("moveToken", walker, move([before, landing]));
  await settle();
  await settle();
  const earlier = scene.getFlag("theiks-toolbag", "footprintTrails").trails[walker.id].prints;
  assert.ok(earlier.length > 0);
  fire("moveToken", walker, move([before, landing, after]));
  await settle();
  await settle();
  const prints = scene.getFlag("theiks-toolbag", "footprintTrails").trails[walker.id].prints;
  assert.ok(prints.length > earlier.length);
  assert.equal(prints.filter(print => print.groundX < 200).length, earlier.length);
  assert.ok(prints.slice(earlier.length).every(print => print.groundX > 1000));
});

test("an elevation-only cumulative update breaks the trail until surface movement resumes", async () => {
  await clearSceneFootprints(scene);
  game.user = gm;
  game.users.activeGM = gm;
  const walker = token("surface-walker");
  const send = (id, origin, passed) => fire("moveToken", walker, {
    id, method: "dragging",
    animation: {duration: 0, started: Promise.resolve(), ended: Promise.resolve()},
    origin, passed: {waypoints: passed}
  });
  send("surface-and-ascent", waypoint(0), [waypoint(100)]);
  await settle();
  await settle();
  const original = scene.getFlag("theiks-toolbag", "footprintTrails").trails[walker.id].prints;
  assert.ok(original.length > 0);

  send("surface-and-ascent", waypoint(0), [waypoint(100), {...waypoint(100), elevation: 5}]);
  await settle();
  await settle();
  let trail = scene.getFlag("theiks-toolbag", "footprintTrails").trails[walker.id];
  assert.equal(trail.prints.length, original.length);
  assert.equal(trail.state, null);

  send("airborne", {...waypoint(100), elevation: 5}, [{...waypoint(200), elevation: 5}]);
  send("descent", {...waypoint(200), elevation: 5}, [waypoint(200)]);
  await settle();
  await settle();
  trail = scene.getFlag("theiks-toolbag", "footprintTrails").trails[walker.id];
  assert.equal(trail.prints.length, original.length);

  send("ground-again", waypoint(200), [waypoint(300)]);
  await settle();
  await settle();
  trail = scene.getFlag("theiks-toolbag", "footprintTrails").trails[walker.id];
  assert.ok(trail.prints.length > original.length);
  assert.ok(trail.prints.slice(original.length).every(print => print.elevation === 0));
  assert.notEqual(trail.prints.at(-1).segmentId, original.at(-1).segmentId);
});

test("quadruped and Slither images persist and right stamps render mirrored after reload", async () => {
  await clearSceneFootprints(scene);
  game.user = gm;
  game.users.activeGM = gm;
  const quadruped = {...token("four-legs"), flags: {"theiks-toolbag": {footprintConfig: {
    movementType: "quadruped", image: "back.png",
    alternateSide: "right", alternateImage: "back-right.png",
    frontImage: "front.png", frontAlternateSide: "left", frontAlternateImage: "front-left.png"
  }}}};
  fire("moveToken", quadruped, movement("four-legs-move", 0, 200));
  await settle();
  await settle();
  const saved = scene.getFlag("theiks-toolbag", "footprintTrails").trails[quadruped.id].prints;
  assert.deepEqual(saved.slice(0, 4).map(print => print.image), [
    "back.png", "front.png", "front-left.png", "back-right.png"
  ]);
  assert.deepEqual(saved.slice(0, 4).map(print => print.leg), ["hind", "front", "front", "hind"]);
  fire("canvasTearDown");
  fire("canvasReady");
  await settle();
  const quadMeshes = new Map(primary.children.map(mesh => [mesh.options.name, mesh]));
  for (const print of saved) {
    const mesh = quadMeshes.get(`theiks-toolbag.footprint.${print.id}`);
    assert.ok(mesh);
    assert.equal(mesh.options.texture.src, print.image);
    assert.equal(mesh.scale.x < 0, print.side === 1);
  }

  await clearSceneFootprints(scene);
  const alternating = {...token("alternating-legs"), flags: {"theiks-toolbag": {footprintConfig: {
    movementType: "quadrupedAlternating", image: "hind.png", frontImage: "front.png"
  }}}};
  fire("moveToken", alternating, movement("alternating-move", 0, 200));
  await settle();
  await settle();
  const alternatingSaved = scene.getFlag("theiks-toolbag", "footprintTrails")
    .trails[alternating.id].prints;
  assert.deepEqual(alternatingSaved.slice(0, 4).map(print => print.leg),
    ["hind", "front", "hind", "front"]);
  fire("canvasTearDown");
  fire("canvasReady");
  await settle();
  const alternatingMeshes = new Map(primary.children.map(mesh => [mesh.options.name, mesh]));
  for (const print of alternatingSaved) {
    const mesh = alternatingMeshes.get(`theiks-toolbag.footprint.${print.id}`);
    assert.ok(mesh);
    assert.equal(mesh.options.texture.src, print.image);
    assert.equal(mesh.scale.x < 0, print.side === 1);
  }

  await clearSceneFootprints(scene);
  const slither = {...token("slither"), flags: {"theiks-toolbag": {footprintConfig: {
    movementType: "slither", image: "sinuous.png"
  }}}};
  fire("moveToken", slither, movement("slither-move", 0, 200));
  await settle();
  await settle();
  const body = scene.getFlag("theiks-toolbag", "footprintTrails").trails[slither.id].prints;
  assert.ok(body.length > 0);
  assert.ok(body.every(print => print.leg === "body" && print.image === "sinuous.png"));
  assert.ok(body.every(print => print.x === print.groundX && print.y === print.groundY));
  const bodyMeshes = new Map(primary.children.map(mesh => [mesh.options.name, mesh]));
  for (const print of body) {
    const mesh = bodyMeshes.get(`theiks-toolbag.footprint.${print.id}`);
    assert.ok(mesh);
    assert.equal(mesh.scale.x < 0, print.side === 1);
  }
});

test("saved biped prints from the earlier trail format still render", async () => {
  await clearSceneFootprints(scene);
  scene.flags["theiks-toolbag"].footprintTrails = {version: 1, trails: {legacy: {
    prints: [{id: "legacy-foot", x: 50, y: 38, groundX: 50, groundY: 50,
      elevation: 0, levelId: "ground", rotation: 90, side: 1, scale: 1,
      image: "old-foot.png", tint: "#ffffff", segmentId: "old:0", distance: 0,
      cameFromEnabled: true}],
    state: null
  }}};
  fire("canvasReady");
  await settle();
  const mesh = primary.children.find(child =>
    child.options.name === "theiks-toolbag.footprint.legacy-foot");
  assert.ok(mesh);
  assert.equal(mesh.options.texture.src, "old-foot.png");
  assert.ok(mesh.scale.x < 0);
});

test("real-time prints stamp at reveal, ignore positive distance cutoff, and fade after half their lifetime", async () => {
  await clearSceneFootprints(scene);
  game.time = {serverTime: 100_000, worldTime: 1000};
  scene.flags["theiks-toolbag"].footprintConfig.fadeMode = "time";
  scene.flags["theiks-toolbag"].footprintConfig.fadeSeconds = 60;
  scene.flags["theiks-toolbag"].footprintConfig.fadeUseWorldTime = false;
  cutoff = 1;
  fire("moveToken", token("timed"), movement("timed-move", 0, 500));
  await settle();
  await settle();
  const prints = scene.getFlag("theiks-toolbag", "footprintTrails").trails.timed.prints;
  assert.ok(prints.length > 8 && prints.every(print => print.placedAt === 100));
  assert.equal(primary.children.length, prints.length);
  game.time.serverTime = 130_000;
  fire("sightRefresh");
  await settle();
  assert.ok(primary.children.every(mesh => mesh.alpha === 1));
  game.time.serverTime = 145_000;
  fire("sightRefresh");
  await settle();
  assert.ok(primary.children.every(mesh => Math.abs(mesh.alpha - 0.25) < 1e-9));
  cutoff = 0;
  fire("theiks-toolbag.footprintCutoffChanged");
  await settle();
  assert.equal(primary.children.length, 0);
  cutoff = 5;
  game.time.serverTime = 160_000;
  fire("theiks-toolbag.footprintCutoffChanged");
  await settle();
  assert.equal(primary.children.length, 0);
  delete scene.flags["theiks-toolbag"].footprintConfig.fadeMode;
  delete scene.flags["theiks-toolbag"].footprintConfig.fadeSeconds;
  delete scene.flags["theiks-toolbag"].footprintConfig.fadeUseWorldTime;
  delete game.time;
});

test("animated prints receive timestamps as the Token reaches them", async () => {
  await clearSceneFootprints(scene);
  game.time = {serverTime: 100_000, worldTime: 1000};
  const frames = [];
  const originalFrame = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = callback => { frames.push(callback); return frames.length; };
  let finish;
  const ended = new Promise(resolve => { finish = resolve; });
  const walker = {...token("timed-animation"), flags: {"theiks-toolbag": {footprintConfig: {
    fadeMode: "time", fadeSeconds: 60, fadeUseWorldTime: false
  }}}, object: {center: {x: 50, y: 50}}};
  fire("moveToken", walker, {
    id: "timed-animation-move", method: "dragging",
    animation: {duration: 1000, started: Promise.resolve(), ended},
    origin: waypoint(0), passed: {waypoints: [waypoint(300)]}
  });
  await settle();
  game.time.serverTime = 110_000;
  walker.object.center = {x: 150, y: 50};
  frames.shift()?.();
  await settle();
  game.time.serverTime = 120_000;
  walker.object.center = {x: 250, y: 50};
  frames.shift()?.();
  await settle();
  game.time.serverTime = 130_000;
  finish();
  await settle();
  await settle();
  const stamps = scene.getFlag("theiks-toolbag", "footprintTrails")
    .trails[walker.id].prints.map(print => print.placedAt);
  assert.ok(stamps.includes(110) && stamps.includes(120) && stamps.includes(130));
  globalThis.requestAnimationFrame = originalFrame;
  delete game.time;
});

test("world-time prints follow the world clock, including a rewind", async () => {
  await clearSceneFootprints(scene);
  game.time = {serverTime: 100_000, worldTime: 1000};
  const walker = {...token("world-timed"), flags: {"theiks-toolbag": {footprintConfig: {
    fadeMode: "time", fadeSeconds: 60, fadeUseWorldTime: true
  }}}};
  fire("moveToken", walker, movement("world-clock-move", 0, 200));
  await settle();
  await settle();
  const prints = scene.getFlag("theiks-toolbag", "footprintTrails").trails[walker.id].prints;
  assert.ok(prints.every(print => print.placedAt === 1000 && print.fadeUseWorldTime));
  game.time.worldTime = 1045;
  fire("updateWorldTime", 1045);
  await settle();
  assert.ok(primary.children.every(mesh => Math.abs(mesh.alpha - 0.25) < 1e-9));
  game.time.worldTime = 1000;
  fire("updateWorldTime", 1000);
  await settle();
  assert.ok(primary.children.every(mesh => mesh.alpha === 1));
  delete game.time;
});

test("an expired newer time print does not hide an older distance print", async () => {
  await clearSceneFootprints(scene);
  game.time = {serverTime: 100_000, worldTime: 1000};
  const base = {elevation: 0, levelId: "ground", rotation: 90, side: 0,
    scale: 1, image: "foot.png", tint: "#ffffff", cameFromEnabled: true};
  scene.flags["theiks-toolbag"].footprintTrails = {version: 1, trails: {mixed: {
    prints: [
      {...base, id: "older-distance", x: 50, y: 50, groundX: 50, groundY: 50,
        fadeMode: "distance"},
      {...base, id: "newer-expired", x: 85, y: 50, groundX: 85, groundY: 50,
        fadeMode: "time", fadeSeconds: 60, fadeUseWorldTime: false, placedAt: 0}
    ], state: null
  }}};
  fire("canvasReady");
  await settle();
  assert.ok(primary.children.some(mesh => mesh.options.name.endsWith("older-distance")));
  assert.ok(!primary.children.some(mesh => mesh.options.name.endsWith("newer-expired")));
  delete game.time;
});
