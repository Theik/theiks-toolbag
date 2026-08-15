import {
  EVENT_NAMES_BY_ALIAS,
  SCRIPT_BEHAVIOR_TYPE,
  eventBehaviorCollectionsEqual,
  validateEventBehaviorCollection
} from "./script-events.js";

const MODULE_ID = "theiks-toolbag";
const LIST_TEMPLATE = `modules/${MODULE_ID}/templates/script-behavior-list.hbs`;
const EDITOR_TEMPLATE = `modules/${MODULE_ID}/templates/script-behavior-config.hbs`;
const paletteStores = new WeakMap();
const paletteForms = new WeakSet();
const openEditors = new Map();

/**
 * Mount a Region-style script behavior list into one Toolbag configuration panel.
 * Normal sheets persist immediately; palettes retain a draft for their normal Apply workflow.
 */
export async function mountScriptBehaviorList({
  application,
  host,
  document,
  alias,
  feature,
  behaviorField,
  legacyDeleteField,
  behaviors,
  selectedBehaviorLists = [],
  getUnavailableEvents = () => []
}) {
  if (!host || host.dataset.toolbagBehaviorsMounted === "true") return null;
  host.dataset.toolbagBehaviorsMounted = "true";

  const palette = isPlaceablePalette(application);
  const mixed = palette && application.isSelect && selectedBehaviorLists.length > 1
    && !selectedBehaviorLists.every(value => eventBehaviorCollectionsEqual(value, selectedBehaviorLists[0]));
  const store = {
    application,
    host,
    document,
    alias,
    feature,
    behaviorField,
    legacyDeleteField,
    getUnavailableEvents,
    palette,
    mixed,
    dirty: false,
    current: cloneBehaviors(behaviors)
  };

  if (palette) registerPaletteStore(store);
  host.addEventListener("click", event => void handleBehaviorAction(event, store));
  await renderBehaviorList(store);
  return store;
}

/** Close behavior editors belonging to a disabled feature. */
export function closeScriptBehaviorEditors(feature) {
  const editors = openEditors.get(feature);
  if (!editors) return;
  for (const editor of [...editors]) void editor.close?.();
  openEditors.delete(feature);
}

/** Return whether every selected document has the same normalized behavior list. */
export function hasIdenticalBehaviorLists(lists) {
  return lists.length < 2 || lists.every(value => eventBehaviorCollectionsEqual(value, lists[0]));
}

async function handleBehaviorAction(event, store) {
  const control = event.target.closest?.("[data-toolbag-behavior-action]");
  if (!control || store.mixed || control.disabled) return;
  event.preventDefault();
  event.stopPropagation();
  const action = control.dataset.toolbagBehaviorAction;
  const row = control.closest?.("[data-toolbag-behavior-id]");
  const id = row?.dataset.toolbagBehaviorId;

  try {
    switch (action) {
      case "add": {
        const behavior = await promptScriptBehavior(store, createBehavior(store.current));
        if (!behavior) return;
        await persistBehaviors(store, [...store.current, behavior]);
        break;
      }
      case "edit": {
        const existing = store.current.find(behavior => behavior.id === id);
        if (!existing) return;
        const behavior = await promptScriptBehavior(store, existing);
        if (!behavior) return;
        await persistBehaviors(store, store.current.map(value => value.id === id ? behavior : value));
        break;
      }
      case "toggle":
        await persistBehaviors(store, store.current.map(behavior => behavior.id === id
          ? {...behavior, disabled: !behavior.disabled}
          : behavior));
        break;
      case "delete": {
        const existing = store.current.find(behavior => behavior.id === id);
        if (!existing || !await confirmBehaviorDeletion(existing)) return;
        await persistBehaviors(store, store.current.filter(behavior => behavior.id !== id));
        break;
      }
    }
  } catch (error) {
    globalThis.ui?.notifications?.error?.(error?.message ?? String(error));
    console.error(`${MODULE_ID} | Script behavior ${action} failed`, error);
  }
}

async function persistBehaviors(store, proposed) {
  const behaviors = validateEventBehaviorCollection(proposed, {alias: store.alias});
  if (store.palette) {
    store.current = cloneBehaviors(behaviors);
    store.dirty = true;
  } else {
    const updated = await store.document.update({
      [store.behaviorField]: behaviors,
      [store.legacyDeleteField]: null
    }, {render: false});
    if (!updated) throw new Error(localize("Errors.UpdateFailed"));
    store.current = cloneBehaviors(behaviors);
  }
  await renderBehaviorList(store);
  if (store.palette) markPaletteDirty(store);
}

async function renderBehaviorList(store) {
  const behaviors = cloneBehaviors(store.current)
    .sort((left, right) => Number(left.disabled) - Number(right.disabled)
      || left.name.localeCompare(right.name, globalThis.game?.i18n?.lang));
  const html = await globalThis.foundry.applications.handlebars.renderTemplate(LIST_TEMPLATE, {
    mixed: store.mixed,
    editable: !store.mixed,
    palette: store.palette,
    behaviorField: store.behaviorField,
    behaviors: behaviors.map(behavior => ({
      ...behavior,
      eventLabels: behavior.events.map(eventLabel).join(", ") || localize("NoEvents")
    }))
  });
  store.host.innerHTML = html;
  store.application?.setPosition?.({height: "auto"});
}

async function promptScriptBehavior(store, behavior) {
  const unavailable = new Set(store.getUnavailableEvents?.() ?? []);
  const selected = new Set(behavior.events);
  const html = await globalThis.foundry.applications.handlebars.renderTemplate(EDITOR_TEMPLATE, {
    behavior,
    events: EVENT_NAMES_BY_ALIAS[store.alias].map(value => ({
      value,
      label: eventLabel(value),
      selected: selected.has(value),
      disabled: unavailable.has(value)
    }))
  });
  const DialogV2 = globalThis.foundry.applications.api.DialogV2;

  return await new Promise(resolve => {
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const dialog = new DialogV2({
      window: {
        title: behavior.name || localize("ExecuteScript"),
        icon: "fa-solid fa-code"
      },
      classes: ["theiks-toolbag", "script-behavior-config"],
      position: {width: 520},
      content: html,
      form: {closeOnSubmit: false},
      buttons: [{
        action: "save",
        label: localize("Save"),
        icon: "fa-solid fa-floppy-disk",
        default: true,
        callback: async (_event, button, application) => {
          try {
            const form = button.form;
            const candidate = validateEventBehaviorCollection([{
              id: behavior.id,
              type: SCRIPT_BEHAVIOR_TYPE,
              name: form.elements.name?.value ?? "",
              disabled: form.elements.disabled?.checked === true,
              events: Array.from(form.elements.events?.value ?? []),
              source: form.elements.source?.value ?? ""
            }], {alias: store.alias})[0];
            finish(candidate);
            await application.close({submitted: true});
            return candidate;
          } catch (error) {
            const message = globalThis.game?.i18n?.format?.("THEIKS_TOOLBAG.EventBehaviors.Errors.Invalid", {
              name: behavior.name || localize("ExecuteScript"),
              error: error.message
            }) ?? error.message;
            globalThis.ui?.notifications?.error?.(message);
            application.element?.querySelector?.('[name="source"]')?.focus?.();
            return undefined;
          }
        }
      }, {
        action: "cancel",
        label: localize("Cancel"),
        icon: "fa-solid fa-xmark",
        type: "button",
        callback: async (_event, _button, application) => {
          finish(null);
          await application.close();
          return null;
        }
      }]
    });

    registerOpenEditor(store.feature, dialog);
    dialog.addEventListener("close", () => {
      unregisterOpenEditor(store.feature, dialog);
      finish(null);
    }, {once: true});
    dialog.render({force: true});
  });
}

async function confirmBehaviorDeletion(behavior) {
  return await globalThis.foundry.applications.api.DialogV2.confirm({
    window: {title: localize("DeleteTitle")},
    content: `<p>${format("DeleteConfirm", {name: escapeHTML(behavior.name)})}</p>`,
    yes: {label: localize("Delete"), icon: "fa-solid fa-trash"},
    no: {label: localize("Cancel"), icon: "fa-solid fa-xmark"},
    rejectClose: false,
    modal: true
  });
}

function registerPaletteStore(store) {
  let stores = paletteStores.get(store.application);
  if (!stores) paletteStores.set(store.application, stores = new Map());
  stores.set(store.behaviorField, store);

  const form = store.application.form ?? store.application.element?.querySelector?.("form");
  if (!form || paletteForms.has(form)) return;
  paletteForms.add(form);
  form.addEventListener("formdata", event => {
    for (const currentStore of paletteStores.get(store.application)?.values?.() ?? []) {
      if (currentStore.mixed) continue;
      event.formData.set(currentStore.behaviorField, cloneBehaviors(currentStore.current));
      if (currentStore.dirty) event.formData.set(currentStore.legacyDeleteField, null);
    }
  });
}

function markPaletteDirty(store) {
  const {application} = store;
  if (application.isSelect) {
    application._dirtyFields?.add(store.behaviorField);
    application._dirtyFields?.add(store.legacyDeleteField);
    application.element?.querySelector?.('button[type="submit"]')?.removeAttribute?.("hidden");
    return;
  }
  const input = store.host.querySelector?.(`[name="${store.behaviorField}"]`);
  input?.dispatchEvent?.(new Event("change", {bubbles: true}));
}

function createBehavior(existing) {
  const ids = new Set(existing.map(behavior => behavior.id));
  let id;
  do id = randomID(); while (ids.has(id));
  return {
    id,
    type: SCRIPT_BEHAVIOR_TYPE,
    name: localize("ExecuteScript"),
    disabled: false,
    events: [],
    source: ""
  };
}

function registerOpenEditor(feature, editor) {
  let editors = openEditors.get(feature);
  if (!editors) openEditors.set(feature, editors = new Set());
  editors.add(editor);
}

function unregisterOpenEditor(feature, editor) {
  const editors = openEditors.get(feature);
  editors?.delete(editor);
  if (!editors?.size) openEditors.delete(feature);
}

function cloneBehaviors(behaviors) {
  return (behaviors ?? []).map(behavior => ({...behavior, events: [...behavior.events]}));
}

function isPlaceablePalette(application) {
  return application && ("_dirtyFields" in application) && (typeof application.isSelect === "boolean");
}

function randomID() {
  return globalThis.foundry?.utils?.randomID?.()
    ?? globalThis.crypto?.randomUUID?.().replaceAll("-", "").slice(0, 16)
    ?? Math.random().toString(36).slice(2, 18);
}

function eventLabel(eventName) {
  return localize(`Events.${eventName}`);
}

function escapeHTML(value) {
  return globalThis.foundry?.utils?.escapeHTML?.(String(value ?? "")) ?? String(value ?? "");
}

function format(key, data) {
  return globalThis.game?.i18n?.format?.(`THEIKS_TOOLBAG.EventBehaviors.${key}`, data)
    ?? localize(key);
}

function localize(key) {
  return globalThis.game?.i18n?.localize?.(`THEIKS_TOOLBAG.EventBehaviors.${key}`)
    ?? `THEIKS_TOOLBAG.EventBehaviors.${key}`;
}
