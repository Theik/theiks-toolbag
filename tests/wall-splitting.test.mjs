import assert from "node:assert/strict";
import {isDeepStrictEqual} from "node:util";
import {
  calculateWallSections,
  registerWallSplitting,
  splitWallsIntoGridSections
} from "../scripts/breakable-walls/wall-splitting.js";

const MODULE_ID = "theiks-toolbag";
const FEATURE_HOOK = `${MODULE_ID}.featureSettingChanged`;

// Full grid-sized sections are followed by a shorter remainder at the stored second endpoint.
assert.deepEqual(calculateWallSections([0, 0, 250, 0], 100), [
  [0, 0, 100, 0],
  [100, 0, 200, 0],
  [200, 0, 250, 0]
]);
assert.deepEqual(calculateWallSections([0, 0, 200, 0], 100), [
  [0, 0, 100, 0],
  [100, 0, 200, 0]
], "an exact multiple does not create a zero-length remainder");
assert.deepEqual(calculateWallSections([0, 250, 0, 0], 100), [
  [0, 250, 0, 150],
  [0, 150, 0, 50],
  [0, 50, 0, 0]
], "reversed endpoint order and remainder placement are retained");
assert.deepEqual(calculateWallSections([0, 0, 300, 400], 200), [
  [0, 0, 120, 160],
  [120, 160, 240, 320],
  [240, 320, 300, 400]
]);
assert.deepEqual(calculateWallSections([4, 8, 84, 8], 100), [[4, 8, 84, 8]]);
assert.deepEqual(calculateWallSections([4, 8, 4, 8], 100), [[4, 8, 4, 8]]);

const roundedDiagonal = calculateWallSections([3, 7, 278, 196], 100);
assert.deepEqual(roundedDiagonal.at(-1).slice(2), [278, 196], "the final endpoint remains exact");
for (let index = 1; index < roundedDiagonal.length; index += 1) {
  assert.deepEqual(
    roundedDiagonal[index - 1].slice(2),
    roundedDiagonal[index].slice(0, 2),
    "rounded diagonal sections share their breakpoint"
  );
}
assert.ok(roundedDiagonal.flat().every(Number.isInteger), "every stored coordinate is an integer");

const hooks = new Map();
globalThis.Hooks = {
  on: (name, callback) => {
    const callbacks = hooks.get(name) ?? [];
    callbacks.push(callback);
    hooks.set(name, callbacks);
  }
};

const settings = {enableBreakableWalls: true};
globalThis.game = {
  activeTool: "select",
  user: {id: "gm", isGM: true},
  settings: {get: (_namespace, key) => settings[key]},
  i18n: {
    localize: key => key,
    format: (key, data) => `${key}:${JSON.stringify(data)}`
  }
};
globalThis.CONST = {GRID_TYPES: {GRIDLESS: 0}};
assert.throws(() => calculateWallSections([0, 0, 100.5, 0], 100), /InvalidCoordinates/);
assert.throws(() => calculateWallSections([0, 0, 100, 0], 0), /InvalidGrid/);

class FakeBasePlaceableHUD {
  static DEFAULT_OPTIONS = {};

  closeCount = 0;

  async close() {
    this.closeCount += 1;
  }
}

globalThis.foundry = {
  utils: {
    equals: isDeepStrictEqual,
    randomID: () => `generated-${nextWallId++}`,
    escapeHTML: value => String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
  },
  applications: {
    hud: {BasePlaceableHUD: FakeBasePlaceableHUD}
  }
};

const notifications = {error: [], info: []};
let placeablesRenderCount = 0;
let paletteRenderCount = 0;
globalThis.ui = {
  notifications: {
    error: message => notifications.error.push(message),
    info: message => notifications.info.push(message)
  },
  placeables: {render: () => { placeablesRenderCount += 1; }},
  placeablesPalette: {render: () => { paletteRenderCount += 1; }}
};

let nextWallId = 1;

function createEnvironment({gridSize = 100} = {}) {
  const operation = {
    createCalls: [],
    deleteCalls: [],
    failCreate: false,
    failDelete: false,
    failRollback: false,
    failUpdate: false,
    mutateDuringCreate: null,
    partialCreateBeforeFailure: false,
    partialUpdateBeforeFailure: false,
    updateCalls: [],
    updateGate: null,
    updateStarted: null
  };
  const walls = new Map();
  const layer = {
    controlled: [],
    get: id => walls.get(id)?.object ?? null,
    hud: null
  };
  const scene = {
    id: `scene-${nextWallId++}`,
    uuid: `Scene.scene-${nextWallId}`,
    walls,
    async createEmbeddedDocuments(type, data, options) {
      assert.equal(type, "Wall");
      assert.equal(options.keepId, true);
      operation.createCalls.push(structuredClone(data));
      if (operation.failCreate && !operation.partialCreateBeforeFailure) throw new Error("create rejected");
      const sources = operation.partialCreateBeforeFailure ? data.slice(0, 1) : data;
      const created = sources.map(source => createWall(scene, layer, {
        ...structuredClone(source)
      }));
      if (operation.failCreate) throw new Error("create rejected");
      operation.mutateDuringCreate?.();
      return created;
    },
    async updateEmbeddedDocuments(type, updates) {
      assert.equal(type, "Wall");
      operation.updateCalls.push(structuredClone(updates));
      operation.updateStarted?.();
      if (operation.updateGate) await operation.updateGate;

      const isRollback = operation.updateCalls.length > 1;
      if (isRollback && operation.failRollback) throw new Error("rollback rejected");
      if (!isRollback && operation.failUpdate) {
        if (operation.partialUpdateBeforeFailure && updates[0]) applyUpdate(walls, updates[0]);
        throw new Error("update rejected");
      }
      return updates.map(update => applyUpdate(walls, update));
    },
    async deleteEmbeddedDocuments(type, ids) {
      assert.equal(type, "Wall");
      operation.deleteCalls.push([...ids]);
      if (operation.failDelete) throw new Error("delete rejected");
      return ids.map(id => {
        const wall = walls.get(id);
        walls.delete(id);
        return wall;
      }).filter(Boolean);
    }
  };
  globalThis.canvas = {
    ready: true,
    scene,
    walls: layer,
    grid: {type: 1},
    dimensions: {size: gridSize}
  };
  return {layer, operation, scene, walls};
}

function createWall(scene, layer, source, {controlled = false} = {}) {
  const data = {
    _id: source._id ?? `wall-${nextWallId++}`,
    c: source.c ?? [0, 0, 250, 0],
    levels: source.levels ?? ["upper"],
    light: source.light ?? 1,
    move: source.move ?? 1,
    sight: source.sight ?? 1,
    sound: source.sound ?? 1,
    dir: source.dir ?? 2,
    door: source.door ?? 1,
    ds: source.ds ?? 2,
    doorSound: source.doorSound ?? "stone",
    threshold: source.threshold ?? {light: null, sight: 5, sound: null, attenuation: true},
    animation: source.animation ?? {type: "swing", direction: -1},
    flags: source.flags ?? {
      [MODULE_ID]: {
        breakableWall: {
          enabled: true,
          destroyed: true,
          destruction: {kind: "both", side: null},
          behaviors: [{
            id: "wall-events",
            type: "executeScript",
            name: "Wall events",
            disabled: false,
            events: ["destroyed", "repaired"],
            source: "await Promise.resolve();"
          }],
          scripts: {destroyed: "destroyed();", repaired: "repaired();"},
          restore: {light: 1, sight: 1, sound: 1, move: 1, door: 1, ds: 2}
        }
      },
      external: {value: "preserved"}
    }
  };
  const wall = {
    documentName: "Wall",
    id: data._id,
    c: data.c,
    parent: scene,
    toObject: () => structuredClone(data),
    clone: overrides => {
      const cloned = structuredClone(data);
      delete cloned._id;
      Object.assign(cloned, structuredClone(overrides));
      return {toObject: () => structuredClone(cloned)};
    }
  };
  wall.object = {
    controlled,
    document: wall,
    control: options => {
      assert.equal(options.releaseOthers, false);
      wall.object.controlled = true;
      if (!layer.controlled.includes(wall.object)) layer.controlled.push(wall.object);
    }
  };
  scene.walls.set(wall.id, wall);
  if (controlled) layer.controlled.push(wall.object);
  return wall;
}

function applyUpdate(walls, update) {
  const wall = walls.get(update._id);
  if (!wall) throw new Error(`missing wall ${update._id}`);
  if (update.c) {
    const source = wall.toObject();
    source.c = [...update.c];
    wall.c = source.c;
    wall.toObject = () => structuredClone(source);
    wall.clone = overrides => {
      const cloned = structuredClone(source);
      delete cloned._id;
      Object.assign(cloned, structuredClone(overrides));
      return {toObject: () => structuredClone(cloned)};
    };
  }
  return wall;
}

// Splitting retains original IDs, clones complete Wall data, batches writes, and selects every result.
let environment = createEnvironment();
const original = createWall(environment.scene, environment.layer, {_id: "original", c: [0, 0, 250, 0]}, {controlled: true});
const short = createWall(environment.scene, environment.layer, {_id: "short", c: [0, 0, 80, 0]}, {controlled: true});
const sourceBeforeSplit = original.toObject();
const result = await splitWallsIntoGridSections([original.object, short, original]);
assert.equal(result.splitWallCount, 1);
assert.equal(result.sectionCount, 3);
assert.equal(result.walls.length, 4);
assert.deepEqual(original.c, [0, 0, 100, 0]);
assert.equal(environment.operation.createCalls.length, 1);
assert.equal(environment.operation.createCalls[0].length, 2);
assert.equal(environment.operation.updateCalls.length, 1);
assert.deepEqual(environment.operation.updateCalls[0], [{_id: "original", c: [0, 0, 100, 0]}]);

const createdWalls = Array.from(environment.walls.values()).filter(wall => wall.id.startsWith("generated-"));
assert.deepEqual(createdWalls.map(wall => wall.c), [
  [100, 0, 200, 0],
  [200, 0, 250, 0]
]);
for (const wall of createdWalls) {
  const source = wall.toObject();
  for (const field of ["levels", "light", "move", "sight", "sound", "dir", "door", "ds", "doorSound", "threshold", "animation", "flags"]) {
    assert.deepEqual(source[field], sourceBeforeSplit[field], `${field} is cloned onto every new section`);
  }
  assert.equal(wall.object.controlled, true, "newly created sections are selected");
}
assert.equal(short.object.controlled, true, "unchanged selected walls remain selected");
assert.equal(placeablesRenderCount, 1);
assert.equal(paletteRenderCount, 1);

// Walls of one grid unit or less are a no-op and make no database calls.
environment = createEnvironment();
const alreadySized = createWall(environment.scene, environment.layer, {_id: "already", c: [0, 0, 100, 0]}, {controlled: true});
const noOp = await splitWallsIntoGridSections([alreadySized]);
assert.equal(noOp.splitWallCount, 0);
assert.equal(noOp.sectionCount, 0);
assert.equal(environment.operation.createCalls.length, 0);
assert.equal(environment.operation.updateCalls.length, 0);

// Creation failure leaves the original Wall entirely untouched.
environment = createEnvironment();
const createFailure = createWall(environment.scene, environment.layer, {_id: "create-failure", c: [0, 0, 250, 0]}, {controlled: true});
environment.operation.failCreate = true;
await assert.rejects(() => splitWallsIntoGridSections([createFailure]), /CreateFailed/);
assert.deepEqual(createFailure.c, [0, 0, 250, 0]);
assert.equal(environment.walls.size, 1);
assert.equal(environment.operation.updateCalls.length, 0);
assert.equal(environment.operation.deleteCalls.length, 0);

// Known IDs allow a partially completed create to be cleaned up even when Foundry rejects the batch.
environment = createEnvironment();
const partialCreateFailure = createWall(environment.scene, environment.layer, {_id: "partial-create-failure", c: [0, 0, 250, 0]}, {controlled: true});
environment.operation.failCreate = true;
environment.operation.partialCreateBeforeFailure = true;
await assert.rejects(() => splitWallsIntoGridSections([partialCreateFailure]), /CreateFailed/);
assert.deepEqual(partialCreateFailure.c, [0, 0, 250, 0]);
assert.equal(environment.walls.size, 1);
assert.equal(environment.operation.updateCalls.length, 0);
assert.equal(environment.operation.deleteCalls.length, 1);
assert.equal(environment.operation.deleteCalls[0].length, 1);

// Update failure restores original geometry and removes every clone.
environment = createEnvironment();
const updateFailure = createWall(environment.scene, environment.layer, {_id: "update-failure", c: [0, 0, 250, 0]}, {controlled: true});
environment.operation.failUpdate = true;
environment.operation.partialUpdateBeforeFailure = true;
await assert.rejects(() => splitWallsIntoGridSections([updateFailure]), /UpdateFailed/);
assert.deepEqual(updateFailure.c, [0, 0, 250, 0]);
assert.equal(environment.walls.size, 1, "created sections are deleted after restoration");
assert.equal(environment.operation.updateCalls.length, 2, "a failed update is followed by coordinate restoration");
assert.equal(environment.operation.deleteCalls.length, 1);

// If original geometry cannot be restored, clones are deliberately retained to avoid losing coverage.
environment = createEnvironment();
const rollbackFailure = createWall(environment.scene, environment.layer, {_id: "rollback-failure", c: [0, 0, 250, 0]}, {controlled: true});
environment.operation.failUpdate = true;
environment.operation.partialUpdateBeforeFailure = true;
environment.operation.failRollback = true;
await assert.rejects(() => splitWallsIntoGridSections([rollbackFailure]), /RollbackFailed/);
assert.deepEqual(rollbackFailure.c, [0, 0, 100, 0]);
assert.equal(environment.walls.size, 3, "clones remain when removing them could create a gap");
assert.equal(environment.operation.deleteCalls.length, 0);

// A concurrent split of the same Scene is rejected while the first operation is unresolved.
environment = createEnvironment();
const concurrent = createWall(environment.scene, environment.layer, {_id: "concurrent", c: [0, 0, 250, 0]}, {controlled: true});
let releaseUpdate;
environment.operation.updateGate = new Promise(resolve => { releaseUpdate = resolve; });
let updateStarted;
const started = new Promise(resolve => { updateStarted = resolve; });
environment.operation.updateStarted = updateStarted;
const pending = splitWallsIntoGridSections([concurrent]);
await started;
await assert.rejects(() => splitWallsIntoGridSections([concurrent]), /InProgress/);
releaseUpdate();
await pending;

// Environment guards reject without writes.
environment = createEnvironment();
const guarded = createWall(environment.scene, environment.layer, {_id: "guarded", c: [0, 0, 250, 0]}, {controlled: true});
canvas.grid.type = CONST.GRID_TYPES.GRIDLESS;
await assert.rejects(() => splitWallsIntoGridSections([guarded]), /Gridless/);
canvas.grid.type = 1;
game.user.isGM = false;
await assert.rejects(() => splitWallsIntoGridSections([guarded]), /GmOnly/);
game.user.isGM = true;
settings.enableBreakableWalls = false;
await assert.rejects(() => splitWallsIntoGridSections([guarded]), /Settings\.Disabled/);
settings.enableBreakableWalls = true;
const unavailable = createWall(environment.scene, environment.layer, {_id: "unavailable", c: [0, 0, 250, 0]});
environment.walls.delete(unavailable.id);
await assert.rejects(() => splitWallsIntoGridSections([unavailable]), /WallUnavailable/);
assert.equal(environment.operation.createCalls.length, 0);
assert.equal(environment.operation.updateCalls.length, 0);

// A state change during clone creation aborts before original coordinates are changed and removes clones.
environment = createEnvironment();
const racing = createWall(environment.scene, environment.layer, {_id: "racing", c: [0, 0, 250, 0]}, {controlled: true});
environment.operation.mutateDuringCreate = () => { racing.c = [0, 0, 300, 0]; };
await assert.rejects(() => splitWallsIntoGridSections([racing]), /StateChanged/);
assert.equal(environment.walls.size, 1);
assert.equal(environment.operation.updateCalls.length, 0);
assert.equal(environment.operation.deleteCalls.length, 1);

// The Wall HUD attaches only in the supported environment and its hammer uses the full controlled selection.
environment = createEnvironment();
const hudWall = createWall(environment.scene, environment.layer, {_id: "hud-wall", c: [0, 0, 250, 0]}, {controlled: true});
const secondHudWall = createWall(environment.scene, environment.layer, {_id: "hud-wall-2", c: [0, 0, 180, 0]}, {controlled: true});
registerWallSplitting();
assert.equal(hooks.get("canvasReady")?.length, 1);
assert.equal(hooks.get("canvasTearDown")?.length, 1);
assert.equal(hooks.get(FEATURE_HOOK)?.length, 1);
hooks.get("canvasReady")[0]();
const hud = canvas.walls.hud;
assert.ok(hud instanceof FakeBasePlaceableHUD);
const html = await hud._renderHTML();
assert.match(html, /fa-hammer/);
assert.match(html, /Split\.Hud\.Title/);

let prevented = false;
let stopped = false;
const target = {disabled: false};
const splitAction = hud.constructor.DEFAULT_OPTIONS.actions.split;
await splitAction.call(hud, {
  preventDefault: () => { prevented = true; },
  stopPropagation: () => { stopped = true; }
}, target);
assert.equal(prevented, true);
assert.equal(stopped, true);
assert.equal(target.disabled, true);
assert.equal(hud.closeCount, 1);
assert.match(notifications.info.at(-1), /Complete/);
assert.deepEqual(environment.operation.updateCalls[0], [
  {_id: hudWall.id, c: [0, 0, 100, 0]},
  {_id: secondHudWall.id, c: [0, 0, 100, 0]}
], "the hammer splits every controlled Wall in one operation");
assert.equal(environment.layer.controlled[0].document, hudWall);
assert.equal(environment.layer.controlled[1].document, secondHudWall);

settings.enableBreakableWalls = false;
hooks.get(FEATURE_HOOK)[0]("breakableWalls", false);
assert.equal(Object.hasOwn(canvas.walls, "hud"), false, "disabling the feature detaches the HUD");
settings.enableBreakableWalls = true;
canvas.grid.type = CONST.GRID_TYPES.GRIDLESS;
hooks.get("canvasReady")[0]();
assert.equal(Object.hasOwn(canvas.walls, "hud"), false, "gridless Scenes do not receive a Wall HUD");
canvas.grid.type = 1;
game.user.isGM = false;
hooks.get("canvasReady")[0]();
assert.equal(Object.hasOwn(canvas.walls, "hud"), false, "players do not receive a Wall HUD");
game.user.isGM = true;
hooks.get("canvasTearDown")[0]();

console.log("wall splitting tests passed");
