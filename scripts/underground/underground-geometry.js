import {isDugSubcell, isUndergroundSubcell} from "./underground-data.js";

/** Sight and light reach this many subcells into intact earth. Half a logical cell. */
export function visionOverlapSubcells(data) {
  const subdivision = Math.max(1, Number(data?.subdivision) || 4);
  return Math.max(1, Math.floor(subdivision / 2));
}

/** Return merged world-space boundary segments around every intact underground subcell. */
export function buildUndergroundBoundarySegments(data) {
  return buildBoundarySegments(data, false);
}

/** Sight and light walls sit half a logical cell inside intact earth. */
export function buildUndergroundVisionBoundarySegments(data) {
  return buildBoundarySegments(data, true);
}

function buildBoundarySegments(data, visionOverlap) {
  const horizontal = new Map();
  const vertical = new Map();
  if (visionOverlap) collectVisionEdges(data, horizontal, vertical);
  else collectMovementEdges(data, horizontal, vertical);
  const segments = [];
  for (const [y, starts] of horizontal) {
    for (const [start, end] of mergeUnitIntervals(starts)) {
      segments.push([
        data.origin.x + start * data.subGridSize,
        data.origin.y + y * data.subGridSize,
        data.origin.x + end * data.subGridSize,
        data.origin.y + y * data.subGridSize
      ]);
    }
  }
  for (const [x, starts] of vertical) {
    for (const [start, end] of mergeUnitIntervals(starts)) {
      segments.push([
        data.origin.x + x * data.subGridSize,
        data.origin.y + start * data.subGridSize,
        data.origin.x + x * data.subGridSize,
        data.origin.y + end * data.subGridSize
      ]);
    }
  }
  return segments;
}

function isIntactSubcell(data, x, y) {
  if (x < 0 || y < 0 || x >= data.subWidth || y >= data.subHeight) return false;
  const index = (y * data.subWidth) + x;
  return isUndergroundSubcell(data, index) && !isDugSubcell(data, index);
}

function collectMovementEdges(data, horizontal, vertical) {
  const blocking = (x, y) => isIntactSubcell(data, x, y);
  for (let y = 0; y < data.subHeight; y += 1) {
    for (let x = 0; x < data.subWidth; x += 1) {
      if (!blocking(x, y)) continue;
      if (!blocking(x, y - 1)) addInterval(horizontal, y, x);
      if (!blocking(x + 1, y)) addInterval(vertical, x + 1, y);
      if (!blocking(x, y + 1)) addInterval(horizontal, y + 1, x);
      if (!blocking(x - 1, y)) addInterval(vertical, x, y);
    }
  }
}

const VISION_OUTSIDE = 0;
const VISION_INTACT = 1;
const VISION_DUG = 2;
const VISION_FRINGE = 3;

function collectVisionEdges(data, horizontal, vertical) {
  for (let y = 0; y < data.subHeight; y += 1) {
    for (let x = 0; x < data.subWidth; x += 1) {
      const here = visionClass(data, x, y);
      if (visionBlocksBetween(here, visionClass(data, x, y - 1))) addInterval(horizontal, y, x);
      if (visionBlocksBetween(here, visionClass(data, x + 1, y))) addInterval(vertical, x + 1, y);
      if (visionBlocksBetween(here, visionClass(data, x, y + 1))) addInterval(horizontal, y + 1, x);
      if (visionBlocksBetween(here, visionClass(data, x - 1, y))) addInterval(vertical, x, y);
    }
  }
}

function visionClass(data, x, y) {
  if (x < 0 || y < 0 || x >= data.subWidth || y >= data.subHeight) return VISION_OUTSIDE;
  const index = (y * data.subWidth) + x;
  if (!isUndergroundSubcell(data, index)) return VISION_OUTSIDE;
  if (isDugSubcell(data, index)) return VISION_DUG;
  return isWithinDugOverlap(data, x, y) ? VISION_FRINGE : VISION_INTACT;
}

function visionBlocksBetween(left, right) {
  if (left === right) return false;
  const open = value => value === VISION_DUG || value === VISION_FRINGE;
  if (open(left) && open(right)) return false;
  if ((left === VISION_DUG && right === VISION_OUTSIDE) || (left === VISION_OUTSIDE && right === VISION_DUG)) {
    return false;
  }
  return true;
}

function isWithinDugOverlap(data, x, y) {
  const radius = visionOverlapSubcells(data);
  for (let dy = -radius; dy <= radius; dy += 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      if (dx === 0 && dy === 0) continue;
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= data.subWidth || ny >= data.subHeight) continue;
      if (isDugSubcell(data, (ny * data.subWidth) + nx)) return true;
    }
  }
  return false;
}

export function cellIndexAtPoint(data, point) {
  const x = Math.floor((point.x - data.origin.x) / data.gridSize);
  const y = Math.floor((point.y - data.origin.y) / data.gridSize);
  if (x < 0 || y < 0 || x >= data.width || y >= data.height) return null;
  return (y * data.width) + x;
}

export function subcellIndexAtPoint(data, point) {
  const x = Math.floor((point.x - data.origin.x) / data.subGridSize);
  const y = Math.floor((point.y - data.origin.y) / data.subGridSize);
  if (x < 0 || y < 0 || x >= data.subWidth || y >= data.subHeight) return null;
  return (y * data.subWidth) + x;
}

/** Disk brush in world space, sized in logical cells (1, 3, or 5). */
export function diskSubcellIndexes(data, point, size) {
  if (!point || ![1, 3, 5].includes(size)) return [];
  const radius = (size * data.gridSize) / 2;
  if (!(radius > 0)) return [];
  const radiusSquared = radius * radius;
  const minX = Math.max(0, Math.floor((point.x - radius - data.origin.x) / data.subGridSize));
  const maxX = Math.min(data.subWidth - 1, Math.floor((point.x + radius - data.origin.x) / data.subGridSize));
  const minY = Math.max(0, Math.floor((point.y - radius - data.origin.y) / data.subGridSize));
  const maxY = Math.min(data.subHeight - 1, Math.floor((point.y + radius - data.origin.y) / data.subGridSize));
  const cells = [];
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const centerX = data.origin.x + (x + 0.5) * data.subGridSize;
      const centerY = data.origin.y + (y + 0.5) * data.subGridSize;
      const dx = centerX - point.x;
      const dy = centerY - point.y;
      if ((dx * dx) + (dy * dy) > radiusSquared) continue;
      const index = (y * data.subWidth) + x;
      if (isUndergroundSubcell(data, index)) cells.push(index);
    }
  }
  return cells;
}

function addInterval(map, key, start) {
  const values = map.get(key) ?? [];
  values.push(start);
  map.set(key, values);
}

function mergeUnitIntervals(starts) {
  const ordered = Array.from(new Set(starts)).sort((left, right) => left - right);
  const merged = [];
  for (const start of ordered) {
    const current = merged.at(-1);
    if (current && current[1] === start) current[1] = start + 1;
    else merged.push([start, start + 1]);
  }
  return merged;
}
