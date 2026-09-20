export const MODULE_ID = "theiks-toolbag";

export const FEATURES = Object.freeze({
  breakableWalls: "breakableWalls",
  breakableTerrain: "breakableTerrain",
  diggableTerrain: "diggableTerrain",
  visibleLights: "visibleLights",
  usableTiles: "usableTiles",
  footprints: "footprints",
  levelTools: "levelTools",
  fallingMessages: "fallingMessages"
});

export const FEATURE_SETTING_CHANGED_HOOK = `${MODULE_ID}.featureSettingChanged`;

const DEFINITIONS = Object.freeze({
  [FEATURES.breakableWalls]: {
    key: "enableBreakableWalls",
    name: "THEIKS_TOOLBAG.Settings.BreakableWalls.Name",
    hint: "THEIKS_TOOLBAG.Settings.BreakableWalls.Hint"
  },
  [FEATURES.breakableTerrain]: {
    key: "enableBreakableTerrain",
    name: "THEIKS_TOOLBAG.Settings.BreakableTerrain.Name",
    hint: "THEIKS_TOOLBAG.Settings.BreakableTerrain.Hint"
  },
  [FEATURES.diggableTerrain]: {
    key: "enableDiggableTerrain",
    name: "THEIKS_TOOLBAG.Settings.DiggableTerrain.Name",
    hint: "THEIKS_TOOLBAG.Settings.DiggableTerrain.Hint"
  },
  [FEATURES.visibleLights]: {
    key: "enableVisibleLights",
    name: "THEIKS_TOOLBAG.Settings.VisibleLights.Name",
    hint: "THEIKS_TOOLBAG.Settings.VisibleLights.Hint"
  },
  [FEATURES.usableTiles]: {
    key: "enableUsableTiles",
    name: "THEIKS_TOOLBAG.Settings.UsableTiles.Name",
    hint: "THEIKS_TOOLBAG.Settings.UsableTiles.Hint"
  },
  [FEATURES.footprints]: {
    key: "enableFootprints",
    name: "THEIKS_TOOLBAG.Settings.Footprints.Name",
    hint: "THEIKS_TOOLBAG.Settings.Footprints.Hint"
  },
  [FEATURES.levelTools]: {
    key: "enableLevelTools",
    name: "THEIKS_TOOLBAG.Settings.LevelTools.Name",
    hint: "THEIKS_TOOLBAG.Settings.LevelTools.Hint"
  },
  [FEATURES.fallingMessages]: {
    key: "enableFallingMessages",
    name: "THEIKS_TOOLBAG.Settings.FallingMessages.Name",
    hint: "THEIKS_TOOLBAG.Settings.FallingMessages.Hint"
  }
});

/** Register the world-level feature switches displayed in Theik's Toolbag's settings category. */
export function registerFeatureSettings() {
  for (const [feature, definition] of Object.entries(DEFINITIONS)) {
    game.settings.register(MODULE_ID, definition.key, {
      name: definition.name,
      hint: definition.hint,
      scope: "world",
      config: true,
      type: Boolean,
      default: true,
      onChange: enabled => handleFeatureSettingChange(feature, enabled === true)
    });
    if (feature === FEATURES.footprints) registerFootprintSettings();
  }
}

export const DEFAULT_FOOTPRINT_IMAGE = `modules/${MODULE_ID}/assets/images/extras/footprint.png`;
export const FOOTPRINT_IMAGE_SETTING_CHANGED_HOOK = `${MODULE_ID}.footprintImageChanged`;
export const FOOTPRINT_CUTOFF_CHANGED_HOOK = `${MODULE_ID}.footprintCutoffChanged`;

function registerFootprintSettings() {
  const ImageField = globalThis.foundry?.data?.fields?.FilePathField;
  game.settings.register(MODULE_ID, "defaultFootprintImage", {
    name: "THEIKS_TOOLBAG.Settings.Footprints.ImageName",
    hint: "THEIKS_TOOLBAG.Settings.Footprints.ImageHint",
    scope: "world", config: true,
    type: ImageField ? new ImageField({categories: ["IMAGE"]}) : String,
    default: DEFAULT_FOOTPRINT_IMAGE,
    onChange: () => Hooks.callAll(FOOTPRINT_IMAGE_SETTING_CHANGED_HOOK)
  });
  game.settings.register(MODULE_ID, "footprintCutoff", {
    name: "THEIKS_TOOLBAG.Settings.Footprints.CutoffName",
    hint: "THEIKS_TOOLBAG.Settings.Footprints.CutoffHint",
    scope: "client", config: true, type: Number, range: {min: 0, max: 100, step: 1},
    default: 15,
    onChange: () => Hooks.callAll(FOOTPRINT_CUTOFF_CHANGED_HOOK)
  });
}

export function getFootprintImageSetting() {
  try { return game.settings.get(MODULE_ID, "defaultFootprintImage") || DEFAULT_FOOTPRINT_IMAGE; }
  catch (_error) { return DEFAULT_FOOTPRINT_IMAGE; }
}

export function getFootprintCutoff() {
  let value = 15;
  try { value = Number(game.settings.get(MODULE_ID, "footprintCutoff")); }
  catch (_error) { /* use the default */ }
  return Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) : 15;
}

/** Feature settings fail open during early initialization and in lightweight test environments. */
export function isFeatureEnabled(feature) {
  const definition = DEFINITIONS[feature];
  if (!definition) return false;
  try {
    return game.settings?.get?.(MODULE_ID, definition.key) !== false;
  } catch (_error) {
    return true;
  }
}

/** Reject an interactive or macro action while its owning feature is switched off. */
export function assertFeatureEnabled(feature) {
  if (isFeatureEnabled(feature)) return;
  throw createFeatureDisabledError(feature);
}

export function createFeatureDisabledError(feature) {
  const definition = DEFINITIONS[feature];
  const name = game.i18n.localize(definition.name);
  return new Error(game.i18n.format("THEIKS_TOOLBAG.Settings.Disabled", {feature: name}));
}

function handleFeatureSettingChange(feature, enabled) {
  Hooks.callAll(FEATURE_SETTING_CHANGED_HOOK, feature, enabled);
  try {
    const render = ui.controls?.render?.({reset: true});
    Promise.resolve(render).catch(error => {
      console.error(`${MODULE_ID} | Failed to refresh Scene Controls after a feature setting changed`, error);
    });
  } catch (error) {
    console.error(`${MODULE_ID} | Failed to refresh Scene Controls after a feature setting changed`, error);
  }
}
