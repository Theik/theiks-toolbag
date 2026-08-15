import {
  FEATURES,
  FEATURE_SETTING_CHANGED_HOOK,
  isFeatureEnabled
} from "../settings.js";
import {mountToolbagConfigTab, removeToolbagConfigTabs} from "../config-tabs.js";
import {
  normalizeEventBehaviors,
  normalizeEventScript,
  validateEventBehaviorChanges,
  validateEventScriptChanges
} from "../script-events.js";
import {closeScriptBehaviorEditors, mountScriptBehaviorList} from "../script-behaviors-ui.js";

export const MODULE_ID = "theiks-toolbag";
export const VISIBLE_LIGHT_FLAG = "visibleLight";

const TEMPLATE_PATH = `modules/${MODULE_ID}/templates/visible-light-config.hbs`;
export const LIGHT_FIELDS = Object.freeze({
  destroyed: `flags.${MODULE_ID}.${VISIBLE_LIGHT_FLAG}.destroyed`,
  on: `flags.${MODULE_ID}.${VISIBLE_LIGHT_FLAG}.images.on`,
  off: `flags.${MODULE_ID}.${VISIBLE_LIGHT_FLAG}.images.off`,
  destroyedImage: `flags.${MODULE_ID}.${VISIBLE_LIGHT_FLAG}.images.destroyed`,
  behaviors: `flags.${MODULE_ID}.${VISIBLE_LIGHT_FLAG}.behaviors`,
  toggledOnScript: `flags.${MODULE_ID}.${VISIBLE_LIGHT_FLAG}.scripts.toggledOn`,
  toggledOffScript: `flags.${MODULE_ID}.${VISIBLE_LIGHT_FLAG}.scripts.toggledOff`,
  destroyedScript: `flags.${MODULE_ID}.${VISIBLE_LIGHT_FLAG}.scripts.destroyed`
});
const LIGHT_LEGACY_SCRIPTS_FIELD = `flags.${MODULE_ID}.${VISIBLE_LIGHT_FLAG}.-=scripts`;
const LIGHT_SCRIPT_FIELDS = [
  LIGHT_FIELDS.toggledOnScript,
  LIGHT_FIELDS.toggledOffScript,
  LIGHT_FIELDS.destroyedScript
];

/**
 * Read and normalize this module's data from an Ambient Light document.
 *
 * @param {AmbientLightDocument} light
 * @returns {{destroyed: boolean, images: {on: string, off: string, destroyed: string},
 *   behaviors: object[],
 *   scripts: {toggledOn: string, toggledOff: string, destroyed: string}}}
 */
export function getVisibleLightData(light) {
  const data = light?.getFlag?.(MODULE_ID, VISIBLE_LIGHT_FLAG) ?? {};
  const scripts = {
    toggledOn: normalizeEventScript(data.scripts?.toggledOn),
    toggledOff: normalizeEventScript(data.scripts?.toggledOff),
    destroyed: normalizeEventScript(data.scripts?.destroyed)
  };
  return {
    destroyed: data.destroyed === true,
    images: {
      on: typeof data.images?.on === "string" ? data.images.on : "",
      off: typeof data.images?.off === "string" ? data.images.off : "",
      destroyed: typeof data.images?.destroyed === "string" ? data.images.destroyed : ""
    },
    behaviors: normalizeEventBehaviors(data.behaviors, {alias: "light", legacyScripts: scripts}),
    scripts
  };
}

/** @param {AmbientLightDocument} light */
export function isVisibleLightConfigured(light) {
  const {images} = getVisibleLightData(light);
  return Boolean(images.on || images.off || images.destroyed);
}

/** @param {AmbientLightDocument} light */
export function getVisibleLightState(light) {
  if (getVisibleLightData(light).destroyed) return "destroyed";
  return light?.hidden ? "off" : "on";
}

/** @param {AmbientLightDocument} light */
export function getVisibleLightImage(light) {
  const data = getVisibleLightData(light);
  return data.images[getVisibleLightState(light)];
}

/** Register the AmbientLightConfig hook used by both the normal sheet and Light Palette. */
export function registerVisibleLightConfig() {
  Hooks.on("renderAmbientLightConfig", renderVisibleLightConfig);
  Hooks.on("preCreateAmbientLight", validateLightScriptChanges);
  Hooks.on("preUpdateAmbientLight", validateLightScriptChanges);
  Hooks.on(FEATURE_SETTING_CHANGED_HOOK, (feature, enabled) => {
    if (feature !== FEATURES.visibleLights || enabled) return;
    closeScriptBehaviorEditors(FEATURES.visibleLights);
    removeToolbagConfigTabs(FEATURES.visibleLights);
  });
}

function validateLightScriptChanges(_light, changes, _options, userId) {
  validateEventBehaviorChanges(changes, LIGHT_FIELDS.behaviors, "light", userId);
  validateEventScriptChanges(changes, LIGHT_SCRIPT_FIELDS, "light", userId);
}

/**
 * Add visible-light fields to an AmbientLightConfig or AmbientLightPalette form.
 *
 * @param {foundry.applications.sheets.AmbientLightConfig} application
 * @param {HTMLElement} element
 * @param {object} context
 * @returns {Promise<void>}
 */
async function renderVisibleLightConfig(application, element, context) {
  if (!isFeatureEnabled(FEATURES.visibleLights)) return;
  const form = application.form ?? element.querySelector("form");
  const root = element.querySelector(".standard-form.scrollable") ?? form;
  if (!root || element.querySelector(".theiks-toolbag.visible-light")) return;

  // The Light Palette strips flags from its synthetic backing document. Seed the form from the
  // first real controlled light, then mark any divergent values below.
  const light = application.isSelect && application.controlled?.length
    ? application.controlled[0]
    : context.document ?? application.document;
  const data = getVisibleLightData(light);
  const controlled = application.isSelect ? application.controlled ?? [] : [];
  const html = await foundry.applications.handlebars.renderTemplate(TEMPLATE_PATH, {
    rootId: `${application.id}-visible-light`,
    fields: LIGHT_FIELDS,
    ...data,
    onImage: data.images.on,
    offImage: data.images.off,
    destroyedImage: data.images.destroyed
  });

  if (!isFeatureEnabled(FEATURES.visibleLights) || !application.rendered || !root.isConnected) return;
  const mounted = mountToolbagConfigTab({
    application,
    element,
    content: html,
    feature: FEATURES.visibleLights,
    nativeTab: application.isSelect === undefined ? "basic" : undefined,
    nativeLabel: game.i18n.localize("THEIKS_TOOLBAG.ConfigTabs.Light"),
    nativeIcon: "fa-solid fa-lightbulb"
  });
  if (!mounted) return;
  applyMultipleValueState(application, mounted.panel);
  await mountScriptBehaviorList({
    application,
    host: mounted.panel.querySelector("[data-toolbag-behaviors]"),
    document: light,
    alias: "light",
    feature: FEATURES.visibleLights,
    behaviorField: LIGHT_FIELDS.behaviors,
    legacyDeleteField: LIGHT_LEGACY_SCRIPTS_FIELD,
    behaviors: data.behaviors,
    selectedBehaviorLists: controlled.map(document => getVisibleLightData(document).behaviors)
  });
  application.setPosition({height: "auto"});
}

/**
 * Represent divergent values when the Light Palette is editing a mixed selection.
 *
 * @param {foundry.applications.sheets.AmbientLightConfig} application
 * @param {HTMLElement} root
 */
function applyMultipleValueState(application, root) {
  if (!application.isSelect || application.controlled?.length < 2) return;

  const documents = application.controlled;
  setMultipleState(root, LIGHT_FIELDS.destroyed, documents.map(light => getVisibleLightData(light).destroyed));
  setMultipleState(root, LIGHT_FIELDS.on, documents.map(light => getVisibleLightData(light).images.on));
  setMultipleState(root, LIGHT_FIELDS.off, documents.map(light => getVisibleLightData(light).images.off));
  setMultipleState(root, LIGHT_FIELDS.destroyedImage,
    documents.map(light => getVisibleLightData(light).images.destroyed));
}

/**
 * Mark one form control as containing multiple selected values when appropriate.
 *
 * @param {HTMLElement} root
 * @param {string} name
 * @param {unknown[]} values
 */
function setMultipleState(root, name, values) {
  if (values.every(value => foundry.utils.equals(value, values[0]))) return;

  const field = root.querySelector(`[name="${name}"]`);
  if (!field) return;
  field.classList.add("multiple-values");

  if (foundry.utils.isElementInstanceOf(field, HTMLInputElement) && field.type === "checkbox") {
    field.checked = false;
    field.indeterminate = true;
    return;
  }

  field.value = "";
  const input = field.querySelector?.(":scope > input");
  if (input) input.placeholder = game.i18n.localize("PLACEABLE_PALETTE.MultipleValues");
}
