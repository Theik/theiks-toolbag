import {
  BREAKABLE_WALL_FLAG,
  MODULE_ID,
  getBreakableWallData
} from "./wall-config.js";
import {
  FEATURES,
  FEATURE_SETTING_CHANGED_HOOK,
  assertFeatureEnabled,
  isFeatureEnabled
} from "../settings.js";
import {queueEventBehaviors} from "../script-events.js";

const DESTRUCTION_KINDS = new Set(["both", "single"]);
const DESTRUCTION_SIDES = new Set(["positive", "negative"]);
const RESTORE_FIELDS = ["light", "sight", "sound", "move", "door", "ds"];
const FLAG_ROOT = `flags.${MODULE_ID}.${BREAKABLE_WALL_FLAG}`;
const DESTROYED_FIELD = `${FLAG_ROOT}.destroyed`;
const DESTRUCTION_FIELD = `${FLAG_ROOT}.destruction`;
const RESTORE_FIELD = `${FLAG_ROOT}.restore`;
const REPAIR_NONCE_OPTION = "theiksToolbagRepairNonce";
const inProgress = new Set();
const repairAuthorizations = new Map();
const reconciliationInProgress = new Set();
const reconciliationQueued = new Set();
let repairSequence = 0;

/** Register invariants and active-GM reconciliation for reversible destroyed walls. */
export function registerBreakableWallState() {
  Hooks.on("preUpdateWall", keepDestroyedWallDisabled);
  Hooks.on("canvasReady", reconcileCurrentScene);
  Hooks.on("createWall", reconcileChangedWall);
  Hooks.on("updateWall", reconcileChangedWall);
  Hooks.on(FEATURE_SETTING_CHANGED_HOOK, (feature, enabled) => {
    if (feature === FEATURES.breakableWalls && enabled) void reconcileCurrentScene();
  });
}

/**
 * Calculate endpoint-order-independent rubble-art geometry for a wall segment.
 * The artwork is one wall-length wide and two wall-lengths deep.
 *
 * @param {number[]} coordinates Wall coordinates in [x1, y1, x2, y2] order.
 * @returns {{x: number, y: number, width: number, height: number, rotation: number,
 *   positiveNormal: {x: number, y: number}, negativeNormal: {x: number, y: number}}}
 */
export function calculateRubbleGeometry(coordinates) {
  const [x1, y1, x2, y2] = coordinates;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const length = Math.hypot(dx, dy);
  if (!Number.isFinite(length) || length <= 0) {
    throw new Error(localize("Errors.ZeroLength"));
  }

  let rotation = Math.atan2(dy, dx) * 180 / Math.PI;
  rotation = ((rotation % 180) + 180) % 180;
  if (Math.abs(rotation - 180) < Number.EPSILON) rotation = 0;

  const radians = rotation * Math.PI / 180;
  const positiveNormal = {x: -Math.sin(radians), y: Math.cos(radians)};

  return {
    x: Math.round((x1 + x2) / 2),
    y: Math.round((y1 + y2) / 2),
    width: Math.max(1, Math.round(length)),
    height: Math.max(1, Math.round(length * 2)),
    rotation,
    positiveNormal,
    negativeNormal: {x: -positiveNormal.x, y: -positiveNormal.y}
  };
}

/**
 * Prompt for a destruction type and destroy the selected Wall if confirmed.
 *
 * @param {WallDocument} wall
 * @returns {Promise<WallDocument|null>}
 */
export async function promptWallDestruction(wall) {
  try {
    const data = validateDestroyableWall(wall);
    const geometry = calculateRubbleGeometry(wall.c);
    const buttons = [];

    if (data.images.both) {
      buttons.push({
        action: "both",
        label: "THEIKS_TOOLBAG.BreakableWalls.Dialog.Both",
        icon: "fa-solid fa-burst"
      });
    }

    if (data.images.single) {
      const positive = directionButton(geometry.positiveNormal);
      const negative = directionButton(geometry.negativeNormal);
      buttons.push({
        action: "single-positive",
        label: game.i18n.format("THEIKS_TOOLBAG.BreakableWalls.Dialog.Toward", {direction: positive.label}),
        icon: positive.icon
      }, {
        action: "single-negative",
        label: game.i18n.format("THEIKS_TOOLBAG.BreakableWalls.Dialog.Toward", {direction: negative.label}),
        icon: negative.icon
      });
    }

    if (!buttons.length) throw new Error(localize("Errors.NoImages"));
    buttons.push({
      action: "cancel",
      label: "COMMON.Cancel",
      icon: "fa-solid fa-xmark"
    });

    const choice = await foundry.applications.api.DialogV2.wait({
      window: {
        title: localize("Dialog.Title"),
        icon: "fa-solid fa-hammer"
      },
      content: `<p>${localize("Dialog.Prompt")}</p>`,
      buttons
    });

    if (!choice || choice === "cancel") return null;
    if (choice === "both") return await destroyWall(wall, {kind: "both"});
    const side = choice === "single-positive" ? "positive" : "negative";
    return await destroyWall(wall, {kind: "single", side});
  } catch (error) {
    ui.notifications.error(error.message);
    console.error(`${MODULE_ID} | Wall destruction failed`, error);
    return null;
  }
}

/** Destroy an intact Wall immediately using one uniformly random valid artwork direction. */
export async function quickDestroyWall(wall, {random = Math.random} = {}) {
  const data = validateDestroyableWall(wall);
  const choices = [];
  if (data.images.both) choices.push({kind: "both"});
  if (data.images.single) {
    choices.push(
      {kind: "single", side: "positive"},
      {kind: "single", side: "negative"}
    );
  }
  if (!choices.length) throw new Error(localize("Errors.NoImages"));

  const rolled = Number(random());
  const bounded = Number.isFinite(rolled)
    ? Math.min(Math.max(rolled, 0), 1 - Number.EPSILON)
    : 0;
  return await destroyWall(wall, choices[Math.floor(bounded * choices.length)]);
}

/**
 * Disable a Wall while retaining its document and exact repair state.
 *
 * @param {WallDocument} wall
 * @param {{kind: "both"|"single", side?: "positive"|"negative"}} options
 * @returns {Promise<WallDocument>}
 */
export async function destroyWall(wall, {kind, side} = {}) {
  const data = validateDestroyableWall(wall);
  if (!DESTRUCTION_KINDS.has(kind)) throw new Error(localize("Errors.InvalidKind"));
  if (kind === "single" && !DESTRUCTION_SIDES.has(side)) throw new Error(localize("Errors.InvalidSide"));

  const progressKey = getProgressKey(wall);
  if (inProgress.has(progressKey)) throw new Error(localize("Errors.InProgress"));
  inProgress.add(progressKey);

  try {
    const src = kind === "both" ? data.images.both : data.images.single;
    if (!src) throw new Error(localize(kind === "both" ? "Errors.MissingBothImage" : "Errors.MissingSingleImage"));

    calculateRubbleGeometry(wall.c);
    const texture = await foundry.canvas.loadTexture(src);
    if (!texture) throw new Error(game.i18n.format("THEIKS_TOOLBAG.BreakableWalls.Errors.ImageLoad", {src}));

    // Texture loading yields to other clients. Do not overwrite a destruction or configuration
    // change which arrived while this operation was waiting.
    const currentData = validateDestroyableWall(wall);
    const currentSrc = kind === "both" ? currentData.images.both : currentData.images.single;
    if (currentSrc !== src) throw new Error(localize("Errors.StateChanged"));
    calculateRubbleGeometry(wall.c);
    const previous = getWallEventState(wall, currentData);

    const updated = await wall.update({
      [DESTROYED_FIELD]: true,
      [DESTRUCTION_FIELD]: {
        kind,
        side: kind === "single" ? side : null
      },
      [RESTORE_FIELD]: snapshotWallState(wall),
      ...getDisabledWallChanges()
    });
    if (!updated) throw new Error(localize("Errors.UpdateFailed"));

    releaseWall(wall);
    queueEventBehaviors({
      behaviors: getBreakableWallData(updated).behaviors,
      document: updated,
      alias: "wall",
      name: "destroyed",
      previous,
      current: getWallEventState(updated)
    });
    return updated;
  } finally {
    inProgress.delete(progressKey);
  }
}

/**
 * Restore a destroyed Wall's exact saved mechanical state.
 *
 * @param {WallDocument} wall
 * @returns {Promise<WallDocument>}
 */
export async function repairWall(wall) {
  return await repairWallState(wall, {emitBehaviors: true});
}

/** Restore a destroyed Wall without emitting Toolbag repair behaviors. */
export async function repairWallSilently(wall) {
  return await repairWallState(wall, {emitBehaviors: false});
}

/** Restore a destroyed Wall's exact saved mechanical state. */
async function repairWallState(wall, {emitBehaviors}) {
  const data = validateDestroyedWall(wall);
  if (!data.restore) throw new Error(localize("Errors.InvalidRestore"));

  const progressKey = getProgressKey(wall);
  if (inProgress.has(progressKey)) throw new Error(localize("Errors.InProgress"));
  inProgress.add(progressKey);
  const repairNonce = `${game.user?.id ?? "gm"}:${Date.now()}:${++repairSequence}`;
  repairAuthorizations.set(progressKey, repairNonce);

  try {
    const previous = getWallEventState(wall, data);
    const updated = await wall.update({
      ...data.restore,
      [DESTROYED_FIELD]: false,
      [DESTRUCTION_FIELD]: null,
      [RESTORE_FIELD]: null
    }, {[REPAIR_NONCE_OPTION]: repairNonce});
    if (!updated) throw new Error(localize("Errors.UpdateFailed"));
    if (emitBehaviors) {
      queueEventBehaviors({
        behaviors: getBreakableWallData(updated).behaviors,
        document: updated,
        alias: "wall",
        name: "repaired",
        previous,
        current: getWallEventState(updated)
      });
    }
    return updated;
  } finally {
    repairAuthorizations.delete(progressKey);
    inProgress.delete(progressKey);
  }
}

/**
 * Repair a destroyed wall, destroy an intact wall with explicit options, or prompt for artwork.
 *
 * @param {WallDocument} wall
 * @param {{kind?: "both"|"single", side?: "positive"|"negative"}} [options]
 * @returns {Promise<WallDocument|null>}
 */
export async function toggleWall(wall, options = {}) {
  validateWall(wall);
  if (getBreakableWallData(wall).destroyed) return await repairWall(wall);
  if (options?.kind) return await destroyWall(wall, options);
  return await promptWallDestruction(wall);
}

/** Create the stable wall-state snapshot supplied to event scripts. */
export function getWallEventState(wall, data = getBreakableWallData(wall)) {
  return {
    destroyed: data.destroyed,
    destruction: data.destruction,
    light: wall?.light,
    sight: wall?.sight,
    sound: wall?.sound,
    move: wall?.move,
    door: wall?.door,
    ds: wall?.ds
  };
}

/** @param {WallDocument} wall */
function validateWall(wall) {
  assertFeatureEnabled(FEATURES.breakableWalls);
  if (!game.user?.isGM) throw new Error(localize("Errors.GmOnly"));
  if (wall?.documentName !== "Wall") throw new Error(localize("Errors.InvalidWall"));
  if (!canvas.ready || !canvas.scene || wall.parent !== canvas.scene || canvas.scene.walls.get(wall.id) !== wall) {
    throw new Error(localize("Errors.WallUnavailable"));
  }
}

/** Validate a new destruction operation and return normalized flag data. */
function validateDestroyableWall(wall) {
  validateWall(wall);
  const data = getBreakableWallData(wall);
  if (data.destroyed) throw new Error(localize("Errors.AlreadyDestroyed"));
  if (!data.enabled) throw new Error(localize("Errors.NotBreakable"));
  return data;
}

/** Validate a repair operation and return normalized flag data. */
function validateDestroyedWall(wall) {
  validateWall(wall);
  const data = getBreakableWallData(wall);
  if (!data.destroyed) throw new Error(localize("Errors.NotDestroyed"));
  return data;
}

/** Capture only the authoritative fields which destruction temporarily overrides. */
function snapshotWallState(wall) {
  const source = wall._source ?? wall;
  const restore = Object.fromEntries(RESTORE_FIELDS.map(field => [field, source[field] ?? wall[field]]));
  if (!RESTORE_FIELDS.every(field => Number.isInteger(restore[field]))) {
    throw new Error(localize("Errors.InvalidRestore"));
  }
  return restore;
}

/** Return Foundry's native nonblocking values for every affected Wall subsystem. */
function getDisabledWallChanges() {
  return {
    light: CONST.EDGE_SENSE_TYPES.NONE,
    sight: CONST.EDGE_SENSE_TYPES.NONE,
    sound: CONST.EDGE_SENSE_TYPES.NONE,
    move: CONST.WALL_MOVEMENT_TYPES.NONE,
    door: CONST.WALL_DOOR_TYPES.NONE
  };
}

/** Keep the destroyed flag and core nonblocking state authoritative until repairWall authorizes restoration. */
function keepDestroyedWallDisabled(wall, changes, options = {}) {
  if (!isFeatureEnabled(FEATURES.breakableWalls)) return;
  const data = getBreakableWallData(wall);
  const current = data.destroyed;
  const requested = getChangedValue(changes, DESTROYED_FIELD);
  const progressKey = getProgressKey(wall);
  const repairNonce = repairAuthorizations.get(progressKey);
  const authorizedRepair = current && requested.present && requested.value === false
    && typeof repairNonce === "string" && repairNonce === options[REPAIR_NONCE_OPTION];
  if (authorizedRepair) return;

  const willBeDestroyed = requested.present ? requested.value === true : current;
  if (!willBeDestroyed && !current) return;

  if (current) {
    preventBreakableFlagDeletion(changes);
    setChangedValue(changes, DESTROYED_FIELD, true);
    // These values are the only lossless route back to the original wall. Preserve them when a
    // whole flag object is replaced or a macro attempts to alter state outside repairWall.
    setChangedValue(changes, DESTRUCTION_FIELD, data.destruction);
    setChangedValue(changes, RESTORE_FIELD, data.restore);
  } else {
    // A direct flag update is still safe and repairable even when it bypasses the public API.
    setChangedValue(changes, RESTORE_FIELD, snapshotWallState(wall));
  }
  Object.assign(changes, getDisabledWallChanges());
}

/** Reconcile a changed wall on the active GM without allowing update-hook recursion. */
async function reconcileChangedWall(wall) {
  if (!isFeatureEnabled(FEATURES.breakableWalls)) return;
  if (!isActiveGM() || wall?.parent !== canvas.scene || canvas.scene?.walls?.get?.(wall.id) !== wall) return;
  if (!getBreakableWallData(wall).destroyed || isWallDisabled(wall)) return;

  const progressKey = getProgressKey(wall);
  if (inProgress.has(progressKey)) {
    queueWallReconciliation(wall);
    return;
  }
  if (reconciliationInProgress.has(progressKey)) return;
  reconciliationInProgress.add(progressKey);
  try {
    const updated = await wall.update(getDisabledWallChanges());
    if (!updated) throw new Error(localize("Errors.UpdateFailed"));
    if (!isWallDisabled(wall)) throw new Error(localize("Errors.UpdateFailed"));
  } catch (error) {
    console.error(`${MODULE_ID} | Failed to reconcile a destroyed wall`, error);
  } finally {
    reconciliationInProgress.delete(progressKey);
  }
}

/** Retry once the public transition lock is released if a later update hook changed the result. */
function queueWallReconciliation(wall) {
  const progressKey = getProgressKey(wall);
  if (reconciliationQueued.has(progressKey)) return;
  reconciliationQueued.add(progressKey);
  setTimeout(() => {
    reconciliationQueued.delete(progressKey);
    void reconcileChangedWall(wall);
  }, 0);
}

/** Reconcile every destroyed Wall in the current Scene when the canvas becomes ready. */
async function reconcileCurrentScene() {
  if (!isFeatureEnabled(FEATURES.breakableWalls)) return;
  if (!isActiveGM() || !canvas.ready || !canvas.scene) return;
  const walls = canvas.scene.walls?.contents ?? Array.from(canvas.scene.walls?.values?.() ?? []);
  await Promise.all(walls.map(wall => reconcileChangedWall(wall)));
}

/** @param {WallDocument} wall */
function isWallDisabled(wall) {
  const disabled = getDisabledWallChanges();
  return Object.entries(disabled).every(([field, value]) => wall[field] === value);
}

function isActiveGM() {
  if (!game.user?.isGM) return false;
  if (!game.users || !("activeGM" in game.users)) return true;
  return game.users.activeGM?.id === game.user.id;
}

/** Read either a flattened Foundry update key or its nested equivalent. */
function getChangedValue(changes, path) {
  if (Object.hasOwn(changes, path)) return {present: true, value: changes[path], flattened: true};
  const parts = path.split(".");
  for (let length = parts.length - 1; length > 0; length -= 1) {
    const prefix = parts.slice(0, length).join(".");
    if (!Object.hasOwn(changes, prefix)) continue;

    let value = changes[prefix];
    for (const part of parts.slice(length)) {
      if (!value || typeof value !== "object" || !Object.hasOwn(value, part)) {
        return {present: false, value: undefined, flattened: false};
      }
      value = value[part];
    }
    return {present: true, value, flattened: false};
  }

  let value = changes;
  for (const part of parts) {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, part)) {
      return {present: false, value: undefined, flattened: false};
    }
    value = value[part];
  }
  return {present: true, value, flattened: false};
}

/** Set a change without mixing nested and flattened representations of the same existing path. */
function setChangedValue(changes, path, value) {
  const existing = getChangedValue(changes, path);
  if (existing.flattened) {
    changes[path] = value;
    return;
  }

  const parts = path.split(".");
  for (let length = parts.length - 1; length > 0; length -= 1) {
    const prefix = parts.slice(0, length).join(".");
    if (!Object.hasOwn(changes, prefix)) continue;

    let target = changes[prefix];
    if (!target || typeof target !== "object") target = changes[prefix] = {};
    for (const part of parts.slice(length, -1)) {
      if (!target[part] || typeof target[part] !== "object") target[part] = {};
      target = target[part];
    }
    target[parts.at(-1)] = value;
    return;
  }

  if (!existing.present && !Object.hasOwn(changes, parts[0])) {
    changes[path] = value;
    return;
  }

  let target = changes;
  for (const part of parts.slice(0, -1)) {
    if (!target[part] || typeof target[part] !== "object") target[part] = {};
    target = target[part];
  }
  target[parts.at(-1)] = value;
}

/** Do not allow unsetFlag to discard the only exact repair snapshot for a destroyed wall. */
function preventBreakableFlagDeletion(changes) {
  delete changes[`flags.${MODULE_ID}.-=${BREAKABLE_WALL_FLAG}`];
  const moduleChanges = changes.flags?.[MODULE_ID];
  if (moduleChanges && typeof moduleChanges === "object") delete moduleChanges[`-=${BREAKABLE_WALL_FLAG}`];
}

/** Release a controlled wall before its native representation is hidden. */
function releaseWall(wall) {
  try {
    const placeable = wall.object ?? canvas.walls?.get?.(wall.id);
    if (placeable?.controlled) placeable.release();
  } catch (error) {
    console.warn(`${MODULE_ID} | Failed to release a destroyed wall`, error);
  }
}

/** @param {WallDocument} wall */
function getProgressKey(wall) {
  return wall.uuid ?? `${wall.parent?.id ?? "scene"}.${wall.id}`;
}

/**
 * Get the localized label and matching arrow icon for the nearest compass direction.
 *
 * @param {{x: number, y: number}} vector
 * @returns {{label: string, icon: string}}
 */
function directionButton(vector) {
  const angle = (Math.atan2(vector.y, vector.x) * 180 / Math.PI + 360) % 360;
  const directions = [
    {key: "Right", icon: "fa-solid fa-arrow-right"},
    {key: "DownRight", icon: "fa-solid fa-arrow-down-right"},
    {key: "Down", icon: "fa-solid fa-arrow-down"},
    {key: "DownLeft", icon: "fa-solid fa-arrow-down-left"},
    {key: "Left", icon: "fa-solid fa-arrow-left"},
    {key: "UpLeft", icon: "fa-solid fa-arrow-up-left"},
    {key: "Up", icon: "fa-solid fa-arrow-up"},
    {key: "UpRight", icon: "fa-solid fa-arrow-up-right"}
  ];
  const direction = directions[Math.round(angle / 45) % directions.length];
  return {
    label: localize(`Directions.${direction.key}`),
    icon: direction.icon
  };
}

/** @param {string} key */
function localize(key) {
  return game.i18n.localize(`THEIKS_TOOLBAG.BreakableWalls.${key}`);
}
