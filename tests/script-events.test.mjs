import assert from "node:assert/strict";
import {
  SCRIPT_BEHAVIOR_TYPE,
  eventBehaviorCollectionsEqual,
  executeEventBehavior,
  normalizeEventBehaviors,
  normalizeEventScript,
  queueEventBehaviors,
  validateEventBehaviorChanges,
  validateEventBehaviorCollection,
  validateEventScript
} from "../scripts/script-events.js";

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
globalThis.foundry = {
  utils: {
    AsyncFunction,
    equals: (left, right) => JSON.stringify(left) === JSON.stringify(right)
  }
};
globalThis.game = {
  user: {id: "gm", isGM: true},
  users: new Map(),
  i18n: {
    localize: key => key.split(".").at(-1),
    format: (key, data) => `${key}:${JSON.stringify(data)}`
  }
};
game.users.set("gm", game.user);
game.users.set("player", {id: "player", isGM: false});

const scene = {id: "scene"};
const wall = {id: "wall", uuid: "Scene.scene.Wall.wall", parent: scene};
const previous = {destroyed: false};
const current = {destroyed: true};
const behavior = (overrides = {}) => ({
  id: "behavior-1",
  type: SCRIPT_BEHAVIOR_TYPE,
  name: "Notify",
  disabled: false,
  events: ["destroyed"],
  source: "await Promise.resolve();",
  ...overrides
});

assert.equal(normalizeEventScript(null), "");
assert.equal(normalizeEventScript("  return;\n"), "  return;\n");
assert.equal(validateEventScript("await Promise.resolve();", {alias: "wall"}), "await Promise.resolve();");
assert.throws(() => validateEventScript("if (", {alias: "wall"}), SyntaxError);

let javaScriptFieldOptions;
let javaScriptFieldSource;
let javaScriptFieldValidationOptions;
globalThis.foundry.data = {
  fields: {
    JavaScriptField: class {
      constructor(options) {
        javaScriptFieldOptions = options;
      }

      validate(source, options) {
        javaScriptFieldSource = source;
        javaScriptFieldValidationOptions = options;
      }
    }
  }
};
validateEventScript("await Promise.resolve('native');", {alias: "wall"});
assert.deepEqual(javaScriptFieldOptions, {async: true, gmOnly: true});
assert.equal(javaScriptFieldSource, "await Promise.resolve('native');");
assert.deepEqual(javaScriptFieldValidationOptions, {strict: true});
delete globalThis.foundry.data;

const legacy = normalizeEventBehaviors(undefined, {
  alias: "wall",
  legacyScripts: {destroyed: "destroy();", repaired: "repair();"}
});
assert.deepEqual(legacy.map(value => ({id: value.id, events: value.events, source: value.source})), [
  {id: "legacy-destroyed", events: ["destroyed"], source: "destroy();"},
  {id: "legacy-repaired", events: ["repaired"], source: "repair();"}
]);
assert.deepEqual(
  normalizeEventBehaviors([], {alias: "wall", legacyScripts: {destroyed: "ignored();"}}),
  [],
  "an explicit empty collection takes precedence over legacy fixed scripts"
);

const normalized = validateEventBehaviorCollection([
  behavior({name: "  Notify  ", events: ["repaired", "destroyed"], source: "await Promise.resolve();"})
], {alias: "wall"});
assert.deepEqual(normalized[0], behavior({
  name: "Notify",
  events: ["destroyed", "repaired"],
  source: "await Promise.resolve();"
}));
assert.throws(
  () => validateEventBehaviorCollection([behavior(), behavior()], {alias: "wall"}),
  /Duplicate.*ID/
);
assert.throws(
  () => validateEventBehaviorCollection([behavior({events: ["toggledOn"]})], {alias: "wall"}),
  /Unknown wall behavior event/
);
assert.throws(
  () => validateEventBehaviorCollection([behavior({events: []})], {alias: "wall"}),
  /EventRequired/
);
assert.equal(
  validateEventBehaviorCollection([behavior({source: ""})], {alias: "wall"})[0].source,
  "",
  "blank scripts remain valid"
);
assert.throws(
  () => validateEventBehaviorCollection([behavior({source: "if ("})], {alias: "wall"}),
  SyntaxError
);
assert.equal(eventBehaviorCollectionsEqual(normalized, structuredClone(normalized)), true);
assert.equal(eventBehaviorCollectionsEqual(normalized, [behavior({name: "Different"})]), false);

const behaviorField = "flags.theiks-toolbag.breakableWall.behaviors";
const proposed = {[behaviorField]: [behavior()]};
validateEventBehaviorChanges(proposed, behaviorField, "wall", "gm");
assert.deepEqual(proposed[behaviorField], [behavior()]);
assert.throws(
  () => validateEventBehaviorChanges({[behaviorField]: [behavior()]}, behaviorField, "wall", "player"),
  /GmOnly/
);

delete globalThis.__toolbagBehaviorResult;
assert.equal(await executeEventBehavior({
  behavior: behavior({source: `
    await Promise.resolve();
    globalThis.__toolbagBehaviorResult = {
      sceneMatches: scene === document.parent,
      aliasMatches: wall === document,
      behaviorMatches: behavior.id === "behavior-1",
      thisMatches: this === globalThis,
      name: event.name,
      user: event.user.id,
      documentMatches: event.data.document === document,
      previous: event.data.previous,
      current: event.data.current
    };
  `}),
  document: wall,
  alias: "wall",
  name: "destroyed",
  previous,
  current
}), true);
assert.deepEqual(globalThis.__toolbagBehaviorResult, {
  sceneMatches: true,
  aliasMatches: true,
  behaviorMatches: true,
  thisMatches: true,
  name: "destroyed",
  user: "gm",
  documentMatches: true,
  previous,
  current
});

const originalError = console.error;
const logged = [];
console.error = (...args) => logged.push(args);
assert.equal(await executeEventBehavior({
  behavior: behavior({name: "Broken", source: "throw new Error('script failure');"}),
  document: wall,
  alias: "wall",
  name: "destroyed",
  previous,
  current
}), false);
assert.match(logged[0][0], /wall destroyed behavior "Broken" \(behavior-1\) failed/);
assert.match(logged[0][1].message, /script failure/);
console.error = originalError;

globalThis.__queuedToolbagBehaviors = [];
const queued = queueEventBehaviors({
  behaviors: [
    behavior({id: "first", source: "globalThis.__queuedToolbagBehaviors.push(behavior.id);"}),
    behavior({id: "second", events: ["destroyed", "repaired"], source: "globalThis.__queuedToolbagBehaviors.push(behavior.id);"}),
    behavior({id: "disabled", disabled: true, source: "globalThis.__queuedToolbagBehaviors.push(behavior.id);"}),
    behavior({id: "other", events: ["repaired"], source: "globalThis.__queuedToolbagBehaviors.push(behavior.id);"})
  ],
  document: wall,
  alias: "wall",
  name: "destroyed",
  previous,
  current
});
assert.equal(queued, 2);
assert.deepEqual(globalThis.__queuedToolbagBehaviors, [], "dispatching never executes inline");
await new Promise(resolve => setTimeout(resolve, 0));
assert.deepEqual(new Set(globalThis.__queuedToolbagBehaviors), new Set(["first", "second"]));

game.user.isGM = false;
delete globalThis.__blockedToolbagBehavior;
assert.equal(queueEventBehaviors({
  behaviors: [behavior({source: "globalThis.__blockedToolbagBehavior = true;"})],
  document: wall,
  alias: "wall",
  name: "destroyed"
}), 0);
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(globalThis.__blockedToolbagBehavior, undefined, "non-GM clients never run behaviors");

console.log("script behavior tests passed");
