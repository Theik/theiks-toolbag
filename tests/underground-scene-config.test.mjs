import assert from "node:assert/strict";
import test from "node:test";

globalThis.game = {
  user: {isGM: true},
  settings: {get: () => true},
  i18n: {localize: key => key, format: key => key}
};

const {
  applyUndergroundLevelSubmit,
  applyUndergroundSceneSubmit,
  getUndergroundSceneConfigData,
  needsOccupancyScan,
  preserveUndergroundMasks,
  shouldShowSceneUndergroundConfig,
  UNDERGROUND_SCENE_FIELDS
} = await import("../scripts/underground/underground-scene-config.js");
const {
  createUndergroundSource,
  getUndergroundData,
  isDugSubcell,
  isUndergroundSubcell,
  subcellsForLogicalIndexes,
  UNDERGROUND_FLAG_PATH
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
    },
    async unsetFlag(module, key) {
      this.unset = `${module}.${key}`;
      if (this.flags[module]) delete this.flags[module][key];
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

test("a dugMask-only update keeps the newly dug bits", () => {
  const existing = storedSource({enabled: true});
  const changes = {
    flags: {
      "theiks-toolbag": {
        undergroundTerrain: {dugMask: "newly-dug"}
      }
    }
  };
  preserveUndergroundMasks(sceneWithFlag(existing), changes);
  const merged = changes.flags["theiks-toolbag"].undergroundTerrain;
  assert.equal(merged.dugMask, "newly-dug");
  assert.equal(merged.sourceMask, existing.sourceMask);
  assert.equal(merged.enabled, existing.enabled);
});

function createConfigLevel(id) {
  return {
    id,
    _id: id,
    flags: {},
    updates: [],
    getFlag(module, key) { return this.flags[module]?.[key]; },
    async update(change) {
      this.updates.push(change);
      const source = change[UNDERGROUND_FLAG_PATH];
      if (source) {
        this.flags["theiks-toolbag"] ??= {};
        this.flags["theiks-toolbag"].undergroundTerrain = source;
      }
      return this;
    }
  };
}

function attachLevels(scene, levels) {
  const contents = Array.isArray(levels) ? levels : [levels];
  scene.levels = {
    contents,
    get(id) { return contents.find(level => level.id === id) ?? null; },
    values() { return contents.values(); }
  };
  for (const level of contents) level.parent = scene;
  return scene;
}

test("Scene Config underground is hidden when a Scene has multiple Levels", () => {
  const scene = attachLevels(sceneWithFlag(null), [createConfigLevel("ground"), createConfigLevel("upper")]);
  assert.equal(shouldShowSceneUndergroundConfig(scene), false);
  assert.equal(shouldShowSceneUndergroundConfig(sceneWithFlag(null)), true);
  assert.equal(shouldShowSceneUndergroundConfig(attachLevels(sceneWithFlag(null), [createConfigLevel("ground")])), true);
});

test("Scene Config create on a one-Level Scene writes the Level, not the Scene", async () => {
  const level = createConfigLevel("level-1");
  const scene = attachLevels(sceneWithFlag(null), [level]);
  const submitData = {
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
  await applyUndergroundSceneSubmit(scene, submitData, {
    sampleTileAlpha: async () => 0,
    getTextureSize: () => ({width: 10, height: 10})
  });
  assert.equal(submitData.flags["theiks-toolbag"]?.undergroundTerrain, undefined);
  const source = level.updates[0][UNDERGROUND_FLAG_PATH];
  assert.equal(source.levelId, "level-1");
  assert.equal(source.intactSrc, "undug.webp");
  assert.equal(typeof source.sourceMask, "string");
});

test("Level Config submit creates and later merges a source on that Level", async () => {
  const level = createConfigLevel("upper");
  const scene = attachLevels(sceneWithFlag(null), [createConfigLevel("ground"), level]);
  const submitData = {
    flags: {
      "theiks-toolbag": {
        undergroundTerrain: {
          enabled: true,
          intactSrc: "upper-earth.webp",
          dugSrc: "upper-rubble.webp",
          intactGrid: 2,
          dugGrid: 1
        }
      }
    }
  };
  await applyUndergroundLevelSubmit(level, submitData, {
    scene,
    sampleTileAlpha: async () => 0,
    getTextureSize: () => ({width: 10, height: 10})
  });
  const created = submitData.flags["theiks-toolbag"].undergroundTerrain;
  assert.equal(created.levelId, "upper");
  assert.equal(created.intactGrid, 2);
  const sourceMask = created.sourceMask;
  level.flags = {"theiks-toolbag": {undergroundTerrain: created}};

  const mergeData = {
    flags: {
      "theiks-toolbag": {
        undergroundTerrain: {
          enabled: false,
          intactSrc: "new.webp",
          dugSrc: "new-dug.webp",
          intactGrid: 3,
          dugGrid: 4
        }
      }
    }
  };
  await applyUndergroundLevelSubmit(level, mergeData, {scene});
  const merged = mergeData.flags["theiks-toolbag"].undergroundTerrain;
  assert.equal(merged.enabled, false);
  assert.equal(merged.intactSrc, "new.webp");
  assert.equal(merged.sourceMask, sourceMask);
  assert.equal(merged.dugMask, created.dugMask);
});

test("texture-only save with underground still enabled keeps masks", async () => {
  const existing = storedSource({enabled: true});
  const submitData = {
    flags: {
      "theiks-toolbag": {
        undergroundTerrain: {
          enabled: true,
          intactSrc: "restyle.webp",
          dugSrc: "restyle-dug.webp",
          intactGrid: 2,
          dugGrid: 3
        }
      }
    }
  };
  await applyUndergroundSceneSubmit(sceneWithFlag(existing), submitData);
  const merged = submitData.flags["theiks-toolbag"].undergroundTerrain;
  assert.equal(merged.intactSrc, "restyle.webp");
  assert.equal(merged.sourceMask, existing.sourceMask);
  assert.equal(merged.dugMask, existing.dugMask);
});

test("re-enabling after disable rescans occupancy and keeps overlapping dug bits", async () => {
  const existing = storedSource({enabled: false});
  const dugBytes = Buffer.from(existing.dugMask, "base64");
  dugBytes[0] |= 1;
  dugBytes[0] |= 1 << 4;
  existing.dugMask = Buffer.from(dugBytes).toString("base64");
  const submitData = {
    flags: {
      "theiks-toolbag": {
        undergroundTerrain: {
          enabled: true,
          intactSrc: "earth.webp",
          dugSrc: "rubble.webp",
          intactGrid: 1,
          dugGrid: 1
        }
      }
    }
  };
  await applyUndergroundSceneSubmit(sceneWithFlag(existing), submitData, {
    cells: [4]
  });
  const rebuilt = submitData.flags["theiks-toolbag"].undergroundTerrain;
  const data = getUndergroundData(sceneWithFlag(rebuilt));
  assert.equal(isUndergroundSubcell(data, 0), false);
  assert.equal(isUndergroundSubcell(data, 4), true);
  assert.equal(isDugSubcell(data, 0), false);
  assert.equal(isDugSubcell(data, 4), true);
});

test("needsOccupancyScan is true for first enable and re-enable after disable", () => {
  const enabled = storedSource({enabled: true});
  const disabled = storedSource({enabled: false});
  assert.equal(needsOccupancyScan(null, {enabled: true}), true);
  assert.equal(needsOccupancyScan(enabled, {enabled: true}), false);
  assert.equal(needsOccupancyScan(disabled, {enabled: true}), true);
  assert.equal(needsOccupancyScan(disabled, {enabled: false}), false);
});

