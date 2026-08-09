import assert from "node:assert/strict";
import {
  findAdjacentOwnedToken,
  isTokenAdjacentToLight
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

console.log("visible light adjacency tests passed");
