import assert from "node:assert/strict";
import test from "node:test";

let terrainEnabled = true;
globalThis.game = {
  user: {isGM: true},
  settings: {get: (_module, key) => key === "enableBreakableTerrain" ? terrainEnabled : true},
  i18n: {localize: key => key, format: key => key}
};

const {
  changedLogicalCellIndexes,
  createUndergroundSource,
  DEFAULT_EARTH_SORT,
  digUnderground,
  getUndergroundData,
  getViewedLevelId,
  isDugCell,
  isDugSubcell,
  isUndergroundCell,
  isViewedUndergroundLevel,
  repairUnderground,
  resetUnderground,
  subcellsForLogicalIndexes
} = await import("../scripts/underground/underground-data.js");

function options(overrides = {}) {
  const width = overrides.width ?? 3;
  const height = overrides.height ?? 2;
  const subdivision = overrides.subdivision ?? 4;
  const cells = overrides.cells ?? subcellsForLogicalIndexes([0, 1, 4], width, height, subdivision);
  return {
    levelId: "level-1",
    origin: {x: 100, y: 200},
    width,
    height,
    gridSize: 100,
    intactSrc: "earth.webp",
    dugSrc: "rubble.webp",
    blocksMovement: true,
    blocksVision: true,
    ...overrides,
    cells
  };
}

function createScene(flag) {
  return {
    id: "scene-1",
    documentName: "Scene",
    flags: {"theiks-toolbag": {undergroundTerrain: flag}},
    updates: [],
    getFlag(module, key) { return this.flags[module]?.[key]; },
    async update(change) {
      this.updates.push(change);
      const dugMask = change["flags.theiks-toolbag.undergroundTerrain.dugMask"];
      if (dugMask) this.flags["theiks-toolbag"].undergroundTerrain.dugMask = dugMask;
      return this;
    }
  };
}

test("source masks round-trip with background textures and blocking settings", () => {
  const source = createUndergroundSource(options());
  const data = getUndergroundData(createScene(source));
  assert.deepEqual([0, 1, 2, 3, 4, 5].filter(index => isUndergroundCell(data, index)), [0, 1, 4]);
  assert.equal(data.intactSrc, "earth.webp");
  assert.equal(source.schemaVersion, 2);
  assert.equal(data.subdivision, 4);
  assert.equal(data.subWidth, 12);
  assert.equal(data.enabled, true);
  assert.equal(data.dugSrc, "rubble.webp");
  assert.equal(data.blocksMovement, true);
  assert.equal(data.blocksVision, true);
  assert.equal(data.sort, DEFAULT_EARTH_SORT);
  assert.equal(data.intactGrid, 1);
  assert.equal(data.dugGrid, 1);
  assert.equal(source.intactGrid, 1);
  assert.equal(source.dugGrid, 1);
  assert.equal(source.sourceMask.length, source.dugMask.length);
  assert.equal(data.sourceBytes.length, data.dugBytes.length);
});

test("stored sources can be disabled without discarding their masks", () => {
  const source = createUndergroundSource(options({enabled: false}));
  const data = getUndergroundData(createScene(source));
  assert.equal(source.enabled, false);
  assert.equal(data.enabled, false);
  assert.equal(isUndergroundCell(data, 4), true);

  delete source.enabled;
  assert.equal(getUndergroundData(createScene(source)).enabled, true, "legacy sources default on");
});

test("texture grid periods default to 1x1 and reject invalid sizes", () => {
  assert.equal(getUndergroundData(createScene(createUndergroundSource(options({intactGrid: 5, dugGrid: 2})))).intactGrid, 5);
  assert.equal(getUndergroundData(createScene(createUndergroundSource(options({intactGrid: 5, dugGrid: 2})))).dugGrid, 2);

  const legacy = createUndergroundSource(options());
  delete legacy.intactGrid;
  delete legacy.dugGrid;
  const data = getUndergroundData(createScene(legacy));
  assert.equal(data.intactGrid, 1);
  assert.equal(data.dugGrid, 1);

  assert.throws(() => createUndergroundSource(options({intactGrid: 0})), /intactGrid/);
  assert.throws(() => createUndergroundSource(options({dugGrid: 1.5})), /dugGrid/);
});

test("dig, repair, and reset merge against the latest Scene mask in one update", async () => {
  const scene = createScene(createUndergroundSource(options()));
  const logical0 = 0;
  const logical4 = (1 * 4 * 12) + (1 * 4);
  const outside = 8;
  await digUnderground(scene, [logical0, logical0, outside, logical4]);
  assert.equal(scene.updates.length, 1);
  let data = getUndergroundData(scene);
  assert.equal(isDugSubcell(data, logical0), true);
  assert.equal(isDugSubcell(data, logical4), true);
  assert.equal(isDugSubcell(data, outside), false);
  assert.equal(isDugCell(data, 0), true);
  assert.equal(isDugCell(data, 4), true);
  assert.equal(isDugCell(data, 2), false);

  await repairUnderground(scene, [logical0, outside]);
  assert.equal(scene.updates.length, 2);
  data = getUndergroundData(scene);
  assert.equal(isDugSubcell(data, logical0), false);
  assert.equal(isDugSubcell(data, logical4), true);

  await resetUnderground(scene);
  assert.equal(scene.updates.length, 3);
  assert.equal(isDugSubcell(getUndergroundData(scene), logical4), false);
});

test("a dug-mask delta reports only the logical cells that changed", () => {
  const scene = createScene(createUndergroundSource(options()));
  const data = getUndergroundData(scene);
  assert.deepEqual([...changedLogicalCellIndexes(data, null)].sort((a, b) => a - b), [0, 1, 4]);
  const previous = Uint8Array.from(data.dugBytes);
  data.dugBytes[0] = 1;
  assert.deepEqual([...changedLogicalCellIndexes(data, previous)], [0]);
});

test("mutation is GM-only and requires the Breakable Terrain feature", async () => {
  const scene = createScene(createUndergroundSource(options()));
  game.user.isGM = false;
  await assert.rejects(() => digUnderground(scene, [0]), /GmOnly/);
  game.user.isGM = true;
  terrainEnabled = false;
  await assert.rejects(() => repairUnderground(scene, [0]), /Settings.Disabled/);
  terrainEnabled = true;
});

test("viewed Level matching accepts id, _id, and a missing view with matching initialLevel", () => {
  const data = {levelId: "defaultLevel0000"};
  assert.equal(getViewedLevelId({id: "ground"}), "ground");
  assert.equal(getViewedLevelId({_id: "defaultLevel0000"}), "defaultLevel0000");
  assert.equal(isViewedUndergroundLevel(data, {level: {_id: "defaultLevel0000"}}), true);
  assert.equal(isViewedUndergroundLevel(data, {level: {id: "other"}}), false);
  assert.equal(isViewedUndergroundLevel(data, {
    level: null,
    scene: {initialLevel: "defaultLevel0000"}
  }), true);
  assert.equal(isViewedUndergroundLevel(data, {level: null, scene: {initialLevel: "other"}}), false);
});

test("source creation and reading reject malformed or corrupted data", () => {
  assert.throws(() => createUndergroundSource(options({cells: [96]})), /outside/);
  assert.throws(() => createUndergroundSource(options({dugSrc: ""})), /dugSrc/);
  assert.throws(() => createUndergroundSource(options({intactSrc: ""})), /intactSrc/);
  assert.throws(() => createUndergroundSource(options({blocksVision: null})), /Boolean/);
  assert.throws(() => createUndergroundSource(options({subdivision: 3})), /subdivision/);

  const unused = createUndergroundSource(options({width: 3, height: 1, subdivision: 2, cells: [0, 1, 2]}));
  const unusedBytes = Uint8Array.from(Buffer.from(unused.sourceMask, "base64"));
  unusedBytes[unusedBytes.length - 1] |= 0b11110000;
  unused.sourceMask = Buffer.from(unusedBytes).toString("base64");
  assert.throws(() => getUndergroundData(createScene(unused)), /outside the underground bounds/);

  const dugOutsideSource = createUndergroundSource(options());
  const dugBytes = new Uint8Array(Math.ceil(12 * 8 / 8));
  dugBytes[1] = 1;
  dugOutsideSource.dugMask = Buffer.from(dugBytes).toString("base64");
  assert.throws(() => getUndergroundData(createScene(dugOutsideSource)), /non-underground subcell 8/);
});
