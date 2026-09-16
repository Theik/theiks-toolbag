import {isDugSubcell, isUndergroundSubcell} from "./underground-data.js";

/** Return merged world-space boundary segments around every intact underground subcell. */
export function buildUndergroundBoundarySegments(data) {
  const horizontal = new Map();
  const vertical = new Map();
  const intact = (x, y) => {
    if (x < 0 || y < 0 || x >= data.subWidth || y >= data.subHeight) return false;
    const index = (y * data.subWidth) + x;
    return isUndergroundSubcell(data, index) && !isDugSubcell(data, index);
  };
  const addHorizontal = (y, x) => addInterval(horizontal, y, x);
  const addVertical = (x, y) => addInterval(vertical, x, y);
  for (let y = 0; y < data.subHeight; y += 1) {
    for (let x = 0; x < data.subWidth; x += 1) {
      if (!intact(x, y)) continue;
      if (!intact(x, y - 1)) addHorizontal(y, x);
      if (!intact(x + 1, y)) addVertical(x + 1, y);
      if (!intact(x, y + 1)) addHorizontal(y + 1, x);
      if (!intact(x - 1, y)) addVertical(x, y);
    }
  }
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
