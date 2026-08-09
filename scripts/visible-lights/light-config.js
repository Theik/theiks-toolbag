export const MODULE_ID = "theiks-toolbag";
export const VISIBLE_LIGHT_FLAG = "visibleLight";

const TEMPLATE_PATH = `modules/${MODULE_ID}/templates/visible-light-config.hbs`;
const FLAG_FIELDS = {
  destroyed: `flags.${MODULE_ID}.${VISIBLE_LIGHT_FLAG}.destroyed`,
  on: `flags.${MODULE_ID}.${VISIBLE_LIGHT_FLAG}.images.on`,
  off: `flags.${MODULE_ID}.${VISIBLE_LIGHT_FLAG}.images.off`,
  destroyedImage: `flags.${MODULE_ID}.${VISIBLE_LIGHT_FLAG}.images.destroyed`
};

/**
 * Read and normalize this module's data from an Ambient Light document.
 *
 * @param {AmbientLightDocument} light
 * @returns {{destroyed: boolean, images: {on: string, off: string, destroyed: string}}}
 */
export function getVisibleLightData(light) {
  const data = light?.getFlag?.(MODULE_ID, VISIBLE_LIGHT_FLAG) ?? {};
  return {
    destroyed: data.destroyed === true,
    images: {
      on: typeof data.images?.on === "string" ? data.images.on : "",
      off: typeof data.images?.off === "string" ? data.images.off : "",
      destroyed: typeof data.images?.destroyed === "string" ? data.images.destroyed : ""
    }
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
  const form = application.form ?? element.querySelector("form");
  const root = element.querySelector(".standard-form.scrollable") ?? form;
  if (!root || root.querySelector(".theiks-toolbag.visible-light")) return;

  const target = element.querySelector('.tab[data-tab="basic"]') ?? root;
  // The Light Palette strips flags from its synthetic backing document. Seed the form from the
  // first real controlled light, then mark any divergent values below.
  const light = application.isSelect && application.controlled?.length
    ? application.controlled[0]
    : context.document ?? application.document;
  const data = getVisibleLightData(light);
  const html = await foundry.applications.handlebars.renderTemplate(TEMPLATE_PATH, {
    rootId: `${application.id}-visible-light`,
    fields: FLAG_FIELDS,
    ...data,
    onImage: data.images.on,
    offImage: data.images.off,
    destroyedImage: data.images.destroyed
  });

  if (!application.rendered || !target.isConnected) return;
  target.insertAdjacentHTML("beforeend", html);
  applyMultipleValueState(application, root);
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
  setMultipleState(root, FLAG_FIELDS.destroyed, documents.map(light => getVisibleLightData(light).destroyed));
  setMultipleState(root, FLAG_FIELDS.on, documents.map(light => getVisibleLightData(light).images.on));
  setMultipleState(root, FLAG_FIELDS.off, documents.map(light => getVisibleLightData(light).images.off));
  setMultipleState(root, FLAG_FIELDS.destroyedImage, documents.map(light => getVisibleLightData(light).images.destroyed));
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
