import assert from "node:assert/strict";
import test from "node:test";

globalThis.game = {
  user: {isGM: true},
  settings: {get: () => true},
  i18n: {localize: key => key, format: key => key}
};

const {
  applyUndergroundSceneSubmit,
  getUndergroundSceneConfigData,
  preserveUndergroundMasks,
  UNDERGROUND_SCENE_FIELDS
} = await import("../scripts/underground/underground-scene-config.js");
const {
  createUndergroundSource,
  getUndergroundData,
  subcellsForLogicalIndexes
} = await import("../scripts/underground/underground-data.js");

function storedSource(overrides = {}) {
  return createUndergroundSource({
    levelId: "level-1",
    origin: {x: 0, y: 0},
    width: 2,
    height: 2,
    gridSize: 100,
    cells: subcellsForLogicalIndexes([0, 1, 2, 3], 2, 2, 4),
    intactSrc: "earth.webp",
    dugSrc: "rubble.webp",
    intactGrid: 3,
    dugGrid: 2,
    blocksMovement: true,
    blocksVision: true,
    ...overrides
  });
}

function sceneWithFlag(flag) {
  return {
    initialLevel: "level-1",
    grid: {size: 100},
    dimensions: {sceneX: 0, sceneY: 0, sceneWidth: 200, sceneHeight: 200},
    tiles: [],
    flags: flag ? {"theiks-toolbag": {undergroundTerrain: flag}} : {},
    getFlag(module, key) {
      return this.flags[module]?.[key];
    }
  };
}

test("Scene Config data exposes stored textures and cell count", () => {
  const source = storedSource({enabled: false});
  const data = getUndergroundSceneConfigData(sceneWithFlag(source));
  assert.equal(data.enabled, false);
  assert.equal(data.intactSrc, "earth.webp");
  assert.equal(data.dugSrc, "rubble.webp");
  assert.equal(data.intactGrid, 3);
  assert.equal(data.dugGrid, 2);
  assert.equal(data.hasSource, true);
  assert.equal(data.cellCount, 64);

  const empty = getUndergroundSceneConfigData(sceneWithFlag(null));
  assert.equal(empty.enabled, false);
  assert.equal(empty.hasSource, false);
  assert.equal(empty.cellCount, 0);
});

test("enabling without a source writes a full underground flag", async () => {
  const submitData = {
    name: "Handmade",
    flags: {
      "theiks-toolbag": {
        undergroundTerrain: {
          enabled: true,
          intactSrc: "undug.webp",
          dugSrc: "dug.webp",
          intactGrid: 5,
          dugGrid: 2
        }
      }
    }
  };
  await applyUndergroundSceneSubmit(sceneWithFlag(null), submitData, {
    sampleTileAlpha: async () => 0,
    getTextureSize: () => ({width: 10, height: 10})
  });
  const source = submitData.flags["theiks-toolbag"].undergroundTerrain;
  const data = getUndergroundData(sceneWithFlag(source));
  assert.equal(source.schemaVersion, 2);
  assert.equal(typeof source.sourceMask, "string");
  assert.equal(typeof source.dugMask, "string");
  assert.equal(data.intactSrc, "undug.webp");
  assert.equal(data.dugSrc, "dug.webp");
  assert.equal(data.intactGrid, 5);
  assert.equal(data.dugGrid, 2);
  assert.equal(data.blocksMovement, true);
  assert.equal(data.enabled, true);
  assert.equal(Object.hasOwn(submitData, UNDERGROUND_SCENE_FIELDS.enabled), false);
});

test("later saves merge appearance fields and keep masks", async () => {
  const existing = storedSource({enabled: true, intactGrid: 3, dugGrid: 2});
  const dugMask = existing.dugMask;
  const sourceMask = existing.sourceMask;
  const submitData = {
    flags: {
      "theiks-toolbag": {
        undergroundTerrain: {
          enabled: false,
          intactSrc: "new-earth.webp",
          dugSrc: "new-rubble.webp",
          intactGrid: 4,
          dugGrid: 1
        }
      }
    }
  };
  await applyUndergroundSceneSubmit(sceneWithFlag(existing), submitData);
  const merged = submitData.flags["theiks-toolbag"].undergroundTerrain;
  assert.equal(merged.enabled, false);
  assert.equal(merged.intactSrc, "new-earth.webp");
  assert.equal(merged.dugSrc, "new-rubble.webp");
  assert.equal(merged.intactGrid, 4);
  assert.equal(merged.dugGrid, 1);
  assert.equal(merged.sourceMask, sourceMask);
  assert.equal(merged.dugMask, dugMask);
  assert.equal(merged.blocksMovement, true);
  assert.equal(merged.blocksVision, true);
});

test("enabling without both textures is rejected", async () => {
  await assert.rejects(
    () => applyUndergroundSceneSubmit(sceneWithFlag(null), {
      flags: {"theiks-toolbag": {undergroundTerrain: {enabled: true, intactSrc: "earth.webp"}}}
    }),
    /TexturesRequired/
  );
});

test("disabling without a source strips partial underground keys", async () => {
  const submitData = {
    name: "Blank",
    [UNDERGROUND_SCENE_FIELDS.enabled]: false,
    [UNDERGROUND_SCENE_FIELDS.intactSrc]: "earth.webp",
    flags: {
      "theiks-toolbag": {
        undergroundTerrain: {enabled: false, intactSrc: "earth.webp"}
      },
      other: {keep: true}
    }
  };
  await applyUndergroundSceneSubmit(sceneWithFlag(null), submitData);
  assert.equal(submitData.flags["theiks-toolbag"].undergroundTerrain, undefined);
  assert.deepEqual(submitData.flags.other, {keep: true});
  assert.equal(Object.hasOwn(submitData, UNDERGROUND_SCENE_FIELDS.enabled), false);
  assert.equal(Object.hasOwn(submitData, UNDERGROUND_SCENE_FIELDS.intactSrc), false);
});

test("partial Scene updates keep an existing source mask", () => {
  const existing = storedSource({enabled: true});
  const changes = {
    flags: {
      "theiks-toolbag": {
        undergroundTerrain: {enabled: false, intactSrc: "restyle.webp"}
      }
    }
  };
  preserveUndergroundMasks(sceneWithFlag(existing), changes);
  const merged = changes.flags["theiks-toolbag"].undergroundTerrain;
  assert.equal(merged.enabled, false);
  assert.equal(merged.intactSrc, "restyle.webp");
  assert.equal(merged.sourceMask, existing.sourceMask);
  assert.equal(merged.dugMask, existing.dugMask);
});
