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
globalThis.game = {
  user: gm,
  users: new Map([[gm.id, gm]]),
  settings: {get: () => true},
  i18n: {
    localize: key => key,
    format: (key, data) => `${key}:${data.src ?? data.feature ?? ""}`
  }
};
game.users.activeGM = gm;
globalThis.ui = {notifications: {warn: () => {}}};
globalThis.foundry = {
  utils: {
    AsyncFunction: Object.getPrototypeOf(async function () {}).constructor,
    equals: (left, right) => JSON.stringify(left) === JSON.stringify(right),
    randomID: () => "request"
  },
  canvas: {
    loadTexture: async src => ({src, valid: true, width: 2, height: 2}),
    TextureLoader: {
      getTextureAlphaData: () => ({
        width: 2, height: 2, minX: 0, minY: 0, maxX: 2, maxY: 2,
        data: new Uint8Array([255, 255, 255, 255])
      })
    }
  }
};

const scene = {id: "scene", tiles: new Map(), grid: {size: 100}};
globalThis.canvas = {ready: true, scene, dimensions: {size: 100}, tokens: {controlled: []}};
const usable = {
  enabled: true,
  states: ["off.webp", "step.webp", "on.webp"],
  index: 0,
  direction: "towardOn",
  behaviors: [{
    id: "record",
    type: "executeScript",
    name: "Record",
    disabled: false,
    events: ["off", "on", "step"],
    source: "globalThis.__usableEvents.push({name: event.name, previous: event.data.previous.index, current: event.data.current.index, alias: tile === document, user: event.user.id});"
  }]
};
const breakable = {enabled: true, states: ["broken.webp"], stage: 0, restoreSrc: null};
const tile = {
  documentName: "Tile",
  id: "door",
  uuid: "Scene.scene.Tile.door",
  parent: scene,
  _source: {x: 100, y: 100, width: 100, height: 100, elevation: 0, texture: {src: "off.webp"}},
  texture: {src: "off.webp"},
  getFlag: (_module, key) => key === "usableTile" ? usable : (key === "breakableTerrain" ? breakable : undefined),
  update: async (changes, options = {}) => {
    for (const callback of hooks.get("preUpdateTile") ?? []) callback(tile, changes, options, game.user.id);
    if (Object.hasOwn(changes, "texture.src")) tile._source.texture.src = tile.texture.src = changes["texture.src"];
    for (const [field, key] of [
      ["flags.theiks-toolbag.usableTile.enabled", "enabled"],
      ["flags.theiks-toolbag.usableTile.states", "states"],
      ["flags.theiks-toolbag.usableTile.index", "index"],
      ["flags.theiks-toolbag.usableTile.direction", "direction"]
    ]) if (Object.hasOwn(changes, field)) usable[key] = changes[field];
    for (const [field, key] of [
      ["flags.theiks-toolbag.breakableTerrain.stage", "stage"],
      ["flags.theiks-toolbag.breakableTerrain.restoreSrc", "restoreSrc"]
    ]) if (Object.hasOwn(changes, field)) breakable[key] = changes[field];
    return tile;
  }
};
scene.tiles.set(tile.id, tile);

const {registerUsableTileConfig} = await import("../scripts/usable-tiles/tile-config.js");
const {getUsableTileEventState, useUsableTile} = await import("../scripts/usable-tiles/tile-controls.js");
const {acquireTileTransition} = await import("../scripts/tile-transition-lock.js");
registerUsableTileConfig();

globalThis.__usableEvents = [];
await useUsableTile(tile);
assert.deepEqual(getUsableTileEventState(tile), {
  index: 1, direction: "towardOn", state: "step", textureSrc: "step.webp"
});
await useUsableTile(tile);
assert.equal(usable.index, 2);
assert.equal(usable.direction, "towardOff");
await useUsableTile(tile);
await useUsableTile(tile);
assert.equal(usable.index, 0);
assert.equal(usable.direction, "towardOn");
await new Promise(resolve => setTimeout(resolve, 0));
assert.deepEqual(globalThis.__usableEvents, [
  {name: "step", previous: 0, current: 1, alias: true, user: "gm"},
  {name: "on", previous: 1, current: 2, alias: true, user: "gm"},
  {name: "step", previous: 2, current: 1, alias: true, user: "gm"},
  {name: "off", previous: 1, current: 0, alias: true, user: "gm"}
]);

await assert.rejects(() => tile.update({"texture.src": "manual.webp"}), /ManagedImage/);
await tile.update({"flags.theiks-toolbag.usableTile.states": ["new-off.webp", "new-on.webp"]});
assert.equal(usable.index, 0, "definition changes reset the state");
assert.equal(usable.direction, "towardOn");
assert.equal(tile.texture.src, "new-off.webp");

usable.states = ["new-off.webp", "new-step.webp", "new-on.webp"];
usable.index = 1;
usable.direction = "towardOn";
tile.texture.src = tile._source.texture.src = "new-step.webp";
const {advanceTerrainDestruction, restoreTerrain} = await import("../scripts/breakable-terrain/terrain-destruction.js");
await advanceTerrainDestruction(tile);
assert.equal(tile.texture.src, "broken.webp", "damage artwork replaces the usable state");
assert.equal(breakable.restoreSrc, "new-step.webp", "damage captures the exact usable image");
await restoreTerrain(tile);
assert.equal(tile.texture.src, "new-step.webp", "repair restores the captured usable image");
assert.equal(usable.index, 1, "damage and repair preserve the usable state");

breakable.stage = 1;
breakable.restoreSrc = "new-off.webp";
tile.texture.src = tile._source.texture.src = "broken.webp";
await assert.rejects(() => useUsableTile(tile), /Damaged/);
assert.equal(tile.texture.src, "broken.webp", "broken artwork retains precedence");
await assert.rejects(
  () => tile.update({"flags.theiks-toolbag.usableTile.states": ["a.webp", "b.webp"]}),
  /RepairBeforeUse/
);

breakable.stage = 0;
const release = acquireTileTransition(tile);
await assert.rejects(() => useUsableTile(tile), /InProgress/);
release();

foundry.canvas.loadTexture = async () => null;
const indexBeforeFailedLoad = usable.index;
await assert.rejects(() => useUsableTile(tile), /ImageLoad/);
assert.equal(usable.index, indexBeforeFailedLoad, "a failed image load does not change state");

console.log("usable Tile action tests passed");
