import {FEATURES, FEATURE_SETTING_CHANGED_HOOK, isFeatureEnabled} from "../settings.js";
import {mountToolbagConfigTab, removeToolbagConfigTabs} from "../config-tabs.js";
import {CONFIG_FLAG, MODULE_ID, REGION_TYPE, getSceneFootprintConfig, getTokenFootprintConfig} from "./footprint-data.js";
import {clearSceneFootprints} from "./footprint-runtime.js";

const TEMPLATE = `modules/${MODULE_ID}/templates/footprint-config.hbs`;
const PREFIX = `flags.${MODULE_ID}.${CONFIG_FLAG}`;
const FIELDS = Object.freeze({
  enabled: `${PREFIX}.enabled`, image: `${PREFIX}.image`, tint: `${PREFIX}.tint`,
  tintOverride: `${PREFIX}.tintOverride`, noFootprints: `${PREFIX}.noFootprints`
});

export function registerFootprintConfig() {
  Hooks.on("renderSceneConfig", (app, element, context) => renderConfig(app, element, context, "scene"));
  Hooks.on("renderLevelConfig", (app, element, context) => renderConfig(app, element, context, "level"));
  Hooks.on("renderTokenConfig", (app, element, context) => renderConfig(app, element, context, "token"));
  Hooks.on("renderPrototypeTokenConfig", (app, element, context) => renderConfig(app, element, context, "prototype"));
  Hooks.on(FEATURE_SETTING_CHANGED_HOOK, (feature, enabled) => {
    if (feature === FEATURES.footprints && !enabled) removeToolbagConfigTabs(FEATURES.footprints);
  });
  registerFootprintRegionBehavior();
}

async function renderConfig(application, element, context, kind) {
  if (!isFeatureEnabled(FEATURES.footprints)) return;
  if ((kind === "scene" || kind === "level") && !game.user?.isGM) return;
  const root = element.querySelector(".standard-form.scrollable") ?? application.form ?? element.querySelector("form");
  if (!root || element.querySelector(`.theiks-toolbag.footprints[data-kind="${kind}"]`)) return;
  const document = kind === "prototype"
    ? context?.token ?? application.token ?? application.actor?.prototypeToken
    : context?.document ?? application.document;
  const stored = document?.getFlag?.(MODULE_ID, CONFIG_FLAG) ?? document?.flags?.[MODULE_ID]?.[CONFIG_FLAG] ?? {};
  const sceneConfig = kind === "scene" ? getSceneFootprintConfig(document) : null;
  const tokenConfig = kind === "token" || kind === "prototype" ? getTokenFootprintConfig(document) : null;
  const html = await foundry.applications.handlebars.renderTemplate(TEMPLATE, {
    kind, isScene: kind === "scene", isLevel: kind === "level", isToken: Boolean(tokenConfig),
    fields: FIELDS, rootId: `${application.id}-footprints`,
    enabled: sceneConfig?.enabled,
    levelEnabled: ["true", "false"].includes(stored.enabled) ? stored.enabled : "inherit",
    image: stored.image ?? "", tint: stored.tint ?? "#ffffff",
    tintOverride: stored.tintOverride === true,
    noFootprints: tokenConfig?.noFootprints,
    canClear: kind === "scene" && Boolean(document?.id)
  });
  if (!isFeatureEnabled(FEATURES.footprints) || !application.rendered || !root.isConnected) return;
  const mounted = mountToolbagConfigTab({
    application, element, content: html, feature: FEATURES.footprints,
    nativeTab: kind === "scene" ? "basic" : undefined,
    nativeLabel: game.i18n.localize(`THEIKS_TOOLBAG.ConfigTabs.${kind === "scene" ? "Scene" : kind === "level" ? "Level" : "Token"}`),
    nativeIcon: kind === "scene" ? "fa-solid fa-map" : kind === "level" ? "fa-solid fa-layer-group" : "fa-solid fa-user"
  });
  const fieldset = mounted?.panel?.querySelector(`.theiks-toolbag.footprints[data-kind="${kind}"]`);
  fieldset?.querySelector("[data-action='clear-footprints']")?.addEventListener("click", async event => {
    event.preventDefault();
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: {title: game.i18n.localize("THEIKS_TOOLBAG.Footprints.Config.Clear")},
      content: `<p>${game.i18n.localize("THEIKS_TOOLBAG.Footprints.Config.ClearHint")}</p>`,
      yes: {label: game.i18n.localize("THEIKS_TOOLBAG.Footprints.Config.Clear"), icon: "fa-solid fa-eraser"},
      rejectClose: false,
      modal: true
    });
    if (!confirmed) return;
    await clearSceneFootprints(document);
    ui.notifications.info(game.i18n.localize("THEIKS_TOOLBAG.Footprints.Cleared"));
  });
  const tintInput = fieldset?.querySelector("[data-tint-input]");
  const picker = fieldset?.querySelector("[data-tint-picker]");
  picker?.addEventListener("input", () => { tintInput.value = picker.value; });
  tintInput?.addEventListener("change", () => {
    if (/^#[\da-f]{6}$/i.test(tintInput.value)) picker.value = tintInput.value;
  });
  application.setPosition?.({height: "auto"});
}

function registerFootprintRegionBehavior() {
  const Base = globalThis.foundry?.data?.regionBehaviors?.RegionBehaviorType ?? class {};
  const fields = globalThis.foundry?.data?.fields;
  class FootprintRegionBehaviorType extends Base {
    static LOCALIZATION_PREFIXES = ["THEIKS_TOOLBAG.Footprints.Region"];
    static defineSchema() {
      if (!fields) return {};
      return {
        mode: new fields.StringField({
          required: true, initial: "inherit",
          choices: {
            inherit: "THEIKS_TOOLBAG.Footprints.Region.Modes.Inherit",
            suppress: "THEIKS_TOOLBAG.Footprints.Region.Modes.Suppress",
            enable: "THEIKS_TOOLBAG.Footprints.Region.Modes.Enable",
            situational: "THEIKS_TOOLBAG.Footprints.Region.Modes.Situational"
          }
        }),
        image: new fields.FilePathField({required: true, blank: true, nullable: true, initial: null, categories: ["IMAGE"]}),
        tint: new fields.ColorField({required: true, blank: true, nullable: true, initial: null})
      };
    }
  }
  const config = globalThis.CONFIG?.RegionBehavior;
  if (!config) return;
  config.dataModels ??= {};
  config.typeLabels ??= {};
  config.typeHints ??= {};
  config.typeIcons ??= {};
  config.dataModels[REGION_TYPE] = FootprintRegionBehaviorType;
  config.typeLabels[REGION_TYPE] = "THEIKS_TOOLBAG.Footprints.Region.Label";
  config.typeHints[REGION_TYPE] = "THEIKS_TOOLBAG.Footprints.Region.Hint";
  config.typeIcons[REGION_TYPE] = "fa-solid fa-shoe-prints";
}
