import assert from "node:assert/strict";
import test from "node:test";

const hooks = new Map();
globalThis.Hooks = {on: (name, callback) => hooks.set(name, [...(hooks.get(name) ?? []), callback])};
class Field { constructor(options) { this.options = options; } }
globalThis.foundry = {
  data: {
    regionBehaviors: {RegionBehaviorType: class {}},
    fields: {StringField: Field, FilePathField: Field, ColorField: Field}
  }
};
globalThis.CONFIG = {RegionBehavior: {dataModels: {}, typeLabels: {}, typeHints: {}, typeIcons: {}}};

const {REGION_TYPE} = await import("../scripts/footprints/footprint-data.js");
const {registerFootprintConfig} = await import("../scripts/footprints/footprint-config.js");
registerFootprintConfig();

test("registers one footprint Region behavior with enablement, image, and tint", () => {
  const Behavior = CONFIG.RegionBehavior.dataModels[REGION_TYPE];
  assert.equal(typeof Behavior, "function");
  const schema = Behavior.defineSchema();
  assert.deepEqual(Object.keys(schema), ["mode", "image", "tint"]);
  assert.deepEqual(Object.keys(schema.mode.options.choices), ["inherit", "suppress", "enable", "situational"]);
  assert.deepEqual(schema.image.options.categories, ["IMAGE"]);
  assert.equal(CONFIG.RegionBehavior.typeLabels[REGION_TYPE], "THEIKS_TOOLBAG.Footprints.Region.Label");
});

test("registers Scene, Level, Token, and prototype Token configuration", () => {
  for (const hook of ["renderSceneConfig", "renderLevelConfig", "renderTokenConfig", "renderPrototypeTokenConfig"]) {
    assert.equal(hooks.get(hook)?.length, 1);
  }
});
