import assert from "node:assert/strict";
import {
  destroyVisibleLight,
  registerVisibleLightControls,
  toggleVisibleLight
} from "../scripts/visible-lights/light-controls.js";

const readyHooks = [];
const registeredHooks = new Map();
let socketListener = null;
let authenticatedRequestHandled = false;
globalThis.Hooks = {
  once: (name, callback) => {
    if (name === "ready") readyHooks.push(callback);
  },
  on: (name, callback) => {
    const callbacks = registeredHooks.get(name) ?? [];
    callbacks.push(callback);
    registeredHooks.set(name, callbacks);
  }
};
globalThis.game = {
  user: null,
  i18n: {localize: key => key},
  scenes: new Map(),
  users: new Map(),
  socket: {
    on: (_channel, callback) => { socketListener = callback; },
    emit: (_channel, message) => {
      if (message.type === "visibleLightToggleRequest") {
        // A non-GM cannot forge the result even though module socket packets are broadcast.
        socketListener({
          type: "visibleLightToggleResult",
          requestId: message.requestId,
          userId: player.id,
          ok: true
        }, otherPlayer.id);
        setTimeout(() => {
          const previousUser = game.user;
          game.user = gm;
          socketListener(message, player.id);
          game.user = previousUser;
        }, 0);
      } else if (message.type === "visibleLightToggleResult") {
        authenticatedRequestHandled = true;
        const previousUser = game.user;
        game.user = player;
        socketListener(message, gm.id);
        game.user = previousUser;
      }
    }
  }
};
globalThis.CONST = {DOCUMENT_OWNERSHIP_LEVELS: {OWNER: 3}};
globalThis.canvas = {
  scene: null,
  grid: null,
  dimensions: {size: 100},
  tokens: {controlled: []}
};
globalThis.foundry = {utils: {randomID: () => "request-id"}};

const gm = {id: "gm", active: true, isGM: true};
const player = {id: "player", active: true, isGM: false, viewedScene: "scene"};
const otherPlayer = {id: "other", active: true, isGM: false};
game.users.set(gm.id, gm);
game.users.set(player.id, player);
game.users.set(otherPlayer.id, otherPlayer);
game.users.activeGM = gm;
registerVisibleLightControls();
for (const callback of readyHooks) callback();

function createFixture() {
  const flag = {
    destroyed: false,
    images: {on: "on.webp", off: "off.webp", destroyed: "broken.webp"}
  };
  const scene = {id: "scene", grid: {size: 100}, lights: new Map(), tokens: new Map()};
  const light = {
    documentName: "AmbientLight",
    id: "light",
    uuid: "Scene.scene.AmbientLight.light",
    x: 150,
    y: 50,
    hidden: false,
    parent: scene,
    getFlag: () => flag,
    update: async changes => {
      if (Object.hasOwn(changes, "hidden")) light.hidden = changes.hidden;
      if (Object.hasOwn(changes, "flags.theiks-toolbag.visibleLight.destroyed")) {
        flag.destroyed = changes["flags.theiks-toolbag.visibleLight.destroyed"];
      }
      return light;
    }
  };
  const token = {
    id: "token",
    x: 0,
    y: 0,
    width: 1,
    height: 1,
    parent: scene,
    testUserPermission: user => user === player
  };
  scene.lights.set(light.id, light);
  scene.tokens.set(token.id, token);
  game.scenes.set(scene.id, scene);
  canvas.scene = scene;
  canvas.tokens.controlled = [{document: token}];
  return {flag, light, scene, token};
}

const fixture = createFixture();
game.user = gm;
assert.equal((await toggleVisibleLight(fixture.light)).hidden, true);
assert.equal((await toggleVisibleLight(fixture.light)).hidden, false);

game.user = player;
await toggleVisibleLight(fixture.light);
assert.equal(authenticatedRequestHandled, true, "only the active GM's authenticated response resolves a request");
assert.equal(fixture.light.hidden, true, "an adjacent owner can toggle the light");

canvas.tokens.controlled = [{document: {...fixture.token, testUserPermission: () => false}}];
await assert.rejects(
  () => toggleVisibleLight(fixture.light),
  /TokenRequired/
);
const farToken = {...fixture.token, id: "far", x: 400, testUserPermission: () => true};
canvas.tokens.controlled = [{document: farToken}];
await assert.rejects(
  () => toggleVisibleLight(fixture.light),
  /TokenRequired/
);

fixture.light.hidden = false;
game.user = gm;
await destroyVisibleLight(fixture.light);
assert.equal(fixture.light.hidden, true, "destroying also switches the Foundry light off");
assert.equal(fixture.flag.destroyed, true);
await assert.rejects(() => toggleVisibleLight(fixture.light), /Destroyed/);
await assert.rejects(() => destroyVisibleLight(fixture.light), /AlreadyDestroyed/);

fixture.light.hidden = false;
game.user = gm;
for (const callback of registeredHooks.get("updateAmbientLight") ?? []) callback(fixture.light);
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(fixture.light.hidden, true, "the active GM reconciles a destroyed light switched on by a race");

const playerFixture = createFixture();
game.user = player;
await assert.rejects(
  () => destroyVisibleLight(playerFixture.light, {user: gm}),
  /GmDestroyOnly/
);

// Foundry's occupied-space helper can return different prepared footprints on the viewed player
// canvas and an active GM who is viewing another Scene or Level. Both sides must validate against
// the same saved geometry, without wall/Region/surface filtering.
const geometryFixture = createFixture();
const geometryGrid = {
  size: 100,
  getOffset: ({x, y, elevation}) => ({
    i: Math.floor(y / 100),
    j: Math.floor(x / 100),
    k: Math.floor(elevation / 5)
  }),
  testAdjacency: (a, b) => Math.max(Math.abs(a.i - b.i), Math.abs(a.j - b.j)) === 1
};
geometryFixture.scene.grid = geometryGrid;
canvas.grid = geometryGrid;
const savedGeometry = {x: 0, y: 0, width: 1, height: 1, depth: 1, elevation: 0, shape: 0};
const playerPreparedToken = {
  ...geometryFixture.token,
  _source: savedGeometry,
  getOccupiedGridSpaceOffsets: () => [{i: 0, j: 0, k: 0}]
};
const gmPreparedToken = {
  ...geometryFixture.token,
  x: 900,
  y: 900,
  elevation: 20,
  _source: savedGeometry,
  getOccupiedGridSpaceOffsets: geometry => geometry?.level === null
    ? [{i: 0, j: 0, k: 0}]
    : [{i: 9, j: 9, k: 4}]
};
geometryFixture.scene.tokens.set(geometryFixture.token.id, gmPreparedToken);
canvas.tokens.controlled = [{document: playerPreparedToken}];
game.user = player;
await toggleVisibleLight(geometryFixture.light);
assert.equal(
  geometryFixture.light.hidden,
  true,
  "the GM accepts the same adjacency for which the player-side control is shown"
);

function createStaleAuthorityFixture() {
  const fixture = createFixture();
  fixture.scene.grid = geometryGrid;
  canvas.grid = geometryGrid;
  const playerSource = {x: 0, y: 0, width: 1, height: 1, depth: 1, elevation: 0, shape: 0};
  const gmSource = {...playerSource, x: 400};
  const getOffsets = geometry => [geometryGrid.getOffset(geometry)];
  const playerToken = {
    ...fixture.token,
    _source: playerSource,
    getOccupiedGridSpaceOffsets: getOffsets
  };
  const gmToken = {
    ...fixture.token,
    x: gmSource.x,
    _source: gmSource,
    getOccupiedGridSpaceOffsets: getOffsets
  };
  fixture.scene.tokens.set(fixture.token.id, gmToken);
  canvas.tokens.controlled = [{document: playerToken}];
  return {...fixture, gmToken};
}

const synchronizationFixture = createStaleAuthorityFixture();
game.user = player;
const synchronizedToggle = toggleVisibleLight(synchronizationFixture.light);
setTimeout(() => {
  synchronizationFixture.gmToken.x = 0;
  synchronizationFixture.gmToken._source.x = 0;
}, 50);
await synchronizedToggle;
assert.equal(
  synchronizationFixture.light.hidden,
  true,
  "a rapid click waits for the active GM to apply the immediately preceding Token movement"
);

const forgedStateFixture = createStaleAuthorityFixture();
game.user = player;
const originalWarn = console.warn;
console.warn = () => {};
try {
  await assert.rejects(
    () => toggleVisibleLight(forgedStateFixture.light),
    /NotAdjacent/,
    "a client snapshot never authorizes a toggle unless the GM's Token document becomes adjacent"
  );
} finally {
  console.warn = originalWarn;
}
assert.equal(forgedStateFixture.light.hidden, false);

console.log("visible light action tests passed");
