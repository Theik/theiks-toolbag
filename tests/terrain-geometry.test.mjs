import assert from "node:assert/strict";
import {
  createTerrainVisionContours,
  traceAlphaContours,
  transformTerrainContours
} from "../scripts/breakable-terrain/terrain-edges.js";

function alphaData(rows) {
  const height = rows.length;
  const width = rows[0].length;
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) data[(y * width) + x] = Number(rows[y][x]) * 255;
  }
  return {width, height, minX: 0, minY: 0, maxX: width, maxY: height, data};
}

const solid = traceAlphaContours(alphaData(["11", "11"]), 0.75);
assert.equal(solid.contours.length, 1);
assert.equal(solid.contours[0].length, 4, "collinear pixel boundaries collapse to one rectangle");

const donut = traceAlphaContours(alphaData(["111", "101", "111"]), 0.75);
assert.equal(donut.contours.length, 2, "an alpha hole creates an inner blocking contour");

const islands = traceAlphaContours(alphaData(["1001", "0000", "1001"]), 0.75);
assert.equal(islands.contours.length, 4, "disconnected opaque islands remain separate");
const visionEnvelope = createTerrainVisionContours(islands.contours);
assert.equal(visionEnvelope.length, 1, "disconnected fragments share one vision envelope");
assert.deepEqual(visionEnvelope[0], [
  {x: 0, y: 0},
  {x: 4, y: 0},
  {x: 4, y: 3},
  {x: 0, y: 3}
], "the vision envelope contains every fragment without internal crossings");

const semitransparent = {
  width: 2,
  height: 1,
  minX: 0,
  minY: 0,
  maxX: 2,
  maxY: 1,
  data: new Uint8Array([190, 192])
};
assert.equal(traceAlphaContours(semitransparent, 0.75).contours.length, 1);
assert.deepEqual(
  traceAlphaContours(semitransparent, 0).contours[0],
  [{x: 0, y: 0}, {x: 2, y: 0}, {x: 2, y: 1}, {x: 0, y: 1}],
  "Foundry threshold zero uses the full texture rectangle"
);

const noisyRows = Array.from({length: 32}, (_, y) =>
  Array.from({length: 32}, (_, x) => (x + y) % 2 ? "1" : "0").join(""));
const bounded = traceAlphaContours(alphaData(noisyRows), 0.75, {maxSegments: 32});
assert.equal(bounded.truncated, true);
assert.ok(bounded.contours.reduce((total, contour) => total + contour.length, 0) <= 32);

const tracedRectangle = {
  width: 2,
  height: 1,
  contours: [[{x: 0, y: 0}, {x: 2, y: 0}, {x: 2, y: 1}, {x: 0, y: 1}]]
};
const baseTile = {
  x: 100,
  y: 100,
  width: 200,
  height: 100,
  rotation: 0,
  texture: {anchorX: 0.5, anchorY: 0.5, fit: "fill", scaleX: 1, scaleY: 1}
};
assert.deepEqual(transformTerrainContours(tracedRectangle, baseTile, {width: 200, height: 100})[0], [
  {x: 0, y: 50},
  {x: 200, y: 50},
  {x: 200, y: 150},
  {x: 0, y: 150}
]);

const rotated = transformTerrainContours(tracedRectangle, {...baseTile, rotation: 90}, {width: 200, height: 100})[0];
assert.ok(Math.abs(rotated[0].x - 150) < 1e-8);
assert.ok(Math.abs(rotated[0].y) < 1e-8);

const mirrored = transformTerrainContours(tracedRectangle, {
  ...baseTile,
  texture: {...baseTile.texture, scaleX: -1}
}, {width: 200, height: 100})[0];
assert.deepEqual(mirrored.map(point => point.x), [200, 0, 0, 200]);

const contained = transformTerrainContours(tracedRectangle, {
  ...baseTile,
  width: 100,
  height: 100,
  texture: {...baseTile.texture, fit: "contain"}
}, {width: 200, height: 100})[0];
assert.equal(Math.max(...contained.map(point => point.x)) - Math.min(...contained.map(point => point.x)), 100);
assert.equal(Math.max(...contained.map(point => point.y)) - Math.min(...contained.map(point => point.y)), 50);

console.log("terrain geometry tests passed");
