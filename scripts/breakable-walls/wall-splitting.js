import {
  FEATURES,
  FEATURE_SETTING_CHANGED_HOOK,
  assertFeatureEnabled,
  isFeatureEnabled
} from "../settings.js";

export const MODULE_ID = "theiks-toolbag";

const HUD_ID = `${MODULE_ID}-wall-split-hud`;
const splitScenes = new Set();
let attachedLayer = null;
let wallHud = null;
let WallSplitHUDClass = null;

/** Register the GM-only, grid-aware HUD used to split selected Walls. */
export function registerWallSplitting() {
  Hooks.on("canvasReady", attachWallSplitHUD);
  Hooks.on("canvasTearDown", detachWallSplitHUD);
  Hooks.on(FEATURE_SETTING_CHANGED_HOOK, (feature, enabled) => {
    if (feature !== FEATURES.breakableWalls) return;
    if (enabled) attachWallSplitHUD();
    else detachWallSplitHUD();
  });
}

/**
 * Divide a line into full grid-length sections followed by one shorter remainder.
 * Stored Wall endpoints are integers, so calculated intermediate points are rounded once and
 * then shared by their adjacent sections to prevent gaps.
 *
 * @param {number[]} coordinates Wall coordinates in [x1, y1, x2, y2] order.
 * @param {number} gridSize Grid size in canvas pixels.
 * @returns {number[][]} Coordinate arrays for the resulting Wall sections.
 */
export function calculateWallSections(coordinates, gridSize) {
  if (!Array.isArray(coordinates) || coordinates.length !== 4
    || !coordinates.every(value => Number.isFinite(value) && Number.isInteger(value))) {
    throw new Error(localize("Errors.InvalidCoordinates"));
  }
  if (!Number.isFinite(gridSize) || gridSize <= 0) {
    throw new Error(localize("Errors.InvalidGrid"));
  }

  const [x1, y1, x2, y2] = coordinates;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const length = Math.hypot(dx, dy);
  if (length <= 0 || length <= gridSize) return [[...coordinates]];

  const ratio = length / gridSize;
  const nearestInteger = Math.round(ratio);
  const segmentCount = Math.abs(ratio - nearestInteger) <= 1e-9
    ? nearestInteger
    : Math.ceil(ratio);
  const points = [[x1, y1]];

  for (let index = 1; index < segmentCount; index += 1) {
    const distance = Math.min(index * gridSize, length);
    const progress = distance / length;
    const point = [
      Math.round(x1 + (dx * progress)),
      Math.round(y1 + (dy * progress))
    ];
    if (!samePoint(point, points.at(-1))) points.push(point);
  }
  if (!samePoint(points.at(-1), [x2, y2])) points.push([x2, y2]);

  const sections = [];
  for (let index = 1; index < points.length; index += 1) {
    const [startX, startY] = points[index - 1];
    const [endX, endY] = points[index];
    if ((startX === endX) && (startY === endY)) continue;
    sections.push([startX, startY, endX, endY]);
  }
  return sections.length ? sections : [[...coordinates]];
}

/**
 * Split selected Walls into full grid-length sections and a final remainder.
 * The original document is retained as the first section so its ID and external references survive.
 *
 * @param {Iterable<WallDocument|foundry.canvas.placeables.Wall>} walls
 * @param {{gridSize?: number}} [options]
 * @returns {Promise<{walls: WallDocument[], splitWallCount: number, sectionCount: number}>}
 */
export async function splitWallsIntoGridSections(walls, {gridSize = canvas.dimensions?.size} = {}) {
  validateSplitEnvironment(gridSize);
  const scene = canvas.scene;
  const documents = normalizeWallDocuments(walls);
  if (!documents.length) throw new Error(localize("Errors.NoWallsSelected"));

  for (const wall of documents) {
    if (wall?.documentName !== "Wall" || wall.parent !== scene || scene.walls?.get?.(wall.id) !== wall) {
      throw new Error(localize("Errors.WallUnavailable"));
    }
  }

  const sceneKey = scene.uuid ?? scene.id ?? scene;
  if (splitScenes.has(sceneKey)) throw new Error(localize("Errors.InProgress"));
  splitScenes.add(sceneKey);

  try {
    const plans = documents.map(wall => {
      const source = wall.toObject();
      return {
        wall,
        source,
        originalCoordinates: [...wall.c],
        sections: calculateWallSections(wall.c, gridSize)
      };
    });
    const splitPlans = plans.filter(plan => plan.sections.length > 1);
    if (!splitPlans.length) {
      return {walls: documents, splitWallCount: 0, sectionCount: 0};
    }

    const reservedIds = new Set(scene.walls?.keys?.() ?? []);
    const createData = splitPlans.flatMap(plan => plan.sections.slice(1).map(coordinates => {
      const source = plan.wall.clone({c: coordinates}, {parent: scene}).toObject();
      source._id = createWallId(reservedIds);
      return source;
    }));
    const createdIds = createData.map(source => source._id);
    let created = [];
    let originalsMayHaveChanged = false;
    let failureKey = "Errors.CreateFailed";

    try {
      created = await scene.createEmbeddedDocuments("Wall", createData, {keepId: true});
      if (!Array.isArray(created) || created.length !== createData.length) {
        throw new Error(localize("Errors.CreateFailed"));
      }

      failureKey = "Errors.StateChanged";
      assertSplitStateUnchanged(splitPlans, scene);
      validateSplitEnvironment(gridSize);

      failureKey = "Errors.UpdateFailed";
      originalsMayHaveChanged = true;
      const updated = await scene.updateEmbeddedDocuments("Wall", splitPlans.map(plan => ({
        _id: plan.wall.id,
        c: plan.sections[0]
      })));
      if (!Array.isArray(updated) || updated.length !== splitPlans.length) {
        throw new Error(localize("Errors.UpdateFailed"));
      }
    } catch (cause) {
      created = createdIds.map(id => scene.walls?.get?.(id)).filter(Boolean);
      const rollbackErrors = await rollbackSplit({created, originalsMayHaveChanged, splitPlans, scene});
      if (rollbackErrors.length) {
        const error = new Error(localize("Errors.RollbackFailed"), {cause});
        error.rollbackErrors = rollbackErrors;
        throw error;
      }
      throw createError(failureKey, cause);
    }

    const resultingIds = new Set(documents.map(wall => wall.id));
    for (const wall of created) resultingIds.add(wall.id);
    const resultingWalls = Array.from(resultingIds, id => scene.walls?.get?.(id)).filter(Boolean);
    restoreResultSelection(resultingWalls);
    return {
      walls: resultingWalls,
      splitWallCount: splitPlans.length,
      sectionCount: splitPlans.reduce((total, plan) => total + plan.sections.length, 0)
    };
  } finally {
    splitScenes.delete(sceneKey);
  }
}

function attachWallSplitHUD() {
  if (!canAttachWallSplitHUD()) {
    detachWallSplitHUD();
    return;
  }

  const layer = canvas.walls;
  if (attachedLayer === layer && layer.hud === wallHud) return;
  detachWallSplitHUD();
  if (layer.hud) {
    console.warn(`${MODULE_ID} | A different Wall HUD is already registered; the split HUD was not attached.`);
    return;
  }

  const HudClass = getWallSplitHUDClass();
  const hud = new HudClass();
  try {
    Object.defineProperty(layer, "hud", {
      configurable: true,
      enumerable: false,
      value: hud
    });
    attachedLayer = layer;
    wallHud = hud;
  } catch (error) {
    console.error(`${MODULE_ID} | Failed to attach the Wall split HUD`, error);
  }
}

function detachWallSplitHUD() {
  if (wallHud) {
    Promise.resolve(wallHud.close?.()).catch(error => {
      console.error(`${MODULE_ID} | Failed to close the Wall split HUD`, error);
    });
  }
  if (attachedLayer && Object.hasOwn(attachedLayer, "hud") && attachedLayer.hud === wallHud) {
    delete attachedLayer.hud;
  }
  attachedLayer = null;
  wallHud = null;
}

function canAttachWallSplitHUD() {
  return !!(game.user?.isGM
    && isFeatureEnabled(FEATURES.breakableWalls)
    && canvas.ready
    && canvas.scene
    && canvas.walls
    && canvas.grid
    && canvas.grid.type !== CONST.GRID_TYPES.GRIDLESS
    && Number.isFinite(canvas.dimensions?.size)
    && canvas.dimensions.size > 0);
}

function getWallSplitHUDClass() {
  if (WallSplitHUDClass) return WallSplitHUDClass;
  const BasePlaceableHUD = foundry.applications.hud.BasePlaceableHUD;

  WallSplitHUDClass = class WallSplitHUD extends BasePlaceableHUD {
    static DEFAULT_OPTIONS = {
      id: HUD_ID,
      classes: [MODULE_ID, "wall-split-hud"],
      actions: {
        split: WallSplitHUD.#onSplit
      }
    };

    async _renderHTML() {
      const title = escapeHTML(localize("Hud.Title"));
      return `<div class="col middle">
        <button type="button" class="control-icon" data-action="split"
                data-tooltip-text="${title}" aria-label="${title}">
          <i class="fa-solid fa-hammer" inert></i>
        </button>
      </div>`;
    }

    _replaceHTML(result, content) {
      content.innerHTML = result;
    }

    static async #onSplit(event, target) {
      event.preventDefault();
      event.stopPropagation();
      target.disabled = true;
      const selected = Array.from(canvas.walls?.controlled ?? [], wall => wall.document ?? wall);
      await this.close();

      try {
        const result = await splitWallsIntoGridSections(selected);
        if (!result.splitWallCount) {
          ui.notifications.info(localize("Notifications.NothingToSplit"));
          return;
        }
        ui.notifications.info(game.i18n.format(
          "THEIKS_TOOLBAG.BreakableWalls.Split.Notifications.Complete",
          {walls: result.splitWallCount, sections: result.sectionCount}
        ));
      } catch (error) {
        ui.notifications.error(error.message);
        console.error(`${MODULE_ID} | Wall splitting failed`, error);
      }
    }
  };
  return WallSplitHUDClass;
}

function validateSplitEnvironment(gridSize) {
  assertFeatureEnabled(FEATURES.breakableWalls);
  if (!game.user?.isGM) throw new Error(localize("Errors.GmOnly"));
  if (!canvas.ready || !canvas.scene) throw new Error(localize("Errors.SceneUnavailable"));
  if (canvas.grid?.type === CONST.GRID_TYPES.GRIDLESS) throw new Error(localize("Errors.Gridless"));
  if (!Number.isFinite(gridSize) || gridSize <= 0) throw new Error(localize("Errors.InvalidGrid"));
}

function assertSplitStateUnchanged(plans, scene) {
  if (canvas.scene !== scene) throw new Error(localize("Errors.StateChanged"));
  for (const {wall, source, originalCoordinates} of plans) {
    if (wall.parent !== scene || scene.walls?.get?.(wall.id) !== wall
      || !sameCoordinates(wall.c, originalCoordinates)
      || !sameWallSource(wall, source)) {
      throw new Error(localize("Errors.StateChanged"));
    }
  }
}

async function rollbackSplit({created, originalsMayHaveChanged, splitPlans, scene}) {
  const errors = [];
  let originalsRestored = !originalsMayHaveChanged;

  if (originalsMayHaveChanged) {
    try {
      const restored = await scene.updateEmbeddedDocuments("Wall", splitPlans.map(plan => ({
        _id: plan.wall.id,
        c: plan.originalCoordinates
      })));
      originalsRestored = Array.isArray(restored) && restored.length === splitPlans.length;
      if (!originalsRestored) errors.push(new Error("Not every original Wall was restored."));
    } catch (error) {
      errors.push(error);
    }
  }

  if (created.length && originalsRestored) {
    try {
      const ids = created.map(wall => wall.id).filter(Boolean);
      const deleted = await scene.deleteEmbeddedDocuments("Wall", ids);
      if (!Array.isArray(deleted) || deleted.length !== ids.length) {
        errors.push(new Error("Not every created Wall section was removed."));
      }
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

function restoreResultSelection(walls) {
  for (const wall of walls) {
    const placeable = wall.object ?? canvas.walls?.get?.(wall.id);
    if (!placeable || placeable.controlled) continue;
    placeable.control({releaseOthers: false, renderSidebar: false});
  }
  ui.placeables?.render?.();
  if (game.activeTool === "select") ui.placeablesPalette?.render?.();
}

function normalizeWallDocuments(walls) {
  if (!walls || typeof walls[Symbol.iterator] !== "function") return [];
  const unique = new Map();
  for (const wall of walls) {
    const document = wall?.document ?? wall;
    if (document?.id) unique.set(document.id, document);
  }
  return Array.from(unique.values());
}

function createWallId(reservedIds) {
  let id;
  do id = foundry.utils.randomID();
  while (reservedIds.has(id));
  reservedIds.add(id);
  return id;
}

function sameWallSource(wall, source) {
  const current = wall.toObject();
  if (typeof foundry.utils?.equals === "function") return foundry.utils.equals(current, source);
  return sameCoordinates(current.c, source.c);
}

function sameCoordinates(left, right) {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function samePoint(left, right) {
  return left[0] === right[0] && left[1] === right[1];
}

function createError(key, cause) {
  if (cause?.message === localize(key)) return cause;
  return new Error(localize(key), {cause});
}

function escapeHTML(value) {
  return foundry.utils.escapeHTML(String(value ?? ""));
}

function localize(key) {
  return game.i18n.localize(`THEIKS_TOOLBAG.BreakableWalls.Split.${key}`);
}
