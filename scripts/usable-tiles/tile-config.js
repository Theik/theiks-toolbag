import {
  FEATURES,
  FEATURE_SETTING_CHANGED_HOOK,
  isFeatureEnabled
} from "../settings.js";
import {mountToolbagConfigTab, removeToolbagConfigTabs} from "../config-tabs.js";
import {
  getBreakableTerrainData,
  isTerrainTransitionAuthorized
} from "../breakable-terrain/terrain-config.js";
import {
  normalizeEventBehaviors,
  validateEventBehaviorChanges
} from "../script-events.js";
import {closeScriptBehaviorEditors, mountScriptBehaviorList} from "../script-behaviors-ui.js";

export const MODULE_ID = "theiks-toolbag";
export const USABLE_TILE_FLAG = "usableTile";
export const TOWARD_ON = "towardOn";
export const TOWARD_OFF = "towardOff";

const TEMPLATE_PATH = `modules/${MODULE_ID}/templates/usable-tile-config.hbs`;
const FLAG_ROOT = `flags.${MODULE_ID}.${USABLE_TILE_FLAG}`;
export const USABLE_TILE_FIELDS = Object.freeze({
  enabled: `${FLAG_ROOT}.enabled`,
  states: `${FLAG_ROOT}.states`,
  index: `${FLAG_ROOT}.index`,
  direction: `${FLAG_ROOT}.direction`,
  behaviors: `${FLAG_ROOT}.behaviors`
});
const TRANSITION_NONCE_OPTION = "theiksToolbagUsableTileNonce";
const transitionAuthorizations = new Map();

/** Read and normalize usable state stored on a Tile document. */
export function getUsableTileData(tile) {
  const data = tile?.getFlag?.(MODULE_ID, USABLE_TILE_FLAG) ?? {};
  const states = normalizeUsableStates(data.states);
  const index = Number.isInteger(data.index) && data.index >= 0 && data.index < states.length
    ? data.index
    : 0;
  let direction = data.direction === TOWARD_OFF ? TOWARD_OFF : TOWARD_ON;
  if (index === 0) direction = TOWARD_ON;
  else if (states.length && index === states.length - 1) direction = TOWARD_OFF;
  return {
    enabled: data.enabled === true,
    states,
    index,
    direction,
    behaviors: normalizeEventBehaviors(data.behaviors, {alias: "tile"}),
    state: getUsableStateName(index, states.length),
    configured: data.enabled === true && states.length >= 2
  };
}

/** Normalize ordered state images and discard blank entries. */
export function normalizeUsableStates(states) {
  let values = states;
  if (typeof values === "string") values = [values];
  if (!Array.isArray(values) && values && typeof values === "object") {
    values = Object.entries(values)
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([, value]) => value);
  }
  if (!Array.isArray(values)) return [];
  return values
    .filter(value => typeof value === "string")
    .map(value => value.trim())
    .filter(Boolean);
}

export function getUsableStateName(index, stateCount) {
  if (index <= 0) return "off";
  if (stateCount >= 2 && index >= stateCount - 1) return "on";
  return "step";
}

export function getUsableTileKey(tile) {
  return tile?.uuid ?? `${tile?.parent?.id ?? "scene"}.${tile?.id ?? "tile"}`;
}

export function authorizeUsableTileTransition(tile, nonce) {
  transitionAuthorizations.set(getUsableTileKey(tile), nonce);
  return {[TRANSITION_NONCE_OPTION]: nonce};
}

export function revokeUsableTileTransition(tile, nonce) {
  const key = getUsableTileKey(tile);
  if (transitionAuthorizations.get(key) === nonce) transitionAuthorizations.delete(key);
}

/** Register Tile configuration and state-integrity hooks. */
export function registerUsableTileConfig() {
  Hooks.on("renderTileConfig", renderUsableTileConfig);
  Hooks.on("preCreateTile", validateUsableTileCreation);
  Hooks.on("preUpdateTile", validateUsableTileUpdate);
  Hooks.on("preCreateTile", validateUsableBehaviorChanges);
  Hooks.on("preUpdateTile", validateUsableBehaviorChanges);
  Hooks.on(FEATURE_SETTING_CHANGED_HOOK, (feature, enabled) => {
    if (feature !== FEATURES.usableTiles || enabled) return;
    closeScriptBehaviorEditors(FEATURES.usableTiles);
    removeToolbagConfigTabs(FEATURES.usableTiles);
  });
}

function validateUsableBehaviorChanges(_tile, changes, _options, userId) {
  validateEventBehaviorChanges(changes, USABLE_TILE_FIELDS.behaviors, "tile", userId);
}

async function renderUsableTileConfig(application, element, context) {
  if (!isFeatureEnabled(FEATURES.usableTiles)) return;
  const form = application.form ?? element.querySelector("form");
  const root = element.querySelector(".standard-form.scrollable") ?? form;
  if (!root || element.querySelector(".theiks-toolbag.usable-tile")) return;

  const controlled = application.isSelect ? application.controlled ?? [] : [];
  const tile = controlled[0] ?? context.document ?? application.document;
  const data = getUsableTileData(tile);
  const damaged = getBreakableTerrainData(tile).damaged
    || controlled.some(document => getBreakableTerrainData(document).damaged);
  const states = data.states.length ? data.states : ["", ""];
  const html = await foundry.applications.handlebars.renderTemplate(TEMPLATE_PATH, {
    rootId: `${application.id}-usable-tile`,
    fields: USABLE_TILE_FIELDS,
    ...data,
    states: states.map((src, index) => ({src, number: index + 1})),
    definitionLocked: damaged
  });

  if (!isFeatureEnabled(FEATURES.usableTiles) || !application.rendered || !root.isConnected) return;
  const mounted = mountToolbagConfigTab({
    application,
    element,
    content: html,
    feature: FEATURES.usableTiles,
    nativeTab: application.isSelect === undefined ? "appearance" : undefined,
    nativeLabel: game.i18n.localize("THEIKS_TOOLBAG.ConfigTabs.Tile"),
    nativeIcon: "fa-solid fa-cubes"
  });
  if (!mounted) return;
  const fieldset = mounted.panel.querySelector(".theiks-toolbag.usable-tile");
  fieldset?.addEventListener("click", event => handleStateListAction(event, application, fieldset));
  form?.addEventListener("formdata", event => serializeStates(event, fieldset, damaged));
  applyMultipleValueState(application, mounted.panel);
  await mountScriptBehaviorList({
    application,
    host: mounted.panel.querySelector("[data-toolbag-behaviors]"),
    document: tile,
    alias: "tile",
    feature: FEATURES.usableTiles,
    behaviorField: USABLE_TILE_FIELDS.behaviors,
    behaviors: data.behaviors,
    selectedBehaviorLists: controlled.map(document => getUsableTileData(document).behaviors),
    getUnavailableEvents: () => ["damaged", "destroyed", "repairedPartial", "repaired"]
  });
  if (data.enabled || damaged) lockNativeTextureSource(element);
  updateStateRowControls(fieldset);
  application.setPosition({height: "auto"});
}

function serializeStates(event, fieldset, definitionLocked) {
  if (!fieldset || definitionLocked) return;
  const values = Array.from(
    fieldset.querySelectorAll(`[name="${USABLE_TILE_FIELDS.states}"]`),
    field => field.value
  );
  event.formData.set(USABLE_TILE_FIELDS.states, normalizeUsableStates(values));
}

function handleStateListAction(event, application, fieldset) {
  const button = event.target.closest("button[data-usable-state-action]");
  if (!button || button.disabled) return;
  event.preventDefault();
  const list = fieldset.querySelector("[data-usable-states]");
  const row = button.closest("[data-usable-state-row]");
  if (!list) return;
  switch (button.dataset.usableStateAction) {
    case "add":
      list.insertAdjacentHTML("beforeend", createStateRowHtml(application.id));
      break;
    case "remove":
      row?.remove();
      break;
    case "up":
      if (row?.previousElementSibling) list.insertBefore(row, row.previousElementSibling);
      break;
    case "down":
      if (row?.nextElementSibling) list.insertBefore(row.nextElementSibling, row);
      break;
  }
  markStatesDirty(application, fieldset);
  updateStateRowControls(fieldset);
}

function createStateRowHtml(applicationId) {
  const id = `${applicationId}-usable-state-${foundry.utils.randomID()}`;
  return `<div class="usable-state-row" data-usable-state-row>
    <label for="${id}">${localize("Config.State", {number: ""})}</label>
    <div class="form-fields">
      <file-picker id="${id}" name="${USABLE_TILE_FIELDS.states}" type="image" value=""></file-picker>
      <button type="button" class="icon fa-solid fa-arrow-up" data-usable-state-action="up"></button>
      <button type="button" class="icon fa-solid fa-arrow-down" data-usable-state-action="down"></button>
      <button type="button" class="icon fa-solid fa-trash" data-usable-state-action="remove"></button>
    </div>
  </div>`;
}

function updateStateRowControls(fieldset) {
  const rows = Array.from(fieldset?.querySelectorAll("[data-usable-state-row]") ?? []);
  rows.forEach((row, index) => {
    const label = row.querySelector("label");
    if (label) label.textContent = localize("Config.State", {number: index + 1});
    const up = row.querySelector('[data-usable-state-action="up"]');
    const down = row.querySelector('[data-usable-state-action="down"]');
    if (up) up.disabled = index === 0 || up.hasAttribute("data-definition-locked");
    if (down) down.disabled = index === rows.length - 1 || down.hasAttribute("data-definition-locked");
  });
}

function markStatesDirty(application, fieldset) {
  fieldset.querySelector("[data-usable-states]")?.classList.remove("multiple-values");
  if (application.isSelect) {
    application._dirtyFields?.add(USABLE_TILE_FIELDS.states);
    application.element.querySelector('button[type="submit"]')?.removeAttribute("hidden");
    return;
  }
  fieldset.querySelector(`[name="${USABLE_TILE_FIELDS.states}"]`)
    ?.dispatchEvent(new Event("change", {bubbles: true}));
}

function applyMultipleValueState(application, root) {
  if (!application.isSelect || application.controlled?.length < 2) return;
  const documents = application.controlled;
  setMultipleState(root, USABLE_TILE_FIELDS.enabled, documents.map(tile => getUsableTileData(tile).enabled));
  const stateLists = documents.map(tile => getUsableTileData(tile).states);
  if (!stateLists.every(states => foundry.utils.equals(states, stateLists[0]))) {
    root.querySelector("[data-usable-states]")?.classList.add("multiple-values");
  }
}

function setMultipleState(root, name, values) {
  if (values.every(value => foundry.utils.equals(value, values[0]))) return;
  const field = root.querySelector(`[name="${name}"]`);
  if (!field) return;
  field.classList.add("multiple-values");
  field.checked = false;
  field.indeterminate = true;
}

function lockNativeTextureSource(element) {
  const picker = element.querySelector('[name="texture.src"]');
  if (!picker) return;
  picker.disabled = true;
  picker.setAttribute("disabled", "");
  picker.title = localize("Config.ManagedImage");
}

function validateUsableTileCreation(tile) {
  if (!isFeatureEnabled(FEATURES.usableTiles)) return;
  const data = getUsableTileData(tile);
  validateDefinition(data);
  if (!data.enabled) return;
  tile.updateSource?.({
    "texture.src": data.states[0],
    [USABLE_TILE_FIELDS.index]: 0,
    [USABLE_TILE_FIELDS.direction]: TOWARD_ON,
    [USABLE_TILE_FIELDS.states]: data.states
  });
}

function validateUsableTileUpdate(tile, changes, options = {}) {
  if (!isFeatureEnabled(FEATURES.usableTiles)) return;
  const current = getUsableTileData(tile);
  const authorized = transitionAuthorizations.get(getUsableTileKey(tile));
  const isAuthorized = typeof authorized === "string" && options[TRANSITION_NONCE_OPTION] === authorized;
  const enabledChange = getChangedValue(changes, USABLE_TILE_FIELDS.enabled);
  const statesChange = getChangedValue(changes, USABLE_TILE_FIELDS.states);
  const textureChange = getChangedValue(changes, "texture.src");
  const runtimeChanged = [USABLE_TILE_FIELDS.index, USABLE_TILE_FIELDS.direction]
    .some(path => getChangedValue(changes, path).present);

  if (isAuthorized || isTerrainTransitionAuthorized(tile, options)) return;
  if (runtimeChanged) throw new Error(localize("Errors.ManagedState"));

  const definitionChanged = statesChange.present || (enabledChange.present && enabledChange.value === true);
  const damaged = getBreakableTerrainData(tile).damaged;
  if (damaged && (definitionChanged || textureChange.present || requestsFlagDeletion(changes))) {
    throw new Error(localize("Errors.RepairBeforeUse"));
  }
  if (current.enabled && textureChange.present && !definitionChanged) {
    throw new Error(localize("Errors.ManagedImage"));
  }

  const states = statesChange.present ? normalizeUsableStates(statesChange.value) : current.states;
  const enabled = enabledChange.present ? enabledChange.value === true : current.enabled;
  validateDefinition({enabled, states});
  if (statesChange.present) setChangedValue(changes, USABLE_TILE_FIELDS.states, states);
  if (definitionChanged && enabled) {
    setChangedValue(changes, USABLE_TILE_FIELDS.index, 0);
    setChangedValue(changes, USABLE_TILE_FIELDS.direction, TOWARD_ON);
    setChangedValue(changes, "texture.src", states[0]);
  }
}

function validateDefinition(data) {
  if (data.enabled && data.states.length < 2) throw new Error(localize("Errors.StatesRequired"));
}

function requestsFlagDeletion(changes) {
  return Object.hasOwn(changes ?? {}, `flags.${MODULE_ID}.-=${USABLE_TILE_FLAG}`)
    || Object.hasOwn(changes ?? {}, `flags.-=${MODULE_ID}`)
    || Object.hasOwn(changes?.flags ?? {}, `-=${MODULE_ID}`)
    || Object.hasOwn(changes?.flags?.[MODULE_ID] ?? {}, `-=${USABLE_TILE_FLAG}`);
}

function getChangedValue(changes, path) {
  if (!changes || typeof changes !== "object") return {present: false};
  if (Object.hasOwn(changes, path)) return {present: true, value: changes[path]};
  const parts = path.split(".");
  for (let length = parts.length - 1; length > 0; length -= 1) {
    const prefix = parts.slice(0, length).join(".");
    if (!Object.hasOwn(changes, prefix)) continue;
    let value = changes[prefix];
    for (const part of parts.slice(length)) {
      if (!value || typeof value !== "object" || !Object.hasOwn(value, part)) return {present: false};
      value = value[part];
    }
    return {present: true, value};
  }
  let value = changes;
  for (const part of parts) {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, part)) return {present: false};
    value = value[part];
  }
  return {present: true, value};
}

function setChangedValue(changes, path, value) {
  if (Object.hasOwn(changes, path)) {
    changes[path] = value;
    return;
  }
  const parts = path.split(".");
  for (let length = parts.length - 1; length > 0; length -= 1) {
    const prefix = parts.slice(0, length).join(".");
    if (!Object.hasOwn(changes, prefix)) continue;
    let target = changes[prefix];
    if (!target || typeof target !== "object") return;
    for (const part of parts.slice(length, -1)) {
      if (!target[part] || typeof target[part] !== "object") return;
      target = target[part];
    }
    target[parts.at(-1)] = value;
    return;
  }
  changes[path] = value;
}

function localize(key, data) {
  const path = `THEIKS_TOOLBAG.UsableTiles.${key}`;
  return data ? game.i18n.format(path, data) : game.i18n.localize(path);
}
