import {FEATURES, isFeatureEnabled} from "../settings.js";

export const FORCE_DIGGABLE_BEHAVIOR = "theiks-toolbag.forceDiggable";
export const SUPPRESS_DIGGABLE_BEHAVIOR = "theiks-toolbag.suppressDiggable";
export const ALTER_DIGGABLE_BEHAVIOR = "theiks-toolbag.alterDiggable";

/** Paint force, then suppress, onto parsed underground bytes. Artwork sourceMask is left unchanged. */
export function applyUndergroundRegionOccupancy(scene, data) {
  if (!data?.sourceBytes) return data;
  data.forceBytes = new Uint8Array(data.sourceBytes.length);
  data.suppressBytes = new Uint8Array(data.sourceBytes.length);
  data.appearanceByCell = new Map();
  if (!scene || !isFeatureEnabled(FEATURES.diggableTerrain)) {
    clipDugBytes(data);
    return data;
  }
  const force = [];
  const suppress = [];
  for (const region of listRegions(scene)) {
    if (!regionApplies(region, data.levelId)) continue;
    const kinds = regionBehaviorKinds(region);
    if (kinds.force) force.push(region);
    if (kinds.suppress) suppress.push(region);
  }
  for (const region of force) paintRegion(data, region, true);
  for (const region of suppress) paintRegion(data, region, false);
  clipDugBytes(data);
  applyUndergroundRegionAppearance(scene, data);
  return data;
}

/** Resolve Level textures and grid sizes, then overlay Alter Diggable Terrain Regions. */
export function applyUndergroundRegionAppearance(scene, data) {
  if (!data) return data;
  data.appearanceByCell = new Map();
  if (!scene || !isFeatureEnabled(FEATURES.diggableTerrain)) return data;
  for (const region of listRegions(scene)) {
    if (!regionApplies(region, data.levelId)) continue;
    for (const behavior of listBehaviors(region)) {
      if (behavior?.disabled === true || behavior?._source?.disabled === true) continue;
      const type = behavior?.type ?? behavior?._source?.type;
      if (type !== ALTER_DIGGABLE_BEHAVIOR) continue;
      const patch = appearanceFromBehavior(behavior);
      if (!hasAppearancePatch(patch)) continue;
      paintAppearance(data, region, patch);
    }
  }
  return data;
}

export function cellAppearance(data, logicalIndex) {
  const override = data?.appearanceByCell?.get?.(logicalIndex) ?? {};
  return {
    intactSrc: override.intactSrc ?? data?.intactSrc,
    dugSrc: override.dugSrc ?? data?.dugSrc,
    intactGrid: override.intactGrid ?? data?.intactGrid ?? 1,
    dugGrid: override.dugGrid ?? data?.dugGrid ?? 1
  };
}

export function isForcedSubcell(data, index) {
  if (!data?.forceBytes || !Number.isSafeInteger(index)) return false;
  if (index < 0 || index >= data.subWidth * data.subHeight) return false;
  return isBitSet(data.forceBytes, index);
}

export function isForcedCell(data, logicalIndex) {
  return logicalCellHasBit(data, logicalIndex, data?.forceBytes);
}

export function isSuppressedSubcell(data, index) {
  if (!data?.suppressBytes || !Number.isSafeInteger(index)) return false;
  if (index < 0 || index >= data.subWidth * data.subHeight) return false;
  return isBitSet(data.suppressBytes, index);
}

export function isSuppressedCell(data, logicalIndex) {
  return logicalCellHasBit(data, logicalIndex, data?.suppressBytes);
}

function logicalCellHasBit(data, logicalIndex, bytes) {
  if (!bytes || !Number.isSafeInteger(logicalIndex)) return false;
  if (logicalIndex < 0 || logicalIndex >= data.width * data.height) return false;
  const startX = (logicalIndex % data.width) * data.subdivision;
  const startY = Math.floor(logicalIndex / data.width) * data.subdivision;
  for (let y = 0; y < data.subdivision; y += 1) {
    for (let x = 0; x < data.subdivision; x += 1) {
      if (isBitSet(bytes, ((startY + y) * data.subWidth) + startX + x)) return true;
    }
  }
  return false;
}

export function registerUndergroundRegionBehaviors() {
  const Base = globalThis.foundry?.data?.regionBehaviors?.RegionBehaviorType ?? class {};
  class ForceDiggableRegionBehaviorType extends Base {
    static LOCALIZATION_PREFIXES = ["THEIKS_TOOLBAG.Underground.RegionBehaviors.Force"];
    static defineSchema() { return {}; }
  }
  class SuppressDiggableRegionBehaviorType extends Base {
    static LOCALIZATION_PREFIXES = ["THEIKS_TOOLBAG.Underground.RegionBehaviors.Suppress"];
    static defineSchema() { return {}; }
  }

  class AlterDiggableRegionBehaviorType extends Base {
    static LOCALIZATION_PREFIXES = ["THEIKS_TOOLBAG.Underground.RegionBehaviors.Alter"];
    static defineSchema() { return alterDiggableSchema(); }
  }

  const config = globalThis.CONFIG?.RegionBehavior;
  if (!config) return;
  config.dataModels ??= {};
  config.typeLabels ??= {};
  config.typeIcons ??= {};
  config.typeHints ??= {};
  config.dataModels[FORCE_DIGGABLE_BEHAVIOR] = ForceDiggableRegionBehaviorType;
  config.dataModels[SUPPRESS_DIGGABLE_BEHAVIOR] = SuppressDiggableRegionBehaviorType;
  config.dataModels[ALTER_DIGGABLE_BEHAVIOR] = AlterDiggableRegionBehaviorType;
  config.typeLabels[FORCE_DIGGABLE_BEHAVIOR] = "THEIKS_TOOLBAG.Underground.RegionBehaviors.Force.Label";
  config.typeLabels[SUPPRESS_DIGGABLE_BEHAVIOR] = "THEIKS_TOOLBAG.Underground.RegionBehaviors.Suppress.Label";
  config.typeLabels[ALTER_DIGGABLE_BEHAVIOR] = "THEIKS_TOOLBAG.Underground.RegionBehaviors.Alter.Label";
  config.typeIcons[FORCE_DIGGABLE_BEHAVIOR] = "fa-solid fa-shovel";
  config.typeIcons[SUPPRESS_DIGGABLE_BEHAVIOR] = "fa-solid fa-ban";
  config.typeIcons[ALTER_DIGGABLE_BEHAVIOR] = "fa-solid fa-swatchbook";
  config.typeHints[FORCE_DIGGABLE_BEHAVIOR] = "THEIKS_TOOLBAG.Underground.RegionBehaviors.Force.Hint";
  config.typeHints[SUPPRESS_DIGGABLE_BEHAVIOR] = "THEIKS_TOOLBAG.Underground.RegionBehaviors.Suppress.Hint";
  config.typeHints[ALTER_DIGGABLE_BEHAVIOR] = "THEIKS_TOOLBAG.Underground.RegionBehaviors.Alter.Hint";
}

function alterDiggableSchema() {
  const fields = globalThis.foundry?.data?.fields;
  if (typeof fields?.FilePathField !== "function" || typeof fields?.NumberField !== "function") return {};
  return {
    intactSrc: new fields.FilePathField({
      required: true, blank: true, nullable: true, initial: null, categories: ["IMAGE"]
    }),
    dugSrc: new fields.FilePathField({
      required: true, blank: true, nullable: true, initial: null, categories: ["IMAGE"]
    }),
    intactGrid: new fields.NumberField({
      required: false, nullable: true, integer: true, min: 1, initial: null
    }),
    dugGrid: new fields.NumberField({
      required: false, nullable: true, integer: true, min: 1, initial: null
    })
  };
}

function paintAppearance(data, region, patch) {
  const range = subcellRange(data, regionBounds(region))
    ?? {minX: 0, minY: 0, maxX: data.subWidth, maxY: data.subHeight};
  const elevation = occupancyElevation(region, data);
  const cells = new Set();
  for (let sy = range.minY; sy < range.maxY; sy += 1) {
    for (let sx = range.minX; sx < range.maxX; sx += 1) {
      const point = {
        x: data.origin.x + ((sx + 0.5) * data.subGridSize),
        y: data.origin.y + ((sy + 0.5) * data.subGridSize),
        elevation
      };
      if (!pointInRegion(region, point, elevation)) continue;
      cells.add(logicalIndexForSubcell(data, sx, sy));
    }
  }
  for (const logicalIndex of cells) {
    const current = data.appearanceByCell.get(logicalIndex) ?? {};
    mergeAppearance(current, patch);
    data.appearanceByCell.set(logicalIndex, current);
  }
}

function appearanceFromBehavior(behavior) {
  const system = behavior?.system ?? behavior?._source?.system ?? {};
  return {
    intactSrc: trimmedSrc(system.intactSrc),
    dugSrc: trimmedSrc(system.dugSrc),
    intactGrid: optionalGrid(system.intactGrid),
    dugGrid: optionalGrid(system.dugGrid)
  };
}

function hasAppearancePatch(patch) {
  return Boolean(patch.intactSrc || patch.dugSrc || patch.intactGrid != null || patch.dugGrid != null);
}

function mergeAppearance(target, patch) {
  if (patch.intactSrc) target.intactSrc = patch.intactSrc;
  if (patch.dugSrc) target.dugSrc = patch.dugSrc;
  if (patch.intactGrid != null) target.intactGrid = patch.intactGrid;
  if (patch.dugGrid != null) target.dugGrid = patch.dugGrid;
}

function trimmedSrc(value) {
  if (typeof value !== "string") return "";
  return value.trim();
}

function optionalGrid(value) {
  const grid = Number(value);
  if (!Number.isInteger(grid) || grid < 1) return null;
  return grid;
}

function logicalIndexForSubcell(data, sx, sy) {
  const lx = Math.floor(sx / data.subdivision);
  const ly = Math.floor(sy / data.subdivision);
  return (ly * data.width) + lx;
}

function paintRegion(data, region, enable) {
  const range = subcellRange(data, regionBounds(region))
    ?? {minX: 0, minY: 0, maxX: data.subWidth, maxY: data.subHeight};
  const elevation = occupancyElevation(region, data);
  for (let sy = range.minY; sy < range.maxY; sy += 1) {
    for (let sx = range.minX; sx < range.maxX; sx += 1) {
      const point = {
        x: data.origin.x + ((sx + 0.5) * data.subGridSize),
        y: data.origin.y + ((sy + 0.5) * data.subGridSize),
        elevation
      };
      if (!pointInRegion(region, point, elevation)) continue;
      const index = (sy * data.subWidth) + sx;
      setBit(data.sourceBytes, index, enable);
      setBit(data.forceBytes, index, enable);
      setBit(data.suppressBytes, index, !enable);
    }
  }
}

function clipDugBytes(data) {
  if (!data.dugBytes) return;
  const bits = data.subWidth * data.subHeight;
  for (let index = 0; index < bits; index += 1) {
    if (isBitSet(data.dugBytes, index) && !isBitSet(data.sourceBytes, index)) {
      setBit(data.dugBytes, index, false);
    }
  }
}

function regionApplies(region, levelId) {
  if (region?.hidden === true || region?._source?.hidden === true) return false;
  const assigned = regionLevelIds(region);
  if (!assigned.length) return true;
  const scene = region?.parent ?? region?.scene;
  const level = findLevel(scene, levelId);
  if (level) return regionCoversLevel(region, level, assigned);
  return assigned.some(id => idsEqual(id, levelId));
}

function regionCoversLevel(region, level, assigned = regionLevelIds(region)) {
  if (typeof region?.includedInLevel === "function") {
    try {
      const result = region.includedInLevel(level);
      if (result === true) return true;
      if (result === false) return false;
    } catch (_error) { /* fall through */ }
  }
  if (!assigned.length) return true;
  return assigned.some(id => levelMatches(level, id));
}

function idsEqual(left, right) {
  return left != null && right != null && String(left) === String(right);
}

function levelMatches(level, id) {
  if (!level) return false;
  return idsEqual(level.id, id) || idsEqual(level._id, id);
}

function regionBehaviorKinds(region) {
  let force = false;
  let suppress = false;
  for (const behavior of listBehaviors(region)) {
    if (behavior?.disabled === true || behavior?._source?.disabled === true) continue;
    const type = behavior?.type ?? behavior?._source?.type;
    if (type === FORCE_DIGGABLE_BEHAVIOR) force = true;
    if (type === SUPPRESS_DIGGABLE_BEHAVIOR) suppress = true;
  }
  return {force, suppress};
}

function listRegions(scene) {
  const regions = scene?.regions;
  if (!regions) return [];
  if (Array.isArray(regions.contents)) return regions.contents;
  if (typeof regions.values === "function") return Array.from(regions.values());
  if (Array.isArray(regions)) return regions;
  return Array.from(regions ?? []);
}

function listBehaviors(region) {
  const behaviors = region?.behaviors;
  if (!behaviors) return [];
  if (Array.isArray(behaviors.contents)) return behaviors.contents;
  if (typeof behaviors.values === "function") return Array.from(behaviors.values());
  if (Array.isArray(behaviors)) return behaviors;
  return [];
}

function listShapes(region) {
  const shapes = region?.shapes ?? region?._source?.shapes;
  if (!shapes) return [];
  if (Array.isArray(shapes)) return shapes;
  if (Array.isArray(shapes.contents)) return shapes.contents;
  return [];
}

function listLevels(scene) {
  if (!scene?.levels) return [];
  if (Array.isArray(scene.levels.contents)) return scene.levels.contents;
  if (typeof scene.levels.values === "function") return Array.from(scene.levels.values());
  return Array.from(scene.levels ?? []);
}

function findLevel(scene, levelId) {
  if (!scene?.levels || levelId == null || levelId === "") return null;
  const id = String(levelId);
  const direct = scene.levels.get?.(id);
  if (direct) return direct;
  return listLevels(scene).find(level => levelMatches(level, id)) ?? null;
}

function regionLevelIds(region) {
  const levels = region?.levels ?? region?._source?.levels;
  if (levels == null) return [];
  if (typeof levels === "string") return levels ? [levels] : [];
  try {
    return Array.from(levels, value => value?.id ?? value?._id ?? value)
      .filter(value => value != null && value !== "")
      .map(String);
  } catch (_error) {
    return [];
  }
}

function regionBounds(region) {
  const direct = region?.bounds;
  if (direct && Number(direct.width) > 0 && Number(direct.height) > 0) {
    return {x: Number(direct.x ?? 0), y: Number(direct.y ?? 0), width: Number(direct.width), height: Number(direct.height)};
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const shape of listShapes(region)) {
    const x = Number(shape.x ?? 0);
    const y = Number(shape.y ?? 0);
    const width = Number(shape.width ?? 0);
    const height = Number(shape.height ?? 0);
    if (width > 0 && height > 0) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + width);
      maxY = Math.max(maxY, y + height);
    }
  }
  if (!Number.isFinite(minX)) return null;
  return {x: minX, y: minY, width: maxX - minX, height: maxY - minY};
}

function subcellRange(data, bounds) {
  if (!bounds) return null;
  const minX = Math.max(0, Math.floor((bounds.x - data.origin.x) / data.subGridSize));
  const minY = Math.max(0, Math.floor((bounds.y - data.origin.y) / data.subGridSize));
  const maxX = Math.min(data.subWidth, Math.ceil((bounds.x + bounds.width - data.origin.x) / data.subGridSize));
  const maxY = Math.min(data.subHeight, Math.ceil((bounds.y + bounds.height - data.origin.y) / data.subGridSize));
  if (minX >= maxX || minY >= maxY) return {minX: 0, minY: 0, maxX: 0, maxY: 0};
  return {minX, minY, maxX, maxY};
}

function occupancyElevation(region, data) {
  const bottom = Number(region?.elevation?.bottom);
  if (Number.isFinite(bottom)) return bottom;
  const earth = Number(data?.elevation);
  return Number.isFinite(earth) ? earth : 0;
}

function elevatePoint(region, point, elevation) {
  const resolved = Number.isFinite(Number(point?.elevation))
    ? Number(point.elevation)
    : occupancyElevation(region, {elevation});
  return {x: Number(point.x), y: Number(point.y), elevation: resolved};
}

function pointInRegion(region, point, elevation = 0) {
  const elevated = elevatePoint(region, point, elevation);
  if (typeof region?.testPoint === "function") {
    try {
      const result = region.testPoint(elevated);
      if (typeof result === "boolean") return result;
    } catch (_error) { /* fall through */ }
    try {
      return Boolean(region.testPoint(point, elevated.elevation));
    } catch (_error) { /* fall through */ }
  }
  if (typeof region?.polygonTree?.testPoint === "function") {
    return Boolean(region.polygonTree.testPoint(elevated));
  }
  if (typeof region?.object?.testPoint === "function") {
    try {
      return Boolean(region.object.testPoint(elevated));
    } catch (_error) {
      return Boolean(region.object.testPoint(point, elevated.elevation));
    }
  }
  return false;
}

function isBitSet(bytes, index) {
  return Boolean(bytes[index >> 3] & (1 << (index & 7)));
}

function setBit(bytes, index, enabled) {
  const mask = 1 << (index & 7);
  if (enabled) bytes[index >> 3] |= mask;
  else bytes[index >> 3] &= ~mask;
}
