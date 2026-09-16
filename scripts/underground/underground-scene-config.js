import {
  FEATURES,
  FEATURE_SETTING_CHANGED_HOOK,
  isFeatureEnabled
} from "../settings.js";
import {mountToolbagConfigTab, removeToolbagConfigTabs} from "../config-tabs.js";
import {
  countUndergroundSubcells,
  getUndergroundData,
  MODULE_ID,
  UNDERGROUND_FLAG,
  UNDERGROUND_FLAG_PATH
} from "./underground-data.js";
import {createUndergroundSourceFromScene} from "./underground-occupancy.js";

const TEMPLATE_PATH = `modules/${MODULE_ID}/templates/underground-scene-config.hbs`;
const SUBMIT_WRAP = "_theiksUndergroundSubmitWrapped";

export const UNDERGROUND_SCENE_FIELDS = Object.freeze({
  enabled: `${UNDERGROUND_FLAG_PATH}.enabled`,
  intactSrc: `${UNDERGROUND_FLAG_PATH}.intactSrc`,
  dugSrc: `${UNDERGROUND_FLAG_PATH}.dugSrc`,
  intactGrid: `${UNDERGROUND_FLAG_PATH}.intactGrid`,
  dugGrid: `${UNDERGROUND_FLAG_PATH}.dugGrid`
});

/** Register the SceneConfig tab used to author virtual underground terrain. */
export function registerUndergroundSceneConfig() {
  Hooks.on("renderSceneConfig", renderUndergroundSceneConfig);
  Hooks.on("preUpdateScene", preserveUndergroundMasks);
  Hooks.on(FEATURE_SETTING_CHANGED_HOOK, (feature, enabled) => {
    if (feature !== FEATURES.breakableTerrain || enabled) return;
    removeToolbagConfigTabs(FEATURES.breakableTerrain);
  });
}

/** Read the Scene Config form values for virtual underground. */
export function getUndergroundSceneConfigData(scene) {
  const stored = getStoredSource(scene);
  let data = null;
  try {
    data = getUndergroundData(scene);
  } catch (_error) {
    data = null;
  }
  return {
    enabled: data?.enabled === true,
    intactSrc: data?.intactSrc ?? "",
    dugSrc: data?.dugSrc ?? "",
    intactGrid: data?.intactGrid ?? 1,
    dugGrid: data?.dugGrid ?? 1,
    cellCount: countUndergroundSubcells(data),
    hasSource: hasExistingSource(stored)
  };
}

/**
 * Expand Scene Config submit data into a complete underground flag, or strip a partial one.
 *
 * @param {object} scene
 * @param {object} submitData
 * @param {{sampleTileAlpha?: Function, getTextureSize?: Function, cells?: number[]}} [options]
 * @returns {Promise<object>}
 */
export async function applyUndergroundSceneSubmit(scene, submitData, options = {}) {
  const appearance = readUndergroundAppearance(submitData);
  const stored = getStoredSource(scene);

  if (appearance.enabled && (!appearance.intactSrc || !appearance.dugSrc)) {
    throw new Error(localize("Errors.TexturesRequired"));
  }

  if (appearance.enabled && !hasExistingSource(stored)) {
    const source = await createUndergroundSourceFromScene(scene, {
      ...appearance,
      sampleTileAlpha: options.sampleTileAlpha,
      getTextureSize: options.getTextureSize,
      cells: options.cells
    });
    writeUndergroundFlag(submitData, source);
    return submitData;
  }

  if (hasExistingSource(stored)) {
    writeUndergroundFlag(submitData, {
      ...stored,
      enabled: appearance.enabled,
      intactSrc: appearance.intactSrc || stored.intactSrc,
      dugSrc: appearance.dugSrc || stored.dugSrc,
      intactGrid: appearance.intactGrid,
      dugGrid: appearance.dugGrid
    });
    return submitData;
  }

  stripUndergroundKeys(submitData);
  return submitData;
}

/** Keep masks when a Scene update would replace underground terrain with appearance-only fields. */
export function preserveUndergroundMasks(scene, changes) {
  const incoming = changes?.flags?.[MODULE_ID]?.[UNDERGROUND_FLAG];
  if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) return;
  if (typeof incoming.sourceMask === "string") return;
  const stored = getStoredSource(scene);
  if (!hasExistingSource(stored)) return;
  changes.flags[MODULE_ID][UNDERGROUND_FLAG] = {
    ...stored,
    enabled: incoming.enabled ?? stored.enabled,
    intactSrc: incoming.intactSrc || stored.intactSrc,
    dugSrc: incoming.dugSrc || stored.dugSrc,
    intactGrid: positiveInteger(incoming.intactGrid, stored.intactGrid ?? 1),
    dugGrid: positiveInteger(incoming.dugGrid, stored.dugGrid ?? 1)
  };
}

function readUndergroundAppearance(submitData) {
  const nested = submitData?.flags?.[MODULE_ID]?.[UNDERGROUND_FLAG] ?? {};
  const enabled = firstDefined(
    submitData?.[UNDERGROUND_SCENE_FIELDS.enabled],
    nested.enabled
  );
  const intactSrc = firstDefined(
    submitData?.[UNDERGROUND_SCENE_FIELDS.intactSrc],
    nested.intactSrc
  );
  const dugSrc = firstDefined(
    submitData?.[UNDERGROUND_SCENE_FIELDS.dugSrc],
    nested.dugSrc
  );
  const intactGrid = firstDefined(
    submitData?.[UNDERGROUND_SCENE_FIELDS.intactGrid],
    nested.intactGrid
  );
  const dugGrid = firstDefined(
    submitData?.[UNDERGROUND_SCENE_FIELDS.dugGrid],
    nested.dugGrid
  );
  return {
    enabled: enabled === true || enabled === "true",
    intactSrc: typeof intactSrc === "string" ? intactSrc.trim() : "",
    dugSrc: typeof dugSrc === "string" ? dugSrc.trim() : "",
    intactGrid: positiveInteger(intactGrid, 1),
    dugGrid: positiveInteger(dugGrid, 1)
  };
}

async function renderUndergroundSceneConfig(application, element, context) {
  if (!globalThis.game?.user?.isGM || !isFeatureEnabled(FEATURES.breakableTerrain)) return;
  const root = element.querySelector(".standard-form.scrollable")
    ?? application.form
    ?? element.querySelector("form");
  if (!root || element.querySelector(".theiks-toolbag.underground-terrain")) return;

  const scene = context?.document ?? application.document;
  const data = getUndergroundSceneConfigData(scene);
  const html = await foundry.applications.handlebars.renderTemplate(TEMPLATE_PATH, {
    rootId: `${application.id}-theiks-underground`,
    fields: UNDERGROUND_SCENE_FIELDS,
    ...data
  });
  if (!isFeatureEnabled(FEATURES.breakableTerrain) || !application.rendered || !root.isConnected) return;

  const mounted = mountToolbagConfigTab({
    application,
    element,
    content: html,
    feature: FEATURES.breakableTerrain,
    nativeTab: "basic",
    nativeLabel: globalThis.game.i18n.localize("THEIKS_TOOLBAG.ConfigTabs.Scene"),
    nativeIcon: "fa-solid fa-map"
  });
  if (!mounted) return;

  const fieldset = mounted.panel.querySelector(".theiks-toolbag.underground-terrain");
  fieldset?.addEventListener("change", event => {
    if (event.target?.matches?.(`[name="${UNDERGROUND_SCENE_FIELDS.enabled}"]`)) {
      updateAppearanceVisibility(fieldset);
    }
  });
  updateAppearanceVisibility(fieldset);
  wrapSceneConfigSubmit(application);
  application.setPosition?.({height: "auto"});
}

function wrapSceneConfigSubmit(application) {
  if (!application || application[SUBMIT_WRAP]) return;
  const original = application._processSubmitData;
  if (typeof original !== "function") return;
  application[SUBMIT_WRAP] = true;
  application._processSubmitData = async function processUndergroundSubmit(event, form, submitData, options) {
    try {
      await applyUndergroundSceneSubmit(this.document, submitData);
    } catch (error) {
      globalThis.ui?.notifications?.error?.(error.message);
      throw error;
    }
    return original.call(this, event, form, submitData, options);
  };
}

function updateAppearanceVisibility(fieldset) {
  const enabled = fieldset?.querySelector(`[name="${UNDERGROUND_SCENE_FIELDS.enabled}"]`)?.checked === true;
  const appearance = fieldset?.querySelector("[data-underground-appearance]");
  if (appearance) appearance.hidden = !enabled;
}

function getStoredSource(scene) {
  const source = scene?.getFlag?.(MODULE_ID, UNDERGROUND_FLAG)
    ?? scene?.flags?.[MODULE_ID]?.[UNDERGROUND_FLAG];
  return source && typeof source === "object" && !Array.isArray(source) ? source : null;
}

function hasExistingSource(stored) {
  return typeof stored?.sourceMask === "string" && stored.sourceMask.length > 0;
}

function writeUndergroundFlag(submitData, source) {
  stripUndergroundKeys(submitData);
  if (!submitData.flags || typeof submitData.flags !== "object" || Array.isArray(submitData.flags)) {
    submitData.flags = {};
  }
  const moduleFlags = submitData.flags[MODULE_ID];
  if (!moduleFlags || typeof moduleFlags !== "object" || Array.isArray(moduleFlags)) {
    submitData.flags[MODULE_ID] = {[UNDERGROUND_FLAG]: source};
    return;
  }
  moduleFlags[UNDERGROUND_FLAG] = source;
}

function stripUndergroundKeys(submitData) {
  if (!submitData || typeof submitData !== "object") return;
  delete submitData[UNDERGROUND_FLAG_PATH];
  for (const key of Object.keys(submitData)) {
    if (key.startsWith(`${UNDERGROUND_FLAG_PATH}.`)) delete submitData[key];
  }
  const moduleFlags = submitData.flags?.[MODULE_ID];
  if (moduleFlags && typeof moduleFlags === "object") delete moduleFlags[UNDERGROUND_FLAG];
}

function firstDefined(...values) {
  return values.find(value => value !== undefined);
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) return fallback;
  return number;
}

function localize(key) {
  return globalThis.game?.i18n?.localize?.(`THEIKS_TOOLBAG.Underground.${key}`) ?? key;
}
