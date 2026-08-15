import {
  MODULE_ID,
  TERRAIN_FIELDS,
  authorizeTerrainTransition,
  getBreakableTerrainData,
  getTerrainKey,
  revokeTerrainTransition
} from "./terrain-config.js";
import {prepareTerrainTexture} from "./terrain-edges.js";
import {FEATURES, assertFeatureEnabled, isFeatureEnabled} from "../settings.js";
import {
  completePlatformCollapse,
  promptPlatformCollapse,
  validatePlatformCollapsePlan
} from "./platform-collapse.js";
import {queueEventBehaviors} from "../script-events.js";

const inProgress = new Set();
let transitionSequence = 0;

/**
 * Advance a destroyable Tile by exactly one configured image state.
 *
 * @param {TileDocument} tile
 * @returns {Promise<TileDocument|null>}
 */
export async function advanceTerrainDestruction(tile) {
  validateTile(tile);
  const initial = getBreakableTerrainData(tile);
  if (!initial.enabled) throw new Error(localize("Errors.NotDestroyable"));
  if (!initial.states.length) throw new Error(localize("Errors.StateRequired"));
  if (!initial.canAdvance) throw new Error(localize("Errors.FullyDestroyed"));

  const key = getTerrainKey(tile);
  if (inProgress.has(key)) throw new Error(localize("Errors.InProgress"));
  inProgress.add(key);
  try {
    const initialSrc = getTextureSrc(tile);
    const targetStage = initial.stage + 1;
    const targetSrc = getStateTextureSrc(initial.states[initial.stage]);
    const restoreSrc = initial.stage === 0 ? initialSrc : initial.restoreSrc;
    if (!restoreSrc) throw new Error(localize("Errors.InvalidRestore"));

    const collapsesPlatform = initial.platform
      && targetStage >= initial.states.length
      && isFeatureEnabled(FEATURES.levelTools);
    const platformPlan = collapsesPlatform ? await promptPlatformCollapse(tile) : null;
    if (collapsesPlatform && !platformPlan) return null;

    if (targetSrc) {
      await prepareTerrainTexture(targetSrc, {extractAlpha: targetStage < initial.states.length});
    }

    validateTile(tile);
    const current = getBreakableTerrainData(tile);
    if (!current.enabled
      || current.stage !== initial.stage
      || current.platform !== initial.platform
      || !sameStates(current.states, initial.states)
      || getTextureSrc(tile) !== initialSrc
      || current.restoreSrc !== initial.restoreSrc) {
      throw new Error(localize("Errors.StateChanged"));
    }
    if (platformPlan) validatePlatformCollapsePlan(tile, platformPlan);
    const previous = getTerrainEventState(tile, current);

    const nonce = createNonce();
    const updateOptions = authorizeTerrainTransition(tile, nonce);
    try {
      const updated = await tile.update({
        "texture.src": targetSrc,
        [TERRAIN_FIELDS.stage]: targetStage,
        [TERRAIN_FIELDS.restoreSrc]: restoreSrc
      }, updateOptions);
      if (!updated) throw new Error(localize("Errors.UpdateFailed"));
      if (platformPlan) {
        try {
          await completePlatformCollapse(updated, platformPlan);
        } catch (error) {
          ui.notifications.error(error.message);
          console.error(`${MODULE_ID} | Platform collapse follow-up failed after terrain destruction`, error);
        }
      }
      const destroyed = targetStage >= initial.states.length;
      queueEventBehaviors({
        behaviors: getBreakableTerrainData(updated).behaviors,
        document: updated,
        alias: "tile",
        name: destroyed ? "destroyed" : "damaged",
        previous,
        current: getTerrainEventState(updated)
      });
      return updated;
    } finally {
      revokeTerrainTransition(tile, nonce);
    }
  } finally {
    inProgress.delete(key);
  }
}

/**
 * Move a damaged Tile back by exactly one stage, restoring the original image at stage zero.
 *
 * @param {TileDocument} tile
 * @returns {Promise<TileDocument>}
 */
export async function retreatTerrainDestruction(tile) {
  validateTile(tile);
  const initial = getBreakableTerrainData(tile);
  if (!initial.damaged) throw new Error(localize("Errors.NotDamaged"));
  if (!initial.restoreSrc) throw new Error(localize("Errors.InvalidRestore"));

  const key = getTerrainKey(tile);
  if (inProgress.has(key)) throw new Error(localize("Errors.InProgress"));
  inProgress.add(key);
  try {
    const initialSrc = getTextureSrc(tile);
    const targetStage = initial.stage - 1;
    const targetSrc = targetStage === 0
      ? initial.restoreSrc
      : getStateTextureSrc(initial.states[targetStage - 1]);
    if (targetSrc) await prepareTerrainTexture(targetSrc);

    validateTile(tile);
    const current = getBreakableTerrainData(tile);
    if (current.stage !== initial.stage
      || !sameStates(current.states, initial.states)
      || current.restoreSrc !== initial.restoreSrc
      || getTextureSrc(tile) !== initialSrc) {
      throw new Error(localize("Errors.StateChanged"));
    }

    const previous = getTerrainEventState(tile, current);
    const nonce = createNonce();
    const updateOptions = authorizeTerrainTransition(tile, nonce);
    try {
      const updated = await tile.update({
        "texture.src": targetSrc,
        [TERRAIN_FIELDS.stage]: targetStage,
        [TERRAIN_FIELDS.restoreSrc]: targetStage === 0 ? null : initial.restoreSrc
      }, updateOptions);
      if (!updated) throw new Error(localize("Errors.UpdateFailed"));
      const repaired = targetStage === 0;
      queueEventBehaviors({
        behaviors: getBreakableTerrainData(updated).behaviors,
        document: updated,
        alias: "tile",
        name: repaired ? "repaired" : "repairedPartial",
        previous,
        current: getTerrainEventState(updated)
      });
      return updated;
    } finally {
      revokeTerrainTransition(tile, nonce);
    }
  } finally {
    inProgress.delete(key);
  }
}

/**
 * Restore a damaged Tile to the exact image captured at its first damage transition.
 *
 * @param {TileDocument} tile
 * @returns {Promise<TileDocument>}
 */
export async function restoreTerrain(tile) {
  return await restoreTerrainState(tile, {emitBehaviors: true});
}

/** Restore damaged terrain without emitting Toolbag repair behaviors. */
export async function restoreTerrainSilently(tile) {
  return await restoreTerrainState(tile, {emitBehaviors: false});
}

/** Restore damaged terrain to its exact original texture and stage. */
async function restoreTerrainState(tile, {emitBehaviors}) {
  validateTile(tile);
  const initial = getBreakableTerrainData(tile);
  if (!initial.damaged) throw new Error(localize("Errors.NotDamaged"));
  if (!initial.restoreSrc) throw new Error(localize("Errors.InvalidRestore"));

  const key = getTerrainKey(tile);
  if (inProgress.has(key)) throw new Error(localize("Errors.InProgress"));
  inProgress.add(key);
  try {
    const initialSrc = getTextureSrc(tile);
    const targetSrc = initial.restoreSrc;
    await prepareTerrainTexture(targetSrc);

    validateTile(tile);
    const current = getBreakableTerrainData(tile);
    if (current.stage !== initial.stage
      || current.restoreSrc !== targetSrc
      || getTextureSrc(tile) !== initialSrc) {
      throw new Error(localize("Errors.StateChanged"));
    }

    const previous = getTerrainEventState(tile, current);
    const nonce = createNonce();
    const updateOptions = authorizeTerrainTransition(tile, nonce);
    try {
      const updated = await tile.update({
        "texture.src": targetSrc,
        [TERRAIN_FIELDS.stage]: 0,
        [TERRAIN_FIELDS.restoreSrc]: null
      }, updateOptions);
      if (!updated) throw new Error(localize("Errors.UpdateFailed"));
      if (emitBehaviors) {
        queueEventBehaviors({
          behaviors: getBreakableTerrainData(updated).behaviors,
          document: updated,
          alias: "tile",
          name: "repaired",
          previous,
          current: getTerrainEventState(updated)
        });
      }
      return updated;
    } finally {
      revokeTerrainTransition(tile, nonce);
    }
  } finally {
    inProgress.delete(key);
  }
}

/** Create the stable terrain-state snapshot supplied to event scripts. */
export function getTerrainEventState(tile, data = getBreakableTerrainData(tile)) {
  return {
    stage: data.stage,
    damaged: data.damaged,
    fullyDestroyed: data.fullyDestroyed,
    textureSrc: getTextureSrc(tile)
  };
}

function validateTile(tile) {
  assertFeatureEnabled(FEATURES.breakableTerrain);
  if (!game.user?.isGM) throw new Error(localize("Errors.GmOnly"));
  if (tile?.documentName !== "Tile") throw new Error(localize("Errors.InvalidTile"));
  if (!canvas.ready || !canvas.scene || tile.parent !== canvas.scene || canvas.scene.tiles.get(tile.id) !== tile) {
    throw new Error(localize("Errors.TileUnavailable"));
  }
}

function getTextureSrc(tile) {
  return tile?._source?.texture?.src ?? tile?.texture?.src ?? null;
}

function getStateTextureSrc(state) {
  return state || null;
}

function sameStates(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function createNonce() {
  return `${game.user?.id ?? "gm"}:${Date.now()}:${++transitionSequence}`;
}

function localize(key) {
  return game.i18n.localize(`THEIKS_TOOLBAG.BreakableTerrain.${key}`);
}
