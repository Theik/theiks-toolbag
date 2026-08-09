import { MODULE_ID, getBreakableWallData } from "./wall-config.js";

const DESTRUCTION_KINDS = new Set(["both", "single"]);
const DESTRUCTION_SIDES = new Set(["positive", "negative"]);
const inProgress = new Set();

/**
 * Calculate endpoint-order-independent Tile geometry for a wall segment.
 * The Tile is one wall-length wide and two wall-lengths deep.
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
 * @returns {Promise<TileDocument|null>}
 */
export async function promptWallDestruction(wall) {
  try {
    validateWall(wall);
    const data = getBreakableWallData(wall);
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

/**
 * Replace a Wall with its configured rubble Tile.
 *
 * @param {WallDocument} wall
 * @param {{kind: "both"|"single", side?: "positive"|"negative"}} options
 * @returns {Promise<TileDocument>}
 */
export async function destroyWall(wall, {kind, side} = {}) {
  validateWall(wall);
  if (!DESTRUCTION_KINDS.has(kind)) throw new Error(localize("Errors.InvalidKind"));
  if (kind === "single" && !DESTRUCTION_SIDES.has(side)) throw new Error(localize("Errors.InvalidSide"));

  const progressKey = wall.uuid;
  if (inProgress.has(progressKey)) throw new Error(localize("Errors.InProgress"));
  inProgress.add(progressKey);

  try {
    const data = getBreakableWallData(wall);
    const src = kind === "both" ? data.images.both : data.images.single;
    if (!src) throw new Error(localize(kind === "both" ? "Errors.MissingBothImage" : "Errors.MissingSingleImage"));

    const geometry = calculateRubbleGeometry(wall.c);
    const texture = await foundry.canvas.loadTexture(src);
    if (!texture) throw new Error(game.i18n.format("THEIKS_TOOLBAG.BreakableWalls.Errors.ImageLoad", {src}));

    const tileData = buildTileData(wall, geometry, {kind, side, src});
    const [tile] = await wall.parent.createEmbeddedDocuments("Tile", [tileData]);
    if (!tile) throw new Error(localize("Errors.TileCreation"));

    try {
      await wall.delete();
    } catch (error) {
      try {
        await tile.delete();
      } catch (rollbackError) {
        console.error(`${MODULE_ID} | Failed to roll back rubble Tile`, rollbackError);
      }
      throw new Error(localize("Errors.WallDeletion"), {cause: error});
    }

    return tile;
  } finally {
    inProgress.delete(progressKey);
  }
}

/**
 * Build the Foundry Tile source data for a destroyed wall.
 *
 * @param {WallDocument} wall
 * @param {ReturnType<calculateRubbleGeometry>} geometry
 * @param {{kind: "both"|"single", side?: "positive"|"negative", src: string}} destruction
 * @returns {object}
 */
function buildTileData(wall, geometry, {kind, side, src}) {
  return {
    name: localize("DestroyedTileName"),
    x: geometry.x,
    y: geometry.y,
    width: geometry.width,
    height: geometry.height,
    rotation: geometry.rotation,
    elevation: canvas.level?.elevation?.base ?? 0,
    levels: Array.from(wall.levels ?? []),
    locked: true,
    texture: {
      src,
      anchorX: 0.5,
      anchorY: 0.5,
      scaleX: 1,
      scaleY: kind === "single" && side === "negative" ? -1 : 1
    },
    flags: {
      [MODULE_ID]: {
        destroyedWall: {
          sourceWallId: wall.id,
          kind,
          side: kind === "single" ? side : null
        }
      }
    }
  };
}

/** @param {WallDocument} wall */
function validateWall(wall) {
  if (!game.user?.isGM) throw new Error(localize("Errors.GmOnly"));
  if (wall?.documentName !== "Wall") throw new Error(localize("Errors.InvalidWall"));
  if (!canvas.ready || !canvas.scene || wall.parent !== canvas.scene || canvas.scene.walls.get(wall.id) !== wall) {
    throw new Error(localize("Errors.WallUnavailable"));
  }
  if (!getBreakableWallData(wall).enabled) throw new Error(localize("Errors.NotBreakable"));
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
