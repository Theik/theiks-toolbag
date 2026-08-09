import assert from "node:assert/strict";
import { destroyWall } from "../scripts/breakable-walls/wall-destruction.js";

globalThis.game = {
  user: {isGM: true},
  i18n: {
    localize: key => key,
    format: (key, data) => `${key}:${JSON.stringify(data)}`
  }
};

globalThis.canvas = {
  ready: true,
  level: {elevation: {base: 10}},
  scene: null
};

globalThis.foundry = {
  canvas: {
    loadTexture: async src => src ? {src} : null
  }
};

function createWall({id, coordinates = [0, 0, 125, 0], images, deleteError = null}) {
  const state = {
    createdData: null,
    tileDeleted: false,
    wallDeleted: false
  };
  const tile = {
    delete: async () => {
      state.tileDeleted = true;
    }
  };
  const scene = {
    walls: new Map(),
    createEmbeddedDocuments: async (documentName, data) => {
      assert.equal(documentName, "Tile");
      state.createdData = data[0];
      return [tile];
    }
  };
  const wall = {
    documentName: "Wall",
    id,
    uuid: `Scene.test.Wall.${id}`,
    c: coordinates,
    levels: new Set(["level-1"]),
    parent: scene,
    getFlag: () => ({enabled: true, images}),
    delete: async () => {
      if (deleteError) throw deleteError;
      state.wallDeleted = true;
    }
  };
  scene.walls.set(id, wall);
  canvas.scene = scene;
  return {state, tile, wall};
}

const both = createWall({
  id: "both",
  images: {both: "both.png", single: "single.png"}
});
const bothResult = await destroyWall(both.wall, {kind: "both"});
assert.equal(bothResult, both.tile);
assert.equal(both.state.wallDeleted, true);
assert.equal(both.state.createdData.width, 125);
assert.equal(both.state.createdData.height, 250);
assert.equal(both.state.createdData.x, 63);
assert.equal(both.state.createdData.texture.scaleY, 1);
assert.deepEqual(both.state.createdData.levels, ["level-1"]);
assert.equal(both.state.createdData.elevation, 10);
assert.equal(both.state.createdData.locked, true);

const single = createWall({
  id: "single",
  coordinates: [0, 125, 0, 0],
  images: {both: "both.png", single: "single.png"}
});
await destroyWall(single.wall, {kind: "single", side: "negative"});
assert.equal(single.state.createdData.rotation, 90);
assert.equal(single.state.createdData.texture.scaleY, -1);
assert.equal(single.state.createdData.flags["theiks-toolbag"].destroyedWall.side, "negative");

const rollback = createWall({
  id: "rollback",
  images: {both: "both.png", single: "single.png"},
  deleteError: new Error("database failure")
});
await assert.rejects(() => destroyWall(rollback.wall, {kind: "both"}));
assert.equal(rollback.state.tileDeleted, true, "created Tile is removed when Wall deletion fails");

const missingImage = createWall({id: "missing", images: {both: "", single: ""}});
await assert.rejects(() => destroyWall(missingImage.wall, {kind: "both"}));
assert.equal(missingImage.state.createdData, null, "missing artwork never changes the Scene");

const zeroLength = createWall({
  id: "zero-length",
  coordinates: [5, 5, 5, 5],
  images: {both: "both.png", single: "single.png"}
});
const originalLoadTexture = foundry.canvas.loadTexture;
foundry.canvas.loadTexture = async () => {
  throw new Error("texture loading should not run for invalid geometry");
};
await assert.rejects(
  () => destroyWall(zeroLength.wall, {kind: "both"}),
  /ZeroLength/
);
assert.equal(zeroLength.state.createdData, null);
foundry.canvas.loadTexture = originalLoadTexture;

game.user.isGM = false;
const nonGm = createWall({id: "non-gm", images: {both: "both.png", single: "single.png"}});
await assert.rejects(() => destroyWall(nonGm.wall, {kind: "both"}));
assert.equal(nonGm.state.createdData, null);

console.log("wall destruction tests passed");
