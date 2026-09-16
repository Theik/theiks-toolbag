import assert from "node:assert/strict";

const registeredHooks = new Map();
globalThis.Hooks = {
  on: (name, callback) => {
    const callbacks = registeredHooks.get(name) ?? [];
    callbacks.push(callback);
    registeredHooks.set(name, callbacks);
  }
};
globalThis.game = {
  settings: {
    get: (_namespace, key) => ({
      enableBreakableWalls: true,
      enableBreakableTerrain: true
    }[key])
  }
};
globalThis.requestAnimationFrame = callback => setTimeout(callback, 0);
globalThis.cancelAnimationFrame = id => clearTimeout(id);

const {
  DESTRUCTION_MARKER_LIMIT,
  DESTRUCTION_MARKER_RADIUS_GRIDS,
  countViewedDestroyables,
  getDestructionMarkerCursor,
  isDestroyableOnViewedLevel,
  selectNearbyDestroyables,
  subscribeDestructionMarkerPointer
} = await import("../scripts/destruction-marker-proximity.js");

assert.equal(DESTRUCTION_MARKER_LIMIT, 200);
assert.equal(DESTRUCTION_MARKER_RADIUS_GRIDS, 20);

const nearby = {x: 0, y: 0};
const edge = {x: 2000, y: 0};
const outside = {x: 2001, y: 0};
const items = [
  {id: "near", ...nearby},
  {id: "edge", ...edge},
  {id: "far", ...outside}
];

assert.deepEqual(
  selectNearbyDestroyables(items, {totalCount: 199, cursor: {x: 0, y: 0}, gridSize: 100}).map(item => item.id),
  ["near", "edge", "far"],
  "crowding below the limit keeps every marker"
);
assert.deepEqual(
  selectNearbyDestroyables(items, {totalCount: 200, cursor: {x: 0, y: 0}, gridSize: 100}).map(item => item.id),
  ["near", "edge"],
  "a 20-grid radius includes the boundary and drops anything farther"
);
assert.deepEqual(
  selectNearbyDestroyables(items, {totalCount: 200, cursor: null, gridSize: 100}),
  [],
  "crowded Scenes wait for a cursor before drawing markers"
);

const wallFlag = {enabled: true, destroyed: false};
const tileFlag = {enabled: true, states: ["rubble.webp"], stage: 0};
const ignoredWall = {enabled: false, destroyed: false};
globalThis.canvas = {
  mousePosition: {x: 12, y: 34},
  grid: {size: 100},
  level: {id: "ground"},
  walls: {
    placeables: [
      {document: {getFlag: () => wallFlag, levels: new Set()}},
      {document: {getFlag: () => ignoredWall, levels: new Set()}},
      {document: {getFlag: () => wallFlag, levels: new Set(["cellar"])}}
    ]
  },
  tiles: {
    placeables: [
      {document: {getFlag: () => tileFlag, levels: new Set()}},
      {document: {getFlag: () => ({enabled: false, states: ["rubble.webp"], stage: 0}), levels: new Set()}}
    ]
  }
};

assert.deepEqual(getDestructionMarkerCursor(), {x: 12, y: 34});
assert.equal(isDestroyableOnViewedLevel({levels: new Set()}), true);
assert.equal(isDestroyableOnViewedLevel({levels: new Set(["cellar"])}), false);
assert.equal(
  countViewedDestroyables(),
  2,
  "only viewed-level destroyable walls and tiles are counted"
);

const pointerListeners = [];
const stage = {
  on(name, callback) {
    if (name === "pointermove") pointerListeners.push(callback);
  },
  off(name, callback) {
    if (name !== "pointermove") return;
    const index = pointerListeners.indexOf(callback);
    if (index >= 0) pointerListeners.splice(index, 1);
  }
};
canvas.stage = stage;

let notified = 0;
let latestCursor = null;
const unsubscribe = subscribeDestructionMarkerPointer(cursor => {
  notified++;
  latestCursor = cursor;
});
assert.equal(pointerListeners.length, 1, "destruction mode listens for cursor movement");

pointerListeners[0]({getLocalPosition: () => ({x: 50, y: 75})});
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(notified, 1);
assert.deepEqual(latestCursor, {x: 50, y: 75});
assert.deepEqual(getDestructionMarkerCursor(), {x: 50, y: 75});

unsubscribe();
assert.equal(pointerListeners.length, 0, "leaving destruction mode removes the cursor listener");

console.log("destruction-marker-proximity tests passed");
