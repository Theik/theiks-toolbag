export const MODULE_ID = "theiks-toolbag";
export const BREAKABLE_TERRAIN_FLAG = "breakableTerrain";

const TEMPLATE_PATH = `modules/${MODULE_ID}/templates/breakable-terrain-config.hbs`;
const FLAG_ROOT = `flags.${MODULE_ID}.${BREAKABLE_TERRAIN_FLAG}`;
export const TERRAIN_FIELDS = Object.freeze({
  enabled: `${FLAG_ROOT}.enabled`,
  blocksMovement: `${FLAG_ROOT}.blocksMovement`,
  blocksVision: `${FLAG_ROOT}.blocksVision`,
  states: `${FLAG_ROOT}.states`,
  stage: `${FLAG_ROOT}.stage`,
  restoreSrc: `${FLAG_ROOT}.restoreSrc`
});

const TRANSITION_NONCE_OPTION = "theiksToolbagTerrainNonce";
const transitionAuthorizations = new Map();

/**
 * Read and normalize this module's terrain data from a Tile document.
 *
 * @param {TileDocument} tile
 * @returns {{
 *   enabled: boolean,
 *   blocksMovement: boolean,
 *   blocksVision: boolean,
 *   states: string[],
 *   stage: number,
 *   restoreSrc: string|null,
 *   damaged: boolean,
 *   fullyDestroyed: boolean,
 *   canAdvance: boolean,
 *   blocks: boolean
 * }}
 */
export function getBreakableTerrainData(tile) {
  const data = tile?.getFlag?.(MODULE_ID, BREAKABLE_TERRAIN_FLAG) ?? {};
  const states = normalizeTerrainStates(data.states);
  const stage = Number.isInteger(data.stage) && data.stage >= 0 ? data.stage : 0;
  const damaged = stage > 0;
  const fullyDestroyed = damaged && stage >= states.length;
  const enabled = data.enabled === true;
  const blocksMovement = data.blocksMovement === true;
  const blocksVision = data.blocksVision === true;
  return {
    enabled,
    blocksMovement,
    blocksVision,
    states,
    stage,
    restoreSrc: typeof data.restoreSrc === "string" && data.restoreSrc ? data.restoreSrc : null,
    damaged,
    fullyDestroyed,
    canAdvance: enabled && states.length > 0 && stage < states.length,
    blocks: (blocksMovement || blocksVision) && !fullyDestroyed
  };
}

/** Normalize an ordered list submitted by a normal form, repeated inputs, or expanded numeric keys. */
export function normalizeTerrainStates(states) {
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
    .map(value => value.trim());
}

/** Register Tile configuration and state-integrity hooks. */
export function registerBreakableTerrainConfig() {
  Hooks.on("renderTileConfig", renderBreakableTerrainConfig);
  Hooks.on("preCreateTile", validateTerrainCreation);
  Hooks.on("preUpdateTile", validateTerrainUpdate);
}

/** Authorize one transition update without exposing its nonce outside this subsystem. */
export function authorizeTerrainTransition(tile, nonce) {
  transitionAuthorizations.set(getTerrainKey(tile), nonce);
  return {[TRANSITION_NONCE_OPTION]: nonce};
}

/** Revoke a transition authorization after its document update settles. */
export function revokeTerrainTransition(tile, nonce) {
  const key = getTerrainKey(tile);
  if (transitionAuthorizations.get(key) === nonce) transitionAuthorizations.delete(key);
}

/** Add breakable-terrain fields to a TileConfig or TilePalette form. */
async function renderBreakableTerrainConfig(application, element, context) {
  const form = application.form ?? element.querySelector("form");
  const root = element.querySelector(".standard-form.scrollable") ?? form;
  if (!root || root.querySelector(".theiks-toolbag.breakable-terrain")) return;

  const target = element.querySelector('.tab[data-tab="appearance"]') ?? root;
  const controlled = application.isSelect ? application.controlled ?? [] : [];
  const tile = controlled[0] ?? context.document ?? application.document;
  const data = getBreakableTerrainData(tile);
  const definitionLocked = data.damaged || controlled.some(document => getBreakableTerrainData(document).damaged);
  const states = data.states.length ? data.states : [""];
  const html = await foundry.applications.handlebars.renderTemplate(TEMPLATE_PATH, {
    rootId: `${application.id}-breakable-terrain`,
    fields: TERRAIN_FIELDS,
    ...data,
    states: states.map((src, index) => ({src, number: index + 1})),
    definitionLocked
  });

  if (!application.rendered || !target.isConnected) return;
  target.insertAdjacentHTML("beforeend", html);
  const fieldset = target.querySelector(".theiks-toolbag.breakable-terrain");
  fieldset?.addEventListener("click", event => handleStateListAction(event, application, fieldset));
  fieldset?.addEventListener("change", event => handleStateFieldChange(event, application, fieldset));
  form?.addEventListener("formdata", event => serializeTerrainStates(event, fieldset, definitionLocked));
  if (isPlaceablePalette(application)) {
    form?.addEventListener("change", event => validatePaletteDefaultChange(event, application, fieldset), {
      capture: true
    });
  }
  if (definitionLocked) lockNativeTextureSource(element);
  applyMultipleValueState(application, root);
  updateStateRowControls(fieldset);
  application.setPosition({height: "auto"});
}

function serializeTerrainStates(event, fieldset, definitionLocked) {
  if (!fieldset || definitionLocked) return;
  const states = Array.from(fieldset.querySelectorAll(`[name="${TERRAIN_FIELDS.states}"]`), field => field.value);
  event.formData.set(TERRAIN_FIELDS.states, normalizeTerrainStates(states));
}

function handleStateFieldChange(event, application, fieldset) {
  const picker = event.target.closest?.(`file-picker[name="${TERRAIN_FIELDS.states}"]`);
  if (!picker) return;
  markStatesDirty(application, fieldset);
}

function isPlaceablePalette(application) {
  return application && ("_dirtyFields" in application) && (typeof application.isSelect === "boolean");
}

function validatePaletteDefaultChange(event, application, fieldset) {
  if (application.isSelect || !fieldset) return;
  const enabled = fieldset.querySelector(`[name="${TERRAIN_FIELDS.enabled}"]`)?.checked === true;
  const states = Array.from(fieldset.querySelectorAll(`[name="${TERRAIN_FIELDS.states}"]`), field => field.value);
  if (!enabled || normalizeTerrainStates(states).length) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  ui.notifications.error(localize("Errors.StateRequired"));
}

function lockNativeTextureSource(element) {
  const picker = element.querySelector('[name="texture.src"]');
  if (!picker) return;
  picker.disabled = true;
  picker.setAttribute("disabled", "");
  picker.title = localize("Config.RestoreBeforeDefinitionChange");
}

function handleStateListAction(event, application, fieldset) {
  const button = event.target.closest("button[data-terrain-state-action]");
  if (!button || button.disabled) return;
  event.preventDefault();
  const list = fieldset.querySelector("[data-terrain-states]");
  const row = button.closest("[data-terrain-state-row]");
  if (!list) return;

  switch (button.dataset.terrainStateAction) {
    case "add":
      list.insertAdjacentHTML("beforeend", createStateRowHtml(application.id));
      break;
    case "remove":
      row?.remove();
      if (!list.querySelector("[data-terrain-state-row]")) {
        list.insertAdjacentHTML("beforeend", createStateRowHtml(application.id));
      }
      markStatesDirty(application, fieldset, {submit: true});
      break;
    case "up":
      if (row?.previousElementSibling) list.insertBefore(row, row.previousElementSibling);
      markStatesDirty(application, fieldset, {submit: true});
      break;
    case "down":
      if (row?.nextElementSibling) list.insertBefore(row.nextElementSibling, row);
      markStatesDirty(application, fieldset, {submit: true});
      break;
  }
  updateStateRowControls(fieldset);
}

function createStateRowHtml(applicationId) {
  const id = `${applicationId}-terrain-state-${foundry.utils.randomID()}`;
  return `<div class="terrain-state-row" data-terrain-state-row>
    <label for="${id}">${localize("Config.State", {number: ""})}</label>
    <div class="form-fields">
      <file-picker id="${id}" name="${TERRAIN_FIELDS.states}" type="image" value=""></file-picker>
      <button type="button" class="icon fa-solid fa-arrow-up" data-terrain-state-action="up"
        aria-label="${localize("Config.MoveUp")}" data-tooltip="${localize("Config.MoveUp")}"></button>
      <button type="button" class="icon fa-solid fa-arrow-down" data-terrain-state-action="down"
        aria-label="${localize("Config.MoveDown")}" data-tooltip="${localize("Config.MoveDown")}"></button>
      <button type="button" class="icon fa-solid fa-trash" data-terrain-state-action="remove"
        aria-label="${localize("Config.RemoveState")}" data-tooltip="${localize("Config.RemoveState")}"></button>
    </div>
  </div>`;
}

function updateStateRowControls(fieldset) {
  if (!fieldset) return;
  const rows = Array.from(fieldset.querySelectorAll("[data-terrain-state-row]"));
  rows.forEach((row, index) => {
    const label = row.querySelector("label");
    if (label) label.textContent = localize("Config.State", {number: index + 1});
    const up = row.querySelector('[data-terrain-state-action="up"]');
    const down = row.querySelector('[data-terrain-state-action="down"]');
    if (up) up.disabled = index === 0 || up.hasAttribute("data-definition-locked");
    if (down) down.disabled = index === rows.length - 1 || down.hasAttribute("data-definition-locked");
  });
}

function markStatesDirty(application, fieldset, {submit = false} = {}) {
  fieldset.querySelector("[data-terrain-states]")?.classList.remove("multiple-values");
  if (application.isSelect) {
    application._dirtyFields?.add(TERRAIN_FIELDS.states);
    application.element.querySelector('button[type="submit"]')?.removeAttribute("hidden");
    return;
  }
  if (!submit) return;
  const field = fieldset.querySelector(`[name="${TERRAIN_FIELDS.states}"]`);
  field?.dispatchEvent(new Event("change", {bubbles: true}));
}

function applyMultipleValueState(application, root) {
  if (!application.isSelect || application.controlled?.length < 2) return;
  const documents = application.controlled;
  setMultipleState(root, TERRAIN_FIELDS.enabled, documents.map(tile => getBreakableTerrainData(tile).enabled));
  setMultipleState(root, TERRAIN_FIELDS.blocksMovement,
    documents.map(tile => getBreakableTerrainData(tile).blocksMovement));
  setMultipleState(root, TERRAIN_FIELDS.blocksVision,
    documents.map(tile => getBreakableTerrainData(tile).blocksVision));

  const stateLists = documents.map(tile => getBreakableTerrainData(tile).states);
  if (!stateLists.every(states => foundry.utils.equals(states, stateLists[0]))) {
    const list = root.querySelector("[data-terrain-states]");
    list?.classList.add("multiple-values");
  }
}

function setMultipleState(root, name, values) {
  if (values.every(value => foundry.utils.equals(value, values[0]))) return;
  const field = root.querySelector(`[name="${name}"]`);
  if (!field) return;
  field.classList.add("multiple-values");
  if (foundry.utils.isElementInstanceOf(field, HTMLInputElement) && field.type === "checkbox") {
    field.checked = false;
    field.indeterminate = true;
  }
}

function validateTerrainCreation(tile) {
  validateEnabledStates(getBreakableTerrainData(tile));
}

function validateTerrainUpdate(tile, changes, options = {}) {
  const current = getBreakableTerrainData(tile);
  const authorized = transitionAuthorizations.get(getTerrainKey(tile));
  const isAuthorized = typeof authorized === "string" && options[TRANSITION_NONCE_OPTION] === authorized;

  const statesChange = getChangedValue(changes, TERRAIN_FIELDS.states);
  if (statesChange.present) setChangedValue(changes, TERRAIN_FIELDS.states, normalizeTerrainStates(statesChange.value));

  if (!isAuthorized) {
    const runtimeChanged = [TERRAIN_FIELDS.stage, TERRAIN_FIELDS.restoreSrc]
      .some(path => getChangedValue(changes, path).present);
    if (runtimeChanged) throw new Error(localize("Errors.ManagedState"));

    if (current.damaged) {
      const definitionChanged = [TERRAIN_FIELDS.enabled, TERRAIN_FIELDS.states, "texture.src"]
        .some(path => getChangedValue(changes, path).present);
      if (definitionChanged || requestsFlagDeletion(changes)) {
        throw new Error(localize("Errors.RestoreBeforeDefinitionChange"));
      }
    }
  }

  if (!isAuthorized) {
    const next = getProspectiveData(tile, changes);
    validateEnabledStates(next);
  }
}

function getProspectiveData(tile, changes) {
  const current = getBreakableTerrainData(tile);
  const enabled = getChangedValue(changes, TERRAIN_FIELDS.enabled);
  const blocksMovement = getChangedValue(changes, TERRAIN_FIELDS.blocksMovement);
  const blocksVision = getChangedValue(changes, TERRAIN_FIELDS.blocksVision);
  const states = getChangedValue(changes, TERRAIN_FIELDS.states);
  const stage = getChangedValue(changes, TERRAIN_FIELDS.stage);
  const restoreSrc = getChangedValue(changes, TERRAIN_FIELDS.restoreSrc);
  return {
    ...current,
    enabled: enabled.present ? enabled.value === true : current.enabled,
    blocksMovement: blocksMovement.present ? blocksMovement.value === true : current.blocksMovement,
    blocksVision: blocksVision.present ? blocksVision.value === true : current.blocksVision,
    states: states.present ? normalizeTerrainStates(states.value) : current.states,
    stage: stage.present && Number.isInteger(stage.value) && stage.value >= 0 ? stage.value : current.stage,
    restoreSrc: restoreSrc.present ? restoreSrc.value : current.restoreSrc
  };
}

function validateEnabledStates(data) {
  if (data.enabled && !data.states.length) throw new Error(localize("Errors.StateRequired"));
}

function requestsFlagDeletion(changes) {
  if (Object.hasOwn(changes, `flags.${MODULE_ID}.-=${BREAKABLE_TERRAIN_FLAG}`)) return true;
  if (Object.hasOwn(changes, `flags.-=${MODULE_ID}`)) return true;
  if (Object.hasOwn(changes.flags ?? {}, `-=${MODULE_ID}`)) return true;
  return Object.hasOwn(changes.flags?.[MODULE_ID] ?? {}, `-=${BREAKABLE_TERRAIN_FLAG}`);
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
  changes[path] = value;
}

export function getTerrainKey(tile) {
  return tile?.uuid ?? `${tile?.parent?.id ?? "scene"}.${tile?.id ?? "tile"}`;
}

function localize(key, data) {
  const path = `THEIKS_TOOLBAG.BreakableTerrain.${key}`;
  return data ? game.i18n.format(path, data) : game.i18n.localize(path);
}
