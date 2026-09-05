import assert from "node:assert/strict";
import {
  findAdjacentOwnedToken,
  isTokenAdjacentToTile,
  isTokenBlockedFromTile
} from "../scripts/usable-tiles/tile-interaction.js";

const size = 100;
const level = {id: "ground"};
const scene = {grid: {size}, levels: new Map([[level.id, level]]), initializeEdges: () => {}};
const grid = {
  size,
  testAdjacency: (a, b) => Math.max(Math.abs(a.i - b.i), Math.abs(a.j - b.j)) === 1
};
const tile = {
  parent: scene,
  _source: {x: 100, y: 100, width: 200, height: 100, elevation: 0, levels: [level.id]}
};
const tileContours = [[
  {x: 100, y: 100}, {x: 300, y: 100}, {x: 300, y: 200}, {x: 100, y: 200}
]];
const token = {
  parent: scene,
  _source: {x: 0, y: 100, width: 1, height: 1, elevation: 0, level: level.id},
  getOccupiedGridSpaceOffsets: () => [{i: 1, j: 0}],
  testUserPermission: () => true,
  getMovementOrigin: () => ({x: 50, y: 150, elevation: 0})
};

assert.equal(isTokenAdjacentToTile(token, tile, {grid, gridSize: size, contours: tileContours}), true, "either large-Tile space is reachable");
assert.equal(isTokenAdjacentToTile({
  ...token,
  getOccupiedGridSpaceOffsets: () => [{i: 1, j: 4}]
}, tile, {grid, gridSize: size, contours: tileContours}), false, "two spaces beyond the Tile footprint is out of range");
assert.equal(isTokenAdjacentToTile({
  ...token,
  _source: {...token._source, elevation: 10}
}, tile, {grid, gridSize: size, contours: tileContours}), false, "another elevation is not reachable");
assert.equal(isTokenAdjacentToTile({
  ...token,
  _source: {...token._source, level: "upper"}
}, tile, {grid, gridSize: size, contours: tileContours}), false, "another Scene Level is not reachable");

const paddedTile = {...tile, _source: {...tile._source, width: 400}};
const paddedContours = [[
  {x: 400, y: 100}, {x: 500, y: 100}, {x: 500, y: 200}, {x: 400, y: 200}
]];
assert.equal(isTokenAdjacentToTile(token, paddedTile, {
  grid, gridSize: size, contours: paddedContours
}), false, "transparent padding does not extend the usable grid footprint");

const centeredToken = {
  ...token,
  _source: {...token._source, x: 200, y: 200},
  getOccupiedGridSpaceOffsets: () => [{i: 2, j: 2}]
};
const holedContours = [
  [{x: 0, y: 0}, {x: 500, y: 0}, {x: 500, y: 500}, {x: 0, y: 500}],
  [{x: 100, y: 100}, {x: 100, y: 400}, {x: 400, y: 400}, {x: 400, y: 100}]
];
assert.equal(isTokenAdjacentToTile(centeredToken, tile, {
  grid, gridSize: size, contours: holedContours
}), false, "a large transparent hole does not count as usable artwork");

const islandContours = [
  [{x: 0, y: 200}, {x: 100, y: 200}, {x: 100, y: 300}, {x: 0, y: 300}],
  [{x: 400, y: 200}, {x: 500, y: 200}, {x: 500, y: 300}, {x: 400, y: 300}]
];
assert.equal(isTokenAdjacentToTile(centeredToken, tile, {
  grid, gridSize: size, contours: islandContours
}), false, "the transparent gap between opaque islands does not count");

const gridlessTile = {...tile, _source: {...tile._source, x: 200, width: 100}};
const gridlessContours = [[
  {x: 200, y: 100}, {x: 300, y: 100}, {x: 300, y: 200}, {x: 200, y: 200}
]];
assert.equal(isTokenAdjacentToTile(token, gridlessTile, {
  gridSize: size, contours: gridlessContours
}), true, "one grid unit from the opaque edge is in range");
assert.equal(isTokenAdjacentToTile(token, {
  ...gridlessTile,
  _source: {...gridlessTile._source, x: 201}
}, {gridSize: size, contours: gridlessContours.map(contour => contour.map(point => ({...point, x: point.x + 1})))}), false,
"more than one grid unit from the opaque edge is out of range");
assert.equal(isTokenAdjacentToTile(token, paddedTile, {
  gridSize: size, contours: paddedContours
}), false, "transparent padding does not extend gridless reach");

let collisionCalls = 0;
const partiallyOpen = {
  testCollision: (_origin, destination) => {
    collisionCalls += 1;
    return destination.x > 200;
  }
};
assert.equal(isTokenBlockedFromTile(token, tile, {
  grid,
  gridSize: size,
  contours: tileContours,
  collisionBackend: partiallyOpen,
  level
}), false, "one unblocked reachable Tile space permits use");
assert.equal(collisionCalls, 1, "only adjacent parts of a large Tile are collision targets");
assert.equal(isTokenBlockedFromTile(token, tile, {
  grid,
  gridSize: size,
  contours: tileContours,
  collisionBackend: {testCollision: () => true},
  level
}), true);

const user = {id: "player"};
assert.equal(findAdjacentOwnedToken(tile, user, [{id: "token", document: token}], {
  grid,
  gridSize: size,
  contours: tileContours,
  collisionBackend: {testCollision: () => false},
  level
})?.id, "token");

console.log("usable Tile interaction tests passed");
