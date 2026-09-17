import assert from "node:assert/strict";
import test from "node:test";

import {createUndergroundSource, getUndergroundData, subcellsForLogicalIndexes} from "../scripts/underground/underground-data.js";
import {
  buildUndergroundBoundarySegments,
  buildUndergroundVisionBoundarySegments,
  cellIndexAtPoint,
  diskSubcellIndexes,
  subcellIndexAtPoint
} from "../scripts/underground/underground-geometry.js";

function dataFor(cells, {width = 2, height = 2, dugMask} = {}) {
  const source = createUndergroundSource({
    levelId: "level", origin: {x: 10, y: 20}, width, height, gridSize: 100,
    cells: subcellsForLogicalIndexes(cells, width, height),
    intactSrc: "earth.webp", dugSrc: "rubble.webp", blocksMovement: true, blocksVision: true
  });
  if (dugMask) source.dugMask = dugMask;
  return getUndergroundData({flags: {"theiks-toolbag": {undergroundTerrain: source}}});
}

function dugMaskFor(logicalCells, width, height) {
  const indexes = subcellsForLogicalIndexes(logicalCells, width, height);
  const bytes = new Uint8Array(Math.ceil(width * height * 16 / 8));
  for (const index of indexes) bytes[index >> 3] |= 1 << (index & 7);
  return Buffer.from(bytes).toString("base64");
}

test("coalesces a solid rectangle into four boundary segments", () => {
  const data = dataFor([0, 1, 2, 3]);
  const expected = [
    [10, 20, 210, 20],
    [10, 220, 210, 220],
    [10, 20, 10, 220],
    [210, 20, 210, 220]
  ];
  assert.deepEqual(buildUndergroundBoundarySegments(data), expected);
  assert.deepEqual(buildUndergroundVisionBoundarySegments(data), expected);
});

test("vision walls sit inside dug earth so the fade stays lit", () => {
  const data = dataFor([0, 1], {width: 2, height: 1, dugMask: dugMaskFor([0], 2, 1)});
  const sharedX = data.origin.x + (data.subdivision * data.subGridSize);
  const insetX = sharedX + ((data.subdivision / 2) * data.subGridSize);
  const moveVertical = buildUndergroundBoundarySegments(data).filter(segment => segment[0] === segment[2]);
  const visionVertical = buildUndergroundVisionBoundarySegments(data).filter(segment => segment[0] === segment[2]);
  assert.ok(moveVertical.some(segment => segment[0] === sharedX));
  assert.equal(visionVertical.some(segment => segment[0] === sharedX), false);
  assert.ok(visionVertical.some(segment => segment[0] === insetX));
});

test("point lookup and disk brushes clip to source subcells and bounds", () => {
  const data = dataFor([0, 1, 3, 4], {width: 3, height: 2});
  assert.equal(cellIndexAtPoint(data, {x: 10, y: 20}), 0);
  assert.equal(cellIndexAtPoint(data, {x: 309, y: 219}), 5);
  assert.equal(cellIndexAtPoint(data, {x: 310, y: 220}), null);
  assert.equal(subcellIndexAtPoint(data, {x: 10, y: 20}), 0);
  const aroundOrigin = diskSubcellIndexes(data, {x: 60, y: 70}, 3);
  assert.ok(aroundOrigin.includes(0));
  assert.ok(aroundOrigin.every(index => [0, 1, 3, 4].includes(
    Math.floor(Math.floor(index / data.subWidth) / data.subdivision) * data.width
      + Math.floor((index % data.subWidth) / data.subdivision)
  )));
  assert.deepEqual(diskSubcellIndexes(data, {x: 260, y: 70}, 1), [], "empty logical cells contribute no brush stamps");
});
