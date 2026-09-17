import assert from "node:assert/strict";
import test from "node:test";

let terrainEnabled = true;
globalThis.game = {
  user: {isGM: true},
  settings: {get: (_module, key) => key === "enableDiggableTerrain" ? terrainEnabled : true},
  i18n: {localize: key => key, format: key => key}
};

const {
  changedLogicalCellIndexes,
  createUndergroundSource,
  DEFAULT_EARTH_SORT,
  digUnderground,
  getAllUndergroundData,
  getUndergroundData,
  getUndergroundOwner,
  getViewedLevelId,
  isDugCell,
  isDugSubcell,
  isUndergroundCell,
  isUndergroundSubcell,
  isViewedUndergroundLevel,
  preserveOverlappingDugMask,
  repairUnderground,
  resetUnderground,
  subcellsForLogicalIndexes,
  UNDERGROUND_FLAG_PATH
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

function applyDugMaskUpdate(doc, change) {
  const full = change[UNDERGROUND_FLAG_PATH];
  if (full && typeof full === "object") {
    doc.flags["theiks-toolbag"] ??= {};
    doc.flags["theiks-toolbag"].undergroundTerrain = full;
    return;
  }
  const dugMask = change[`${UNDERGROUND_FLAG_PATH}.dugMask`];
  if (dugMask) {
    doc.flags["theiks-toolbag"].undergroundTerrain ??= {};
    doc.flags["theiks-toolbag"].undergroundTerrain.dugMask = dugMask;
  }
}

function createLevel(id, flag) {
  return {
    id,
    _id: id,
    flags: flag ? {"theiks-toolbag": {undergroundTerrain: flag}} : {},
    updates: [],
    getFlag(module, key) { return this.flags[module]?.[key]; },
    async update(change) {
      this.updates.push(change);
      applyDugMaskUpdate(this, change);
      return this;
    }
  };
}

function createLeveledScene(levels, sceneFlag) {
  const contents = Array.isArray(levels) ? levels : [levels];
  const collection = new Map(contents.map(level => [level.id, level]));
  collection.contents = contents;
  const scene = {
    id: "scene-1",
    documentName: "Scene",
    initialLevel: contents[0]?.id,
    levels: collection,
    flags: sceneFlag ? {"theiks-toolbag": {undergroundTerrain: sceneFlag}} : {},
    updates: [],
    getFlag(module, key) { return this.flags[module]?.[key]; },
    async update(change) {
      this.updates.push(change);
      applyDugMaskUpdate(this, change);
      return this;
    },
    async unsetFlag(module, key) {
      this.updates.push({unset: `${module}.${key}`});
      delete this.flags[module]?.[key];
    }
  };
  for (const level of contents) level.parent = scene;
  return scene;
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
      applyDugMaskUpdate(this, change);
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

test("preserveOverlappingDugMask keeps dug bits that remain underground", () => {
  const previous = createUndergroundSource(options({
    cells: subcellsForLogicalIndexes([0, 1, 4], 3, 2, 4)
  }));
  const dugBytes = Buffer.from(previous.dugMask, "base64");
  dugBytes[0] |= 1;
  dugBytes[0] |= 1 << 4;
  previous.dugMask = Buffer.from(dugBytes).toString("base64");
  const rebuilt = createUndergroundSource(options({
    cells: subcellsForLogicalIndexes([1, 4], 3, 2, 4)
  }));
  const merged = preserveOverlappingDugMask(rebuilt, previous);
  const data = getUndergroundData(createScene(merged));
  assert.equal(isUndergroundSubcell(data, 0), false);
  assert.equal(isDugSubcell(data, 0), false);
  assert.equal(isDugSubcell(data, 4), true);
});

test("a relative FilePicker texture path joins onto a companion modules/ path", () => {
  const source = createUndergroundSource(options({
    intactSrc: "modules/theiks-map-generator/assets/images/themes/desert-tomb/packed-earth.png",
    dugSrc: "images/themes/desert-tomb/textures/gravel.png"
  }));
  const data = getUndergroundData(createScene(source));
  assert.equal(
    data.dugSrc,
    "modules/theiks-map-generator/assets/images/themes/desert-tomb/textures/gravel.png"
  );
  assert.equal(
    data.intactSrc,
    "modules/theiks-map-generator/assets/images/themes/desert-tomb/packed-earth.png"
  );
});

test("texture grid sizes default to 1x1 and reject invalid sizes", () => {
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

test("dig writes the full underground flag so Foundry persists nested dugMask", async () => {
  const scene = createScene(createUndergroundSource(options()));
  await digUnderground(scene, [0]);
  const change = scene.updates[0];
  assert.equal(typeof change[UNDERGROUND_FLAG_PATH], "object");
  assert.equal(typeof change[UNDERGROUND_FLAG_PATH].dugMask, "string");
  assert.equal(typeof change[UNDERGROUND_FLAG_PATH].sourceMask, "string");
  assert.equal(isDugSubcell(getUndergroundData(scene), 0), true);
});

test("a dug-mask delta reports only the logical cells that changed", () => {
  const scene = createScene(createUndergroundSource(options()));
  const data = getUndergroundData(scene);
  assert.deepEqual([...changedLogicalCellIndexes(data, null)].sort((a, b) => a - b), [0, 1, 4]);
  const previous = Uint8Array.from(data.dugBytes);
  data.dugBytes[0] = 1;
  assert.deepEqual([...changedLogicalCellIndexes(data, previous)], [0]);
});

test("mutation is GM-only and requires the Diggable Terrain feature", async () => {
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
  assert.throws(() => createUndergroundSource(options({subdivision: 3})), /subdivision/);

  const ignored = createUndergroundSource(options({blocksMovement: false, blocksVision: false}));
  assert.equal(ignored.blocksMovement, true);
  assert.equal(ignored.blocksVision, true);
  ignored.blocksMovement = false;
  ignored.blocksVision = false;
  const parsed = getUndergroundData(createScene(ignored));
  assert.equal(parsed.blocksMovement, true);
  assert.equal(parsed.blocksVision, true);

  const unused = createUndergroundSource(options({width: 3, height: 1, subdivision: 2, cells: [0, 1, 2]}));
  const unusedBytes = Uint8Array.from(Buffer.from(unused.sourceMask, "base64"));
  unusedBytes[unusedBytes.length - 1] |= 0b11110000;
  unused.sourceMask = Buffer.from(unusedBytes).toString("base64");
  assert.throws(() => getUndergroundData(createScene(unused)), /outside the underground bounds/);

  const dugOutsideSource = createUndergroundSource(options());
  const dugBytes = new Uint8Array(Math.ceil(12 * 8 / 8));
  dugBytes[1] = 1;
  dugOutsideSource.dugMask = Buffer.from(dugBytes).toString("base64");
  const clipped = getUndergroundData(createScene(dugOutsideSource));
  assert.equal(isDugSubcell(clipped, 8), false, "dug bits outside the effective mask are clipped");
});

test("a Level flag wins over a Scene flag for the same Level", () => {
  const sceneSource = createUndergroundSource(options({intactSrc: "scene-earth.webp", dugSrc: "scene-rubble.webp"}));
  const levelSource = createUndergroundSource(options({intactSrc: "level-earth.webp", dugSrc: "level-rubble.webp"}));
  const ground = createLevel("level-1", levelSource);
  const upper = createLevel("upper");
  const scene = createLeveledScene([ground, upper], sceneSource);
  const data = getUndergroundData(scene, {levelId: "level-1"});
  assert.equal(data.intactSrc, "level-earth.webp");
  assert.equal(getUndergroundOwner(scene, {levelId: "level-1"}), ground);
  assert.equal(getUndergroundData(scene, {levelId: "upper"}), null);
});

test("a Scene flag does not resolve on a different Level", () => {
  const sceneSource = createUndergroundSource(options({levelId: "level-1"}));
  const ground = createLevel("level-1");
  const upper = createLevel("upper");
  const scene = createLeveledScene([ground, upper], sceneSource);
  assert.equal(getUndergroundData(scene, {levelId: "level-1"}).levelId, "level-1");
  assert.equal(getUndergroundOwner(scene, {levelId: "level-1"}), scene);
  assert.equal(getUndergroundData(scene, {levelId: "upper"}), null);
});

test("dig and reset update the Level owner and reset every Level", async () => {
  const groundSource = createUndergroundSource(options({levelId: "level-1"}));
  const upperSource = createUndergroundSource(options({levelId: "upper", intactSrc: "upper.webp", dugSrc: "upper-dug.webp"}));
  const ground = createLevel("level-1", groundSource);
  const upper = createLevel("upper", upperSource);
  const scene = createLeveledScene([ground, upper]);
  globalThis.canvas = {scene, level: ground};
  try {
    await digUnderground(scene, [0]);
    assert.equal(ground.updates.length, 1);
    assert.equal(scene.updates.length, 0);
    assert.equal(isDugSubcell(getUndergroundData(scene, {levelId: "level-1"}), 0), true);

    canvas.level = upper;
    await digUnderground(scene, [0]);
    assert.equal(isDugSubcell(getUndergroundData(scene, {levelId: "upper"}), 0), true);
    assert.equal(getAllUndergroundData(scene).reduce((total, entry) => total + (isDugSubcell(entry.data, 0) ? 1 : 0), 0), 2);

    await resetUnderground(scene);
    assert.equal(isDugSubcell(getUndergroundData(scene, {levelId: "level-1"}), 0), false);
    assert.equal(isDugSubcell(getUndergroundData(scene, {levelId: "upper"}), 0), false);
  } finally {
    globalThis.canvas = undefined;
  }
});

