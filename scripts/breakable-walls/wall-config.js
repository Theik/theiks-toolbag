export const MODULE_ID = "theiks-toolbag";
export const BREAKABLE_WALL_FLAG = "breakableWall";

const TEMPLATE_PATH = `modules/${MODULE_ID}/templates/breakable-wall-config.hbs`;
const FLAG_FIELDS = {
  enabled: `flags.${MODULE_ID}.${BREAKABLE_WALL_FLAG}.enabled`,
  both: `flags.${MODULE_ID}.${BREAKABLE_WALL_FLAG}.images.both`,
  single: `flags.${MODULE_ID}.${BREAKABLE_WALL_FLAG}.images.single`
};

/**
 * Read and normalize this module's data from a Wall document.
 *
 * @param {WallDocument} wall
 * @returns {{enabled: boolean, images: {both: string, single: string}}}
 */
export function getBreakableWallData(wall) {
  const data = wall?.getFlag(MODULE_ID, BREAKABLE_WALL_FLAG) ?? {};
  return {
    enabled: data.enabled === true,
    images: {
      both: typeof data.images?.both === "string" ? data.images.both : "",
      single: typeof data.images?.single === "string" ? data.images.single : ""
    }
  };
}

/** Register the WallConfig render hook used by both the normal sheet and Wall Palette. */
export function registerBreakableWallConfig() {
  Hooks.on("renderWallConfig", renderBreakableWallConfig);
}

/**
 * Add the breakable-wall fields to a WallConfig or WallPalette form.
 *
 * @param {foundry.applications.sheets.WallConfig} application
 * @param {HTMLElement} element
 * @param {object} context
 * @returns {Promise<void>}
 */
async function renderBreakableWallConfig(application, element, context) {
  const scrollable = element.querySelector(".standard-form.scrollable");
  if (!scrollable || scrollable.querySelector(".theiks-toolbag.breakable-wall")) return;

  const wall = context.document ?? application.document;
  const data = getBreakableWallData(wall);
  const html = await foundry.applications.handlebars.renderTemplate(TEMPLATE_PATH, {
    rootId: `${application.id}-breakable-wall`,
    fields: FLAG_FIELDS,
    ...data,
    bothImage: data.images.both,
    singleImage: data.images.single
  });

  if (!application.rendered || !scrollable.isConnected) return;
  scrollable.insertAdjacentHTML("beforeend", html);
  applyMultipleValueState(application, scrollable);
  application.setPosition({height: "auto"});
}

/**
 * Represent divergent values when the Wall Palette is editing a mixed selection.
 * This deliberately compares the selected documents instead of using palette internals.
 *
 * @param {foundry.applications.sheets.WallConfig} application
 * @param {HTMLElement} root
 */
function applyMultipleValueState(application, root) {
  if (!application.isSelect || application.controlled?.length < 2) return;

  const documents = application.controlled;
  setMultipleState(root, FLAG_FIELDS.enabled, documents.map(wall => getBreakableWallData(wall).enabled));
  setMultipleState(root, FLAG_FIELDS.both, documents.map(wall => getBreakableWallData(wall).images.both));
  setMultipleState(root, FLAG_FIELDS.single, documents.map(wall => getBreakableWallData(wall).images.single));
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
