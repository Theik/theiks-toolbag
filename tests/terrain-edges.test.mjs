import assert from "node:assert/strict";

const hooks = new Map();
globalThis.Hooks = {
  on: (name, callback) => {
    const callbacks = hooks.get(name) ?? [];
    callbacks.push(callback);
    hooks.set(name, callbacks);
  }
};

class FakeEdge {
  constructor(a, b, options) {
    this.a = a;
    this.b = b;
    Object.assign(this, options);
  }
}

globalThis.CONST = {
  EDGE_SENSE_TYPES: {NONE: 0, NORMAL: 1, LIMITED: 2},
  EDGE_DIRECTIONS: {BOTH: 0}
};

const alphaData = {
  width: 2,
  height: 2,
  minX: 0,
  minY: 0,
  maxX: 2,
  maxY: 2,
  data: new Uint8Array([255, 255, 255, 255])
};
const texture = {src: "statue.webp", valid: true, width: 2, height: 2};
globalThis.foundry = {
  canvas: {
    geometry: {edges: {Edge: FakeEdge}},
    TextureLoader: {getTextureAlphaData: () => alphaData},
    loadTexture: async src => ({...texture, src})
  }
};

const ground = {id: "ground", edges: new Map(), isVisible: true};
const upper = {id: "upper", edges: new Map(), isVisible: false};
const levels = new Map([[ground.id, ground], [upper.id, upper]]);
levels.contents = [ground, upper];
const scene = {
  id: "scene",
  tiles: new Map(),
  levels,
  regionRefreshes: [],
  updateRegionShapeConstraints(types) { this.regionRefreshes.push(types); }
};
let perceptionRefreshes = 0;
let movementRefreshes = 0;
globalThis.canvas = {
  ready: true,
  scene,
  perception: {update: () => { perceptionRefreshes += 1; }},
  tokens: {recalculatePlannedMovementPaths: () => { movementRefreshes += 1; }}
};

function createTile({id, levelIds = new Set(), movement = true, vision = false}) {
  const flag = {
    enabled: false,
    blocksMovement: movement,
    blocksVision: vision,
    states: ["destroyed.webp"],
    stage: 0,
    restoreSrc: null
  };
  const tile = {
    documentName: "Tile",
    id,
    uuid: `Scene.scene.Tile.${id}`,
    parent: scene,
    levels: levelIds,
    _source: {
      x: 100,
      y: 100,
      width: 100,
      height: 100,
      rotation: 0,
      levels: [...levelIds],
      texture: {
        src: "statue.webp",
        alphaThreshold: 0.75,
        anchorX: 0.5,
        anchorY: 0.5,
        fit: "fill",
        scaleX: 1,
        scaleY: 1
      }
    },
    getFlag: () => flag,
    object: {mesh: {texture}}
  };
  scene.tiles.set(id, tile);
  return {tile, flag};
}

const {registerBreakableTerrainEdges} = await import("../scripts/breakable-terrain/terrain-edges.js");
registerBreakableTerrainEdges();

for (const hook of ["initializeEdges", "canvasReady", "canvasTearDown", "createTile", "updateTile", "deleteTile"]) {
  assert.ok(hooks.get(hook)?.length, `${hook} is registered`);
}

const fixture = createTile({id: "terrain"});
for (const callback of hooks.get("initializeEdges")) callback(scene);
assert.equal(ground.edges.size, 4);
assert.equal(upper.edges.size, 4, "unassigned blocking terrain is attached to every Scene Level");
for (const edge of ground.edges.values()) {
  assert.equal(edge.type, "wall");
  assert.equal(edge.move, 1);
  assert.equal(edge.light, 0);
  assert.equal(edge.sight, 0);
}

fixture.flag.stage = 1;
for (const callback of hooks.get("updateTile")) callback(fixture.tile);
assert.equal(ground.edges.size, 0, "the final state removes movement edges immediately");
assert.equal(upper.edges.size, 0);

fixture.flag.stage = 0;
fixture.flag.blocksMovement = false;
fixture.flag.blocksVision = true;
fixture.tile.levels = new Set(["ground"]);
fixture.tile._source.levels = ["ground"];
for (const callback of hooks.get("updateTile")) callback(fixture.tile);
assert.equal(ground.edges.size, 4);
assert.equal(upper.edges.size, 0, "explicit Levels assignments are respected");
for (const edge of ground.edges.values()) {
  assert.equal(edge.move, 0);
  assert.equal(edge.light, 2);
  assert.equal(edge.darkness, 2);
  assert.equal(edge.sight, 2, "vision uses Foundry's limited terrain-wall restriction");
}

fixture.tile._source.x = 200;
for (const callback of hooks.get("updateTile")) callback(fixture.tile);
assert.equal(Math.min(...Array.from(ground.edges.values()).flatMap(edge => [edge.a.x, edge.b.x])), 150);

ground.edges.clear();
upper.edges.clear();
for (const callback of hooks.get("initializeEdges")) callback(scene);
assert.equal(ground.edges.size, 4, "cached alpha contours reattach synchronously after Scene edge reset");

await Promise.resolve();
assert.ok(perceptionRefreshes > 0);
assert.ok(movementRefreshes > 0);
assert.ok(scene.regionRefreshes.length > 0);

for (const callback of hooks.get("deleteTile")) callback(fixture.tile);
assert.equal(ground.edges.size, 0);

for (const callback of hooks.get("canvasTearDown")) callback();

console.log("terrain edge lifecycle tests passed");
