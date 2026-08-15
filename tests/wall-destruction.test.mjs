import assert from "node:assert/strict";
import {
  destroyWall,
  registerBreakableWallState,
  repairWall,
  toggleWall
} from "../scripts/breakable-walls/wall-destruction.js";
import { getBreakableWallData } from "../scripts/breakable-walls/wall-config.js";

const MODULE_ID = "theiks-toolbag";
const FLAG = "breakableWall";
const FLAG_ROOT = `flags.${MODULE_ID}.${FLAG}`;
const DESTROYED_FIELD = `${FLAG_ROOT}.destroyed`;
const DESTRUCTION_FIELD = `${FLAG_ROOT}.destruction`;
const RESTORE_FIELD = `${FLAG_ROOT}.restore`;
const NONE = 0;
const featureSettings = {enableBreakableWalls: true};
const ORIGINAL_STATE = {
  light: 11,
  sight: 12,
  sound: 13,
  move: 14,
  door: 15,
  ds: 16
};

const hookHandlers = new Map();
globalThis.Hooks = {
  on: (name, callback) => {
    const handlers = hookHandlers.get(name) ?? [];
    handlers.push(callback);
    hookHandlers.set(name, handlers);
  }
};

globalThis.CONST = {
  EDGE_SENSE_TYPES: {NONE},
  WALL_MOVEMENT_TYPES: {NONE},
  WALL_DOOR_TYPES: {NONE}
};

globalThis.game = {
  user: {id: "gm", active: true, isGM: true},
  users: null,
  settings: {get: (_namespace, key) => featureSettings[key]},
  i18n: {
    localize: key => key,
    format: (key, data) => `${key}:${JSON.stringify(data)}`
  }
};
game.users = {activeGM: game.user};

globalThis.canvas = {
  ready: true,
  scene: null,
  walls: {get: () => null}
};

let loadTexture = async src => src ? {src} : null;
globalThis.foundry = {
  canvas: {
    loadTexture: (...args) => loadTexture(...args)
  },
  applications: {
    api: {
      DialogV2: {wait: async () => "cancel"}
    }
  }
};

globalThis.ui = {
  notifications: {
    error: () => {}
  }
};

registerBreakableWallState();

function clone(value) {
  return structuredClone(value);
}

function applyFlagChange(flag, path, value) {
  const suffix = path.slice(`${FLAG_ROOT}.`.length);
  const parts = suffix.split(".");
  let target = flag;
  for (const part of parts.slice(0, -1)) {
    if (!target[part] || typeof target[part] !== "object") target[part] = {};
    target = target[part];
  }
  target[parts.at(-1)] = clone(value);
}

function applyNestedFlagChanges(flag, changes) {
  const nested = changes.flags?.[MODULE_ID]?.[FLAG];
  if (!nested) return;
  for (const [key, value] of Object.entries(nested)) flag[key] = clone(value);
}

function createWall({
  id,
  coordinates = [0, 0, 125, 0],
  images = {both: "both.png", single: "single.png"},
  enabled = true,
  destroyed = false,
  destruction = null,
  restore = null,
  scripts = {},
  mechanicalState = ORIGINAL_STATE,
  updateResult = true,
  updateGate = null
} = {}) {
  const state = {
    embeddedDocumentCalls: 0,
    deleteCalls: 0,
    released: false,
    updateCalls: []
  };
  const flag = {enabled, images: clone(images), destroyed, destruction, restore, scripts: clone(scripts)};
  const scene = {
    id: "scene",
    walls: new Map(),
    createEmbeddedDocuments: async () => {
      state.embeddedDocumentCalls += 1;
      throw new Error("destroyWall must not create embedded documents");
    }
  };
  const wall = {
    documentName: "Wall",
    id,
    uuid: `Scene.scene.Wall.${id}`,
    c: coordinates,
    parent: scene,
    object: {
      controlled: true,
      release: () => {
        state.released = true;
      }
    },
    _source: clone(mechanicalState),
    ...clone(mechanicalState),
    getFlag: () => flag,
    delete: async () => {
      state.deleteCalls += 1;
      throw new Error("destroyWall must not delete the Wall");
    },
    update: async (changes, options = {}) => {
      for (const callback of hookHandlers.get("preUpdateWall") ?? []) {
        callback(wall, changes, options, game.user.id);
      }
      state.updateCalls.push(clone(changes));
      if (updateGate) await updateGate;
      if (!updateResult) return null;

      for (const [path, value] of Object.entries(changes)) {
        if (path.startsWith(`${FLAG_ROOT}.`)) applyFlagChange(flag, path, value);
        else if (["light", "sight", "sound", "move", "door", "ds"].includes(path)) {
          wall[path] = value;
          wall._source[path] = value;
        }
      }
      applyNestedFlagChanges(flag, changes);
      for (const callback of hookHandlers.get("updateWall") ?? []) void callback(wall, changes, {}, game.user.id);
      return wall;
    }
  };
  scene.walls.set(id, wall);
  canvas.scene = scene;
  return {flag, scene, state, wall};
}

// Flag normalization remains backward-compatible and rejects partial restoration snapshots.
assert.deepEqual(getBreakableWallData({
  getFlag: () => ({enabled: true, images: {both: "both.png"}})
}), {
  enabled: true,
  images: {both: "both.png", single: ""},
  behaviors: [],
  scripts: {destroyed: "", repaired: ""},
  destroyed: false,
  destruction: null,
  restore: null
});
assert.deepEqual(getBreakableWallData({
  getFlag: () => ({
    destroyed: true,
    destruction: {kind: "both", side: "negative"},
    restore: ORIGINAL_STATE
  })
}).destruction, {kind: "both", side: null});
assert.equal(getBreakableWallData({
  getFlag: () => ({restore: {...ORIGINAL_STATE, ds: undefined}})
}).restore, null);

// Destruction is one update on the same Wall and snapshots every exact special value.
const both = createWall({id: "both"});
const originalId = both.wall.id;
const bothResult = await destroyWall(both.wall, {kind: "both"});
assert.equal(bothResult, both.wall);
assert.equal(both.wall.id, originalId);
assert.equal(both.state.updateCalls.length, 1);
assert.equal(both.state.embeddedDocumentCalls, 0);
assert.equal(both.state.deleteCalls, 0);
assert.equal(both.state.released, true);
assert.deepEqual(both.flag.restore, ORIGINAL_STATE);
assert.deepEqual(both.flag.destruction, {kind: "both", side: null});
assert.equal(both.flag.destroyed, true);
for (const field of ["light", "sight", "sound", "move", "door"]) assert.equal(both.wall[field], NONE);
assert.equal(both.wall.ds, ORIGINAL_STATE.ds, "door state is retained but inert while door type is NONE");

// Repair works after disabling the breakable setting and restores every field exactly.
both.flag.enabled = false;
const repaired = await repairWall(both.wall);
assert.equal(repaired, both.wall);
assert.deepEqual(Object.fromEntries(Object.keys(ORIGINAL_STATE).map(field => [field, both.wall[field]])), ORIGINAL_STATE);
assert.equal(both.flag.destroyed, false);
assert.equal(both.flag.destruction, null);
assert.equal(both.flag.restore, null);
assert.equal(both.state.updateCalls.length, 2);

// Single-sided choices are persisted for the sprite renderer without changing geometry or identity.
const single = createWall({id: "single", coordinates: [0, 125, 0, 0]});
await destroyWall(single.wall, {kind: "single", side: "negative"});
assert.deepEqual(single.flag.destruction, {kind: "single", side: "negative"});
assert.equal(single.wall.c[1], 125);

// toggleWall repairs immediately and prompts only when an intact call omits artwork options.
const toggleRepair = await toggleWall(single.wall);
assert.equal(toggleRepair, single.wall);
assert.equal(single.flag.destroyed, false);

const prompted = createWall({id: "prompted"});
foundry.applications.api.DialogV2.wait = async () => "both";
assert.equal(await toggleWall(prompted.wall), prompted.wall);
assert.equal(prompted.flag.destroyed, true);

// Repair authorization belongs to one update operation, not every update on that wall while its
// database request is pending.
let finishRepair;
const repairGate = new Promise(resolve => {
  finishRepair = resolve;
});
const guardedRepair = createWall({
  id: "guarded-repair",
  enabled: false,
  destroyed: true,
  destruction: {kind: "both", side: null},
  restore: ORIGINAL_STATE,
  mechanicalState: {light: 0, sight: 0, sound: 0, move: 0, door: 0, ds: ORIGINAL_STATE.ds},
  updateGate: repairGate
});
const pendingRepair = repairWall(guardedRepair.wall);
await Promise.resolve();
const spoofedRepair = {[DESTROYED_FIELD]: false, move: 99};
for (const callback of hookHandlers.get("preUpdateWall") ?? []) {
  callback(guardedRepair.wall, spoofedRepair, {}, game.user.id);
}
assert.equal(spoofedRepair[DESTROYED_FIELD], true);
assert.equal(spoofedRepair.move, NONE);
finishRepair();
await pendingRepair;

// Invalid options and unavailable artwork fail before any Scene mutation.
const invalidSide = createWall({id: "invalid-side"});
await assert.rejects(() => destroyWall(invalidSide.wall, {kind: "single", side: "elsewhere"}), /InvalidSide/);
assert.equal(invalidSide.state.updateCalls.length, 0);

const missingImage = createWall({id: "missing", images: {both: "", single: ""}});
await assert.rejects(() => destroyWall(missingImage.wall, {kind: "both"}), /MissingBothImage/);
assert.equal(missingImage.state.updateCalls.length, 0);

const zeroLength = createWall({id: "zero", coordinates: [5, 5, 5, 5]});
let textureCalls = 0;
loadTexture = async src => {
  textureCalls += 1;
  return {src};
};
await assert.rejects(() => destroyWall(zeroLength.wall, {kind: "both"}), /ZeroLength/);
assert.equal(textureCalls, 0);
assert.equal(zeroLength.state.updateCalls.length, 0);

const textureFailure = createWall({id: "texture-failure"});
loadTexture = async () => null;
await assert.rejects(() => destroyWall(textureFailure.wall, {kind: "both"}), /ImageLoad/);
assert.equal(textureFailure.state.updateCalls.length, 0);
loadTexture = async src => ({src});

// State changes which arrive during texture loading are not overwritten.
let finishTexture;
loadTexture = () => new Promise(resolve => {
  finishTexture = resolve;
});
const stateRace = createWall({id: "state-race"});
const racingDestruction = destroyWall(stateRace.wall, {kind: "both"});
await Promise.resolve();
stateRace.flag.images.both = "replacement.png";
finishTexture({src: "both.png"});
await assert.rejects(() => racingDestruction, /StateChanged/);
assert.equal(stateRace.state.updateCalls.length, 0);
loadTexture = async src => ({src});

// A wall moved to zero length during texture loading is not disabled without renderable geometry.
let finishMovedTexture;
loadTexture = () => new Promise(resolve => {
  finishMovedTexture = resolve;
});
const movedToZero = createWall({id: "moved-to-zero"});
const movedDestruction = destroyWall(movedToZero.wall, {kind: "both"});
await Promise.resolve();
movedToZero.wall.c = [5, 5, 5, 5];
finishMovedTexture({src: "both.png"});
await assert.rejects(() => movedDestruction, /ZeroLength/);
assert.equal(movedToZero.state.updateCalls.length, 0);
loadTexture = async src => ({src});

// A second local operation is rejected while the first update is unresolved.
let finishUpdate;
const updateGate = new Promise(resolve => {
  finishUpdate = resolve;
});
const concurrent = createWall({id: "concurrent", updateGate});
const firstUpdate = destroyWall(concurrent.wall, {kind: "both"});
await Promise.resolve();
await Promise.resolve();
await assert.rejects(() => destroyWall(concurrent.wall, {kind: "both"}), /InProgress/);
finishUpdate();
await firstUpdate;

// Corrupt snapshots are never guessed, and intact walls cannot be repaired.
const corrupt = createWall({
  id: "corrupt",
  enabled: false,
  destroyed: true,
  destruction: {kind: "both", side: null},
  restore: {...ORIGINAL_STATE, door: undefined},
  mechanicalState: {light: 0, sight: 0, sound: 0, move: 0, door: 0, ds: 0}
});
await assert.rejects(() => repairWall(corrupt.wall), /InvalidRestore/);
assert.equal(corrupt.state.updateCalls.length, 0);

const intact = createWall({id: "intact"});
await assert.rejects(() => repairWall(intact.wall), /NotDestroyed/);

const alreadyDestroyed = createWall({
  id: "already-destroyed",
  destroyed: true,
  destruction: {kind: "both", side: null},
  restore: ORIGINAL_STATE,
  mechanicalState: {light: 0, sight: 0, sound: 0, move: 0, door: 0, ds: ORIGINAL_STATE.ds}
});
await assert.rejects(() => destroyWall(alreadyDestroyed.wall, {kind: "both"}), /AlreadyDestroyed/);

// A failed Foundry update is surfaced, leaves the source untouched, and releases the progress lock.
delete globalThis.__failedWallEvent;
const failedUpdate = createWall({
  id: "failed-update",
  updateResult: false,
  scripts: {destroyed: "globalThis.__failedWallEvent = true;"}
});
await assert.rejects(() => destroyWall(failedUpdate.wall, {kind: "both"}), /UpdateFailed/);
await assert.rejects(() => destroyWall(failedUpdate.wall, {kind: "both"}), /UpdateFailed/);
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(globalThis.__failedWallEvent, undefined, "failed wall updates emit no scripts");
assert.equal(failedUpdate.flag.destroyed, false);

// Direct edits cannot clear the canonical state or re-enable mechanics outside repairWall.
const guarded = createWall({
  id: "guarded",
  enabled: false,
  destroyed: true,
  destruction: {kind: "both", side: null},
  restore: ORIGINAL_STATE,
  mechanicalState: {light: 0, sight: 0, sound: 0, move: 0, door: 0, ds: ORIGINAL_STATE.ds}
});
const unauthorizedChanges = {
  [DESTROYED_FIELD]: false,
  move: 99,
  sight: 99,
  light: 99,
  sound: 99,
  door: 99
};
for (const callback of hookHandlers.get("preUpdateWall") ?? []) callback(guarded.wall, unauthorizedChanges);
assert.equal(unauthorizedChanges[DESTROYED_FIELD], true);
for (const field of ["light", "sight", "sound", "move", "door"]) assert.equal(unauthorizedChanges[field], NONE);

const replacementChanges = {flags: {[MODULE_ID]: {[FLAG]: {enabled: false, images: {both: "", single: ""}}}}};
for (const callback of hookHandlers.get("preUpdateWall") ?? []) callback(guarded.wall, replacementChanges);
assert.equal(replacementChanges.flags[MODULE_ID][FLAG].destroyed, true);
assert.deepEqual(replacementChanges.flags[MODULE_ID][FLAG].destruction, guarded.flag.destruction);
assert.deepEqual(replacementChanges.flags[MODULE_ID][FLAG].restore, ORIGINAL_STATE);

const flattenedReplacement = {
  [FLAG_ROOT]: {
    enabled: false,
    destroyed: false,
    destruction: null,
    restore: null
  }
};
for (const callback of hookHandlers.get("preUpdateWall") ?? []) callback(guarded.wall, flattenedReplacement);
assert.equal(flattenedReplacement[FLAG_ROOT].destroyed, true);
assert.deepEqual(flattenedReplacement[FLAG_ROOT].destruction, guarded.flag.destruction);
assert.deepEqual(flattenedReplacement[FLAG_ROOT].restore, ORIGINAL_STATE);

// Direct nested flag activation receives a complete repair snapshot and native NONE values.
const direct = createWall({id: "direct"});
const directChanges = {flags: {[MODULE_ID]: {[FLAG]: {destroyed: true}}}};
for (const callback of hookHandlers.get("preUpdateWall") ?? []) callback(direct.wall, directChanges);
assert.deepEqual(directChanges.flags[MODULE_ID][FLAG].restore, ORIGINAL_STATE);
for (const field of ["light", "sight", "sound", "move", "door"]) assert.equal(directChanges[field], NONE);

// The active GM reconciles source data which was imported or raced into an inconsistent state.
const inconsistent = createWall({
  id: "inconsistent",
  destroyed: true,
  destruction: {kind: "both", side: null},
  restore: ORIGINAL_STATE,
  mechanicalState: ORIGINAL_STATE
});
for (const callback of hookHandlers.get("updateWall") ?? []) await callback(inconsistent.wall, {}, {}, game.user.id);
assert.equal(inconsistent.state.updateCalls.length, 1);
for (const field of ["light", "sight", "sound", "move", "door"]) assert.equal(inconsistent.wall[field], NONE);

// If a later pre-update hook overrides the first destruction update, reconciliation waits for the
// transition lock to clear and then restores the canonical NONE fields.
let overrideInitialDestruction = true;
hookHandlers.get("preUpdateWall").push((wall, changes) => {
  if (wall.id !== "late-hook" || !overrideInitialDestruction) return;
  overrideInitialDestruction = false;
  changes.move = 99;
});
const lateHook = createWall({id: "late-hook"});
await destroyWall(lateHook.wall, {kind: "both"});
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(lateHook.wall.move, NONE);
assert.equal(lateHook.state.updateCalls.length, 2, "a deferred reconciliation follows the overridden transition");

// A local control-release failure cannot turn a completed document update into a failed destroy call.
const releaseFailure = createWall({id: "release-failure"});
releaseFailure.wall.object.release = () => {
  throw new Error("placeable already disposed");
};
const originalWarn = console.warn;
let releaseWarning = "";
console.warn = message => {
  releaseWarning = message;
};
try {
  assert.equal(await destroyWall(releaseFailure.wall, {kind: "both"}), releaseFailure.wall);
} finally {
  console.warn = originalWarn;
}
assert.equal(releaseFailure.flag.destroyed, true);
assert.match(releaseWarning, /Failed to release/);

globalThis.__wallEvents = [];
const recordWallEvent = `globalThis.__wallEvents.push({
  name: event.name,
  previous: event.data.previous.destroyed,
  current: event.data.current.destroyed,
  alias: wall === document,
  user: event.user.id
});`;
const eventWall = createWall({
  id: "events",
  scripts: {destroyed: recordWallEvent, repaired: recordWallEvent}
});
await destroyWall(eventWall.wall, {kind: "both"});
await repairWall(eventWall.wall);
await new Promise(resolve => setTimeout(resolve, 0));
assert.deepEqual(globalThis.__wallEvents, [
  {name: "destroyed", previous: false, current: true, alias: true, user: "gm"},
  {name: "repaired", previous: true, current: false, alias: true, user: "gm"}
]);

game.user.isGM = false;
const nonGm = createWall({id: "non-gm"});
await assert.rejects(() => destroyWall(nonGm.wall, {kind: "both"}), /GmOnly/);
assert.equal(nonGm.state.updateCalls.length, 0);

featureSettings.enableBreakableWalls = false;
game.user.isGM = true;
const disabled = createWall({id: "disabled"});
await assert.rejects(
  () => destroyWall(disabled.wall, {kind: "both"}),
  /Settings\.Disabled/,
  "configured walls cannot be destroyed through the public API while the feature is disabled"
);
assert.equal(disabled.state.updateCalls.length, 0);

console.log("wall destruction tests passed");
