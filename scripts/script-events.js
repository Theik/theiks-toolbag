export const MODULE_ID = "theiks-toolbag";
export const SCRIPT_BEHAVIOR_TYPE = "executeScript";

export const EVENT_NAMES_BY_ALIAS = Object.freeze({
  light: Object.freeze(["toggledOn", "toggledOff", "destroyed", "repaired"]),
  wall: Object.freeze(["destroyed", "repaired"]),
  tile: Object.freeze(["damaged", "destroyed", "repairedPartial", "repaired"])
});

const DOCUMENT_ALIASES = new Set(Object.keys(EVENT_NAMES_BY_ALIAS));
const ALL_EVENT_NAMES = new Set(Object.values(EVENT_NAMES_BY_ALIAS).flat());

/** Preserve JavaScript formatting while normalizing missing or invalid persisted values. */
export function normalizeEventScript(source) {
  return typeof source === "string" ? source : "";
}

/** Return a shared script value, or blank when a palette selection contains divergent scripts. */
export function getCommonEventScript(values, fallback = "") {
  if (!values?.length) return normalizeEventScript(fallback);
  const normalized = values.map(normalizeEventScript);
  return normalized.every(value => valuesEqual(value, normalized[0])) ? normalized[0] : "";
}

/** Validate the asynchronous JavaScript scope used by Toolbag script behaviors. */
export function validateEventScript(source, {alias = "document"} = {}) {
  const script = normalizeEventScript(source);
  validateWithJavaScriptField(script);
  const AsyncFunction = getAsyncFunction();
  new AsyncFunction("scene", "document", alias, "behavior", "event", `{${script}\n}`);
  return script;
}

/**
 * Normalize a flag-backed behavior collection, or expose legacy fixed scripts as stable behaviors.
 * Passing any explicit behaviors value, including an empty array, takes precedence over legacy scripts.
 */
export function normalizeEventBehaviors(behaviors, {alias, legacyScripts} = {}) {
  validateAlias(alias);
  if (Array.isArray(behaviors)) return normalizeExplicitBehaviors(behaviors, alias);
  if (!legacyScripts || typeof legacyScripts !== "object") return [];

  return EVENT_NAMES_BY_ALIAS[alias].flatMap(eventName => {
    const source = normalizeEventScript(legacyScripts[eventName]);
    if (!source.trim()) return [];
    return [{
      id: `legacy-${eventName}`,
      type: SCRIPT_BEHAVIOR_TYPE,
      name: localizeEventName(eventName),
      disabled: false,
      events: [eventName],
      source
    }];
  });
}

/** Return whether two normalized behavior collections contain the same persisted values. */
export function eventBehaviorCollectionsEqual(left, right) {
  return valuesEqual(
    normalizeComparableBehaviors(left),
    normalizeComparableBehaviors(right)
  );
}

/** Strictly validate and normalize a behavior collection proposed by a document update. */
export function validateEventBehaviorCollection(value, {alias} = {}) {
  validateAlias(alias);
  if (!Array.isArray(value)) throw new TypeError("Toolbag behaviors must be an array.");

  const allowedEvents = new Set(EVENT_NAMES_BY_ALIAS[alias]);
  const ids = new Set();
  return value.map((behavior, index) => {
    if (!behavior || typeof behavior !== "object" || Array.isArray(behavior)) {
      throw new TypeError(`Toolbag behavior ${index + 1} must be an object.`);
    }
    const id = typeof behavior.id === "string" ? behavior.id.trim() : "";
    if (!id) throw new TypeError(`Toolbag behavior ${index + 1} requires an ID.`);
    if (ids.has(id)) throw new TypeError(`Duplicate Toolbag behavior ID: ${id}`);
    ids.add(id);
    if (behavior.type !== SCRIPT_BEHAVIOR_TYPE) {
      throw new TypeError(`Unknown Toolbag behavior type: ${behavior.type}`);
    }
    if (typeof behavior.name !== "string") {
      throw new TypeError(`Toolbag behavior ${id} requires a name.`);
    }
    if (typeof behavior.disabled !== "boolean") {
      throw new TypeError(`Toolbag behavior ${id} requires a disabled state.`);
    }
    if (!Array.isArray(behavior.events)) {
      throw new TypeError(`Toolbag behavior ${id} events must be an array.`);
    }
    const events = [];
    for (const eventName of behavior.events) {
      if (!allowedEvents.has(eventName)) {
        throw new TypeError(`Unknown ${alias} behavior event: ${eventName}`);
      }
      if (events.includes(eventName)) throw new TypeError(`Duplicate behavior event: ${eventName}`);
      events.push(eventName);
    }
    if (!events.length) throw new TypeError(localize("Errors.EventRequired"));
    if (typeof behavior.source !== "string") {
      throw new TypeError(`Toolbag behavior ${id} source must be a string.`);
    }
    const source = validateEventScript(behavior.source, {alias});
    return {
      id,
      type: SCRIPT_BEHAVIOR_TYPE,
      name: behavior.name.trim() || localize("Behavior.ExecuteScript"),
      disabled: behavior.disabled,
      events: orderEvents(events, alias),
      source
    };
  });
}

/** Validate one proposed behaviors field and restrict script authoring to GMs. */
export function validateEventBehaviorChanges(changes, field, alias, userId) {
  const change = getChangedValue(changes, field);
  if (!change.present) return;
  assertScriptAuthor(userId);
  const behaviors = validateEventBehaviorCollection(change.value, {alias});
  setChangedValue(changes, field, behaviors);
}

/** Validate legacy script fields while they remain readable for backwards compatibility. */
export function validateEventScriptChanges(changes, fields, alias, userId) {
  const changedScripts = fields
    .map(path => [path, getChangedValue(changes, path)])
    .filter(([, change]) => change.present);
  if (!changedScripts.length) return;
  assertScriptAuthor(userId);
  for (const [path, change] of changedScripts) {
    const script = normalizeEventScript(change.value);
    validateEventScript(script, {alias});
    setChangedValue(changes, path, script);
  }
}

/**
 * Execute one Region-style Toolbag behavior. Runtime failures are contained and reported.
 *
 * @returns {Promise<boolean>} Whether the behavior completed without an error.
 */
export async function executeEventBehavior({
  behavior,
  document,
  alias,
  name,
  previous,
  current,
  user = globalThis.game?.user
}) {
  const normalized = normalizeExplicitBehaviors([behavior], alias)[0];
  if (!normalized?.source.trim()) return true;

  try {
    validateEventOptions({document, alias, name});
    const event = {
      name,
      user,
      data: {document, previous, current}
    };
    const AsyncFunction = getAsyncFunction();
    const fn = new AsyncFunction(
      "scene", "document", alias, "behavior", "event", `{${normalized.source}\n}`
    );
    await fn.call(globalThis, document.parent ?? null, document, document, normalized, event);
    return true;
  } catch (error) {
    console.error(
      `${MODULE_ID} | ${alias} ${name} behavior "${normalized?.name ?? "unknown"}" `
      + `(${normalized?.id ?? "unknown"}) failed for ${document?.uuid ?? document?.id ?? "unknown document"}`,
      error
    );
    return false;
  }
}

/** Queue every enabled behavior subscribed to one semantic event on the current GM. */
export function queueEventBehaviors({behaviors, ...eventOptions}) {
  const {alias, name} = eventOptions;
  if (globalThis.game?.user?.isGM !== true) return 0;
  const matching = normalizeEventBehaviors(behaviors, {alias}).filter(behavior => (
    !behavior.disabled && behavior.events.includes(name) && behavior.source.trim()
  ));
  if (!matching.length) return 0;

  const execute = () => void Promise.allSettled(matching.map(behavior => (
    executeEventBehavior({...eventOptions, behavior})
  )));
  if (typeof globalThis.setTimeout === "function") globalThis.setTimeout(execute, 0);
  else if (typeof globalThis.queueMicrotask === "function") globalThis.queueMicrotask(execute);
  else void Promise.resolve().then(execute);
  return matching.length;
}

/** Backwards-compatible internal wrapper for the former fixed-slot executor. */
export async function executeEventScript({source, ...options}) {
  return await executeEventBehavior({
    ...options,
    behavior: {
      id: `legacy-${options.name}`,
      type: SCRIPT_BEHAVIOR_TYPE,
      name: localizeEventName(options.name),
      disabled: false,
      events: [options.name],
      source
    }
  });
}

/** Backwards-compatible internal wrapper for the former fixed-slot queue. */
export function queueEventScript({source, ...options}) {
  return queueEventBehaviors({
    ...options,
    behaviors: [{
      id: `legacy-${options.name}`,
      type: SCRIPT_BEHAVIOR_TYPE,
      name: localizeEventName(options.name),
      disabled: false,
      events: [options.name],
      source
    }]
  }) > 0;
}

/** Legacy fixed-editor submit validation retained for backwards-compatible internal tests and integrations. */
export function bindEventScriptValidation(form, root) {
  if (!form || !root || form.dataset.toolbagScriptValidation === "true") return;
  form.dataset.toolbagScriptValidation = "true";
  const validateForm = event => {
    const invalid = findInvalidLegacyEditor(form);
    if (!invalid) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    reportInvalidLegacyEditor(invalid);
  };
  form.addEventListener("submit", validateForm, {capture: true});
  form.addEventListener("change", event => {
    if (!event.target?.matches?.("code-mirror[data-toolbag-script]")) return;
    validateForm(event);
  }, {capture: true});
}

/** Legacy mixed-value helper retained while old fixed fields remain readable. */
export function setMultipleScriptState(root, name, values) {
  if (!values.length || values.every(value => valuesEqual(value, values[0]))) return;
  const editor = root.querySelector?.(`[name="${name}"]`);
  if (!editor) return;
  editor.classList.add("multiple-values");
  editor.dataset.tooltip = globalThis.game?.i18n?.localize?.("PLACEABLE_PALETTE.MultipleValues")
    ?? "Multiple Values";
}

function normalizeExplicitBehaviors(behaviors, alias) {
  validateAlias(alias);
  const allowedEvents = new Set(EVENT_NAMES_BY_ALIAS[alias]);
  const ids = new Set();
  return behaviors.flatMap((behavior, index) => {
    if (!behavior || typeof behavior !== "object" || Array.isArray(behavior)) return [];
    if (behavior.type !== undefined && behavior.type !== SCRIPT_BEHAVIOR_TYPE) return [];
    let id = typeof behavior.id === "string" ? behavior.id.trim() : "";
    if (!id) id = `behavior-${index + 1}`;
    const baseId = id;
    for (let suffix = 2; ids.has(id); suffix += 1) id = `${baseId}-${suffix}`;
    ids.add(id);
    const rawEvents = behavior.events instanceof Set
      ? Array.from(behavior.events)
      : (Array.isArray(behavior.events) ? behavior.events : []);
    const events = orderEvents(Array.from(new Set(rawEvents.filter(eventName => allowedEvents.has(eventName)))), alias);
    return [{
      id,
      type: SCRIPT_BEHAVIOR_TYPE,
      name: typeof behavior.name === "string" && behavior.name.trim()
        ? behavior.name.trim()
        : localize("Behavior.ExecuteScript"),
      disabled: behavior.disabled === true,
      events,
      source: normalizeEventScript(behavior.source)
    }];
  });
}

function findInvalidLegacyEditor(root) {
  for (const editor of root.querySelectorAll?.("code-mirror[data-toolbag-script]") ?? []) {
    try {
      validateEventScript(editor.value, {alias: editor.dataset.documentAlias});
    } catch (error) {
      return {editor, error};
    }
  }
  return null;
}

function reportInvalidLegacyEditor({editor, error}) {
  const label = editor.dataset.scriptLabel ?? editor.name;
  const message = globalThis.game?.i18n?.format?.("THEIKS_TOOLBAG.EventScripts.Invalid", {
    label,
    error: error.message
  }) ?? `${label}: ${error.message}`;
  globalThis.ui?.notifications?.error?.(message);
  editor.focus?.();
}

function normalizeComparableBehaviors(behaviors) {
  if (!Array.isArray(behaviors)) return [];
  return behaviors.map(behavior => ({
    id: behavior.id,
    type: behavior.type,
    name: behavior.name,
    disabled: behavior.disabled,
    events: Array.from(behavior.events ?? []),
    source: behavior.source
  }));
}

function orderEvents(events, alias) {
  const selected = new Set(events);
  return EVENT_NAMES_BY_ALIAS[alias].filter(eventName => selected.has(eventName));
}

function assertScriptAuthor(userId) {
  const user = globalThis.game?.users?.get?.(userId)
    ?? ((!userId || globalThis.game?.user?.id === userId) ? globalThis.game?.user : null);
  if (user?.isGM === true) return;
  throw new Error(globalThis.game?.i18n?.localize?.("THEIKS_TOOLBAG.EventScripts.GmOnly")
    ?? "Only a GM can configure Toolbag script behaviors.");
}

function validateEventOptions({document, alias, name}) {
  if (!document) throw new TypeError("A document is required for a Toolbag script behavior.");
  validateAlias(alias);
  if (!ALL_EVENT_NAMES.has(name) || !EVENT_NAMES_BY_ALIAS[alias].includes(name)) {
    throw new TypeError(`Unknown Toolbag ${alias} event: ${name}`);
  }
}

function validateAlias(alias) {
  if (!DOCUMENT_ALIASES.has(alias)) throw new TypeError(`Unknown Toolbag script document alias: ${alias}`);
}

function valuesEqual(left, right) {
  return globalThis.foundry?.utils?.equals?.(left, right)
    ?? JSON.stringify(left) === JSON.stringify(right);
}

function getChangedValue(changes, path) {
  if (!changes || typeof changes !== "object") return {present: false};
  if (Object.hasOwn(changes, path)) return {present: true, value: changes[path]};
  const parts = path.split(".");
  for (let length = parts.length - 1; length > 0; length -= 1) {
    const prefix = parts.slice(0, length).join(".");
    if (!Object.hasOwn(changes, prefix)) continue;
    let value = changes[prefix];
    for (const part of parts.slice(length)) {
      if (!value || typeof value !== "object" || !Object.hasOwn(value, part)) return {present: false};
      value = value[part];
    }
    return {present: true, value};
  }
  let value = changes;
  for (const part of parts) {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, part)) return {present: false};
    value = value[part];
  }
  return {present: true, value};
}

function setChangedValue(changes, path, value) {
  if (Object.hasOwn(changes, path)) {
    changes[path] = value;
    return;
  }
  const parts = path.split(".");
  for (let length = parts.length - 1; length > 0; length -= 1) {
    const prefix = parts.slice(0, length).join(".");
    if (!Object.hasOwn(changes, prefix)) continue;
    let target = changes[prefix];
    if (!target || typeof target !== "object") return;
    for (const part of parts.slice(length, -1)) {
      if (!target[part] || typeof target[part] !== "object") return;
      target = target[part];
    }
    target[parts.at(-1)] = value;
    return;
  }
  let target = changes;
  for (const part of parts.slice(0, -1)) {
    if (!target[part] || typeof target[part] !== "object") return;
    target = target[part];
  }
  target[parts.at(-1)] = value;
}

function localizeEventName(eventName) {
  return localize(`Events.${eventName}`);
}

function localize(key) {
  const fullKey = `THEIKS_TOOLBAG.EventBehaviors.${key}`;
  return globalThis.game?.i18n?.localize?.(fullKey) ?? fullKey;
}

function getAsyncFunction() {
  return globalThis.foundry?.utils?.AsyncFunction
    ?? Object.getPrototypeOf(async function () {}).constructor;
}

function validateWithJavaScriptField(source) {
  const JavaScriptField = globalThis.foundry?.data?.fields?.JavaScriptField;
  if (typeof JavaScriptField !== "function") return;
  const field = new JavaScriptField({async: true, gmOnly: true});
  field.validate(source, {strict: true});
}
