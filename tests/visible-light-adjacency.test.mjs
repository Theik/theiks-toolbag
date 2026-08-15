import assert from "node:assert/strict";
import {
  findAdjacentOwnedToken,
  isTokenAdjacentToLight,
  isTokenBlockedFromLight
} from "../scripts/visible-lights/light-controls.js";

const token = {x: 0, y: 0, width: 1, height: 1};
const fallback = {gridSize: 100};

assert.equal(isTokenAdjacentToLight(token, {x: 50, y: 50}, fallback), true, "same square");
assert.equal(isTokenAdjacentToLight(token, {x: 150, y: 50}, fallback), true, "orthogonally adjacent");
assert.equal(isTokenAdjacentToLight(token, {x: 150, y: 150}, fallback), true, "diagonally adjacent");
assert.equal(isTokenAdjacentToLight(token, {x: 250, y: 50}, fallback), false, "two squares away");
assert.equal(
  isTokenAdjacentToLight({...token, elevation: 10}, {x: 150, y: 50, elevation: 0}, fallback),
  false,
  "a token on another elevation is not adjacent"
);
assert.equal(
  isTokenAdjacentToLight({x: 0, y: 0, width: 2, height: 2}, {x: 250, y: 150}, fallback),
  true,
  "large token footprint is respected"
);

const squareGrid = {
  isSquare: true,
  size: 125,
  getOffset: ({x, y}) => ({i: Math.floor(y / 125), j: Math.floor(x / 125)}),
  testAdjacency: (a, b) => Math.max(Math.abs(a.i - b.i), Math.abs(a.j - b.j)) === 1
};
const getSquareTokenOffsets = geometry => [{
  i: Math.floor((geometry.y + (squareGrid.size / 2)) / squareGrid.size),
  j: Math.floor((geometry.x + (squareGrid.size / 2)) / squareGrid.size),
  k: 0
}];
const gridSpaceToken = {
  _source: {x: 1000, y: 1250, width: 1, height: 1, elevation: 0},
  getOccupiedGridSpaceOffsets: getSquareTokenOffsets
};
assert.equal(
  isTokenAdjacentToLight(gridSpaceToken, {x: 938, y: 1313, elevation: 0}, {grid: squareGrid}),
  true,
  "the live Scene's integer-rounded light in the left neighboring space is in range"
);
assert.equal(
  isTokenAdjacentToLight(gridSpaceToken, {x: 1188, y: 1313, elevation: 0}, {grid: squareGrid}),
  true,
  "the live Scene's integer-rounded light in the right neighboring space is also in range"
);
assert.equal(
  isTokenAdjacentToLight(gridSpaceToken, {x: 1249, y: 1374, elevation: 0}, {grid: squareGrid}),
  true,
  "pixel distance within a neighboring grid space does not affect reach"
);
assert.equal(
  isTokenAdjacentToLight(gridSpaceToken, {x: 1313, y: 1313, elevation: 0}, {grid: squareGrid}),
  false,
  "a light two grid spaces away is out of range regardless of pixel distance"
);

for (const offset of [-1, 1]) {
  const offsetToken = {
    ...gridSpaceToken,
    _source: {...gridSpaceToken._source, x: 1000 + offset, y: 1250 + offset}
  };
  assert.equal(
    isTokenAdjacentToLight(offsetToken, {x: 938, y: 1313, elevation: 0}, {grid: squareGrid}),
    true,
    `a Token offset ${offset}px still reaches the left neighboring grid space`
  );
  assert.equal(
    isTokenAdjacentToLight(offsetToken, {x: 1188, y: 1313, elevation: 0}, {grid: squareGrid}),
    true,
    `a Token offset ${offset}px still reaches the right neighboring grid space`
  );
}

const gridToken = {
  getOccupiedGridSpaceOffsets: () => [{i: 4, j: 6}]
};
const adjacentGrid = {
  getOffset: () => ({i: 5, j: 7}),
  testAdjacency: (a, b) => Math.max(Math.abs(a.i - b.i), Math.abs(a.j - b.j)) === 1
};
assert.equal(isTokenAdjacentToLight(gridToken, {x: 0, y: 0}, {grid: adjacentGrid}), true);

const elevatedGridToken = {
  elevation: 10,
  getOccupiedGridSpaceOffsets: () => [{i: 4, j: 6, k: 1}]
};
const elevatedGrid = {
  ...adjacentGrid,
  getOffset: () => ({i: 5, j: 7, k: 0})
};
assert.equal(
  isTokenAdjacentToLight(elevatedGridToken, {x: 0, y: 0, elevation: 10}, {grid: elevatedGrid}),
  false,
  "3D grid offsets on another floor do not qualify"
);

const distantGrid = {
  ...adjacentGrid,
  getOffset: () => ({i: 6, j: 8})
};
assert.equal(isTokenAdjacentToLight(gridToken, {x: 0, y: 0}, {grid: distantGrid}), false);

let receivedGeometry;
const sourceAwareGrid = {
  getOffset: ({x, y, elevation}) => ({
    i: Math.floor(y / 100),
    j: Math.floor(x / 100),
    k: Math.floor(elevation / 5)
  }),
  testAdjacency: (a, b) => Math.max(Math.abs(a.i - b.i), Math.abs(a.j - b.j)) === 1
};
const sourceAwareToken = {
  x: 900,
  y: 900,
  elevation: 20,
  _source: {x: 0, y: 0, width: 1, height: 1, depth: 1, elevation: 0, shape: 0},
  getOccupiedGridSpaceOffsets: geometry => {
    receivedGeometry = geometry;
    return geometry.level === null ? [{i: 0, j: 0, k: 0}] : [{i: 9, j: 9, k: 4}];
  }
};
const sourceAwareLight = {
  x: 900,
  y: 900,
  elevation: 20,
  _source: {x: 150, y: 50, elevation: 0}
};
assert.equal(
  isTokenAdjacentToLight(sourceAwareToken, sourceAwareLight, {grid: sourceAwareGrid}),
  true,
  "saved geometry is used consistently instead of client-prepared Levels geometry"
);
assert.equal(receivedGeometry.level, null, "wall, Region, and surface filtering is disabled for adjacency");
assert.equal(receivedGeometry.x, 0);
assert.equal(receivedGeometry.y, 0);

const scene = {};
const user = {id: "player"};
const light = {x: 150, y: 50, parent: scene};
const selected = [
  {id: "foreign", document: {...token, parent: scene, testUserPermission: () => false}},
  {id: "far", document: {...token, x: 400, parent: scene, testUserPermission: () => true}},
  {id: "adjacent", document: {...token, parent: scene, testUserPermission: () => true}}
];
assert.equal(
  findAdjacentOwnedToken(light, user, selected, fallback)?.id,
  "adjacent",
  "only a selected, owned, adjacent token qualifies"
);
assert.equal(findAdjacentOwnedToken(light, user, selected.slice(0, 2), fallback), null);

const level = {id: "ground"};
let edgesInitialized = 0;
let receivedCollision;
const collisionScene = {
  grid: {size: 100},
  levels: new Map([[level.id, level]]),
  initializeEdges: () => { edgesInitialized += 1; }
};
const collisionToken = {
  parent: collisionScene,
  _source: {
    x: 0,
    y: 0,
    width: 1,
    height: 1,
    depth: 1,
    elevation: 0,
    level: level.id
  },
  getMovementOrigin: source => ({
    x: source.x + 50,
    y: source.y + 50,
    elevation: source.elevation + 2.5
  })
};
const collisionLight = {
  parent: collisionScene,
  _source: {x: 150, y: 50, elevation: 0, level: level.id}
};
const blockingBackend = {
  testCollision: (origin, destination, options) => {
    receivedCollision = {origin, destination, options};
    return true;
  }
};
assert.equal(
  isTokenBlockedFromLight(collisionToken, collisionLight, {collisionBackend: blockingBackend}),
  true,
  "Foundry movement collisions block interaction through walls"
);
assert.equal(edgesInitialized, 1, "off-canvas Scene edges are initialized before collision testing");
assert.deepEqual(receivedCollision.origin, {x: 50, y: 50, elevation: 2.5});
assert.deepEqual(receivedCollision.destination, {x: 150, y: 50, elevation: 2.5});
assert.equal(receivedCollision.options.type, "move");
assert.equal(receivedCollision.options.mode, "any");
assert.equal(receivedCollision.options.level, level);
assert.equal(
  isTokenBlockedFromLight(collisionToken, collisionLight, {
    collisionBackend: {testCollision: () => false}
  }),
  false,
  "an open route remains interactable"
);

const collisionUser = {id: "collision-player"};
const blockedCandidate = {
  id: "blocked",
  document: {...collisionToken, testUserPermission: () => true}
};
assert.equal(
  findAdjacentOwnedToken(collisionLight, collisionUser, [blockedCandidate], {
    gridSize: 100,
    collisionBackend: blockingBackend
  }),
  null,
  "an owned adjacent Token does not qualify when a wall blocks it"
);
assert.equal(
  findAdjacentOwnedToken(collisionLight, collisionUser, [blockedCandidate], {
    gridSize: 100,
    collisionBackend: blockingBackend,
    testWalls: false
  })?.id,
  "blocked",
  "callers can distinguish wall blocking from a missing adjacent Token"
);

console.log("visible light adjacency tests passed");
