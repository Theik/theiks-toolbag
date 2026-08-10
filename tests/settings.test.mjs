import assert from "node:assert/strict";

const registrations = new Map();
const values = new Map();
const hookCalls = [];
let controlRenderOptions = null;

globalThis.game = {
  settings: {
    register: (namespace, key, definition) => {
      registrations.set(`${namespace}.${key}`, definition);
      values.set(`${namespace}.${key}`, definition.default);
    },
    get: (namespace, key) => values.get(`${namespace}.${key}`)
  },
  i18n: {
    localize: key => key,
    format: (key, data) => `${key}:${data.feature}`
  }
};
globalThis.Hooks = {callAll: (...args) => hookCalls.push(args)};
globalThis.ui = {controls: {render: options => { controlRenderOptions = options; }}};

const {
  FEATURES,
  FEATURE_SETTING_CHANGED_HOOK,
  assertFeatureEnabled,
  isFeatureEnabled,
  registerFeatureSettings
} = await import("../scripts/settings.js");

registerFeatureSettings();
assert.equal(registrations.size, 5);
for (const definition of registrations.values()) {
  assert.equal(definition.scope, "world");
  assert.equal(definition.config, true);
  assert.equal(definition.type, Boolean);
  assert.equal(definition.default, true);
}
assert.equal(isFeatureEnabled(FEATURES.breakableWalls), true);
assert.equal(isFeatureEnabled(FEATURES.breakableTerrain), true);
assert.equal(isFeatureEnabled(FEATURES.visibleLights), true);
assert.equal(isFeatureEnabled(FEATURES.levelTools), true);
assert.equal(isFeatureEnabled(FEATURES.fallingMessages), true);

const settingKeys = Array.from(registrations.keys());
assert.equal(
  settingKeys.indexOf("theiks-toolbag.enableFallingMessages"),
  settingKeys.indexOf("theiks-toolbag.enableLevelTools") + 1,
  "falling messages are registered directly beneath Level Tools"
);

const visibleLightsKey = "theiks-toolbag.enableVisibleLights";
values.set(visibleLightsKey, false);
assert.equal(isFeatureEnabled(FEATURES.visibleLights), false);
assert.throws(() => assertFeatureEnabled(FEATURES.visibleLights), /Settings\.Disabled/);

registrations.get(visibleLightsKey).onChange(false);
assert.deepEqual(hookCalls.at(-1), [FEATURE_SETTING_CHANGED_HOOK, FEATURES.visibleLights, false]);
assert.deepEqual(controlRenderOptions, {reset: true});

console.log("feature settings tests passed");
