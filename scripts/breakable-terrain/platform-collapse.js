import {getBreakableTerrainData, MODULE_ID} from "./terrain-config.js";
import {getLevelBelow, getTokenLevel} from "../levels/level-tools.js";
import {FEATURES, assertFeatureEnabled, isFeatureEnabled} from "../settings.js";

/** Resolve every assigned platform Level and its nearest Level below. */
export function getPlatformLevels(tile) {
  const scene = tile?.parent;
  const levelIds = normalizeLevelIds(tile?.levels ?? tile?._source?.levels);
  if (!levelIds.length) throw new Error(localize("Errors.PlatformLevelRequired"));
  const platformLevels = levelIds.map(id => scene?.levels?.get?.(id));
  if (platformLevels.some(level => !level)) throw new Error(localize("Errors.PlatformLevelRequired"));

  const pairs = platformLevels.map(platformLevel => ({
    platformLevel,
    lowerLevel: getLevelBelow(platformLevel, scene)
  }));
  const missing = pairs.filter(pair => !pair.lowerLevel).map(pair => pair.platformLevel.name);
  if (missing.length) {
    throw new Error(game.i18n.format(
      "THEIKS_TOOLBAG.BreakableTerrain.Platform.Errors.NoLevelBelow",
      {levels: missing.join(", ")}
    ));
  }
  return pairs;
}

/** Find Tokens on a platform and Tokens directly underneath its transformed Tile shape. */
export function getPlatformTokenContext(tile) {
  const levelPairs = getPlatformLevels(tile);
  const pairsByPlatformId = new Map(levelPairs.map(pair => [pair.platformLevel.id, pair]));
  const tokens = getSceneTokens(tile.parent);
  const inside = tokens.filter(token => isTokenInsideTile(token, tile));
  const fallTargets = new Map();
  const candidates = inside.filter(token => {
    const pair = pairsByPlatformId.get(getTokenLevel(token, tile.parent)?.id);
    if (!pair) return false;
    fallTargets.set(token.id, pair.lowerLevel);
    return true;
  });
  const candidateIds = new Set(candidates.map(token => token.id));
  const lowerLevelIds = new Set(levelPairs.map(pair => pair.lowerLevel.id));
  return {
    levelPairs,
    fallTargets,
    candidates,
    underneath: inside.filter(token => !candidateIds.has(token.id)
      && lowerLevelIds.has(getTokenLevel(token, tile.parent)?.id))
  };
}

/** Prompt the GM to select which currently qualifying platform Tokens should fall. */
export async function promptPlatformCollapse(tile) {
  assertFeatureEnabled(FEATURES.levelTools);
  const context = getPlatformTokenContext(tile);
  const tokenList = context.candidates.length
    ? context.levelPairs.map(({platformLevel, lowerLevel}) => {
      const tokens = context.candidates.filter(token => getTokenLevel(token, tile.parent)?.id === platformLevel.id);
      if (!tokens.length) return "";
      return `<fieldset class="platform-level-group">
        <legend>${escapeHTML(platformLevel.name)} → ${escapeHTML(lowerLevel.name)}</legend>
        ${tokens.map(token => `<label class="checkbox">
          <input type="checkbox" name="tokenId" value="${escapeHTML(token.id)}" checked>
          ${escapeHTML(token.name)}
        </label>`).join("")}
      </fieldset>`;
    }).join("")
    : `<p><em>${localize("Dialog.NoCandidates")}</em></p>`;
  const underneathList = context.underneath.length
    ? `<ul>${context.underneath.map(token => `<li>${escapeHTML(token.name)} (${escapeHTML(
      getTokenLevel(token, tile.parent)?.name
    )})</li>`).join("")}</ul>`
    : `<p><em>${localize("Dialog.NoUnderneath")}</em></p>`;

  const selectedTokenIds = await foundry.applications.api.DialogV2.wait({
    window: {
      title: localize("Dialog.Title"),
      icon: "fa-solid fa-person-falling-burst"
    },
    content: `<div class="theiks-toolbag platform-collapse-dialog">
      <p>${game.i18n.format("THEIKS_TOOLBAG.BreakableTerrain.Platform.Dialog.Prompt", {
        tile: escapeHTML(tile.name)
      })}</p>
      <hr>
      <h3>${localize("Dialog.SelectTokens")}</h3>
      <div class="platform-token-list">${tokenList}</div>
      <hr>
      <h3>${localize("Dialog.Underneath")}</h3>
      ${underneathList}
    </div>`,
    buttons: [{
      action: "collapse",
      label: localize("Dialog.Collapse"),
      icon: "fa-solid fa-hammer",
      callback: (_event, button) => Array.from(
        button.form.querySelectorAll('input[name="tokenId"]:checked'),
        input => input.value
      )
    }, {
      action: "cancel",
      label: "COMMON.Cancel",
      icon: "fa-solid fa-xmark",
      default: true
    }],
    rejectClose: false,
    modal: true
  });

  if (!Array.isArray(selectedTokenIds)) return null;
  return {
    levelPairs: context.levelPairs.map(pair => ({
      platformLevelId: pair.platformLevel.id,
      lowerLevelId: pair.lowerLevel.id
    })),
    selectedTokens: selectedTokenIds.map(id => {
      const token = context.candidates.find(candidate => candidate.id === id);
      const platformLevelId = token ? getTokenLevel(token, tile.parent)?.id : null;
      return token && platformLevelId ? {tokenId: token.id, platformLevelId} : null;
    }).filter(Boolean)
  };
}

/** Ensure the platform geometry chosen before an asynchronous dialog or texture load is still authoritative. */
export function validatePlatformCollapsePlan(tile, plan) {
  assertFeatureEnabled(FEATURES.levelTools);
  if (!plan) throw new Error(localize("Errors.PlatformStateChanged"));
  const currentPairs = getPlatformLevels(tile).map(pair => ({
    platformLevelId: pair.platformLevel.id,
    lowerLevelId: pair.lowerLevel.id
  }));
  if (!sameLevelPairs(currentPairs, plan.levelPairs)) {
    throw new Error(localize("Errors.PlatformStateChanged"));
  }
}

/** Move the still-qualifying chosen Tokens and emit one combined platform-collapse Chat message. */
export async function completePlatformCollapse(tile, plan) {
  validatePlatformCollapsePlan(tile, plan);
  const context = getPlatformTokenContext(tile);
  const selectedOrigins = new Map((plan.selectedTokens ?? [])
    .map(selection => [selection.tokenId, selection.platformLevelId]));
  const candidates = context.candidates.filter(token => selectedOrigins.get(token.id)
    === getTokenLevel(token, tile.parent)?.id);

  const results = await Promise.allSettled(candidates.map(async token => {
    const lowerLevel = context.fallTargets.get(token.id);
    const targetElevation = Number(lowerLevel.elevation?.bottom);
    const oldElevation = Number(token?._source?.elevation ?? token.elevation ?? 0);
    const updated = await token.update({
      level: lowerLevel.id,
      elevation: targetElevation
    });
    if (!updated) throw new Error(localize("Errors.UpdateFailed"));
    return {
      token: updated,
      name: token.name,
      distance: oldElevation - targetElevation
    };
  }));

  const falls = [];
  const failed = [];
  results.forEach((result, index) => {
    if (result.status === "fulfilled") {
      if (result.value.distance > 0) falls.push(result.value);
    } else {
      failed.push(candidates[index]);
      console.error(`${MODULE_ID} | Failed to move a Token during platform collapse`, result.reason);
    }
  });

  if (failed.length) {
    ui.notifications.error(game.i18n.format(
      "THEIKS_TOOLBAG.BreakableTerrain.Platform.Errors.TokenMoveFailed",
      {names: failed.map(token => token.name).join(", ")}
    ));
  }

  if (isFeatureEnabled(FEATURES.fallingMessages)) {
    try {
      await createPlatformCollapseMessage(tile, falls, context.underneath);
    } catch (error) {
      ui.notifications.error(localize("Errors.ChatFailed"));
      console.error(`${MODULE_ID} | Failed to create the platform-collapse Chat message`, error);
    }
  }
  return {falls, failed};
}

function isTokenInsideTile(token, tile) {
  const point = getTokenCenter(token, tile.parent);
  if (!point) return false;
  try {
    if (typeof tile.shape?.testPoint === "function") return tile.shape.testPoint(point);
    if (typeof tile.object?.bounds?.contains === "function") return tile.object.bounds.contains(point.x, point.y);
  } catch (_error) {
    return false;
  }
  return false;
}

function getTokenCenter(token, scene) {
  try {
    if (typeof token.getCenterPoint === "function") return token.getCenterPoint();
  } catch (_error) {
    // Fall back to source geometry for lightweight test doubles and partially prepared documents.
  }
  const objectCenter = token.object?.center;
  if (objectCenter) return {x: objectCenter.x, y: objectCenter.y};
  const source = token?._source ?? token;
  const gridSize = Number(scene?.grid?.size ?? canvas.grid?.size ?? 0);
  if (!(Number.isFinite(source?.x) && Number.isFinite(source?.y) && gridSize > 0)) return null;
  return {
    x: Number(source.x) + (Number(source.width ?? 1) * gridSize / 2),
    y: Number(source.y) + (Number(source.height ?? 1) * gridSize / 2)
  };
}

async function createPlatformCollapseMessage(tile, falls, underneath) {
  const configuredMessage = getBreakableTerrainData(tile).platformMessage;
  const collapseContent = configuredMessage ? `<p>${escapeHTML(configuredMessage)}</p>` : "";
  const fallContent = falls.length
    ? `<ul>${falls.map(({name, distance}) => `<li>${game.i18n.format(
      "THEIKS_TOOLBAG.BreakableTerrain.Platform.Chat.Fell",
      {name: escapeHTML(name), distance: formatElevation(distance)}
    )}</li>`).join("")}</ul>`
    : `<p><em>${localize("Chat.NoFalls")}</em></p>`;
  const underneathContent = underneath.length
    ? `<ul>${underneath.map(token => `<li>${game.i18n.format(
      "THEIKS_TOOLBAG.BreakableTerrain.Platform.Chat.Caught",
      {name: escapeHTML(token.name)}
    )}</li>`).join("")}</ul>`
    : `<p><em>${localize("Chat.NoUnderneath")}</em></p>`;

  await ChatMessage.create({
    content: `<div class="theiks-toolbag platform-collapse-message">
      <h2><i class="fa-solid fa-person-falling-burst"></i> ${localize("Chat.Title")}</h2>
      ${collapseContent}
      <h3>${localize("Chat.Falls")}</h3>
      ${fallContent}
      <h3>${localize("Chat.Underneath")}</h3>
      ${underneathContent}
    </div>`
  });
}

function getSceneTokens(scene) {
  if (!scene?.tokens) return [];
  return scene.tokens.contents ?? Array.from(scene.tokens.values?.() ?? scene.tokens);
}

function normalizeLevelIds(levels) {
  if (!levels) return [];
  try {
    return Array.from(levels)
      .map(level => level?.id ?? level?._id ?? level)
      .filter(value => value != null && value !== "")
      .map(String);
  } catch (_error) {
    return [];
  }
}

function sameLevelPairs(left, right) {
  if (!Array.isArray(right) || left.length !== right.length) return false;
  const expected = new Map(right.map(pair => [pair.platformLevelId, pair.lowerLevelId]));
  return left.every(pair => expected.get(pair.platformLevelId) === pair.lowerLevelId);
}

function escapeHTML(value) {
  return foundry.utils.escapeHTML(String(value ?? ""));
}

function formatElevation(value) {
  const number = Number(value);
  return Number.isFinite(number) ? String(number) : "?";
}

function localize(key) {
  return game.i18n.localize(`THEIKS_TOOLBAG.BreakableTerrain.Platform.${key}`);
}
