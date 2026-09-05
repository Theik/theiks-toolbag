import assert from "node:assert/strict";

const hooks = new Map();
globalThis.Hooks = {
  once: (name, callback) => {
    const callbacks = hooks.get(name) ?? [];
    callbacks.push(callback);
    hooks.set(name, callbacks);
  },
  on: (name, callback) => {
    const callbacks = hooks.get(name) ?? [];
    callbacks.push(callback);
    hooks.set(name, callbacks);
  },
  callAll: () => {}
};

const gm = {id: "gm", active: true, isGM: true};
const player = {id: "player", active: true, isGM: false, viewedScene: "scene"};
const users = new Map([[gm.id, gm], [player.id, player]]);
users.activeGM = gm;
const scenes = new Map();
let socketHandler;
let beforeGmRequest = null;
globalThis.game = {
  user: player,
  users,
  scenes,
  settings: {get: () => true},
  i18n: {
    localize: key => key,
    format: (key, data) => `${key}:${data.src ?? data.feature ?? ""}`
  },
  socket: {
    on: (_channel, callback) => { socketHandler = callback; },
    emit: (_channel, message) => {
      if (message.type === "usableTileUseRequest") {
        beforeGmRequest?.();
        queueMicrotask(() => {
          game.user = gm;
          socketHandler(message, player.id);
        });
      } else if (message.type === "usableTileUseResult") {
        queueMicrotask(() => {
          game.user = player;
          socketHandler(message, gm.id);
        });
      }
    }
  }
};

globalThis.CONFIG = {Canvas: {polygonBackends: {move: {testCollision: () => false}}}};
globalThis.foundry = {
  utils: {
    equals: (left, right) => JSON.stringify(left) === JSON.stringify(right),
    randomID: () => "request-1",
    AsyncFunction: Object.getPrototypeOf(async function () {}).constructor
  },
  canvas: {
    TextureLoader: {
      getTextureAlphaData: () => ({
        width: 1, height: 1, minX: 0, minY: 0, maxX: 1, maxY: 1, data: new Uint8Array([255])
      })
    },
    loadTexture: async src => ({src, valid: true, width: 100, height: 100})
  }
};
const level = {id: "ground"};
const scene = {
  id: "scene",
  grid: {
    size: 100,
    testAdjacency: (a, b) => Math.max(Math.abs(a.i - b.i), Math.abs(a.j - b.j)) === 1
  },
  levels: new Map([[level.id, level]]),
  tiles: new Map(),
  tokens: new Map(),
  initializeEdges: () => {}
};
scenes.set(scene.id, scene);
const usable = {
  enabled: true,
  states: ["off.webp", "on.webp"],
  index: 0,
  direction: "towardOn",
  behaviors: []
};
const tile = {
  id: "switch",
  uuid: "Scene.scene.Tile.switch",
  documentName: "Tile",
  parent: scene,
  _source: {x: 100, y: 100, width: 100, height: 100, elevation: 0, levels: [level.id], texture: {src: "off.webp"}},
  texture: {src: "off.webp"},
  getFlag: (_module, key) => key === "usableTile" ? usable : (key === "breakableTerrain" ? {stage: 0} : undefined),
  update: async (changes, options = {}) => {
    for (const callback of hooks.get("preUpdateTile") ?? []) callback(tile, changes, options, game.user.id);
    if (Object.hasOwn(changes, "texture.src")) tile._source.texture.src = tile.texture.src = changes["texture.src"];
    if (Object.hasOwn(changes, "flags.theiks-toolbag.usableTile.index")) {
      usable.index = changes["flags.theiks-toolbag.usableTile.index"];
    }
    if (Object.hasOwn(changes, "flags.theiks-toolbag.usableTile.direction")) {
      usable.direction = changes["flags.theiks-toolbag.usableTile.direction"];
    }
    return tile;
  }
};
scene.tiles.set(tile.id, tile);
const token = {
  id: "hero",
  parent: scene,
  _source: {x: 0, y: 100, width: 1, height: 1, elevation: 0, level: level.id},
  getOccupiedGridSpaceOffsets: () => [{i: 1, j: 0}],
  getMovementOrigin: () => ({x: 50, y: 150, elevation: 0}),
  testUserPermission: user => user === player
};
scene.tokens.set(token.id, token);
const tokenPlaceable = {id: token.id, document: token};
globalThis.canvas = {
  ready: true,
  scene,
  level,
  grid: scene.grid,
  dimensions: {size: 100},
  tokens: {controlled: [tokenPlaceable]}
};

const {registerUsableTileConfig} = await import("../scripts/usable-tiles/tile-config.js");
const {registerUsableTileControls, useUsableTile} = await import("../scripts/usable-tiles/tile-controls.js");
registerUsableTileConfig();
registerUsableTileControls();
for (const callback of hooks.get("ready") ?? []) callback();

assert.equal(await useUsableTile(tile), tile, "the player request resolves to its local Tile document");
assert.equal(usable.index, 1, "the authoritative GM advances the requested Tile");
assert.equal(usable.direction, "towardOff");
assert.equal(tile.texture.src, "on.webp");
assert.equal(game.user, player, "the result is delivered back to the requesting player");

users.activeGM = null;
await assert.rejects(() => useUsableTile(tile), /NoActiveGm/);
users.activeGM = gm;

beforeGmRequest = () => {
  usable.index = 0;
  usable.direction = "towardOn";
};
const originalWarn = console.warn;
console.warn = () => {};
try {
  await assert.rejects(() => useUsableTile(tile), /StateChanged/, "stale player state is rejected by the GM");
} finally {
  console.warn = originalWarn;
}

console.log("usable Tile socket tests passed");
