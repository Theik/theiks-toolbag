import {
  FEATURES,
  FEATURE_SETTING_CHANGED_HOOK,
  isFeatureEnabled
} from "../settings.js";
import {hasMultipleSceneLevels} from "../levels/level-tools.js";
import {mountToolbagConfigTab, removeToolbagConfigTabs} from "../config-tabs.js";
import {
  countUndergroundSubcells,
  getStoredUndergroundSource,
  getUndergroundData,
  MODULE_ID,
  preserveOverlappingDugMask,
  resolveUndergroundTextureSrc,
  UNDERGROUND_FLAG,
  UNDERGROUND_FLAG_PATH
} from "./underground-data.js";
import {createUndergroundSourceFromScene} from "./underground-occupancy.js";
import {openUndergroundProgressDialog} from "./underground-progress.js";

const TEMPLATE_PATH = `modules/${MODULE_ID}/templates/underground-scene-config.hbs`;
const SCENE_SUBMIT_WRAP = "_theiksUndergroundSubmitWrapped";
const LEVEL_SUBMIT_WRAP = "_theiksUndergroundLevelSubmitWrapped";

export const UNDERGROUND_SCENE_FIELDS = Object.freeze({
  enabled: `${UNDERGROUND_FLAG_PATH}.enabled`,
  intactSrc: `${UNDERGROUND_FLAG_PATH}.intactSrc`,
  dugSrc: `${UNDERGROUND_FLAG_PATH}.dugSrc`,
  intactGrid: `${UNDERGROUND_FLAG_PATH}.intactGrid`,
  dugGrid: `${UNDERGROUND_FLAG_PATH}.dugGrid`
});

/** Register Scene Config and Level Config authoring for virtual underground terrain. */
export function registerUndergroundSceneConfig() {
  Hooks.on("renderSceneConfig", renderUndergroundSceneConfig);
  Hooks.on("renderLevelConfig", renderUndergroundLevelConfig);
  Hooks.on("preUpdateScene", preserveUndergroundMasks);
  Hooks.on("preUpdateLevel", preserveUndergroundMasks);
  Hooks.on(FEATURE_SETTING_CHANGED_HOOK, (feature, enabled) => {
    if (feature !== FEATURES.diggableTerrain || enabled) return;
    removeToolbagConfigTabs(FEATURES.diggableTerrain);
  });
}

/** Scene Config only authors underground when the Scene has at most one Level. */
export function shouldShowSceneUndergroundConfig(scene) {
  return !hasMultipleSceneLevels(scene);
}

/** Read the form values for virtual underground on a Scene or Level. */
export function getUndergroundSceneConfigData(scene, {level} = {}) {
  const target = getAuthoringTarget(scene, level);
  let data = null;
  try {
    data = getUndergroundData(target.scene, {levelId: target.levelId, level: target.level});
  } catch (_error) {
    data = null;
  }
  const stored = resolveStoredSource(target);
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
 * One-Level Scenes write the source onto that Level and clear a legacy Scene flag.
 *
 * @param {object} scene
 * @param {object} submitData
 * @param {{sampleTileAlpha?: Function, getTextureSize?: Function, cells?: number[]}} [options]
 * @returns {Promise<object>}
 */
export async function applyUndergroundSceneSubmit(scene, submitData, options = {}) {
  const target = getAuthoringTarget(scene, options.level);
  return applyUndergroundAuthoringSubmit({
    owner: target.level && typeof target.level.update === "function" ? target.level : scene,
    scene,
    levelId: target.levelId,
    submitData,
    options,
    writeOwnerDirectly: Boolean(target.level && typeof target.level.update === "function")
  });
}

/** Expand Level Config submit data into a complete underground flag on that Level. */
export async function applyUndergroundLevelSubmit(level, submitData, options = {}) {
  const scene = options.scene ?? level?.parent;
  return applyUndergroundAuthoringSubmit({
    owner: level,
    scene,
    levelId: level?.id ?? level?._id,
    submitData,
    options,
    writeOwnerDirectly: false
  });
}

/** Keep masks when an update would replace underground terrain with appearance-only fields. */
export function preserveUndergroundMasks(document, changes) {
  const incoming = changes?.flags?.[MODULE_ID]?.[UNDERGROUND_FLAG];
  if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) return;
  const stored = getStoredUndergroundSource(document);
  if (!hasExistingSource(stored)) return;
  if (typeof incoming.sourceMask === "string" && typeof incoming.dugMask === "string") return;
  changes.flags[MODULE_ID][UNDERGROUND_FLAG] = {
    ...stored,
    enabled: incoming.enabled ?? stored.enabled,
    intactSrc: incoming.intactSrc || stored.intactSrc,
    dugSrc: incoming.dugSrc || stored.dugSrc,
    intactGrid: positiveInteger(incoming.intactGrid, stored.intactGrid ?? 1),
    dugGrid: positiveInteger(incoming.dugGrid, stored.dugGrid ?? 1),
    sourceMask: typeof incoming.sourceMask === "string" ? incoming.sourceMask : stored.sourceMask,
    dugMask: typeof incoming.dugMask === "string" ? incoming.dugMask : stored.dugMask
  };
}

async function applyUndergroundAuthoringSubmit({
  owner,
  scene,
  levelId,
  submitData,
  options,
  writeOwnerDirectly
}) {
  const appearance = readUndergroundAppearance(submitData);
  const stored = resolveStoredSource({scene, level: owner === scene ? null : owner, levelId});

  if (appearance.enabled && (!appearance.intactSrc || !appearance.dugSrc)) {
    throw new Error(localize("Errors.TexturesRequired"));
  }

  let source = null;
  if (needsOccupancyScan(stored, appearance)) {
    source = await createUndergroundSourceFromScene(scene, {
      ...appearance,
      levelId,
      level: owner === scene ? null : owner,
      sampleTileAlpha: options.sampleTileAlpha,
      getTextureSize: options.getTextureSize,
      cells: options.cells,
      signal: options.signal
    });
    if (hasExistingSource(stored)) {
      source = preserveOverlappingDugMask(source, stored, {
        scene,
        levelId,
        level: owner === scene ? null : owner
      });
    }
  } else if (hasExistingSource(stored)) {
    source = {
      ...stored,
      enabled: appearance.enabled,
      intactSrc: appearance.intactSrc || stored.intactSrc,
      dugSrc: appearance.dugSrc || stored.dugSrc,
      intactGrid: appearance.intactGrid,
      dugGrid: appearance.dugGrid,
      levelId: stored.levelId || levelId
    };
  }

  stripUndergroundKeys(submitData);
  if (!source) return submitData;

  if (writeOwnerDirectly) {
    markLegacySceneFlagRemoval(submitData, scene, levelId);
    await owner.update({[UNDERGROUND_FLAG_PATH]: source});
    return submitData;
  }

  writeUndergroundFlag(submitData, source);
  if (owner !== scene) await unsetLegacySceneFlag(scene, levelId);
  return submitData;
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
  const intact = typeof intactSrc === "string" ? intactSrc.trim() : "";
  const dug = typeof dugSrc === "string" ? dugSrc.trim() : "";
  return {
    enabled: enabled === true || enabled === "true",
    intactSrc: resolveUndergroundTextureSrc(intact, dug),
    dugSrc: resolveUndergroundTextureSrc(dug, intact),
    intactGrid: positiveInteger(intactGrid, 1),
    dugGrid: positiveInteger(dugGrid, 1)
  };
}

async function renderUndergroundSceneConfig(application, element, context) {
  if (!globalThis.game?.user?.isGM || !isFeatureEnabled(FEATURES.diggableTerrain)) return;
  const scene = context?.document ?? application.document;
  if (!shouldShowSceneUndergroundConfig(scene)) return;
  await mountUndergroundConfig({
    application,
    element,
    document: scene,
    nativeTab: "basic",
    nativeLabel: globalThis.game.i18n.localize("THEIKS_TOOLBAG.ConfigTabs.Scene"),
    nativeIcon: "fa-solid fa-map",
    wrapSubmit: wrapSceneConfigSubmit
  });
}

async function renderUndergroundLevelConfig(application, element, context) {
  if (!globalThis.game?.user?.isGM || !isFeatureEnabled(FEATURES.diggableTerrain)) return;
  const level = context?.document ?? application.document;
  await mountUndergroundConfig({
    application,
    element,
    document: level,
    scene: level?.parent,
    level,
    nativeLabel: globalThis.game.i18n.localize("THEIKS_TOOLBAG.ConfigTabs.Level"),
    nativeIcon: "fa-solid fa-layer-group",
    wrapSubmit: wrapLevelConfigSubmit
  });
}

async function mountUndergroundConfig({
  application,
  element,
  document,
  scene,
  level,
  nativeTab,
  nativeLabel,
  nativeIcon,
  wrapSubmit
}) {
  const root = element.querySelector(".standard-form.scrollable")
    ?? application.form
    ?? element.querySelector("form");
  if (!root || element.querySelector(".theiks-toolbag.underground-terrain")) return;

  const ownerScene = scene ?? document;
  const data = getUndergroundSceneConfigData(ownerScene, {level});
  const html = await foundry.applications.handlebars.renderTemplate(TEMPLATE_PATH, {
    rootId: `${application.id}-theiks-underground`,
    fields: UNDERGROUND_SCENE_FIELDS,
    ...data
  });
  if (!isFeatureEnabled(FEATURES.diggableTerrain) || !application.rendered || !root.isConnected) return;

  const mounted = mountToolbagConfigTab({
    application,
    element,
    content: html,
    feature: FEATURES.diggableTerrain,
    nativeTab,
    nativeLabel,
    nativeIcon
  });
  if (!mounted) return;

  const fieldset = mounted.panel.querySelector(".theiks-toolbag.underground-terrain");
  fieldset?.addEventListener("change", event => {
    if (event.target?.matches?.(`[name="${UNDERGROUND_SCENE_FIELDS.enabled}"]`)) {
      updateAppearanceVisibility(fieldset);
    }
  });
  updateAppearanceVisibility(fieldset);
  wrapSubmit(application);
  application.setPosition?.({height: "auto"});
}

function wrapSceneConfigSubmit(application) {
  if (!application || application[SCENE_SUBMIT_WRAP]) return;
  const original = application._processSubmitData;
  if (typeof original !== "function") return;
  application[SCENE_SUBMIT_WRAP] = true;
  application._processSubmitData = async function processUndergroundSubmit(event, form, submitData, options) {
    return submitUndergroundConfig({
      application: this,
      submitData,
      formOptions: options,
      event,
      form,
      original,
      apply: (data, scanOptions) => applyUndergroundSceneSubmit(this.document, data, scanOptions),
      stored: resolveStoredSource(getAuthoringTarget(this.document)),
      name: this.document?.name
    });
  };
}

function wrapLevelConfigSubmit(application) {
  if (!application || application[LEVEL_SUBMIT_WRAP]) return;
  const original = application._processSubmitData;
  if (typeof original !== "function") return;
  application[LEVEL_SUBMIT_WRAP] = true;
  application._processSubmitData = async function processUndergroundLevelSubmit(event, form, submitData, options) {
    const level = this.document;
    return submitUndergroundConfig({
      application: this,
      submitData,
      formOptions: options,
      event,
      form,
      original,
      apply: (data, scanOptions) => applyUndergroundLevelSubmit(level, data, {
        scene: level?.parent,
        ...scanOptions
      }),
      stored: resolveStoredSource({
        scene: level?.parent,
        level,
        levelId: level?.id ?? level?._id
      }),
      name: level?.name
    });
  };
}

async function submitUndergroundConfig({
  application,
  submitData,
  formOptions,
  event,
  form,
  original,
  apply,
  stored,
  name
}) {
  const appearance = readUndergroundAppearance(submitData);
  const scan = needsOccupancyScan(stored, appearance)
    && Boolean(appearance.intactSrc && appearance.dugSrc);
  const abortController = scan ? new AbortController() : null;
  let progress = null;
  try {
    if (scan) progress = await openUndergroundProgressDialog(name, abortController);
    await apply(submitData, scan ? {signal: abortController.signal} : {});
    progress?.setCreating?.();
    return await original.call(application, event, form, submitData, formOptions);
  } catch (error) {
    if (!isAbortError(error)) globalThis.ui?.notifications?.error?.(error.message);
    throw error;
  } finally {
    await progress?.finish?.();
  }
}

/** True when enabling should scan artwork instead of keeping a stored mask. */
export function needsOccupancyScan(stored, appearance) {
  if (!appearance?.enabled) return false;
  if (!hasExistingSource(stored)) return true;
  return stored.enabled === false;
}

function isAbortError(error) {
  return error?.name === "AbortError";
}

function updateAppearanceVisibility(fieldset) {
  const enabled = fieldset?.querySelector(`[name="${UNDERGROUND_SCENE_FIELDS.enabled}"]`)?.checked === true;
  const appearance = fieldset?.querySelector("[data-underground-appearance]");
  if (appearance) appearance.hidden = !enabled;
}

function getAuthoringTarget(scene, level) {
  if (level) {
    return {
      scene: level.parent ?? scene,
      level,
      levelId: level.id ?? level._id ?? null
    };
  }
  const levels = sceneLevels(scene);
  if (levels.length === 1) {
    const only = levels[0];
    return {scene, level: only, levelId: only.id ?? only._id ?? null};
  }
  return {scene, level: null, levelId: scene?.initialLevel ?? null};
}

function sceneLevels(scene) {
  if (!scene?.levels) return [];
  if (Array.isArray(scene.levels.contents)) return scene.levels.contents;
  if (typeof scene.levels.values === "function") return Array.from(scene.levels.values());
  return Array.from(scene.levels ?? []);
}

function resolveStoredSource({scene, level, levelId}) {
  const fromLevel = getStoredUndergroundSource(level);
  if (hasExistingSource(fromLevel)) return fromLevel;
  const fromScene = getStoredUndergroundSource(scene);
  if (!hasExistingSource(fromScene)) return fromLevel;
  if (!levelId || !scene?.levels || fromScene.levelId === levelId) return fromScene;
  return fromLevel;
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
  if (moduleFlags && typeof moduleFlags === "object") {
    delete moduleFlags[UNDERGROUND_FLAG];
    delete moduleFlags[`-=${UNDERGROUND_FLAG}`];
  }
}

function markLegacySceneFlagRemoval(submitData, scene, levelId) {
  const stored = getStoredUndergroundSource(scene);
  if (!hasExistingSource(stored)) return;
  if (levelId && stored.levelId && stored.levelId !== levelId) return;
  if (!submitData.flags || typeof submitData.flags !== "object" || Array.isArray(submitData.flags)) {
    submitData.flags = {};
  }
  const moduleFlags = submitData.flags[MODULE_ID];
  if (!moduleFlags || typeof moduleFlags !== "object" || Array.isArray(moduleFlags)) {
    submitData.flags[MODULE_ID] = {[`-=${UNDERGROUND_FLAG}`]: null};
    return;
  }
  moduleFlags[`-=${UNDERGROUND_FLAG}`] = null;
}

async function unsetLegacySceneFlag(scene, levelId) {
  const stored = getStoredUndergroundSource(scene);
  if (!hasExistingSource(stored)) return;
  if (levelId && stored.levelId && stored.levelId !== levelId) return;
  if (typeof scene?.unsetFlag === "function") {
    await scene.unsetFlag(MODULE_ID, UNDERGROUND_FLAG);
    return;
  }
  if (typeof scene?.update === "function") {
    await scene.update({[`flags.${MODULE_ID}.-=${UNDERGROUND_FLAG}`]: null});
  }
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
