import assert from "node:assert/strict";
import test from "node:test";

globalThis.game = {settings: {get: (_id, key) => key === "defaultFootprintImage" ? "default.png" : true}};

const {createFootprintRouter} = await import("../scripts/footprints/footprint-routing.js");
const {sampleFootprints, REGION_TYPE} = await import("../scripts/footprints/footprint-data.js");

const ground = {id: "ground", elevation: {bottom: 0, top: 10}};
const upper = {id: "upper", elevation: {bottom: 10, top: 20}};
const scene = {
  grid: {size: 100}, initialLevel: "ground", walls: [], regions: [],
  levels: new Map([[ground.id, ground], [upper.id, upper]]),
  flags: {"theiks-toolbag": {footprintConfig: {enabled: true, image: "map.png"}}},
  getFlag(_module, key) { return this.flags["theiks-toolbag"][key]; },
  initializeEdges() {}
};
ground.parent = scene;
upper.parent = scene;

function wall(c, {level = "ground", open = false} = {}) {
  return {c, move: 20, isOpen: open, includedInLevel: target => target.id === level};
}
function crossing(a, b, c) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const wx = c[2] - c[0];
  const wy = c[3] - c[1];
  const denominator = dx * wy - dy * wx;
  if (Math.abs(denominator) < 1e-9) return false;
  const px = c[0] - a.x;
  const py = c[1] - a.y;
  const t = (px * wy - py * wx) / denominator;
  const u = (px * dy - py * dx) / denominator;
  return t > 1e-6 && t < 1 - 1e-6 && u >= -1e-6 && u <= 1 + 1e-6;
}
let collisionCalls = 0;
globalThis.CONFIG = {Canvas: {polygonBackends: {move: {testCollision(a, b, options) {
  collisionCalls += 1;
  return scene.walls.some(entry => entry.move !== 0 && !entry.isOpen
    && entry.includedInLevel(options.level) && crossing(a, b, entry.c));
}}}}};

function doorway(closed = false) {
  scene.walls = [
    wall([150, -1000, 150, 100]),
    wall([150, 200, 150, 1000]),
    wall([150, 100, 150, 200], {open: !closed})
  ];
}
function waypoint(centerX, centerY, scale = 1, level = "ground") {
  return {x: centerX - scale * 50, y: centerY - scale * 50,
    width: scale, height: scale, level, elevation: level === "upper" ? 10 : 0};
}
function token(scale = 1, level = "ground") {
  return {width: scale, height: scale, level};
}
const from = {x: 50, y: 60};
const to = {x: 250, y: 120};

test("straight and diagonal clear paths remain unchanged", () => {
  doorway();
  const router = createFootprintRouter(scene, 100);
  assert.deepEqual(router.route("ground", {x: 50, y: 150}, {x: 250, y: 150}, 1, 0),
    [{x: 50, y: 150}, {x: 250, y: 150}]);
  assert.deepEqual(router.route("ground", {x: 50, y: 130}, {x: 250, y: 170}, 1, 0),
    [{x: 50, y: 130}, {x: 250, y: 170}]);
});

test("diagonal prints bend through the open doorway, retain Regions, and reveal by raw progress", () => {
  doorway();
  scene.regions = [{includedInLevel: level => level.id === "ground",
    testPoint: point => point.x >= 100 && point.y >= 100,
    behaviors: [{type: REGION_TYPE, system: {mode: "inherit", image: "doorway.png"}}]}];
  const router = createFootprintRouter(scene, 100);
  const path = router.route("ground", from, to, 1, 0);
  assert.ok(path.length > 2);
  assert.ok(path.slice(1, -1).some(point => point.y > 100));
  assert.ok(path.every((point, index) => index === 0
    || !CONFIG.Canvas.polygonBackends.move.testCollision(path[index - 1], point,
      {type: "move", mode: "any", level: ground})));
  const rawLength = Math.hypot(to.x - from.x, to.y - from.y) / 100;
  const result = sampleFootprints(scene, token(), [waypoint(50, 60), waypoint(250, 120)], "doorway");
  assert.ok(result.prints.length > 0);
  assert.ok(result.prints.some(print => print.image === "doorway.png"));
  assert.ok(result.prints.some(print => Math.abs(print.rotation - 90) > 1));
  assert.ok(result.prints.every(print => print.progress <= rawLength + 1e-8));
  assert.ok(result.prints.every((print, index) => index === 0
    || print.progress >= result.prints[index - 1].progress));
  assert.ok(result.prints.every((print, index) => index === 0 || Math.hypot(
    print.x - result.prints[index - 1].x,
    print.y - result.prints[index - 1].y) >= 40));
  assert.ok(result.prints.every((print, index) => index === 0
    || print.side !== result.prints[index - 1].side));
  scene.regions = [];
});

test("closed door and solid wall leave a gap instead of crossing", () => {
  doorway(true);
  const router = createFootprintRouter(scene, 100);
  assert.equal(router.route("ground", from, to, 1, 0), null);
  const result = sampleFootprints(scene, token(), [waypoint(50, 60), waypoint(250, 120)], "closed");
  assert.deepEqual(result.prints, []);
  assert.equal(result.state, null);
  assert.equal(result.broken, true);
  scene.walls = [wall([150, -1000, 150, 1000])];
  assert.equal(createFootprintRouter(scene, 100).route("ground", from, to, 1, 0), null);
});

test("debug samples record raw and corrected routes and rejected print attempts", () => {
  doorway();
  const routed = sampleFootprints(scene, token(),
    [waypoint(50, 60), waypoint(250, 120)], "debug-doorway", null, {debug: true});
  assert.deepEqual(routed.debug[0].raw, [from, to]);
  assert.ok(routed.debug[0].corrected.length > 2);
  assert.ok(routed.debug[0].attempts.some(attempt => attempt.result === "placed"));
  assert.equal(sampleFootprints(scene, token(),
    [waypoint(50, 60), waypoint(250, 120)], "normal").debug, undefined);

  doorway(true);
  const blocked = sampleFootprints(scene, token(),
    [waypoint(50, 60), waypoint(250, 120)], "debug-blocked", null, {debug: true});
  assert.equal(blocked.debug[0].corrected, null);

  scene.walls = [wall([150, -1000, 150, 1000])];
  const crowded = sampleFootprints(scene, token(),
    [waypoint(165, 0), waypoint(165, 100)], "debug-crowded", null, {debug: true});
  assert.ok(crowded.debug[0].attempts.some(attempt => attempt.result === "overlap"));
});

test("routing observes Levels and scales the doorway clearance", () => {
  doorway();
  scene.walls.push(wall([90, 0, 90, 200], {level: "upper"}));
  const router = createFootprintRouter(scene, 100);
  assert.deepEqual(router.route("upper", {x: 150, y: 150}, {x: 250, y: 150}, 1, 0),
    [{x: 150, y: 150}, {x: 250, y: 150}]);
  for (const scale of [0.5, 2]) {
    const path = router.route("ground", from, to, scale, 0);
    assert.ok(path.length > 2);
    const result = sampleFootprints(scene, token(scale),
      [waypoint(50, 60, scale), waypoint(250, 120, scale)], `scale-${scale}`);
    assert.ok(result.prints.length > 0);
    assert.ok(result.prints.every(print => print.scale === scale));
  }
});

test("a lateral foot is pulled back before it crosses a wall", () => {
  scene.walls = [wall([150, -1000, 150, 1000])];
  const router = createFootprintRouter(scene, 100);
  const foot = router.placeFoot("ground", {x: 145, y: 10}, {x: 157, y: 10}, 1, 0);
  assert.ok(foot.x <= 115.5);
  assert.equal(foot.y, 10);
  assert.ok(collisionCalls > 0);
});

test("a clear centerline still moves visible foot artwork away from a wall", () => {
  scene.walls = [wall([150, -1000, 150, 1000])];
  const router = createFootprintRouter(scene, 100);
  assert.deepEqual(router.route("ground", {x: 165, y: 0}, {x: 165, y: 100}, 1, 0),
    [{x: 165, y: 0}, {x: 165, y: 100}]);
  const foot = router.placeFoot("ground", {x: 165, y: 50}, {x: 153, y: 50}, 1, 0);
  assert.ok(foot.x >= 184.5 && foot.x < 195,
    "keep the visible print clear without pushing it half a tile away");
  assert.equal(foot.y, 50);
  const prints = sampleFootprints(scene, token(),
    [waypoint(165, 0), waypoint(165, 100)], "near-wall").prints;
  assert.ok(prints.length >= 2);
  assert.ok(prints.every(print => print.groundX === 165 && print.x >= 184.5));
  assert.deepEqual(prints.slice(0, 2).map(print => print.side), [0, 1]);
  assert.ok(prints[1].groundY - prints[0].groundY < 60,
    "the pending foot should retry soon after the crowded position");
});

test("wall-end clearance changes only the sideways position of a print", () => {
  scene.walls = [wall([150, 100, 150, 200])];
  const router = createFootprintRouter(scene, 100);
  const groundPoint = {x: 140, y: 80};
  const foot = router.placeFoot("ground", groundPoint, {x: 140, y: 68}, 1, 0);
  assert.ok(foot);
  assert.equal(foot.x, groundPoint.x, "clearance must preserve the print's forward stride");
  assert.ok(Math.hypot(foot.x - 150, foot.y - 100) >= 34.5);
});

test("a wall with no sideways clearance leaves a print gap", () => {
  scene.walls = [wall([150, -1000, 150, 1000])];
  const router = createFootprintRouter(scene, 100);
  assert.equal(router.placeFoot("ground", {x: 140, y: 80}, {x: 140, y: 68}, 1, 0), null);
});

test("a one-grid doorway keeps prints while reserving 0.35 grid by its wall ends", () => {
  doorway();
  const prints = sampleFootprints(scene, token(),
    [waypoint(50, 150), waypoint(250, 150)], "tight-doorway").prints;
  assert.ok(prints.some(print => print.groundX < 150));
  assert.ok(prints.some(print => print.groundX > 150));
  assert.ok(prints.some(print => print.groundX > 125 && print.groundX < 175));
  for (const print of prints) {
    for (const entry of scene.walls.filter(entry => !entry.isOpen)) {
      const nearestY = Math.max(Math.min(entry.c[1], entry.c[3]),
        Math.min(print.y, Math.max(entry.c[1], entry.c[3])));
      assert.ok(Math.hypot(print.x - 150, print.y - nearestY) >= 34.5);
    }
  }
  for (let i = 1; i < prints.length; i += 1) {
    assert.ok(Math.hypot(prints[i].x - prints[i - 1].x,
      prints[i].y - prints[i - 1].y) >= 40,
    "adjacent visible prints must not stack in the narrow doorway");
    assert.notEqual(prints[i].side, prints[i - 1].side,
      "a skipped print must not skip its turn in the left/right sequence");
  }
});

test("print separation carries into the next movement section", () => {
  scene.walls = [wall([150, -1000, 150, 1000])];
  const first = sampleFootprints(scene, token(),
    [waypoint(165, 0), waypoint(165, 100)], "section-one");
  const second = sampleFootprints(scene, token(),
    [waypoint(165, 100), waypoint(165, 200)], "section-two", first.state);
  assert.ok(first.prints.length > 0 && second.prints.length > 0);
  const previous = first.prints.at(-1);
  const next = second.prints[0];
  assert.ok(Math.hypot(next.x - previous.x, next.y - previous.y) >= 40);
  assert.notEqual(next.side, previous.side);
});

test("quadruped feet follow a corrected doorway route without losing their gait", () => {
  doorway();
  const walker = {...token(), flags: {"theiks-toolbag": {footprintConfig: {
    movementType: "quadruped"
  }}}};
  const prints = sampleFootprints(scene, walker,
    [waypoint(50, 60), waypoint(250, 120)], "quadruped-doorway").prints;
  assert.ok(prints.length >= 4);
  assert.ok(prints.some(print => print.groundY > 100));
  const gait = [["hind", 0], ["front", 1], ["front", 0], ["hind", 1]];
  assert.ok(prints.every((print, index) => {
    const [leg, side] = gait[index % gait.length];
    return print.leg === leg && print.side === side;
  }));
  assert.ok(prints.every((print, index) => index === 0 || Math.hypot(
    print.x - prints[index - 1].x, print.y - prints[index - 1].y) >= 30));

  scene.walls = [wall([0, -1000, 0, 100]), wall([50, -1000, 50, 100])];
  const crowded = sampleFootprints(scene, walker,
    [waypoint(25, 0), waypoint(25, 200)], "crowded-quadruped", null, {debug: true});
  assert.ok(crowded.debug[0].attempts.some(attempt => attempt.result !== "placed"));
  assert.ok(crowded.prints.length > 0);
  assert.ok(crowded.prints.every((print, index) => {
    const [leg, side] = gait[index % gait.length];
    return print.leg === leg && print.side === side;
  }));
});

test("alternating quadruped preserves front and hind order through a doorway", () => {
  doorway();
  const walker = {...token(), flags: {"theiks-toolbag": {footprintConfig: {
    movementType: "quadrupedAlternating", image: "hind.png", frontImage: "front.png"
  }}}};
  const prints = sampleFootprints(scene, walker,
    [waypoint(50, 60), waypoint(250, 120)], "alternating-doorway").prints;
  assert.ok(prints.length >= 4);
  assert.ok(prints.some(print => print.groundY > 100));
  const gait = [["hind", 0], ["front", 1], ["hind", 1], ["front", 0]];
  assert.ok(prints.every((print, index) => {
    const [leg, side] = gait[index % gait.length];
    return print.leg === leg && print.side === side
      && print.image === (leg === "front" ? "front.png" : "hind.png");
  }));
});

test("Slither keeps stamps centered through a doorway and leaves gaps beside walls", () => {
  doorway();
  const router = createFootprintRouter(scene, 100);
  assert.equal(router.placeCenter("ground", {x: 140, y: 0}, 1, 0), null);
  assert.deepEqual(router.placeCenter("ground", {x: 150, y: 150}, 1, 0),
    {x: 150, y: 150});
  const walker = {...token(), flags: {"theiks-toolbag": {footprintConfig: {
    movementType: "slither"
  }}}};
  const prints = sampleFootprints(scene, walker,
    [waypoint(50, 60), waypoint(250, 120)], "slither-doorway").prints;
  assert.ok(prints.length > 0);
  assert.ok(prints.some(print => print.groundY > 100));
  assert.ok(prints.every(print => print.x === print.groundX && print.y === print.groundY));
  assert.ok(prints.every((print, index) => print.side === index % 2));
});
