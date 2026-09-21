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
  getFootprintFadeSettings,
  getFootprintCutoff,
  isFeatureEnabled,
  registerFeatureSettings
} = await import("../scripts/settings.js");

registerFeatureSettings();
assert.equal(registrations.size, 13);
for (const [key, definition] of registrations) {
  if (!key.split(".").at(-1).startsWith("enable")) continue;
  assert.equal(definition.scope, "world");
  assert.equal(definition.config, true);
  assert.equal(definition.type, Boolean);
  assert.equal(definition.default, true);
}
assert.equal(isFeatureEnabled(FEATURES.breakableWalls), true);
assert.equal(isFeatureEnabled(FEATURES.breakableTerrain), true);
assert.equal(isFeatureEnabled(FEATURES.diggableTerrain), true);
assert.equal(isFeatureEnabled(FEATURES.visibleLights), true);
assert.equal(isFeatureEnabled(FEATURES.usableTiles), true);
assert.equal(isFeatureEnabled(FEATURES.footprints), true);
assert.equal(isFeatureEnabled(FEATURES.levelTools), true);
assert.equal(isFeatureEnabled(FEATURES.fallingMessages), true);

const settingKeys = Array.from(registrations.keys());
assert.equal(settingKeys.indexOf("theiks-toolbag.defaultFootprintImage"),
  settingKeys.indexOf("theiks-toolbag.enableFootprints") + 1);
assert.equal(registrations.get("theiks-toolbag.footprintCutoff").scope, "client");
assert.deepEqual(registrations.get("theiks-toolbag.footprintCutoff").range, {min: 0, max: 100, step: 1});
assert.equal(registrations.get("theiks-toolbag.footprintCutoff").default, 15);
assert.deepEqual(getFootprintFadeSettings(), {mode: "distance", seconds: 60, useWorldTime: false});
for (const key of ["footprintFadeMode", "footprintFadeSeconds", "footprintFadeUseWorldTime"]) {
  assert.equal(registrations.get(`theiks-toolbag.${key}`).scope, "world");
}
values.set("theiks-toolbag.footprintFadeMode", "both");
values.set("theiks-toolbag.footprintFadeSeconds", 30);
values.set("theiks-toolbag.footprintFadeUseWorldTime", true);
assert.deepEqual(getFootprintFadeSettings(), {mode: "both", seconds: 30, useWorldTime: true});
values.set("theiks-toolbag.footprintFadeSeconds", 0);
assert.equal(getFootprintFadeSettings().seconds, 60);
assert.equal(getFootprintCutoff(), 15);
values.set("theiks-toolbag.footprintCutoff", Number.NaN);
assert.equal(getFootprintCutoff(), 15);
assert.equal(
  settingKeys.indexOf("theiks-toolbag.enableDiggableTerrain"),
  settingKeys.indexOf("theiks-toolbag.enableBreakableTerrain") + 1,
  "diggable terrain is registered directly beneath Breakable Terrain"
);
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
