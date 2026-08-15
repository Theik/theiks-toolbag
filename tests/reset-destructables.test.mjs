import assert from "node:assert/strict";

const featureSettings = {
  enableBreakableWalls: true,
  enableBreakableTerrain: true,
  enableVisibleLights: true
};
globalThis.game = {
  user: {id: "gm", isGM: true},
  settings: {get: (_namespace, key) => featureSettings[key]},
  i18n: {
    localize: key => key,
    format: (key, data) => `${key}:${JSON.stringify(data)}`
  }
};
const notifications = {info: [], warn: [], error: []};
globalThis.ui = {
  notifications: {
    info: message => notifications.info.push(message),
    warn: message => notifications.warn.push(message),
    error: message => notifications.error.push(message)
  }
};
globalThis.foundry = {applications: {api: {DialogV2: {confirm: async () => false}}}};

function createDocument({id, flagName, flag, hidden = false, level = "ground"}) {
  return {
    id,
    uuid: `Scene.scene.${id}`,
    hidden,
    levels: new Set([level]),
    getFlag: (_module, key) => key === flagName ? flag : undefined
  };
}

function createScene({empty = false} = {}) {
  const scene = {id: "scene", walls: new Map(), tiles: new Map(), lights: new Map()};
  if (empty) return scene;

  scene.walls.set("destroyed-wall", createDocument({
    id: "destroyed-wall",
    flagName: "breakableWall",
    flag: {enabled: true, destroyed: true, restore: {move: 1}},
    level: "basement"
  }));
  scene.walls.set("intact-wall", createDocument({
    id: "intact-wall",
    flagName: "breakableWall",
    flag: {enabled: true, destroyed: false}
  }));
  scene.tiles.set("damaged-tile", createDocument({
    id: "damaged-tile",
    flagName: "breakableTerrain",
    flag: {enabled: true, states: ["damage.webp", "destroyed.webp"], stage: 1, restoreSrc: "floor.webp"},
    hidden: true,
    level: "first-floor"
  }));
  scene.tiles.set("intact-tile", createDocument({
    id: "intact-tile",
    flagName: "breakableTerrain",
    flag: {enabled: true, states: ["damage.webp"], stage: 0}
  }));
  scene.lights.set("destroyed-light", createDocument({
    id: "destroyed-light",
    flagName: "visibleLight",
    flag: {destroyed: true, images: {destroyed: "broken.webp"}},
    hidden: true,
    level: "attic"
  }));
  scene.lights.set("intact-light", createDocument({
    id: "intact-light",
    flagName: "visibleLight",
    flag: {destroyed: false, images: {on: "light.webp"}}
  }));
  return scene;
}

const scene = createScene();
globalThis.canvas = {ready: true, scene};

const {
  collectResettableDestructables,
  promptResetDestructables,
  resetSceneDestructables
} = await import("../scripts/reset-destructables.js");

const targets = collectResettableDestructables(scene);
assert.deepEqual(targets.walls.map(document => document.id), ["destroyed-wall"]);
assert.deepEqual(targets.terrain.map(document => document.id), ["damaged-tile"]);
assert.deepEqual(targets.lights.map(document => document.id), ["destroyed-light"]);
assert.equal(targets.terrain[0].hidden, true, "hidden documents on another Level remain eligible");

featureSettings.enableBreakableWalls = false;
assert.equal(collectResettableDestructables(scene).walls.length, 0, "disabled feature categories are skipped");
featureSettings.enableBreakableWalls = true;

const restored = [];
const originalError = console.error;
const errors = [];
console.error = (...args) => errors.push(args);
let result;
try {
  result = await resetSceneDestructables(scene, {
    restorers: {
      walls: document => restored.push(`wall:${document.id}`),
      terrain: document => { throw new Error(`bad tile:${document.id}`); },
      lights: async document => restored.push(`light:${document.id}`)
    }
  });
} finally {
  console.error = originalError;
}
assert.deepEqual(result, {total: 3, repaired: 2, failed: 1});
assert.deepEqual(restored.sort(), ["light:destroyed-light", "wall:destroyed-wall"]);
assert.equal(errors.length, 1, "one failed repair is logged without preventing the others");
assert.match(errors[0][0], /damaged-tile/);

let confirmationOptions;
let resetCalled = false;
assert.equal(await promptResetDestructables({
  confirm: async options => {
    confirmationOptions = options;
    return false;
  },
  reset: async () => {
    resetCalled = true;
    return {total: 3, repaired: 3, failed: 0};
  }
}), null);
assert.equal(resetCalled, false, "canceling the confirmation performs no repairs");
assert.equal(confirmationOptions.window.icon, "fa-solid fa-arrow-rotate-left");
assert.match(confirmationOptions.content, /\"total\":3/);
assert.doesNotMatch(confirmationOptions.content, /without running their repair behaviors/,
  "the reset confirmation no longer describes repairs as silent");

const emptyScene = createScene({empty: true});
canvas.scene = emptyScene;
let emptyConfirmed = false;
assert.deepEqual(await promptResetDestructables({
  confirm: async () => {
    emptyConfirmed = true;
    return true;
  }
}), {repaired: 0, failed: 0});
assert.equal(emptyConfirmed, false, "an empty Scene reports immediately without a dialog");
assert.match(notifications.info.at(-1), /Notifications\.Empty/);

canvas.scene = scene;
const otherScene = createScene({empty: true});
resetCalled = false;
await promptResetDestructables({
  confirm: async () => {
    canvas.scene = otherScene;
    return true;
  },
  reset: async () => {
    resetCalled = true;
    return {total: 3, repaired: 3, failed: 0};
  }
});
assert.equal(resetCalled, false, "changing Scenes while confirming aborts the reset");
assert.match(notifications.warn.at(-1), /Notifications\.SceneChanged/);

canvas.scene = scene;
let finishConfirmation;
const pending = promptResetDestructables({
  confirm: () => new Promise(resolve => { finishConfirmation = resolve; })
});
await Promise.resolve();
assert.equal(await promptResetDestructables(), null, "a second reset cannot overlap an open confirmation");
assert.match(notifications.info.at(-1), /Notifications\.InProgress/);
finishConfirmation(false);
await pending;

let resetScene;
const completed = await promptResetDestructables({
  confirm: async () => true,
  reset: async currentScene => {
    resetScene = currentScene;
    return {total: 3, repaired: 3, failed: 0};
  }
});
assert.equal(resetScene, scene);
assert.deepEqual(completed, {total: 3, repaired: 3, failed: 0});
assert.match(notifications.info.at(-1), /Notifications\.Complete/);

const originalPromptError = console.error;
console.error = () => {};
try {
  assert.equal(await promptResetDestructables({
    confirm: async () => { throw new Error("dialog failed"); }
  }), null);
} finally {
  console.error = originalPromptError;
}
assert.match(notifications.error.at(-1), /Notifications\.Failed/);

console.log("reset destructables tests passed");
