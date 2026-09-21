import assert from "node:assert/strict";
import test from "node:test";
import {readFileSync} from "node:fs";

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

test("Token gait controls and their labels are present in the shared config form", () => {
  const template = readFileSync(new URL("../templates/footprint-config.hbs", import.meta.url), "utf8");
  const language = JSON.parse(readFileSync(new URL("../lang/en.json", import.meta.url), "utf8"));
  const labels = language.THEIKS_TOOLBAG.Footprints.Config;
  for (const field of [
    "movementType", "alternateSide", "alternateImage", "frontImage",
    "frontAlternateSide", "frontAlternateImage"
  ]) {
    assert.ok(template.includes(`{{fields.${field}}}`), `${field} must submit as a Token flag`);
  }
  for (const key of [
    "MovementType", "Bipedal", "QuadrupedHop", "QuadrupedAlternating", "Slither", "AlternateSide",
    "NoAlternate", "Left", "Right", "AlternateImage", "FrontImage",
    "FrontAlternateSide", "NoFrontAlternate", "FrontAlternateImage"
  ]) assert.equal(typeof labels[key], "string", `${key} needs an English label`);
  assert.ok(template.includes('data-gait-field="feet"'));
  assert.ok(template.includes('data-gait-field="quadruped"'));
  assert.ok(template.includes('data-gait-field="front-alternate-image"'));
  assert.ok(template.includes('value="quadruped"'));
  assert.ok(template.includes('value="quadrupedAlternating"'));
});

test("the shared config form exposes inheritable timed fade fields", () => {
  const template = readFileSync(new URL("../templates/footprint-config.hbs", import.meta.url), "utf8");
  const language = JSON.parse(readFileSync(new URL("../lang/en.json", import.meta.url), "utf8"));
  for (const field of ["fadeMode", "fadeSeconds", "fadeUseWorldTime"]) {
    assert.ok(template.includes(`{{fields.${field}}}`));
  }
  for (const key of ["FadeMode", "FadeDistance", "FadeTime", "FadeBoth", "FadeSeconds", "FadeUseWorldTime"]) {
    assert.equal(typeof language.THEIKS_TOOLBAG.Footprints.Config[key], "string");
  }
  assert.ok(template.includes("{{fadeInheritLabel}}"));
  assert.equal(language.THEIKS_TOOLBAG.Footprints.Config.InheritWorld, "Inherit world setting");
  assert.equal(language.THEIKS_TOOLBAG.Footprints.Config.Inherit, "Inherit map setting");
  assert.equal(typeof language.THEIKS_TOOLBAG.Footprints.Config.InheritToken, "string");
  assert.ok(template.includes("data-fade-detail"));
});
