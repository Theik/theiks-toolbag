import {FEATURES, assertFeatureEnabled, isFeatureEnabled} from "../settings.js";

export const MODULE_ID = "theiks-toolbag";
export const UNDERGROUND_FLAG = "undergroundTerrain";
export const UNDERGROUND_SCHEMA_VERSION = 2;
export const UNDERGROUND_FLAG_PATH = `flags.${MODULE_ID}.${UNDERGROUND_FLAG}`;
export const DEFAULT_SUBDIVISION = 4;
export const DEFAULT_EARTH_SORT = -100001;
const ALLOWED_SUBDIVISIONS = new Set([2, 4, 8]);

export function isUndergroundAvailable() {
  return isFeatureEnabled(FEATURES.breakableTerrain);
}

/** Return the viewed Level id, preferring Foundry's public id then the document _id. */
export function getViewedLevelId(level = globalThis.canvas?.level) {
  return level?.id ?? level?._id ?? null;
}

/** True when underground artwork and edges belong on the currently viewed Level. */
export function isViewedUndergroundLevel(data, {
  level = globalThis.canvas?.level,
  scene = globalThis.canvas?.scene
} = {}) {
  if (!data) return false;
  const viewed = getViewedLevelId(level);
  if (viewed === data.levelId) return true;
  return viewed == null && scene?.initialLevel === data.levelId;
}

/** Build the serializable Scene flag used by virtual underground terrain. */
export function createUndergroundSource(options) {
  const width = positiveInteger(options?.width, "width");
  const height = positiveInteger(options?.height, "height");
  const gridSize = positiveNumber(options?.gridSize, "gridSize");
  const origin = finitePoint(options?.origin, "origin");
  const levelId = nonEmptyString(options?.levelId, "levelId");
  const intactSrc = nonEmptyString(options?.intactSrc, "intactSrc");
  const dugSrc = nonEmptyString(options?.dugSrc, "dugSrc");
  const subdivision = normalizeSubdivision(options?.subdivision);
  if (typeof options?.blocksMovement !== "boolean" || typeof options?.blocksVision !== "boolean") {
    throw new TypeError("blocksMovement and blocksVision must be Boolean values.");
  }
  const subWidth = width * subdivision;
  const subHeight = height * subdivision;
  const subCount = subWidth * subHeight;
  const sourceBytes = new Uint8Array(Math.ceil(subCount / 8));
  if (!Array.isArray(options?.cells)) throw new TypeError("cells must be an array.");
  for (const index of options.cells) {
    if (!Number.isSafeInteger(index) || index < 0 || index >= subCount) {
      throw new TypeError(`Underground cell index ${index} is outside the ${width}x${height} bounds.`);
    }
    setBit(sourceBytes, index, true);
  }
  const dugBytes = new Uint8Array(sourceBytes.length);
  return {
    schemaVersion: UNDERGROUND_SCHEMA_VERSION,
    enabled: options?.enabled !== false,
    levelId,
    origin,
    width,
    height,
    gridSize,
    subdivision,
    sourceMask: encodeBytes(sourceBytes),
    dugMask: encodeBytes(dugBytes),
    intactSrc,
    dugSrc,
    intactGrid: optionalPositiveInteger(options?.intactGrid, "intactGrid"),
    dugGrid: optionalPositiveInteger(options?.dugGrid, "dugGrid"),
    elevation: finiteNumber(options?.elevation ?? 0, "elevation"),
    sort: finiteNumber(options?.sort ?? DEFAULT_EARTH_SORT, "sort"),
    blocksMovement: options.blocksMovement === true,
    blocksVision: options.blocksVision === true
  };
}

/** Expand logical cell indexes into every contained subcell index. */
export function subcellsForLogicalIndexes(logicalIndexes, width, height, subdivision = DEFAULT_SUBDIVISION) {
  const sub = normalizeSubdivision(subdivision);
  const subWidth = width * sub;
  const cells = [];
  for (const index of logicalIndexes ?? []) {
    const lx = index % width;
    const ly = Math.floor(index / width);
    for (let y = 0; y < sub; y += 1) {
      for (let x = 0; x < sub; x += 1) {
        cells.push(((ly * sub + y) * subWidth) + (lx * sub + x));
      }
    }
  }
  return cells;
}

/** Read and validate one Scene's underground flag. */
export function getUndergroundData(scene) {
  const source = scene?.getFlag?.(MODULE_ID, UNDERGROUND_FLAG)
    ?? scene?.flags?.[MODULE_ID]?.[UNDERGROUND_FLAG];
  if (source == null) return null;
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new TypeError("Underground terrain data must be an object.");
  }
  if (source.schemaVersion !== UNDERGROUND_SCHEMA_VERSION) {
    throw new TypeError(`Unsupported underground terrain schema ${source.schemaVersion}.`);
  }
  const width = positiveInteger(source.width, "width");
  const height = positiveInteger(source.height, "height");
  const subdivision = normalizeSubdivision(source.subdivision);
  const dugBits = width * subdivision * height * subdivision;
  const maskBytes = Math.ceil(dugBits / 8);
  const sourceBytes = decodeBytes(source.sourceMask, maskBytes, "sourceMask");
  const dugBytes = decodeBytes(source.dugMask, maskBytes, "dugMask");
  validateUnusedBits(sourceBytes, dugBits, "sourceMask");
  validateUnusedBits(dugBytes, dugBits, "dugMask");
  const data = {
    schemaVersion: UNDERGROUND_SCHEMA_VERSION,
    enabled: source.enabled !== false,
    levelId: nonEmptyString(source.levelId, "levelId"),
    origin: finitePoint(source.origin, "origin"),
    width,
    height,
    gridSize: positiveNumber(source.gridSize, "gridSize"),
    subdivision,
    subWidth: width * subdivision,
    subHeight: height * subdivision,
    subGridSize: source.gridSize / subdivision,
    sourceMask: source.sourceMask,
    dugMask: source.dugMask,
    sourceBytes,
    dugBytes,
    intactSrc: nonEmptyString(source.intactSrc, "intactSrc"),
    dugSrc: nonEmptyString(source.dugSrc, "dugSrc"),
    intactGrid: optionalPositiveInteger(source.intactGrid, "intactGrid"),
    dugGrid: optionalPositiveInteger(source.dugGrid, "dugGrid"),
    elevation: finiteNumber(source.elevation ?? 0, "elevation"),
    sort: finiteNumber(source.sort ?? 0, "sort"),
    blocksMovement: source.blocksMovement === true,
    blocksVision: source.blocksVision === true
  };
  for (let index = 0; index < dugBits; index += 1) {
    if (isBitSet(dugBytes, index) && !isUndergroundSubcell(data, index)) {
      throw new TypeError(`dugMask contains non-underground subcell ${index}.`);
    }
  }
  return data;
}

export function isUndergroundCell(data, index) {
  if (!Number.isSafeInteger(index) || index < 0 || index >= data.width * data.height) return false;
  const startX = (index % data.width) * data.subdivision;
  const startY = Math.floor(index / data.width) * data.subdivision;
  for (let y = 0; y < data.subdivision; y += 1) {
    for (let x = 0; x < data.subdivision; x += 1) {
      if (isBitSet(data.sourceBytes, ((startY + y) * data.subWidth) + startX + x)) return true;
    }
  }
  return false;
}

export function isUndergroundSubcell(data, index) {
  if (!Number.isSafeInteger(index) || index < 0 || index >= data.subWidth * data.subHeight) return false;
  return isBitSet(data.sourceBytes, index);
}

/** Logical cells whose dug bits differ from a previous dug mask. */
export function changedLogicalCellIndexes(data, previousDugBytes) {
  const dirty = new Set();
  const total = data.subWidth * data.subHeight;
  if (!previousDugBytes || previousDugBytes.length !== data.dugBytes.length) {
    for (let index = 0; index < data.width * data.height; index += 1) {
      if (isUndergroundCell(data, index)) dirty.add(index);
    }
    return dirty;
  }
  for (let index = 0; index < total; index += 1) {
    if (isBitSet(data.dugBytes, index) === isBitSet(previousDugBytes, index)) continue;
    dirty.add(logicalIndexFromSubcell(data, index));
  }
  return dirty;
}

export function isDugSubcell(data, index) {
  return isUndergroundSubcell(data, index) && isBitSet(data.dugBytes, index);
}

export function isDugCell(data, index) {
  if (!isUndergroundCell(data, index)) return false;
  const startX = (index % data.width) * data.subdivision;
  const startY = Math.floor(index / data.width) * data.subdivision;
  for (let y = 0; y < data.subdivision; y += 1) {
    for (let x = 0; x < data.subdivision; x += 1) {
      if (isBitSet(data.dugBytes, ((startY + y) * data.subWidth) + startX + x)) return true;
    }
  }
  return false;
}

export function logicalIndexFromSubcell(data, index) {
  const sx = index % data.subWidth;
  const sy = Math.floor(index / data.subWidth);
  return (Math.floor(sy / data.subdivision) * data.width) + Math.floor(sx / data.subdivision);
}

export function countDugCells(data) {
  if (!data) return 0;
  let count = 0;
  const bits = data.subWidth * data.subHeight;
  for (let index = 0; index < bits; index += 1) {
    if (isDugSubcell(data, index)) count += 1;
  }
  return count;
}

/** Count subcells that belong to the underground source mask. */
export function countUndergroundSubcells(data) {
  if (!data) return 0;
  let count = 0;
  const bits = data.subWidth * data.subHeight;
  for (let index = 0; index < bits; index += 1) {
    if (isUndergroundSubcell(data, index)) count += 1;
  }
  return count;
}

export async function digUnderground(scene, cellIndexes) {
  return updateDugCells(scene, cellIndexes, true);
}

export async function repairUnderground(scene, cellIndexes) {
  return updateDugCells(scene, cellIndexes, false);
}

export async function resetUnderground(scene) {
  assertUndergroundMutation(scene);
  const data = getUndergroundData(scene);
  if (!data || !countDugCells(data)) return scene;
  const dugMask = encodeBytes(new Uint8Array(data.dugBytes.length));
  return scene.update({[`${UNDERGROUND_FLAG_PATH}.dugMask`]: dugMask});
}

async function updateDugCells(scene, cellIndexes, dug) {
  assertUndergroundMutation(scene);
  if (!Array.isArray(cellIndexes)) throw new TypeError("cellIndexes must be an array.");
  const data = getUndergroundData(scene);
  if (!data) throw new Error("This Scene has no underground terrain.");
  const bytes = new Uint8Array(data.dugBytes);
  let changed = false;
  for (const index of new Set(cellIndexes)) {
    if (!isUndergroundSubcell(data, index)) continue;
    if (isBitSet(bytes, index) === dug) continue;
    setBit(bytes, index, dug);
    changed = true;
  }
  if (!changed) return scene;
  return scene.update({[`${UNDERGROUND_FLAG_PATH}.dugMask`]: encodeBytes(bytes)});
}

function assertUndergroundMutation(scene) {
  assertFeatureEnabled(FEATURES.breakableTerrain);
  if (!globalThis.game?.user?.isGM) throw new Error(localize("Errors.GmOnly"));
  if (scene?.documentName !== "Scene" && !scene?.update) throw new TypeError("A Scene document is required.");
}

function normalizeSubdivision(value) {
  const subdivision = value == null ? DEFAULT_SUBDIVISION : value;
  if (!ALLOWED_SUBDIVISIONS.has(subdivision)) {
    throw new TypeError("subdivision must be 2, 4, or 8.");
  }
  return subdivision;
}

function encodeBytes(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  if (typeof globalThis.btoa === "function") return globalThis.btoa(binary);
  return globalThis.Buffer.from(bytes).toString("base64");
}

function decodeBytes(value, expectedLength, field) {
  if (typeof value !== "string") throw new TypeError(`${field} must be a base64 string.`);
  let bytes;
  try {
    if (typeof globalThis.atob === "function") {
      const binary = globalThis.atob(value);
      bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    } else bytes = Uint8Array.from(globalThis.Buffer.from(value, "base64"));
  } catch (_error) {
    throw new TypeError(`${field} must be a valid base64 string.`);
  }
  if (bytes.length !== expectedLength) {
    throw new TypeError(`${field} must contain ${expectedLength} bytes; received ${bytes.length}.`);
  }
  return bytes;
}

function isBitSet(bytes, index) {
  return Boolean(bytes[index >> 3] & (1 << (index & 7)));
}

function validateUnusedBits(bytes, bitLength, field) {
  const remainder = bitLength % 8;
  if (!remainder || !bytes.length) return;
  const validMask = (1 << remainder) - 1;
  if (bytes.at(-1) & ~validMask) throw new TypeError(`${field} contains bits outside the underground bounds.`);
}

function setBit(bytes, index, enabled) {
  const mask = 1 << (index & 7);
  if (enabled) bytes[index >> 3] |= mask;
  else bytes[index >> 3] &= ~mask;
}

function positiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${field} must be a positive integer.`);
  return value;
}

function optionalPositiveInteger(value, field, fallback = 1) {
  if (value == null) return fallback;
  return positiveInteger(value, field);
}

function positiveNumber(value, field) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${field} must be a positive finite number.`);
  }
  return value;
}

function finiteNumber(value, field) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError(`${field} must be finite.`);
  return value;
}

function finitePoint(value, field) {
  if (!value || typeof value !== "object") throw new TypeError(`${field} must be an object.`);
  return {x: finiteNumber(value.x, `${field}.x`), y: finiteNumber(value.y, `${field}.y`)};
}

function nonEmptyString(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${field} must be a non-empty string.`);
  return value.trim();
}

function localize(key) {
  return globalThis.game?.i18n?.localize?.(`THEIKS_TOOLBAG.Underground.${key}`) ?? key;
}
