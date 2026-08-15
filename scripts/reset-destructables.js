import {getBreakableWallData} from "./breakable-walls/wall-config.js";
import {repairWall} from "./breakable-walls/wall-destruction.js";
import {getBreakableTerrainData} from "./breakable-terrain/terrain-config.js";
import {restoreTerrain} from "./breakable-terrain/terrain-destruction.js";
import {getVisibleLightData} from "./visible-lights/light-config.js";
import {repairVisibleLight} from "./visible-lights/light-controls.js";
import {FEATURES, isFeatureEnabled} from "./settings.js";

const MODULE_ID = "theiks-toolbag";
const RESET_ICON = "fa-solid fa-arrow-rotate-left";

const DEFAULT_RESTORERS = Object.freeze({
  walls: repairWall,
  terrain: restoreTerrain,
  lights: repairVisibleLight
});

let resetInProgress = false;

/** Prompt the GM before repairing every damaged destructable in the active Scene. */
export async function promptResetDestructables({
  confirm = options => foundry.applications.api.DialogV2.confirm(options),
  reset = resetSceneDestructables
} = {}) {
  if (!game.user?.isGM) return null;
  if (resetInProgress) {
    ui.notifications.info(localize("Notifications.InProgress"));
    return null;
  }

  const scene = globalThis.canvas?.ready ? canvas.scene : null;
  if (!scene) {
    ui.notifications.warn(localize("Notifications.SceneUnavailable"));
    return null;
  }

  const initial = collectResettableDestructables(scene);
  if (!countTargets(initial)) {
    ui.notifications.info(localize("Notifications.Empty"));
    return {repaired: 0, failed: 0};
  }

  resetInProgress = true;
  try {
    const confirmed = await confirm({
      window: {
        title: localize("Dialog.Title"),
        icon: RESET_ICON
      },
      content: `<p>${format("Dialog.Content", getTargetCounts(initial))}</p>`,
      yes: {
        label: localize("Dialog.Confirm"),
        icon: RESET_ICON
      },
      rejectClose: false
    });
    if (!confirmed) return null;

    if (!canvas.ready || canvas.scene !== scene) {
      ui.notifications.warn(localize("Notifications.SceneChanged"));
      return null;
    }

    const result = await reset(scene);
    if (!result.total) {
      ui.notifications.info(localize("Notifications.Empty"));
    } else if (result.failed) {
      ui.notifications.warn(format("Notifications.Partial", result));
    } else {
      ui.notifications.info(format("Notifications.Complete", result));
    }
    return result;
  } catch (error) {
    ui.notifications.error(localize("Notifications.Failed"));
    console.error(`${MODULE_ID} | Failed to reset Scene destructables`, error);
    return null;
  } finally {
    resetInProgress = false;
  }
}

/**
 * Repair all currently damaged destructables in one Scene, including their configured Toolbag behaviors.
 * Each document is independent so one invalid restore does not prevent the remaining repairs.
 */
export async function resetSceneDestructables(scene, {restorers = DEFAULT_RESTORERS} = {}) {
  const targets = collectResettableDestructables(scene);
  const operations = [
    ...targets.walls.map(document => ({kind: "Wall", document, restore: restorers.walls})),
    ...targets.terrain.map(document => ({kind: "Tile", document, restore: restorers.terrain})),
    ...targets.lights.map(document => ({kind: "AmbientLight", document, restore: restorers.lights}))
  ];
  const settled = await Promise.allSettled(operations.map(operation => (
    Promise.resolve().then(() => operation.restore(operation.document))
  )));
  let repaired = 0;
  let failed = 0;
  settled.forEach((result, index) => {
    if (result.status === "fulfilled") {
      repaired += 1;
      return;
    }
    failed += 1;
    const operation = operations[index];
    console.error(
      `${MODULE_ID} | Failed to reset ${operation.kind} `
      + `${operation.document?.uuid ?? operation.document?.id ?? "unknown"}`,
      result.reason
    );
  });
  return {total: operations.length, repaired, failed};
}

/** Collect damaged documents from the full Scene, including hidden and other-Level documents. */
export function collectResettableDestructables(scene) {
  return {
    walls: isFeatureEnabled(FEATURES.breakableWalls)
      ? collectionContents(scene?.walls).filter(wall => getBreakableWallData(wall).destroyed)
      : [],
    terrain: isFeatureEnabled(FEATURES.breakableTerrain)
      ? collectionContents(scene?.tiles).filter(tile => getBreakableTerrainData(tile).damaged)
      : [],
    lights: isFeatureEnabled(FEATURES.visibleLights)
      ? collectionContents(scene?.lights).filter(light => getVisibleLightData(light).destroyed)
      : []
  };
}

function collectionContents(collection) {
  if (Array.isArray(collection?.contents)) return collection.contents;
  if (typeof collection?.values === "function") return Array.from(collection.values());
  return Array.from(collection ?? []);
}

function countTargets(targets) {
  return targets.walls.length + targets.terrain.length + targets.lights.length;
}

function getTargetCounts(targets) {
  return {
    walls: targets.walls.length,
    terrain: targets.terrain.length,
    lights: targets.lights.length,
    total: countTargets(targets)
  };
}

function localize(key) {
  return game.i18n.localize(`THEIKS_TOOLBAG.DestructionMode.Reset.${key}`);
}

function format(key, data) {
  return game.i18n.format(`THEIKS_TOOLBAG.DestructionMode.Reset.${key}`, data);
}
