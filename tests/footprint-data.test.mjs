import assert from "node:assert/strict";
import test from "node:test";

globalThis.game = {settings: {get: (_id, key) => key === "defaultFootprintImage" ? "default.png" : 5}};

const {
  CONFIG_FLAG, MAX_PRINTS, REGION_TYPE, appendFootprints, getLevelFootprintConfig,
  getSceneFootprintConfig, getTokenFootprintConfig, printAlpha, pruneDisabledPrints,
  resolveFootprintPoint, sampleFootprints
} = await import("../scripts/footprints/footprint-data.js");

function flagged(data) {
  return {flags: {"theiks-toolbag": {[CONFIG_FLAG]: data}}, getFlag(_module, name) {
    return this.flags["theiks-toolbag"][name];
  }};
}

function scene(config = {enabled: true, image: "map.png", tint: "#aabbcc"}) {
  const level = {...flagged({}), id: "ground"};
  const map = {...flagged(config), id: "scene", initialLevel: "ground", grid: {size: 100},
    regions: [], levels: new Map([[level.id, level]])};
  level.parent = map;
  return {map, level};
}

function region(mode, {x = 0, width = 100, image = "", tint = "", level = "ground"} = {}) {
  return {
    includedInLevel: target => target.id === level,
    testPoint: point => point.x >= x && point.x < x + width,
    behaviors: [{type: REGION_TYPE, system: {mode, image, tint}}]
  };
}

function token(config = {}) { return {...flagged(config), id: "hero", width: 1, height: 1, level: "ground"}; }
function waypoints(distance = 100, scale = 1) {
  return [
    {x: 0, y: 0, width: scale, height: scale, level: "ground", elevation: 0},
    {x: distance, y: 0, width: scale, height: scale, level: "ground", elevation: 0}
  ];
}

test("scene, level, and token configuration inherit individual fields", () => {
  const {map, level} = scene();
  assert.deepEqual(getSceneFootprintConfig(map), {enabled: true, image: "map.png", tint: "#aabbcc"});
  assert.deepEqual(getLevelFootprintConfig(level), getSceneFootprintConfig(map));
  level.flags["theiks-toolbag"][CONFIG_FLAG] = {enabled: "false", image: "level.png", tint: "#123456"};
  assert.deepEqual(getLevelFootprintConfig(level), {enabled: false, image: "level.png", tint: "#aabbcc"});
  level.flags["theiks-toolbag"][CONFIG_FLAG].tintOverride = true;
  assert.equal(getLevelFootprintConfig(level).tint, "#123456");
  assert.deepEqual(getTokenFootprintConfig(token({noFootprints: true, image: "hero.png"})),
    {noFootprints: true, image: "hero.png"});
});

test("suppress wins; enable and tint override map; token image wins", () => {
  const {map} = scene({enabled: false, image: "map.png", tint: "#ffffff"});
  map.regions.push(region("enable", {image: "region.png", tint: "#010203"}));
  let value = resolveFootprintPoint(map, "ground", {x: 50, y: 0, elevation: 0}, false, token());
  assert.deepEqual({enabled: value.enabled, image: value.image, tint: value.tint},
    {enabled: true, image: "region.png", tint: "#010203"});
  value = resolveFootprintPoint(map, "ground", {x: 50, y: 0, elevation: 0}, false,
    token({image: "hero.png"}));
  assert.equal(value.image, "hero.png");
  map.regions.push(region("suppress"));
  assert.equal(resolveFootprintPoint(map, "ground", {x: 50, y: 0, elevation: 0}).enabled, false);
  assert.equal(resolveFootprintPoint(map, "ground", {x: 50, y: 0, elevation: 0}, false,
    token({noFootprints: true})).enabled, false);
});

test("situational regions carry the prior grid-space state", () => {
  const {map} = scene({enabled: false});
  map.regions.push(region("enable", {x: 0, width: 100}));
  map.regions.push(region("situational", {x: 100, width: 300}));
  let enabled = resolveFootprintPoint(map, "ground", {x: 50, y: 50, elevation: 0}).enabled;
  for (const x of [150, 250, 350]) {
    enabled = resolveFootprintPoint(map, "ground", {x, y: 50, elevation: 0}, enabled).enabled;
    assert.equal(enabled, true);
  }
  assert.equal(resolveFootprintPoint(map, "ground", {x: 150, y: 50, elevation: 0}, false).enabled, false);
  assert.equal(resolveFootprintPoint(map, "ground", {x: 450, y: 50, elevation: 0}, enabled).enabled, false);
});

test("Region image overrides are independent of the footprint rule", () => {
  const {map} = scene({enabled: false, image: "map.png"});
  map.regions.push(region("enable", {x: 0, width: 100}));
  map.regions.push(region("situational", {x: 100, width: 200, image: "situational.png"}));
  const point = {x: 150, y: 50, elevation: 0};
  const carried = resolveFootprintPoint(map, "ground", point, true, token());
  assert.equal(carried.enabled, true);
  assert.equal(carried.image, "situational.png");
  assert.equal(resolveFootprintPoint(map, "ground", point, false, token()).enabled, false);
  assert.equal(resolveFootprintPoint(map, "ground", point, true, token({image: "token.png"})).image,
    "token.png");
  const prints = sampleFootprints(map, token(), waypoints(200), "situational-image").prints;
  assert.ok(prints.some(print => print.groundX >= 100 && print.image === "situational.png"));

  map.flags["theiks-toolbag"][CONFIG_FLAG] = {enabled: true, image: "map.png"};
  map.regions.push(region("inherit", {x: 300, width: 100, image: "unchanged.png"}));
  assert.equal(resolveFootprintPoint(map, "ground", {x: 350, y: 50}, false, token()).image,
    "unchanged.png");
});

test("walking stamps alternating feet and scales both stride and image", () => {
  const {map} = scene();
  const full = sampleFootprints(map, token(), waypoints(200), "move-full");
  const half = sampleFootprints(map, token(), waypoints(200, 0.5), "move-half");
  assert.ok(full.prints.length >= 4);
  assert.ok(half.prints.length > full.prints.length);
  assert.deepEqual(full.prints.slice(0, 4).map(print => print.side), [0, 1, 0, 1]);
  assert.ok(full.prints.every(print => print.scale === 1 && print.image === "map.png"));
  assert.ok(half.prints.every(print => print.scale === 0.5));
  assert.ok(full.prints[1].groundX - full.prints[0].groundX >
    half.prints[1].groundX - half.prints[0].groundX);
});

test("turns use the actual route and level changes have no connecting prints", () => {
  const {map} = scene();
  const turn = sampleFootprints(map, token(), [
    ...waypoints(100),
    {x: 100, y: 100, width: 1, height: 1, level: "ground", elevation: 0}
  ], "turn");
  assert.ok(turn.prints.some(print => Math.abs(print.rotation - 90) < 1));
  assert.ok(turn.prints.some(print => Math.abs(print.rotation - 180) < 1));
  const jump = sampleFootprints(map, token(), [
    waypoints()[0],
    {x: 1000, y: 0, width: 1, height: 1, level: "upper", elevation: 10}
  ], "jump");
  assert.equal(jump.prints.length, 0);
});

test("persisted trail keeps appearance, caps prints, and pruning deletes disabled areas", () => {
  const {map} = scene();
  const marks = sampleFootprints(map, token({image: "old.png"}), waypoints(5000), "long");
  const stored = appendFootprints({trails: {}}, "hero", marks.prints, marks.state);
  assert.equal(stored.trails.hero.prints.length, MAX_PRINTS);
  map.flags["theiks-toolbag"][CONFIG_FLAG] = {enabled: false};
  const pruned = pruneDisabledPrints(stored, map);
  assert.equal(pruned.changed, true);
  assert.equal(pruned.stored.trails.hero.prints.length, 0);
  assert.equal(marks.prints[0].image, "old.png");
});

test("viewer cutoff fades increasingly from halfway through the visible trail", () => {
  assert.equal(printAlpha(0, 0), 0);
  assert.equal(printAlpha(0, 5), 1);
  assert.equal(printAlpha(2, 5), 1);
  assert.equal(printAlpha(2.5, 5), 1);
  assert.equal(printAlpha(3.75, 5), 0.25);
  assert.ok(Math.abs(printAlpha(4, 5) - 0.16) < 1e-10);
  assert.equal(printAlpha(5, 5), 0);
  assert.equal(printAlpha(75, 100), 0.25);
  assert.ok(printAlpha(99, 100) < 0.001);
});
