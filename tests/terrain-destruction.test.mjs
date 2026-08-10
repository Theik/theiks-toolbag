import assert from "node:assert/strict";

const hookHandlers = new Map();
globalThis.Hooks = {
  on: (name, callback) => {
    const handlers = hookHandlers.get(name) ?? [];
    handlers.push(callback);
    hookHandlers.set(name, handlers);
  }
};

globalThis.game = {
  user: {id: "gm", isGM: true},
  i18n: {
    localize: key => key,
    format: (key, data) => `${key}:${JSON.stringify(data)}`
  }
};

let loadTexture = async src => ({src, valid: true, width: 2, height: 2});
globalThis.foundry = {
  canvas: {
    loadTexture: (...args) => loadTexture(...args),
    TextureLoader: {
      getTextureAlphaData: () => ({
        width: 2,
        height: 2,
        minX: 0,
        minY: 0,
        maxX: 2,
        maxY: 2,
        data: new Uint8Array([255, 255, 255, 255])
      })
    }
  }
};

const scene = {id: "scene", tiles: new Map()};
globalThis.canvas = {ready: true, scene};

const {
  registerBreakableTerrainConfig
} = await import("../scripts/breakable-terrain/terrain-config.js");
const {
  advanceTerrainDestruction,
  restoreTerrain,
  retreatTerrainDestruction
} = await import("../scripts/breakable-terrain/terrain-destruction.js");
registerBreakableTerrainConfig();

function createTile({
  id,
  enabled = true,
  blocksMovement = true,
  blocksVision = true,
  states = ["cracked.webp", "rubble.webp"],
  stage = 0,
  restoreSrc = null,
  src = "statue.webp",
  updateGate = null,
  updateResult = true
}) {
  const flag = {enabled, blocksMovement, blocksVision, states, stage, restoreSrc};
  const updateCalls = [];
  const tile = {
    documentName: "Tile",
    id,
    uuid: `Scene.scene.Tile.${id}`,
    parent: scene,
    _source: {texture: {src, alphaThreshold: 0.75}},
    texture: {src, alphaThreshold: 0.75},
    getFlag: () => flag,
    update: async (changes, options = {}) => {
      for (const callback of hookHandlers.get("preUpdateTile") ?? []) callback(tile, changes, options, game.user.id);
      updateCalls.push({changes: structuredClone(changes), options: {...options}});
      if (updateGate) await updateGate;
      if (!updateResult) return false;
      if (Object.hasOwn(changes, "texture.src")) tile._source.texture.src = tile.texture.src = changes["texture.src"];
      if (Object.hasOwn(changes, "flags.theiks-toolbag.breakableTerrain.enabled")) {
        flag.enabled = changes["flags.theiks-toolbag.breakableTerrain.enabled"];
      }
      if (Object.hasOwn(changes, "flags.theiks-toolbag.breakableTerrain.states")) {
        flag.states = changes["flags.theiks-toolbag.breakableTerrain.states"];
      }
      if (Object.hasOwn(changes, "flags.theiks-toolbag.breakableTerrain.platformMessage")) {
        flag.platformMessage = changes["flags.theiks-toolbag.breakableTerrain.platformMessage"];
      }
      if (Object.hasOwn(changes, "flags.theiks-toolbag.breakableTerrain.stage")) {
        flag.stage = changes["flags.theiks-toolbag.breakableTerrain.stage"];
      }
      if (Object.hasOwn(changes, "flags.theiks-toolbag.breakableTerrain.restoreSrc")) {
        flag.restoreSrc = changes["flags.theiks-toolbag.breakableTerrain.restoreSrc"];
      }
      return tile;
    }
  };
  scene.tiles.set(id, tile);
  return {tile, flag, updateCalls};
}

const fixture = createTile({id: "progression"});
assert.equal(await advanceTerrainDestruction(fixture.tile), fixture.tile);
assert.equal(fixture.tile.texture.src, "cracked.webp");
assert.equal(fixture.flag.stage, 1);
assert.equal(fixture.flag.restoreSrc, "statue.webp");

await advanceTerrainDestruction(fixture.tile);
assert.equal(fixture.tile.texture.src, "rubble.webp");
assert.equal(fixture.flag.stage, 2);
assert.equal(fixture.flag.restoreSrc, "statue.webp", "the first-hit restore source remains exact");
await assert.rejects(() => advanceTerrainDestruction(fixture.tile), /FullyDestroyed/);

await restoreTerrain(fixture.tile);
assert.equal(fixture.tile.texture.src, "statue.webp");
assert.equal(fixture.flag.stage, 0);
assert.equal(fixture.flag.restoreSrc, null);
await assert.rejects(() => restoreTerrain(fixture.tile), /NotDamaged/);

const oneState = createTile({id: "one-state", states: ["destroyed.webp"]});
await advanceTerrainDestruction(oneState.tile);
assert.equal(oneState.flag.stage, 1);
await restoreTerrain(oneState.tile);
assert.equal(oneState.tile.texture.src, "statue.webp");

const emptyState = createTile({id: "empty-state", states: [""]});
await advanceTerrainDestruction(emptyState.tile);
assert.equal(emptyState.tile.texture.src, null, "an empty damage state hides the Tile texture");
assert.equal(emptyState.flag.stage, 1);
await restoreTerrain(emptyState.tile);
assert.equal(emptyState.tile.texture.src, "statue.webp");

const stepBack = createTile({id: "step-back"});
await advanceTerrainDestruction(stepBack.tile);
await advanceTerrainDestruction(stepBack.tile);
await retreatTerrainDestruction(stepBack.tile);
assert.equal(stepBack.flag.stage, 1);
assert.equal(stepBack.tile.texture.src, "cracked.webp");
assert.equal(stepBack.flag.restoreSrc, "statue.webp");
await retreatTerrainDestruction(stepBack.tile);
assert.equal(stepBack.flag.stage, 0);
assert.equal(stepBack.tile.texture.src, "statue.webp");
assert.equal(stepBack.flag.restoreSrc, null);
await assert.rejects(() => retreatTerrainDestruction(stepBack.tile), /NotDamaged/);

const disabled = createTile({id: "disabled", enabled: false});
await assert.rejects(() => advanceTerrainDestruction(disabled.tile), /NotDestroyable/);
const missingStates = createTile({id: "missing", enabled: false, states: []});
await assert.rejects(
  () => missingStates.tile.update({"flags.theiks-toolbag.breakableTerrain.enabled": true}),
  /StateRequired/
);

const damaged = createTile({
  id: "guarded",
  stage: 1,
  restoreSrc: "statue.webp",
  src: "cracked.webp"
});
await assert.rejects(() => damaged.tile.update({"texture.src": "replacement.webp"}), /RestoreBeforeDefinitionChange/);
await assert.rejects(
  () => damaged.tile.update({"flags.theiks-toolbag.breakableTerrain.stage": 2}),
  /ManagedState/
);
await assert.rejects(
  () => damaged.tile.update({"flags.theiks-toolbag.breakableTerrain.platform": true}),
  /RestoreBeforeDefinitionChange/
);
await damaged.tile.update({"flags.theiks-toolbag.breakableTerrain.platformMessage": "It crumbles!"});
assert.equal(damaged.flag.platformMessage, "It crumbles!", "collapse text remains editable while damaged");
await damaged.tile.update({"flags.theiks-toolbag.breakableTerrain.blocksMovement": false});
await assert.rejects(
  () => damaged.tile.update({"flags.-=theiks-toolbag": null}),
  /RestoreBeforeDefinitionChange/
);

const corruptDefinition = createTile({
  id: "corrupt-definition",
  states: [],
  stage: 1,
  restoreSrc: "statue.webp",
  src: "orphaned-damage.webp"
});
await restoreTerrain(corruptDefinition.tile);
assert.equal(corruptDefinition.tile.texture.src, "statue.webp");
assert.equal(corruptDefinition.flag.stage, 0, "restoration repairs a damaged tile even if its state list is corrupt");

let finishTexture;
loadTexture = () => new Promise(resolve => { finishTexture = resolve; });
const race = createTile({id: "race"});
const racingAdvance = advanceTerrainDestruction(race.tile);
await Promise.resolve();
race.flag.states[1] = "replacement.webp";
finishTexture({valid: true, width: 2, height: 2});
await assert.rejects(() => racingAdvance, /StateChanged/);
assert.equal(race.flag.stage, 0);

let finishConcurrentTexture;
loadTexture = () => new Promise(resolve => { finishConcurrentTexture = resolve; });
const concurrent = createTile({id: "concurrent"});
const first = advanceTerrainDestruction(concurrent.tile);
await Promise.resolve();
await assert.rejects(() => advanceTerrainDestruction(concurrent.tile), /InProgress/);
finishConcurrentTexture({valid: true, width: 2, height: 2});
await first;

loadTexture = async () => null;
const failedTexture = createTile({id: "failed-texture"});
await assert.rejects(() => advanceTerrainDestruction(failedTexture.tile), /ImageLoad/);
assert.equal(failedTexture.flag.stage, 0);

loadTexture = async () => ({valid: false, width: 2, height: 2});
const invalidTexture = createTile({id: "invalid-texture"});
await assert.rejects(() => advanceTerrainDestruction(invalidTexture.tile), /ImageLoad/);
assert.equal(invalidTexture.flag.stage, 0);

loadTexture = async () => { throw new Error("decoder failed"); };
const rejectedTexture = createTile({id: "rejected-texture"});
await assert.rejects(() => advanceTerrainDestruction(rejectedTexture.tile), /ImageLoad/);
assert.equal(rejectedTexture.flag.stage, 0);

loadTexture = async src => ({src, valid: true, width: 2, height: 2});
const failedUpdate = createTile({id: "failed-update", updateResult: false});
await assert.rejects(() => advanceTerrainDestruction(failedUpdate.tile), /UpdateFailed/);
await assert.rejects(() => advanceTerrainDestruction(failedUpdate.tile), /UpdateFailed/);

game.user.isGM = false;
const nonGm = createTile({id: "non-gm"});
await assert.rejects(() => advanceTerrainDestruction(nonGm.tile), /GmOnly/);

console.log("terrain destruction tests passed");
