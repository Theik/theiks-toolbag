import assert from "node:assert/strict";
import {calculateRubbleGeometry} from "../scripts/breakable-walls/wall-destruction.js";
import {
  createRubbleAccessMask,
  getRubbleBarrierSegments
} from "../scripts/breakable-walls/wall-rubble-mask.js";

const geometry = calculateRubbleGeometry([0, 0, 100, 0]);
const parallelBarrier = [[-50, 50, 150, 50]];

const both = createRubbleAccessMask(geometry, {kind: "both", side: null}, parallelBarrier);
assert.equal(alphaAtWorld(both, geometry, 50, -50), 255, "both-sided rubble remains above its source Wall");
assert.equal(alphaAtWorld(both, geometry, 50, 25), 255, "rubble reaches the near side of a blocking Wall");
assert.equal(alphaAtWorld(both, geometry, 50, 75), 0, "a parallel Wall stops rubble on its far side");

const positive = createRubbleAccessMask(geometry, {kind: "single", side: "positive"}, parallelBarrier);
assert.equal(alphaAtWorld(positive, geometry, 50, -25), 255,
  "the access mask does not cut single-sided artwork at the source Wall bounds");
assert.equal(alphaAtWorld(positive, geometry, 50, 25), 255);
assert.equal(alphaAtWorld(positive, geometry, 50, 75), 0);

const negative = createRubbleAccessMask(geometry, {kind: "single", side: "negative"}, []);
assert.equal(alphaAtWorld(negative, geometry, 50, -25), 255);
assert.equal(alphaAtWorld(negative, geometry, 50, 25), 255,
  "the configured image alpha remains responsible for the single-sided shape");

const endpointBarrier = createRubbleAccessMask(geometry, {kind: "single", side: "positive"}, [
  [0, 45, 55, 45]
]);
assert.equal(alphaAtWorld(endpointBarrier, geometry, 25, 70), 255,
  "rubble can flow around a Wall endpoint inside the artwork bounds");

const diagonalBarrier = createRubbleAccessMask(geometry, {kind: "single", side: "positive"}, [
  [0, 10, 100, 90]
]);
assert.equal(alphaAtWorld(diagonalBarrier, geometry, 50, 20), 255);
assert.equal(alphaAtWorld(diagonalBarrier, geometry, 50, 80), 0,
  "dilated diagonal barriers do not leak through corner-touching pixels");

const reversedGeometry = calculateRubbleGeometry([100, 0, 0, 0]);
const reversed = createRubbleAccessMask(reversedGeometry, {kind: "both", side: null}, parallelBarrier);
assert.deepEqual(reversed.data, both.data, "Wall endpoint order does not change clipping");

const constants = {
  WALL_MOVEMENT_TYPES: {NONE: 0, NORMAL: 1},
  WALL_DOOR_TYPES: {NONE: 0, DOOR: 1},
  WALL_DOOR_STATES: {CLOSED: 0, OPEN: 1, LOCKED: 2}
};
const wall = (id, overrides = {}) => ({
  id,
  c: [0, 0, 100, 0],
  move: 1,
  door: 0,
  ds: 0,
  levels: new Set(["ground"]),
  ...overrides
});
const barriers = getRubbleBarrierSegments([
  wall("source"),
  wall("solid"),
  wall("closed", {move: 0, door: 1, ds: 0}),
  wall("locked", {move: 0, door: 1, ds: 2}),
  wall("open", {door: 1, ds: 1}),
  wall("nonblocking", {move: 0}),
  wall("destroyed"),
  wall("upper", {levels: new Set(["upper"])})
], {
  sourceWallId: "source",
  levelId: "ground",
  constants,
  isDestroyed: document => document.id === "destroyed"
});
assert.equal(barriers.length, 3, "only solid Walls and closed or locked doors on the viewed Level block rubble");

const capped = createRubbleAccessMask(
  {x: 0, y: 0, width: 2000, height: 4000, rotation: 0},
  {kind: "both", side: null},
  []
);
assert.equal(Math.max(capped.width, capped.height), 1024, "large access masks cap their longest dimension");

console.log("wall rubble mask tests passed");

function alphaAtWorld(mask, rubble, x, y) {
  const radians = rubble.rotation * Math.PI / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const dx = x - rubble.x;
  const dy = y - rubble.y;
  const localX = (cos * dx) + (sin * dy) + rubble.width / 2;
  const localY = (-sin * dx) + (cos * dy) + rubble.height / 2;
  const px = Math.max(0, Math.min(mask.width - 1, Math.round(localX / rubble.width * (mask.width - 1))));
  const py = Math.max(0, Math.min(mask.height - 1, Math.round(localY / rubble.height * (mask.height - 1))));
  return mask.data[((py * mask.width) + px) * 4 + 3];
}
