import assert from "node:assert/strict";

const hooks = new Map();
const featureSettings = {
  enableBreakableWalls: false,
  enableBreakableTerrain: false,
  enableVisibleLights: false
};
let templateRenders = 0;
let removedFieldsets = 0;

globalThis.Hooks = {
  on: (name, callback) => {
    const callbacks = hooks.get(name) ?? [];
    callbacks.push(callback);
    hooks.set(name, callbacks);
  },
  callAll: (name, ...args) => {
    for (const callback of hooks.get(name) ?? []) callback(...args);
  }
};
globalThis.game = {
  settings: {get: (_namespace, key) => featureSettings[key]}
};
globalThis.foundry = {
  applications: {
    handlebars: {
      renderTemplate: async () => {
        templateRenders += 1;
        return "<fieldset></fieldset>";
      }
    }
  }
};
globalThis.document = {
  querySelectorAll: () => [{remove: () => { removedFieldsets += 1; }}]
};

const {registerBreakableWallConfig} = await import("../scripts/breakable-walls/wall-config.js");
const {registerBreakableTerrainConfig} = await import("../scripts/breakable-terrain/terrain-config.js");
const {registerVisibleLightConfig} = await import("../scripts/visible-lights/light-config.js");

registerBreakableWallConfig();
registerBreakableTerrainConfig();
registerVisibleLightConfig();

const element = {
  querySelector: () => {
    throw new Error("disabled configuration hooks must return before inspecting the form");
  }
};
for (const [hook, feature] of [
  ["renderWallConfig", "breakableWalls"],
  ["renderTileConfig", "breakableTerrain"],
  ["renderAmbientLightConfig", "visibleLights"]
]) {
  for (const callback of hooks.get(hook) ?? []) await callback({}, element, {});
  Hooks.callAll("theiks-toolbag.featureSettingChanged", feature, false);
}

assert.equal(templateRenders, 0, "disabled features never render their configuration templates");
assert.equal(removedFieldsets, 3, "turning a feature off removes its fieldset from an already-open configuration");

console.log("feature visibility tests passed");
