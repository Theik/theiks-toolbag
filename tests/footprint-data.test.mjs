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
  const level = {...flagged({}), id: "ground", elevation: {bottom: 0, top: 10}};
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
    {noFootprints: true, image: "hero.png", movementType: "bipedal",
      alternateSide: "none", alternateImage: "", frontImage: "",
      frontAlternateSide: "none", frontAlternateImage: ""});
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

test("biped alternate image replaces only its chosen side and mirrors right prints", () => {
  const {map} = scene();
  for (const alternateSide of ["left", "right"]) {
    const prints = sampleFootprints(map, token({
      image: "left.png", alternateSide, alternateImage: "peg.png"
    }), waypoints(200), `alternate-${alternateSide}`).prints;
    assert.ok(prints.length >= 4);
    assert.deepEqual(prints.slice(0, 4).map(print => print.side), [0, 1, 0, 1]);
    assert.ok(prints.every(print => print.image ===
      (print.side === (alternateSide === "left" ? 0 : 1) ? "peg.png" : "left.png")));
  }
  const withoutImage = sampleFootprints(map, token({
    alternateSide: "right", alternateImage: ""
  }), waypoints(100), "empty-alternate").prints;
  assert.ok(withoutImage.every(print => print.image === "map.png"));
});

test("quadruped alternates sides at a shorter stride while using all four legs", () => {
  const {map} = scene();
  const biped = sampleFootprints(map, token(), waypoints(200), "biped").prints;
  const quadruped = sampleFootprints(map, token({movementType: "quadruped"}),
    waypoints(400), "quadruped").prints;
  assert.deepEqual(quadruped.slice(0, 8).map(({leg, side}) => [leg, side]), [
    ["hind", 0], ["front", 1], ["front", 0], ["hind", 1],
    ["hind", 0], ["front", 1], ["front", 0], ["hind", 1]
  ]);
  assert.ok(quadruped.every(print => print.movementType === "quadruped"));
  assert.ok(quadruped.every(print => print.image === "map.png"));
  assert.ok(Math.abs(quadruped[1].groundX - quadruped[0].groundX - 25) < 1e-8);
  assert.ok(quadruped[1].groundX - quadruped[0].groundX <
    biped[1].groundX - biped[0].groundX);
  const half = sampleFootprints(map, token({movementType: "quadruped"}),
    waypoints(400, 0.5), "small-quadruped").prints;
  assert.ok(half.length > quadruped.length);
  assert.ok(half.every(print => print.scale === 0.5));
  assert.ok(Math.abs(half[1].groundX - half[0].groundX - 12.5) < 1e-8);
});

test("alternating quadruped uses front and hind in turn without skipping same-side prints", () => {
  const {map} = scene();
  const walker = token({movementType: "quadrupedAlternating", image: "hind.png",
    alternateSide: "right", alternateImage: "hind-right.png",
    frontImage: "front.png", frontAlternateSide: "left",
    frontAlternateImage: "front-left.png"});
  assert.equal(getTokenFootprintConfig(walker).movementType, "quadrupedAlternating");
  const first = sampleFootprints(map, walker, waypoints(100), "alternating-one");
  const second = sampleFootprints(map, walker,
    [waypoints(100)[1], waypoints(200)[1]], "alternating-two", first.state);
  const prints = [...first.prints, ...second.prints];
  assert.ok(prints.length >= 7);
  assert.ok(prints.every((print, index) => {
    const [leg, side] = [["hind", 0], ["front", 1], ["hind", 1], ["front", 0]][index % 4];
    const image = ["hind.png", "front.png", "hind-right.png", "front-left.png"][index % 4];
    return print.leg === leg && print.side === side && print.image === image
      && print.movementType === "quadrupedAlternating";
  }));
  assert.ok(prints.every((print, index) => index === 0
    || Math.abs(print.groundX - prints[index - 1].groundX - (index % 2 ? 0 : 50)) < 1e-8));
  for (const side of [0, 1]) {
    const lane = prints.filter(print => print.side === side);
    for (let index = 1; index < lane.length - 1; index += 1) {
      if (lane[index].leg !== "front") continue;
      assert.equal(lane[index - 1].leg, "hind");
      assert.equal(lane[index + 1].leg, "hind");
      assert.ok(Math.abs(lane[index].groundX
        - (lane[index - 1].groundX + lane[index + 1].groundX) / 2) < 1e-8);
    }
  }
  const half = sampleFootprints(map, token({movementType: "quadrupedAlternating"}),
    waypoints(100, 0.5), "small-alternating").prints;
  assert.equal(half[0].groundX, half[1].groundX);
  assert.ok(Math.abs(half[2].groundX - half[0].groundX - 25) < 1e-8);
  assert.equal(new Set(prints.map(print => print.segmentId)).size, 1);
  walker.flags["theiks-toolbag"][CONFIG_FLAG].movementType = "quadruped";
  const changed = sampleFootprints(map, walker,
    [waypoints(200)[1], waypoints(300)[1]], "changed-to-hop", second.state);
  assert.notEqual(changed.prints[0].segmentId, prints.at(-1).segmentId);
  assert.deepEqual(changed.prints.slice(0, 4).map(({leg, side}) => [leg, side]), [
    ["hind", 0], ["front", 1], ["front", 0], ["hind", 1]
  ]);
});

test("the four-beat gait continues across movement sections and stays capped", () => {
  const {map} = scene();
  const walker = token({movementType: "quadruped"});
  const first = sampleFootprints(map, walker, waypoints(100), "section-one");
  const second = sampleFootprints(map, walker,
    [waypoints(100)[1], waypoints(200)[1]], "section-two", first.state);
  const combined = [...first.prints, ...second.prints];
  assert.ok(first.prints.length > 0 && second.prints.length > 0);
  assert.ok(combined.every((print, index) => {
    const expected = [["hind", 0], ["front", 1], ["front", 0], ["hind", 1]][index % 4];
    return print.leg === expected[0] && print.side === expected[1];
  }));
  const earlierSpacing = {...first.state, stride: 0.5, next: 0.01};
  const afterSpacingChange = sampleFootprints(map, walker,
    [waypoints(100)[1], waypoints(200)[1]], "new-spacing", earlierSpacing);
  assert.equal(afterSpacingChange.state.stride, 0.25);
  assert.ok(Math.abs(afterSpacingChange.prints[0].groundX - 162.5) < 1e-8);
  assert.notEqual(afterSpacingChange.prints[0].segmentId, first.prints.at(-1).segmentId);
  const long = sampleFootprints(map, walker, waypoints(10000), "long-quadruped");
  const stored = appendFootprints({trails: {}}, "hero", long.prints, long.state);
  assert.equal(stored.trails.hero.prints.length, MAX_PRINTS);
  assert.ok(stored.trails.hero.prints.every(print => print.movementType === "quadruped"));
});

test("quadruped front feet inherit the back pattern or use their own images", () => {
  const {map} = scene();
  const inherited = sampleFootprints(map, token({movementType: "quadruped",
    image: "back.png", alternateSide: "right", alternateImage: "back-right.png"
  }), waypoints(200), "inherited-front").prints;
  assert.deepEqual(inherited.slice(0, 4).map(print => print.image), [
    "back.png", "back-right.png", "back.png", "back-right.png"
  ]);
  const retainedPickerValue = sampleFootprints(map, token({movementType: "quadruped",
    image: "back.png", alternateSide: "right", alternateImage: "back-right.png",
    frontAlternateSide: "none", frontAlternateImage: "unused.png"
  }), waypoints(200), "front-picker-retained").prints;
  assert.deepEqual(retainedPickerValue.slice(0, 4).map(print => print.image), [
    "back.png", "back-right.png", "back.png", "back-right.png"
  ]);

  const specific = sampleFootprints(map, token({movementType: "quadruped",
    image: "back.png", alternateSide: "right", alternateImage: "back-right.png",
    frontImage: "front.png", frontAlternateSide: "left", frontAlternateImage: "front-left.png"
  }), waypoints(200), "specific-front").prints;
  assert.deepEqual(specific.slice(0, 4).map(print => print.image), [
    "back.png", "front.png", "front-left.png", "back-right.png"
  ]);

  const partial = sampleFootprints(map, token({movementType: "quadruped",
    image: "back.png", frontAlternateSide: "right", frontAlternateImage: "front-right.png"
  }), waypoints(200), "partial-front").prints;
  assert.deepEqual(partial.slice(0, 4).map(print => print.image), [
    "back.png", "front-right.png", "back.png", "back.png"
  ]);
});

test("Region image changes affect normal steps while Token alternates keep priority", () => {
  const {map} = scene();
  map.regions.push(region("inherit", {x: 100, width: 300, image: "region.png"}));
  const prints = sampleFootprints(map, token({movementType: "quadruped",
    alternateSide: "right", alternateImage: "alternate.png"
  }), waypoints(250), "region-gait").prints;
  assert.ok(prints.some(print => print.groundX < 100 && print.image === "map.png"));
  assert.ok(prints.some(print => print.groundX >= 100 && print.side === 0
    && print.image === "region.png"));
  assert.ok(prints.some(print => print.groundX >= 100 && print.side === 1
    && print.image === "alternate.png"));
});

test("Slither stamps the route center and mirrors successive images", () => {
  const {map} = scene();
  const slither = sampleFootprints(map, token({movementType: "slither"}),
    waypoints(200), "slither").prints;
  const biped = sampleFootprints(map, token(), waypoints(200), "biped").prints;
  assert.equal(slither.length, biped.length);
  assert.ok(slither.every(print => print.x === print.groundX && print.y === print.groundY));
  assert.deepEqual(slither.slice(0, 4).map(print => print.side), [0, 1, 0, 1]);
  assert.ok(slither.every(print => print.leg === "body" && print.image === "map.png"));
});

test("changing movement type starts a new segment while preserving stamped prints", () => {
  const {map} = scene();
  const walker = token();
  const first = sampleFootprints(map, walker, waypoints(100), "first");
  walker.flags["theiks-toolbag"][CONFIG_FLAG].movementType = "slither";
  const next = sampleFootprints(map, walker, [waypoints(100)[1], waypoints(200)[1]],
    "next", first.state);
  assert.ok(next.prints.length > 0);
  assert.notEqual(next.prints[0].segmentId, first.prints.at(-1).segmentId);
  assert.equal(next.prints[0].side, 0);
  assert.equal(first.prints[0].image, "map.png");
  assert.equal(next.state.movementType, "slither");
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

test("only movement exactly at the current Level's bottom stamps prints", () => {
  const {map} = scene();
  const upper = {...flagged({}), id: "upper", elevation: {bottom: 10, top: 20}, parent: map};
  const below = {...flagged({}), id: "below", elevation: {bottom: -10, top: 0}, parent: map};
  map.levels.set("upper", upper);
  map.levels.set("below", below);
  const moveAt = (level, elevation) => waypoints(200).map(point => ({...point, level, elevation}));

  for (const [level, elevation] of [
    ["ground", 5], ["ground", -1], ["upper", 15], ["upper", 0], ["below", -9]
  ]) {
    const result = sampleFootprints(map, token(), moveAt(level, elevation), `${level}-${elevation}`);
    assert.equal(result.prints.length, 0, `${level} at ${elevation}`);
    assert.equal(result.broken, true);
  }
  for (const [level, elevation] of [["ground", 0], ["upper", 10], ["below", -10]]) {
    const result = sampleFootprints(map, token(), moveAt(level, elevation), `${level}-surface`);
    assert.ok(result.prints.length > 0, `${level} at its surface`);
    assert.ok(result.prints.every(print => print.elevation === elevation && print.levelId === level));
  }
  const elevatedToken = {...token(), elevation: 5};
  const withoutWaypointElevation = waypoints(200).map(({elevation: _elevation, ...point}) => point);
  assert.equal(sampleFootprints(map, elevatedToken, withoutWaypointElevation, "token-elevation").prints.length, 0);
  map.levels.get("ground").elevation = {};
  assert.equal(sampleFootprints(map, token(), waypoints(200), "unknown-surface").prints.length, 0);
});

test("ascending and descending leave gaps and resume with a new segment", () => {
  const {map} = scene();
  const point = (x, elevation) => ({
    x, y: 0, width: 1, height: 1, level: "ground", elevation
  });
  const result = sampleFootprints(map, token(), [
    point(0, 0), point(100, 0), point(100, 5), point(200, 5),
    point(300, 0), point(400, 0)
  ], "flight");
  assert.ok(result.prints.some(print => print.groundX < 200));
  assert.ok(result.prints.some(print => print.groundX > 300));
  assert.ok(result.prints.every(print => print.groundX < 200 || print.groundX > 300));
  assert.equal(new Set(result.prints.map(print => print.segmentId)).size, 2);
});

test("teleport actions break trails and walking resumes at the destination", () => {
  const {map} = scene();
  const point = (x, action = "walk") => ({
    x, y: 0, width: 1, height: 1, level: "ground", elevation: 0, action
  });
  const onlyTeleport = sampleFootprints(map, token(),
    [point(0), point(1000, "displace")], "teleport");
  assert.deepEqual(onlyTeleport.prints, []);
  assert.equal(onlyTeleport.state, null);
  assert.equal(onlyTeleport.broken, true);

  const mixed = sampleFootprints(map, token(), [
    point(0), point(100), point(1000, "blink"), point(1100)
  ], "mixed");
  assert.ok(mixed.prints.some(print => print.groundX < 200));
  assert.ok(mixed.prints.some(print => print.groundX > 1000));
  assert.ok(mixed.prints.every(print => print.groundX < 200 || print.groundX > 1000));
  assert.equal(new Set(mixed.prints.map(print => print.segmentId)).size, 2);
  assert.ok(mixed.prints.filter(print => print.groundX > 1000).every(print => print.progress >= 10));

  const originalConfig = globalThis.CONFIG;
  globalThis.CONFIG = {Token: {movement: {actions: {portal: {teleport: true}}}}};
  try {
    assert.equal(sampleFootprints(map, token(),
      [point(0), point(1000, "portal")], "custom-teleport").prints.length, 0);
  } finally {
    globalThis.CONFIG = originalConfig;
  }
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
