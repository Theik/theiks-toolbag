import {
  FEATURES,
  FEATURE_SETTING_CHANGED_HOOK,
  assertFeatureEnabled,
  isFeatureEnabled
} from "../settings.js";

export const MODULE_ID = "theiks-toolbag";

const HUD_CONTROL_CLASS = "theiks-toolbag-level-change";
const FALLING_INPUT_ID = "theiks-toolbag-level-falling";

/** Register the GM-only Token HUD action for native Foundry Scene Levels. */
export function registerLevelTools() {
  Hooks.on("renderTokenHUD", renderTokenLevelControl);
  Hooks.on(FEATURE_SETTING_CHANGED_HOOK, (feature, enabled) => {
    if (feature !== FEATURES.levelTools || enabled) return;
    globalThis.document?.querySelectorAll?.(`.${HUD_CONTROL_CLASS}`).forEach(element => element.remove());
  });
}

/** Return Scene Levels in their configured collection order. */
export function getSceneLevels(scene = canvas.scene) {
  if (!scene?.levels) return [];
  return scene.levels.contents ?? Array.from(scene.levels.values?.() ?? scene.levels);
}

/** Return whether a Scene has enough native Levels for movement between them. */
export function hasMultipleSceneLevels(scene = canvas.scene) {
  return getSceneLevels(scene).length > 1;
}

/** Return whether a target Level is below at least one Token's current Level. */
export function isLevelBelowSelectedTokens(targetLevel, tokens, scene = targetLevel?.parent ?? canvas.scene) {
  const targetBottom = Number(targetLevel?.elevation?.bottom);
  if (!Number.isFinite(targetBottom)) return false;
  return normalizeTokenDocuments(tokens).some(token => {
    const currentBottom = Number(getTokenLevel(token, scene)?.elevation?.bottom);
    return Number.isFinite(currentBottom) && targetBottom < currentBottom;
  });
}

/** Resolve the native Level currently occupied by a Token. */
export function getTokenLevel(token, scene) {
  const document = token?.document ?? token;
  scene ??= document?.parent ?? canvas.scene;
  if (!document || !scene?.levels) return null;
  const levelId = document?._source?.level ?? document.level;
  const explicit = levelId == null ? null : scene.levels.get?.(String(levelId));
  if (explicit) return explicit;

  const elevation = Number(document?._source?.elevation ?? document.elevation ?? 0);
  if (!Number.isFinite(elevation)) return null;
  if (scene === canvas.scene && typeof canvas.inferLevelFromElevation === "function") {
    return canvas.inferLevelFromElevation(elevation) ?? null;
  }
  return getSceneLevels(scene).find(level => elevationInLevel(elevation, level)) ?? null;
}

/** Find the nearest distinct Level completely below another Level. */
export function getLevelBelow(level, scene = level?.parent ?? canvas.scene) {
  if (!level) return null;
  const bottom = Number(level.elevation?.bottom);
  if (!Number.isFinite(bottom)) return null;
  return getSceneLevels(scene)
    .filter(candidate => candidate?.id !== level.id && Number(candidate.elevation?.top) <= bottom)
    .sort((left, right) => Number(right.elevation.top) - Number(left.elevation.top))[0] ?? null;
}

/**
 * Change a Token's elevation after its active Foundry movement completes.
 * Other clients ignore movement initiated by a different User, preventing duplicate Region-script updates.
 *
 * @param {TokenDocument|foundry.canvas.placeables.Token} token
 * @param {number|string} elevation
 * @param {boolean} [falling=false] Announce a downward change as a fall.
 * @param {boolean} [levelTransition=false] Move the Token to the native Level containing the new elevation.
 * @returns {Promise<TokenDocument|null>}
 */
export async function updateTokenElevation(token, elevation, falling = false, levelTransition = false) {
  assertFeatureEnabled(FEATURES.levelTools);
  const document = token?.document ?? token;
  const targetElevation = Number(elevation);
  if (!Number.isFinite(targetElevation)) throw new Error(localize("Errors.InvalidElevation"));
  if (document?.documentName !== "Token"
    || typeof document.update !== "function"
    || document.parent?.tokens?.get?.(document.id) !== document) {
    throw new Error(localize("Errors.TokenUnavailable"));
  }

  const movement = document.movement;
  if (movement?.id && movement.user && !movement.user.isSelf) return null;
  if (isMovementActive(movement)) {
    const completed = await movement.finished;
    if (!completed) return null;

    // Do not interrupt a new movement which began while the original movement was finishing.
    const currentMovement = document.movement;
    if (currentMovement?.id !== movement.id && isMovementActive(currentMovement)) return null;
  }

  const previousElevation = Number(document?._source?.elevation ?? document.elevation);
  if (previousElevation === targetElevation) return document;
  const changes = {elevation: targetElevation};
  const targetLevel = getLevelAtElevation(targetElevation, document.parent);
  if (isChecked(levelTransition)) {
    const currentLevel = getTokenLevel(document, document.parent);
    if (targetLevel && currentLevel?.id !== targetLevel.id) changes.level = targetLevel.id;
  }
  const updated = await document.update(changes, {animate: false});

  const fallDistance = previousElevation - targetElevation;
  if (isChecked(falling) && fallDistance > 0 && isFeatureEnabled(FEATURES.fallingMessages)) {
    if (targetLevel) await announceFalls([{name: document.name, distance: fallDistance}], targetLevel);
  }
  return updated;
}

/**
 * Prompt to move a snapshot of selected Tokens to a native Scene Level.
 *
 * @param {Iterable<TokenDocument|foundry.canvas.placeables.Token>} [tokens]
 * @returns {Promise<TokenDocument[]|null>}
 */
export async function promptTokenLevelChange(tokens) {
  try {
    validateLevelTools();
    const selected = normalizeTokenDocuments(tokens ?? canvas.tokens?.controlled ?? []);
    if (!selected.length) {
      ui.notifications.warn(localize("Errors.NoTokensSelected"));
      return null;
    }

    const levels = getSceneLevels(canvas.scene);
    if (!levels.length) {
      ui.notifications.warn(localize("Errors.NoLevels"));
      return null;
    }

    const defaultLevelId = getDefaultLevelId(selected, levels);
    const defaultLevel = levels.find(level => level.id === defaultLevelId);
    const defaultCanFall = isLevelBelowSelectedTokens(defaultLevel, selected, canvas.scene);
    const tokenNames = selected.map(token => escapeHTML(token.name)).join(", ");
    const options = levels.map(level => {
      const selectedAttribute = level.id === defaultLevelId ? " selected" : "";
      const label = `${escapeHTML(level.name)} (${formatElevation(level.elevation?.bottom)} ${localize("Dialog.To")} ${formatElevation(level.elevation?.top)})`;
      return `<option value="${escapeHTML(level.id)}"${selectedAttribute}>${label}</option>`;
    }).join("");

    const result = await foundry.applications.api.DialogV2.input({
      window: {
        title: localize("Dialog.Title"),
        icon: "fa-solid fa-ladder-water"
      },
      content: `<div class="theiks-toolbag level-change-dialog">
        <p>${localize("Dialog.SelectedTokens")}: ${tokenNames}</p>
        <div class="form-group">
          <label>${localize("Dialog.TargetLevel")}</label>
          <div class="form-fields"><select name="levelId">${options}</select></div>
        </div>
        <div class="form-group" data-role="falling-option"${defaultCanFall ? "" : " hidden"}>
          <label for="${FALLING_INPUT_ID}">${localize("Dialog.Falling")}</label>
          <div class="form-fields"><input id="${FALLING_INPUT_ID}" type="checkbox" name="falling"${defaultCanFall ? "" : " disabled"}></div>
        </div>
      </div>`,
      render: (_event, dialog) => bindFallingOption(dialog.element, selected, levels),
      ok: {
        label: localize("Dialog.Apply"),
        icon: "fa-solid fa-check"
      },
      rejectClose: false,
      modal: true
    });
    if (!result) return null;
    const targetLevel = levels.find(level => level.id === String(result.levelId ?? ""));
    const falling = isChecked(result.falling)
      && isLevelBelowSelectedTokens(targetLevel, selected, canvas.scene);
    return await changeTokenLevels(selected, {
      levelId: String(result.levelId ?? ""),
      falling
    });
  } catch (error) {
    ui.notifications.error(error.message);
    console.error(`${MODULE_ID} | Token Level change failed`, error);
    return null;
  }
}

/**
 * Move Tokens to a native Scene Level and optionally announce downward movement in one message.
 *
 * @param {Iterable<TokenDocument|foundry.canvas.placeables.Token>} tokens
 * @param {{levelId: string, falling?: boolean}} options
 * @returns {Promise<TokenDocument[]>}
 */
export async function changeTokenLevels(tokens, {levelId, falling = false} = {}) {
  validateLevelTools();
  const documents = normalizeTokenDocuments(tokens);
  if (!documents.length) throw new Error(localize("Errors.NoTokensSelected"));

  const scene = canvas.scene;
  for (const token of documents) {
    if (token?.documentName !== "Token" || token.parent !== scene || scene.tokens?.get?.(token.id) !== token) {
      throw new Error(localize("Errors.TokenUnavailable"));
    }
  }

  const targetLevel = scene.levels?.get?.(String(levelId));
  if (!targetLevel) throw new Error(localize("Errors.InvalidLevel"));
  const targetElevation = Number(targetLevel.elevation?.bottom);
  if (!Number.isFinite(targetElevation)) throw new Error(localize("Errors.InvalidLevel"));

  const previous = new Map(documents.map(token => [token.id, {
    elevation: Number(token?._source?.elevation ?? token.elevation ?? 0),
    name: token.name
  }]));
  const updates = documents.map(token => ({
    _id: token.id,
    level: targetLevel.id,
    elevation: targetElevation
  }));
  const updated = await scene.updateEmbeddedDocuments("Token", updates);
  if (!Array.isArray(updated) || updated.length !== documents.length) {
    throw new Error(localize("Errors.UpdateFailed"));
  }

  const falls = updated.map(token => {
    const before = previous.get(token.id);
    const distance = Number(before?.elevation) - targetElevation;
    return distance > 0 ? {name: before?.name ?? token.name, distance} : null;
  }).filter(Boolean);
  if (isChecked(falling) && falls.length && isFeatureEnabled(FEATURES.fallingMessages)) {
    await announceFalls(falls, targetLevel);
  }
  return updated;
}

function renderTokenLevelControl(application, element) {
  if (!game.user?.isGM || !isFeatureEnabled(FEATURES.levelTools)) return;
  if (!canvas.ready || !hasMultipleSceneLevels(canvas.scene)) return;
  if (!element || element.querySelector?.(`.${HUD_CONTROL_CLASS}`)) return;

  const nativeLevelAction = element.querySelector?.([
    '[data-action="level"]',
    '[data-action="levels"]',
    '[data-palette="level"]',
    '[data-palette="levels"]'
  ].join(", "))
    ?? element.querySelector?.(".fa-layer-group, .fa-layers")?.closest?.("button, .control-icon");
  const nativeLevelControl = nativeLevelAction?.matches?.("button, .control-icon")
    ? nativeLevelAction
    : nativeLevelAction?.closest?.("button, .control-icon");
  const column = nativeLevelControl?.parentElement
    ?? element.querySelector?.(".col.left, .controls.left, [data-side='left'], .left");
  if (!nativeLevelControl && !column) return;

  const button = globalThis.document.createElement("button");
  button.type = "button";
  button.className = `control-icon ${HUD_CONTROL_CLASS}`;
  button.dataset.tooltip = localize("Hud.Title");
  button.setAttribute("aria-label", localize("Hud.Title"));
  button.innerHTML = '<i class="fa-solid fa-ladder-water"></i>';
  button.addEventListener("click", event => {
    event.preventDefault();
    event.stopPropagation();
    const selected = Array.from(canvas.tokens?.controlled ?? [], token => token.document ?? token);
    void promptTokenLevelChange(selected);
  });
  if (nativeLevelControl?.insertAdjacentElement) nativeLevelControl.insertAdjacentElement("afterend", button);
  else column?.append(button);
  application?.setPosition?.();
}

function bindFallingOption(element, tokens, levels) {
  const select = element?.querySelector?.('[name="levelId"]');
  const group = element?.querySelector?.('[data-role="falling-option"]');
  const checkbox = group?.querySelector?.('[name="falling"]');
  if (!select || !group || !checkbox) return;

  const update = () => {
    const target = levels.find(level => level.id === String(select.value));
    const visible = isLevelBelowSelectedTokens(target, tokens, canvas.scene);
    group.hidden = !visible;
    checkbox.disabled = !visible;
    if (!visible) checkbox.checked = false;
  };
  select.addEventListener("change", update);
  update();
}

async function createFallingMessage(falls, targetLevel) {
  const lines = falls.map(({name, distance}) => `<li>${game.i18n.format(
    "THEIKS_TOOLBAG.LevelTools.Chat.Fell",
    {name: escapeHTML(name), distance: formatElevation(distance)}
  )}</li>`).join("");
  await ChatMessage.create({
    content: `<div class="theiks-toolbag level-fall-message">
      <h2><i class="fa-solid fa-person-falling"></i> ${localize("Chat.Title")}</h2>
      <p>${game.i18n.format("THEIKS_TOOLBAG.LevelTools.Chat.Target", {level: escapeHTML(targetLevel.name)})}</p>
      <ul>${lines}</ul>
    </div>`
  });
}

async function announceFalls(falls, targetLevel) {
  try {
    await createFallingMessage(falls, targetLevel);
  } catch (error) {
    ui.notifications.error(localize("Errors.ChatFailed"));
    console.error(`${MODULE_ID} | Failed to create the Token falling Chat message`, error);
  }
}

function getLevelAtElevation(elevation, scene = canvas.scene) {
  if (scene === canvas.scene && typeof canvas.inferLevelFromElevation === "function") {
    const inferred = canvas.inferLevelFromElevation(elevation);
    if (inferred) return inferred;
  }
  return getSceneLevels(scene).find(level => elevationInLevel(elevation, level)) ?? null;
}

function normalizeTokenDocuments(tokens) {
  if (!tokens || typeof tokens[Symbol.iterator] !== "function") return [];
  const unique = new Map();
  for (const token of tokens) {
    const document = token?.document ?? token;
    if (document?.id) unique.set(document.id, document);
  }
  return Array.from(unique.values());
}

function getDefaultLevelId(tokens, levels) {
  const ids = new Set(tokens.map(token => getTokenLevel(token, canvas.scene)?.id).filter(Boolean));
  if (ids.size === 1) return ids.values().next().value;
  const viewedId = canvas.level?.id ?? canvas.level?._id;
  if (viewedId && levels.some(level => level.id === viewedId)) return viewedId;
  return levels[0]?.id ?? null;
}

function validateLevelTools() {
  assertFeatureEnabled(FEATURES.levelTools);
  if (!game.user?.isGM) throw new Error(localize("Errors.GmOnly"));
  if (!canvas.ready || !canvas.scene) throw new Error(localize("Errors.SceneUnavailable"));
  if (!getSceneLevels(canvas.scene).length) throw new Error(localize("Errors.NoLevels"));
}

function elevationInLevel(elevation, level) {
  const bottom = Number(level?.elevation?.bottom);
  const top = Number(level?.elevation?.top);
  return Number.isFinite(bottom) && Number.isFinite(top) && elevation >= bottom && elevation <= top;
}

function escapeHTML(value) {
  return foundry.utils.escapeHTML(String(value ?? ""));
}

function formatElevation(value) {
  const number = Number(value);
  return Number.isFinite(number) ? String(number) : "?";
}

function isChecked(value) {
  return value === true || value === "true" || value === "on" || value === 1 || value === "1";
}

function isMovementActive(movement) {
  return movement?.finished?.then
    && movement.state !== "completed"
    && movement.state !== "stopped";
}

function localize(key) {
  return game.i18n.localize(`THEIKS_TOOLBAG.LevelTools.${key}`);
}
