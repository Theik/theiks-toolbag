import assert from "node:assert/strict";
import test from "node:test";
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {dirname, join} from "node:path";

globalThis.Hooks = {on() {}};
globalThis.CONFIG = {RegionBehavior: {dataModels: {}, typeLabels: {}, typeIcons: {}}};
globalThis.foundry = {data: {regionBehaviors: {RegionBehaviorType: class {}}}};
globalThis.game = {
  user: {isGM: true},
  settings: {get: () => true},
  i18n: {localize: key => key}
};

const {
  createUndergroundSource,
  digUnderground,
  getUndergroundData,
  isDugSubcell,
  isUndergroundSubcell,
  preserveOverlappingDugMask,
  subcellsForLogicalIndexes,
  UNDERGROUND_FLAG_PATH
} = await import("../scripts/underground/underground-data.js");
const {
  ALTER_DIGGABLE_BEHAVIOR,
  FORCE_DIGGABLE_BEHAVIOR,
  SUPPRESS_DIGGABLE_BEHAVIOR,
  applyUndergroundRegionOccupancy,
  cellAppearance,
  isForcedCell,
  isForcedSubcell,
  isSuppressedSubcell,
  registerUndergroundRegionBehaviors
} = await import("../scripts/underground/underground-regions.js");

function source(overrides = {}) {
  const width = overrides.width ?? 2;
  const height = overrides.height ?? 2;
  const subdivision = overrides.subdivision ?? 4;
  return createUndergroundSource({
    levelId: "level-1",
    origin: {x: 0, y: 0},
    width,
    height,
    gridSize: 100,
    intactSrc: "earth.webp",
    dugSrc: "rubble.webp",
    ...overrides,
    cells: overrides.cells ?? subcellsForLogicalIndexes(
      overrides.logicalCells ?? [0],
      width,
      height,
      subdivision
    )
  });
}

function rectRegion({
  id = "region",
  x = 0,
  y = 0,
  width = 100,
  height = 100,
  type,
  levels = ["level-1"],
  hidden = false,
  disabled = false,
  system
} = {}) {
  const types = Array.isArray(type) ? type : [type];
  return {
    id,
    hidden,
    levels,
    shapes: [{type: "rectangle", x, y, width, height}],
    bounds: {x, y, width, height},
    behaviors: types.filter(Boolean).map((behaviorType, index) => ({
      id: `${id}-${index}`,
      type: behaviorType,
      disabled,
      system
    })),
    testPoint(point) {
      if (!Number.isFinite(point?.elevation)) return false;
      return point.x >= x && point.x < x + width && point.y >= y && point.y < y + height;
    }
  };
}

function sceneWithRegions(flag, regions, levels = [{id: "level-1"}]) {
  const contents = Array.isArray(levels) ? levels : [levels];
  const collection = new Map(contents.map(level => [level.id, level]));
  collection.contents = contents;
  const scene = {
    id: "scene",
    documentName: "Scene",
    initialLevel: contents[0]?.id,
    levels: collection,
    regions: {contents: regions, values() { return regions.values(); }},
    flags: flag ? {"theiks-toolbag": {undergroundTerrain: flag}} : {},
    getFlag(module, key) { return this.flags[module]?.[key]; },
    async update(change) {
      const full = change[UNDERGROUND_FLAG_PATH];
      if (full) {
        this.flags["theiks-toolbag"] ??= {};
        this.flags["theiks-toolbag"].undergroundTerrain = full;
      }
      return this;
    }
  };
  for (const level of contents) level.parent = scene;
  for (const region of regions) region.parent = scene;
  return scene;
}

test("force makes an opaque floor diggable", () => {
  const scene = sceneWithRegions(
    source({cells: []}),
    [rectRegion({type: FORCE_DIGGABLE_BEHAVIOR, x: 0, y: 0, width: 100, height: 100})]
  );
  const data = getUndergroundData(scene);
  assert.equal(isUndergroundSubcell(data, 0), true);
  assert.equal(isForcedSubcell(data, 0), true);
  assert.equal(isForcedCell(data, 0), true);
  assert.equal(isUndergroundSubcell(data, 4), false);
});

test("Foundry Region.testPoint occupancy uses an elevated point, not a second argument", () => {
  const x = 0;
  const y = 0;
  const width = 100;
  const height = 100;
  const region = rectRegion({type: SUPPRESS_DIGGABLE_BEHAVIOR, x, y, width, height});
  region.elevation = {bottom: 0, top: null};
  region.testPoint = function testPoint(point) {
    if (arguments.length > 1) return false;
    const elevation = point?.elevation;
    if (!(elevation >= 0) || elevation > 0) return false;
    return point.x >= x && point.x < x + width && point.y >= y && point.y < y + height;
  };
  const scene = sceneWithRegions(source({logicalCells: [0, 1]}), [region]);
  const data = getUndergroundData(scene);
  assert.equal(isUndergroundSubcell(data, 0), false);
  assert.equal(isUndergroundSubcell(data, 4), true);
});

test("suppress removes earth from a transparent hole", () => {
  const scene = sceneWithRegions(
    source({logicalCells: [0, 1]}),
    [rectRegion({type: SUPPRESS_DIGGABLE_BEHAVIOR, x: 0, y: 0, width: 100, height: 100})]
  );
  const data = getUndergroundData(scene);
  assert.equal(isUndergroundSubcell(data, 0), false);
  assert.equal(isUndergroundSubcell(data, 4), true);
  assert.equal(isForcedCell(data, 0), false);
  assert.equal(isSuppressedSubcell(data, 0), true);
  assert.equal(isSuppressedSubcell(data, 4), false);
});

test("suppress wins where force and suppress overlap", () => {
  const scene = sceneWithRegions(
    source({cells: []}),
    [
      rectRegion({id: "force", type: FORCE_DIGGABLE_BEHAVIOR, x: 0, y: 0, width: 100, height: 100}),
      rectRegion({id: "suppress", type: SUPPRESS_DIGGABLE_BEHAVIOR, x: 0, y: 0, width: 50, height: 50})
    ]
  );
  const data = getUndergroundData(scene);
  assert.equal(isUndergroundSubcell(data, 0), false);
  assert.equal(isForcedSubcell(data, 0), false);
  assert.equal(isUndergroundSubcell(data, 2), true);
  assert.equal(isForcedSubcell(data, 2), true);
});

test("regions on another Level are ignored", () => {
  const scene = sceneWithRegions(
    source({logicalCells: [0]}),
    [rectRegion({type: SUPPRESS_DIGGABLE_BEHAVIOR, levels: ["upper"]})]
  );
  assert.equal(isUndergroundSubcell(getUndergroundData(scene), 0), true);
});

test("hidden Regions and disabled behaviors do nothing", () => {
  const hidden = sceneWithRegions(
    source({logicalCells: [0]}),
    [rectRegion({type: SUPPRESS_DIGGABLE_BEHAVIOR, hidden: true})]
  );
  assert.equal(isUndergroundSubcell(getUndergroundData(hidden), 0), true);

  const disabled = sceneWithRegions(
    source({logicalCells: [0]}),
    [rectRegion({type: SUPPRESS_DIGGABLE_BEHAVIOR, disabled: true})]
  );
  assert.equal(isUndergroundSubcell(getUndergroundData(disabled), 0), true);
});

test("a Region with no Levels applies to every Level", () => {
  const scene = sceneWithRegions(
    source({cells: []}),
    [rectRegion({type: FORCE_DIGGABLE_BEHAVIOR, levels: []})]
  );
  assert.equal(isUndergroundSubcell(getUndergroundData(scene), 0), true);
});

test("force-only cells can be dug and extra dug bits are clipped without force", async () => {
  const scene = sceneWithRegions(
    source({cells: []}),
    [rectRegion({type: FORCE_DIGGABLE_BEHAVIOR})]
  );
  await digUnderground(scene, [0]);
  assert.equal(isDugSubcell(getUndergroundData(scene), 0), true);

  const orphan = source({logicalCells: [0]});
  const dugBytes = Buffer.from(orphan.dugMask, "base64");
  dugBytes[0] |= 1 << 4;
  orphan.dugMask = Buffer.from(dugBytes).toString("base64");
  assert.equal(isDugSubcell(getUndergroundData(sceneWithRegions(orphan, [])), 4), false);
});

test("preserveOverlappingDugMask keeps force-only dug bits", () => {
  const previous = source({cells: []});
  const scene = sceneWithRegions(
    previous,
    [rectRegion({type: FORCE_DIGGABLE_BEHAVIOR})]
  );
  const dug = Buffer.from(previous.dugMask, "base64");
  dug[0] |= 1;
  previous.dugMask = Buffer.from(dug).toString("base64");
  const rebuilt = source({cells: []});
  const merged = preserveOverlappingDugMask(rebuilt, previous, {scene});
  const data = getUndergroundData(sceneWithRegions(merged, scene.regions.contents));
  assert.equal(isDugSubcell(data, 0), true);
});

test("a Region assigned by Level _id still forces occupancy", () => {
  const flag = source({cells: []});
  const ground = {
    id: "level-1",
    _id: "groundDoc00000000",
    flags: {"theiks-toolbag": {undergroundTerrain: flag}},
    getFlag(module, key) { return this.flags[module]?.[key]; }
  };
  const scene = sceneWithRegions(null, [
    rectRegion({type: FORCE_DIGGABLE_BEHAVIOR, levels: ["groundDoc00000000"]})
  ], [ground]);
  const data = getUndergroundData(scene, {levelId: "level-1", level: ground});
  assert.equal(isUndergroundSubcell(data, 0), true);
  assert.equal(isForcedSubcell(data, 0), true);
});

test("diggable Region behaviors are always registered", () => {
  class FilePathField {
    constructor(options) { this.options = options; }
  }
  class NumberField {
    constructor(options) { this.options = options; }
  }
  foundry.data.fields = {FilePathField, NumberField};
  registerUndergroundRegionBehaviors();
  assert.equal(CONFIG.RegionBehavior.dataModels[FORCE_DIGGABLE_BEHAVIOR].name, "ForceDiggableRegionBehaviorType");
  assert.equal(CONFIG.RegionBehavior.dataModels[ALTER_DIGGABLE_BEHAVIOR].name, "AlterDiggableRegionBehaviorType");
  assert.equal(CONFIG.RegionBehavior.typeIcons[SUPPRESS_DIGGABLE_BEHAVIOR], "fa-solid fa-ban");
  assert.equal(CONFIG.RegionBehavior.typeIcons[ALTER_DIGGABLE_BEHAVIOR], "fa-solid fa-swatchbook");
  assert.equal(
    CONFIG.RegionBehavior.typeLabels[FORCE_DIGGABLE_BEHAVIOR],
    "THEIKS_TOOLBAG.Underground.RegionBehaviors.Force.Label"
  );
  assert.equal(
    CONFIG.RegionBehavior.typeLabels[ALTER_DIGGABLE_BEHAVIOR],
    "THEIKS_TOOLBAG.Underground.RegionBehaviors.Alter.Label"
  );
  const schema = CONFIG.RegionBehavior.dataModels[ALTER_DIGGABLE_BEHAVIOR].defineSchema();
  assert.deepEqual(schema.intactSrc.options.categories, ["IMAGE"]);
  assert.equal(schema.intactSrc.options.blank, true);
  assert.equal(schema.dugSrc.options.blank, true);
  assert.equal(schema.intactGrid.options.nullable, true);
  assert.equal(schema.intactGrid.options.min, 1);
  assert.equal(schema.dugGrid.options.nullable, true);
});

test("module.json declares RegionBehavior subtypes so Foundry lists them", () => {
  const manifest = JSON.parse(readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "module.json"),
    "utf8"
  ));
  assert.deepEqual(manifest.documentTypes.RegionBehavior, {
    forceDiggable: {},
    suppressDiggable: {},
    alterDiggable: {
      filePathFields: {
        intactSrc: ["IMAGE"],
        dugSrc: ["IMAGE"]
      }
    },
    footprints: {
      filePathFields: {image: ["IMAGE"]}
    }
  });
});

test("alter overrides filled appearance fields and inherits blanks", () => {
  const scene = sceneWithRegions(
    source({logicalCells: [0, 1], intactGrid: 1, dugGrid: 1}),
    [
      rectRegion({
        id: "moss",
        type: ALTER_DIGGABLE_BEHAVIOR,
        x: 0, y: 0, width: 200, height: 100,
        system: {intactSrc: "moss.webp", dugSrc: "", intactGrid: 5}
      }),
      rectRegion({
        id: "rubble",
        type: ALTER_DIGGABLE_BEHAVIOR,
        x: 0, y: 0, width: 200, height: 100,
        system: {dugSrc: "sand.webp", intactSrc: "   "}
      })
    ]
  );
  const data = getUndergroundData(scene);
  assert.deepEqual(cellAppearance(data, 0), {
    intactSrc: "moss.webp",
    dugSrc: "sand.webp",
    intactGrid: 5,
    dugGrid: 1
  });
  assert.equal(isUndergroundSubcell(data, 0), true);
  assert.equal(isForcedSubcell(data, 0), false);
  assert.equal(isSuppressedSubcell(data, 0), false);
});

test("later alter wins per field and a partial cell still retextures the whole mesh", () => {
  const scene = sceneWithRegions(
    source({logicalCells: [0, 1]}),
    [
      rectRegion({
        id: "first",
        type: ALTER_DIGGABLE_BEHAVIOR,
        x: 0, y: 0, width: 200, height: 100,
        system: {intactSrc: "first.webp", intactGrid: 2}
      }),
      rectRegion({
        id: "corner",
        type: ALTER_DIGGABLE_BEHAVIOR,
        x: 0, y: 0, width: 20, height: 20,
        system: {intactSrc: "corner.webp"}
      })
    ]
  );
  const data = getUndergroundData(scene);
  assert.equal(cellAppearance(data, 0).intactSrc, "corner.webp");
  assert.equal(cellAppearance(data, 0).intactGrid, 2);
  assert.equal(cellAppearance(data, 1).intactSrc, "first.webp");
  assert.equal(cellAppearance(data, 1).intactGrid, 2);
});

test("alter does not change occupancy", () => {
  const scene = sceneWithRegions(
    source({cells: []}),
    [rectRegion({
      type: ALTER_DIGGABLE_BEHAVIOR,
      system: {intactSrc: "moss.webp", dugSrc: "sand.webp", intactGrid: 3, dugGrid: 2}
    })]
  );
  const data = getUndergroundData(scene);
  assert.equal(isUndergroundSubcell(data, 0), false);
  assert.equal(isForcedSubcell(data, 0), false);
  assert.equal(cellAppearance(data, 0).intactSrc, "moss.webp");
});

test("applyUndergroundRegionOccupancy is a no-op without regions", () => {
  const data = getUndergroundData(sceneWithRegions(source({logicalCells: [0]}), []));
  applyUndergroundRegionOccupancy(null, data);
  assert.equal(isUndergroundSubcell(data, 0), true);
  assert.equal(isForcedCell(data, 0), false);
});
