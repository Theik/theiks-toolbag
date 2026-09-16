import assert from "node:assert/strict";
import test from "node:test";

globalThis.game = {
  user: {isGM: true},
  settings: {get: () => true},
  i18n: {localize: key => key, format: key => key}
};

const {
  collectSceneUndergroundSubcellIndexes,
  createUndergroundSourceFromScene,
  getSceneUndergroundBounds,
  getTileTextureTransform,
  worldPointToTileUv
} = await import("../scripts/underground/underground-occupancy.js");
const {getUndergroundData, isUndergroundSubcell} = await import("../scripts/underground/underground-data.js");

function scene(overrides = {}) {
  return {
    initialLevel: "level-1",
    grid: {size: 100},
    dimensions: {sceneX: 0, sceneY: 0, sceneWidth: 200, sceneHeight: 200},
    tiles: [],
    ...overrides
  };
}

function tile(overrides = {}) {
  const {texture, ...rest} = overrides;
  return {
    hidden: false,
    x: 50,
    y: 50,
    width: 100,
    height: 100,
    rotation: 0,
    levels: [],
    ...rest,
    texture: {
      src: "floor.webp",
      width: 10,
      height: 10,
      anchorX: 0.5,
      anchorY: 0.5,
      scaleX: 1,
      scaleY: 1,
      fit: "fill",
      alphaThreshold: 0.75,
      ...texture
    }
  };
}

function occupancyOptions(sampleTileAlpha, extra = {}) {
  return {
    subdivision: 4,
    sampleTileAlpha,
    getTextureSize: current => ({
      width: current.texture.width,
      height: current.texture.height
    }),
    ...extra
  };
}

test("playable Scene bounds become a logical underground grid", () => {
  const bounds = getSceneUndergroundBounds(scene({
    grid: {size: 100},
    dimensions: {sceneX: 200, sceneY: 300, sceneWidth: 250, sceneHeight: 150}
  }));
  assert.deepEqual(bounds, {origin: {x: 200, y: 300}, width: 3, height: 2, gridSize: 100});
});

test("an empty Scene fills every subcell", async () => {
  const cells = await collectSceneUndergroundSubcellIndexes(scene(), occupancyOptions(async () => 1));
  assert.equal(cells.length, 64);
  assert.deepEqual(cells, Array.from({length: 64}, (_, index) => index));
});

test("opaque pixels punch holes and transparent pixels stay earth", async () => {
  const opaque = await collectSceneUndergroundSubcellIndexes(scene({
    tiles: [tile()]
  }), occupancyOptions(async () => 1));
  assert.equal(opaque.includes(0), false);
  assert.equal(opaque.includes(3), false);
  assert.equal(opaque.includes(27), false);
  assert.equal(opaque.includes(4), true);
  assert.equal(opaque.length, 48);

  const clear = await collectSceneUndergroundSubcellIndexes(scene({
    tiles: [tile()]
  }), occupancyOptions(async () => 0));
  assert.equal(clear.length, 64);
});

test("hidden and wrong-Level Tiles are ignored", async () => {
  const hidden = await collectSceneUndergroundSubcellIndexes(scene({
    tiles: [tile({hidden: true})]
  }), occupancyOptions(async () => 1));
  assert.equal(hidden.length, 64);

  const otherLevel = await collectSceneUndergroundSubcellIndexes(scene({
    tiles: [tile({levels: ["other"]})]
  }), occupancyOptions(async () => 1, {levelId: "level-1"}));
  assert.equal(otherLevel.length, 64);

  const matching = await collectSceneUndergroundSubcellIndexes(scene({
    tiles: [tile({levels: ["level-1"]})]
  }), occupancyOptions(async () => 1, {levelId: "level-1"}));
  assert.equal(matching.length, 48);
});

test("tile AABB sampling does not visit far-away subcells", async () => {
  const sampled = [];
  await collectSceneUndergroundSubcellIndexes(scene({
    tiles: [tile()]
  }), occupancyOptions(async (_tile, u, v) => {
    sampled.push([u, v]);
    return 1;
  }));
  assert.ok(sampled.length > 0);
  assert.ok(sampled.length <= 16);
  for (const [u, v] of sampled) {
    assert.ok(u >= 0 && u <= 1);
    assert.ok(v >= 0 && v <= 1);
  }
});

test("world points invert the Tile texture transform", () => {
  const transform = getTileTextureTransform(tile(), {width: 10, height: 10});
  assert.deepEqual(worldPointToTileUv(transform, 50, 50), {u: 0.5, v: 0.5});
  assert.deepEqual(worldPointToTileUv(transform, 0, 0), {u: 0, v: 0});
  assert.deepEqual(worldPointToTileUv(transform, 100, 100), {u: 1, v: 1});
  assert.equal(worldPointToTileUv(transform, 150, 150), null);
});

test("createSourceFromScene fills empty space and defaults blocking on", async () => {
  const source = await createUndergroundSourceFromScene(scene(), {
    intactSrc: "earth.webp",
    dugSrc: "rubble.webp",
    intactGrid: 5,
    dugGrid: 2,
    sampleTileAlpha: async () => 0,
    getTextureSize: () => ({width: 10, height: 10})
  });
  const data = getUndergroundData({
    getFlag: () => source,
    flags: {"theiks-toolbag": {undergroundTerrain: source}}
  });
  assert.equal(source.levelId, "level-1");
  assert.equal(data.width, 2);
  assert.equal(data.height, 2);
  assert.equal(data.intactGrid, 5);
  assert.equal(data.dugGrid, 2);
  assert.equal(data.blocksMovement, true);
  assert.equal(data.blocksVision, true);
  assert.equal(isUndergroundSubcell(data, 0), true);
  assert.equal([...Array(64).keys()].every(index => isUndergroundSubcell(data, index)), true);
});
