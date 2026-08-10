export const MODULE_ID = "theiks-toolbag";

export const FEATURES = Object.freeze({
  breakableWalls: "breakableWalls",
  breakableTerrain: "breakableTerrain",
  visibleLights: "visibleLights",
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
  [FEATURES.visibleLights]: {
    key: "enableVisibleLights",
    name: "THEIKS_TOOLBAG.Settings.VisibleLights.Name",
    hint: "THEIKS_TOOLBAG.Settings.VisibleLights.Hint"
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
  }
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
