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
export const BREAKABLE_WALL_FLAG = "breakableWall";

const TEMPLATE_PATH = `modules/${MODULE_ID}/templates/breakable-wall-config.hbs`;
export const WALL_FIELDS = Object.freeze({
  enabled: `flags.${MODULE_ID}.${BREAKABLE_WALL_FLAG}.enabled`,
  both: `flags.${MODULE_ID}.${BREAKABLE_WALL_FLAG}.images.both`,
  single: `flags.${MODULE_ID}.${BREAKABLE_WALL_FLAG}.images.single`,
  behaviors: `flags.${MODULE_ID}.${BREAKABLE_WALL_FLAG}.behaviors`,
  destroyedScript: `flags.${MODULE_ID}.${BREAKABLE_WALL_FLAG}.scripts.destroyed`,
  repairedScript: `flags.${MODULE_ID}.${BREAKABLE_WALL_FLAG}.scripts.repaired`
});
const WALL_LEGACY_SCRIPTS_FIELD = `flags.${MODULE_ID}.${BREAKABLE_WALL_FLAG}.-=scripts`;
const WALL_SCRIPT_FIELDS = [WALL_FIELDS.destroyedScript, WALL_FIELDS.repairedScript];

const DESTRUCTION_KINDS = new Set(["both", "single"]);
const DESTRUCTION_SIDES = new Set(["positive", "negative"]);
const RESTORE_FIELDS = ["light", "sight", "sound", "move", "door", "ds"];

/**
 * Read and normalize this module's data from a Wall document.
 *
 * @param {WallDocument} wall
 * @returns {{
 *   enabled: boolean,
 *   images: {both: string, single: string},
 *   behaviors: object[],
 *   scripts: {destroyed: string, repaired: string},
 *   destroyed: boolean,
 *   destruction: null|{kind: "both"|"single", side: null|"positive"|"negative"},
 *   restore: null|{light: number, sight: number, sound: number, move: number, door: number, ds: number}
 * }}
 */
export function getBreakableWallData(wall) {
  const data = wall?.getFlag?.(MODULE_ID, BREAKABLE_WALL_FLAG) ?? {};
  const scripts = {
    destroyed: normalizeEventScript(data.scripts?.destroyed),
    repaired: normalizeEventScript(data.scripts?.repaired)
  };
  return {
    enabled: data.enabled === true,
    images: {
      both: typeof data.images?.both === "string" ? data.images.both : "",
      single: typeof data.images?.single === "string" ? data.images.single : ""
    },
    behaviors: normalizeEventBehaviors(data.behaviors, {alias: "wall", legacyScripts: scripts}),
    scripts,
    destroyed: data.destroyed === true,
    destruction: normalizeDestruction(data.destruction),
    restore: normalizeRestore(data.restore)
  };
}

/** Normalize the artwork selection saved when the wall was destroyed. */
function normalizeDestruction(destruction) {
  if (!destruction || !DESTRUCTION_KINDS.has(destruction.kind)) return null;
  if (destruction.kind === "both") return {kind: "both", side: null};
  if (!DESTRUCTION_SIDES.has(destruction.side)) return null;
  return {kind: "single", side: destruction.side};
}

/** Normalize an exact, complete snapshot of Foundry's mechanical Wall fields. */
function normalizeRestore(restore) {
  if (!restore || typeof restore !== "object" || Array.isArray(restore)) return null;
  if (!RESTORE_FIELDS.every(field => Number.isInteger(restore[field]))) return null;
  return Object.fromEntries(RESTORE_FIELDS.map(field => [field, restore[field]]));
}

/** Register the WallConfig render hook used by both the normal sheet and Wall Palette. */
export function registerBreakableWallConfig() {
  Hooks.on("renderWallConfig", renderBreakableWallConfig);
  Hooks.on("preCreateWall", validateWallScriptChanges);
  Hooks.on("preUpdateWall", validateWallScriptChanges);
  Hooks.on(FEATURE_SETTING_CHANGED_HOOK, (feature, enabled) => {
    if (feature !== FEATURES.breakableWalls || enabled) return;
    closeScriptBehaviorEditors(FEATURES.breakableWalls);
    removeToolbagConfigTabs(FEATURES.breakableWalls);
  });
}

function validateWallScriptChanges(_wall, changes, _options, userId) {
  validateEventBehaviorChanges(changes, WALL_FIELDS.behaviors, "wall", userId);
  validateEventScriptChanges(changes, WALL_SCRIPT_FIELDS, "wall", userId);
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
  if (!isFeatureEnabled(FEATURES.breakableWalls)) return;
  const scrollable = element.querySelector(".standard-form.scrollable");
  if (!scrollable || element.querySelector(".theiks-toolbag.breakable-wall")) return;

  const wall = application.isSelect && application.controlled?.length
    ? application.controlled[0]
    : context.document ?? application.document;
  const data = getBreakableWallData(wall);
  const controlled = application.isSelect ? application.controlled ?? [] : [];
  const html = await foundry.applications.handlebars.renderTemplate(TEMPLATE_PATH, {
    rootId: `${application.id}-breakable-wall`,
    fields: WALL_FIELDS,
    ...data,
    bothImage: data.images.both,
    singleImage: data.images.single
  });

  if (!isFeatureEnabled(FEATURES.breakableWalls) || !application.rendered || !scrollable.isConnected) return;
  const mounted = mountToolbagConfigTab({
    application,
    element,
    content: html,
    feature: FEATURES.breakableWalls,
    nativeLabel: game.i18n.localize("THEIKS_TOOLBAG.ConfigTabs.Wall"),
    nativeIcon: "fa-solid fa-block-brick"
  });
  if (!mounted) return;
  applyMultipleValueState(application, mounted.panel);
  await mountScriptBehaviorList({
    application,
    host: mounted.panel.querySelector("[data-toolbag-behaviors]"),
    document: wall,
    alias: "wall",
    feature: FEATURES.breakableWalls,
    behaviorField: WALL_FIELDS.behaviors,
    legacyDeleteField: WALL_LEGACY_SCRIPTS_FIELD,
    behaviors: data.behaviors,
    selectedBehaviorLists: controlled.map(document => getBreakableWallData(document).behaviors)
  });
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
  setMultipleState(root, WALL_FIELDS.enabled, documents.map(wall => getBreakableWallData(wall).enabled));
  setMultipleState(root, WALL_FIELDS.both, documents.map(wall => getBreakableWallData(wall).images.both));
  setMultipleState(root, WALL_FIELDS.single, documents.map(wall => getBreakableWallData(wall).images.single));
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
