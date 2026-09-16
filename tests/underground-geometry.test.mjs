import assert from "node:assert/strict";
import test from "node:test";

import {createUndergroundSource, getUndergroundData, subcellsForLogicalIndexes} from "../scripts/underground/underground-data.js";
import {
  buildUndergroundBoundarySegments,
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

test("coalesces a solid rectangle into four boundary segments", () => {
  assert.deepEqual(buildUndergroundBoundarySegments(dataFor([0, 1, 2, 3])), [
    [10, 20, 210, 20],
    [10, 220, 210, 220],
    [10, 20, 10, 220],
    [210, 20, 210, 220]
  ]);
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
