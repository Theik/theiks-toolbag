import assert from "node:assert/strict";

const hooks = new Map();
globalThis.Hooks = {
  on: (name, callback) => {
    const callbacks = hooks.get(name) ?? [];
    callbacks.push(callback);
    hooks.set(name, callbacks);
  }
};

const settings = {enableLevelTools: true, enableFallingMessages: true};
globalThis.game = {
  user: {id: "gm", isGM: true},
  settings: {get: (_namespace, key) => settings[key]},
  i18n: {
    localize: key => key,
    format: (key, data) => `${key}:${JSON.stringify(data)}`
  }
};
globalThis.ui = {
  notifications: {
    warn: () => {},
    error: () => {}
  }
};

let dialogResult = null;
let dialogConfig = null;
globalThis.foundry = {
  utils: {
    escapeHTML: value => String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
  },
  applications: {
    api: {
      DialogV2: {input: async config => { dialogConfig = config; return dialogResult; }}
    }
  }
};

const ground = {id: "ground", name: "Ground", elevation: {bottom: -10, top: 10}};
const middle = {id: "middle", name: "Middle", elevation: {bottom: 10, top: 20}};
const upper = {id: "upper", name: "Upper", elevation: {bottom: 30, top: 40}};
const levels = new Map([[ground.id, ground], [middle.id, middle], [upper.id, upper]]);
levels.contents = [ground, middle, upper];
for (const level of levels.values()) level.parent = null;

const tokens = new Map();
const scene = {
  id: "scene",
  levels,
  tokens,
  updateEmbeddedDocuments: async (type, updates) => {
    assert.equal(type, "Token");
    return updates.map(update => {
      const token = tokens.get(update._id);
      token.level = token._source.level = update.level;
      token.elevation = token._source.elevation = update.elevation;
      return token;
    });
  }
};
for (const level of levels.values()) level.parent = scene;

function createToken(id, name, level, elevation) {
  const token = {
    documentName: "Token",
    id,
    name,
    parent: scene,
    level,
    elevation,
    _source: {level, elevation},
    movement: {
      id: "",
      state: "completed",
      user: game.user,
      finished: Promise.resolve(true)
    },
    updateCalls: [],
    update: async (changes, options = {}) => {
      token.updateCalls.push({changes, options});
      if (Object.hasOwn(changes, "elevation")) {
        token.elevation = token._source.elevation = changes.elevation;
      }
      if (Object.hasOwn(changes, "level")) {
        token.level = token._source.level = changes.level;
      }
      return token;
    }
  };
  tokens.set(id, token);
  return token;
}

const first = createToken("first", "A <Hero>", "upper", 35);
const second = createToken("second", "B", "upper", 30);
const third = createToken("third", "C", "ground", -5);
const chatMessages = [];
globalThis.ChatMessage = {create: async data => { chatMessages.push(data); return data; }};
globalThis.canvas = {
  ready: true,
  scene,
  level: upper,
  tokens: {controlled: [{document: first}, {document: second}, {document: third}]},
  inferLevelFromElevation: elevation => levels.contents.find(
    level => elevation >= level.elevation.bottom && elevation <= level.elevation.top
  ) ?? null
};

const {
  changeTokenLevels,
  getLevelBelow,
  getSceneLevels,
  getTokenLevel,
  hasMultipleSceneLevels,
  isLevelBelowSelectedTokens,
  promptTokenLevelChange,
  registerLevelTools,
  updateTokenElevation
} = await import("../scripts/levels/level-tools.js");

assert.deepEqual(getSceneLevels(scene), [ground, middle, upper]);
assert.equal(hasMultipleSceneLevels(scene), true);
assert.equal(hasMultipleSceneLevels({levels: {contents: [ground]}}), false);
assert.equal(hasMultipleSceneLevels({levels: {contents: []}}), false);
assert.equal(getTokenLevel(first, scene), upper);
assert.equal(isLevelBelowSelectedTokens(ground, [first], scene), true);
assert.equal(isLevelBelowSelectedTokens(upper, [first], scene), false);
assert.equal(isLevelBelowSelectedTokens(middle, [first, third], scene), true);
assert.equal(getLevelBelow(upper, scene), middle, "the nearest non-overlapping lower Level wins");
assert.equal(getLevelBelow(middle, scene), ground);
assert.equal(getLevelBelow(ground, scene), null);

const moving = createToken("moving", "Moving", ground.id, -5);
let finishMovement;
const activeMovement = {
  id: "movement-1",
  state: "pending",
  user: {isSelf: true},
  finished: new Promise(resolve => { finishMovement = resolve; })
};
moving.movement = activeMovement;
const elevationChange = updateTokenElevation(moving, 2);
await Promise.resolve();
assert.equal(moving.elevation, -5, "an active movement is not interrupted by the elevation helper");
moving.movement = {...activeMovement, state: "completed"};
finishMovement(true);
assert.equal(await elevationChange, moving);
assert.equal(moving.elevation, 2, "elevation changes after movement completes");
assert.deepEqual(moving.updateCalls.at(-1), {
  changes: {elevation: 2},
  options: {animate: false, theiksToolbagSyncElevation: true}
});

const completing = createToken("completing", "Completing", ground.id, 5);
let finishCompletedMovement;
completing.movement = {
  id: "movement-completing",
  state: "completed",
  user: {isSelf: true},
  finished: new Promise(resolve => { finishCompletedMovement = resolve; })
};
const postMovementElevationChange = updateTokenElevation(completing, 9, false, true, true);
await Promise.resolve();
assert.equal(completing.elevation, 5,
  "a movement marked completed is still allowed to finish its post-workflow before elevation changes");
finishCompletedMovement(true);
assert.equal(await postMovementElevationChange, completing);
assert.equal(completing.elevation, 9);
assert.deepEqual(completing.updateCalls.at(-1), {
  changes: {elevation: 9},
  options: {animate: false, theiksToolbagSyncElevation: true, constrainOptions: {ignoreWalls: true}}
});

const crossingSteps = createToken("crossing-steps", "Crossing Steps", ground.id, 0);
let finishStepCrossing;
let finishStepCrossingAnimation;
let finishRenderedStepCrossingAnimation;
let renderedStepCrossingAnimationActive = true;
const renderedStepCrossingAnimation = new Promise(resolve => {
  finishRenderedStepCrossingAnimation = () => {
    renderedStepCrossingAnimationActive = false;
    resolve();
  };
});
const stepCrossingMovement = {
  id: "movement-crossing-steps",
  state: "pending",
  user: {isSelf: true},
  finished: new Promise(resolve => { finishStepCrossing = resolve; }),
  animation: {ended: new Promise(resolve => { finishStepCrossingAnimation = resolve; })}
};
crossingSteps.movement = stepCrossingMovement;
crossingSteps.object = {
  rendered: true,
  get movementAnimationPromise() {
    return renderedStepCrossingAnimationActive ? renderedStepCrossingAnimation : null;
  },
  stopAnimation: () => {},
  renderFlags: {set: () => {}}
};
const firstStepRequest = updateTokenElevation(crossingSteps, 3, false, true, true);
const secondStepRequest = updateTokenElevation(crossingSteps, 6, false, true, true);
await Promise.resolve();
assert.equal(crossingSteps.updateCalls.length, 0, "adjacent stair Regions wait for the source movement");
crossingSteps.movement = {...stepCrossingMovement, state: "completed"};
finishStepCrossing(true);
await Promise.resolve();
assert.equal(crossingSteps.updateCalls.length, 0,
  "the final stair request also waits for the source movement's chained animation");
finishStepCrossingAnimation();
await Promise.resolve();
assert.equal(crossingSteps.updateCalls.length, 0,
  "the final stair request waits for the rendered Token animation after the movement snapshot resolves");
finishRenderedStepCrossingAnimation();
assert.equal(await firstStepRequest, null, "an earlier elevation request from the same drag becomes stale");
assert.equal(await secondStepRequest, crossingSteps);
assert.equal(crossingSteps.elevation, 6, "the final stair Region crossed determines the elevation");
assert.deepEqual(crossingSteps.updateCalls, [{
  changes: {elevation: 6},
  options: {animate: false, theiksToolbagSyncElevation: true, constrainOptions: {ignoreWalls: true}}
}], "crossing two stair Regions creates only one follow-up Token movement");

const ceilingStopped = createToken("ceiling-stopped", "Ceiling Stopped", ground.id, 5);
ceilingStopped.movement = {
  id: "movement-stopped-at-ceiling",
  state: "stopped",
  user: {isSelf: true},
  finished: Promise.resolve(false)
};
await updateTokenElevation(ceilingStopped, 9, false, true, true);
assert.equal(ceilingStopped.elevation, 9,
  "ignoreCeiling can recover after the entering movement was stopped by the ceiling");
assert.deepEqual(ceilingStopped.updateCalls.at(-1), {
  changes: {elevation: 9},
  options: {animate: false, theiksToolbagSyncElevation: true, constrainOptions: {ignoreWalls: true}}
});

await updateTokenElevation(moving, -5);
assert.equal(chatMessages.length, 0, "direct elevation changes do not count as falling by default");
await updateTokenElevation(moving, -10, true);
assert.equal(chatMessages.length, 1, "the optional elevation-helper argument counts downward movement as falling");
assert.match(chatMessages[0].content, /Moving/);
assert.match(chatMessages[0].content, /Ground/);

const elevationOnly = createToken("elevation-only", "Elevation Only", ground.id, -5);
await updateTokenElevation(elevationOnly, 12);
assert.equal(elevationOnly.elevation, 12);
assert.equal(elevationOnly.level, ground.id, "Level transitions remain disabled by default");
assert.deepEqual(elevationOnly.updateCalls.at(-1), {
  changes: {elevation: 12},
  options: {animate: false, theiksToolbagSyncElevation: true}
});

const ceilingIgnored = createToken("ceiling-ignored", "Ceiling Ignored", ground.id, 5);
await updateTokenElevation(ceilingIgnored, 9, false, false, true);
assert.equal(ceilingIgnored.elevation, 9);
assert.equal(ceilingIgnored.level, ground.id, "ignoring a ceiling does not transition the Token's Level");
assert.deepEqual(ceilingIgnored.updateCalls.at(-1), {
  changes: {elevation: 9},
  options: {animate: false, theiksToolbagSyncElevation: true, constrainOptions: {ignoreWalls: true}}
});

const staleRenderedElevation = createToken("stale-rendered", "Stale Rendered", ground.id, 6);
staleRenderedElevation.update = async (changes, options = {}) => {
  staleRenderedElevation.updateCalls.push({changes, options});
  if (Object.hasOwn(changes, "elevation")) staleRenderedElevation._source.elevation = changes.elevation;
  if (Object.hasOwn(changes, "level")) staleRenderedElevation._source.level = changes.level;
  return staleRenderedElevation;
};
let postUpdateStopOptions;
let postUpdateRenderFlags;
staleRenderedElevation.object = {
  rendered: true,
  stopAnimation: options => {
    postUpdateStopOptions = options;
    staleRenderedElevation.elevation = staleRenderedElevation._source.elevation;
  },
  renderFlags: {set: flags => { postUpdateRenderFlags = flags; }}
};
await updateTokenElevation(staleRenderedElevation, 0);
assert.equal(staleRenderedElevation._source.elevation, 0);
assert.equal(staleRenderedElevation.elevation, 0,
  "the rendered elevation is synchronized after the complete document update operation");
assert.deepEqual(postUpdateStopOptions, {reset: true});
assert.deepEqual(postUpdateRenderFlags, {refreshElevation: true});

const transitioning = createToken("transitioning", "Transitioning", ground.id, -5);
await updateTokenElevation(transitioning, 12, false, true);
assert.equal(transitioning.elevation, 12, "the exact requested elevation is preserved");
assert.equal(transitioning.level, middle.id, "the Token moves to the Level containing its new elevation");
assert.deepEqual(transitioning.updateCalls.at(-1), {
  changes: {elevation: 12, level: middle.id},
  options: {animate: false, theiksToolbagSyncElevation: true}
});

await updateTokenElevation(transitioning, 15, false, true);
assert.deepEqual(transitioning.updateCalls.at(-1).changes, {elevation: 15},
  "remaining inside the current Level does not write its Level ID again");

const boundaryTransition = createToken("boundary-transition", "Boundary Transition", ground.id, 10);
const previousCanvasLevel = canvas.level;
const previousSceneIsView = scene.isView;
const previousSceneView = scene.view;
let viewOptions;
canvas.level = ground;
scene.isView = true;
scene.view = async options => {
  viewOptions = options;
  canvas.level = levels.get(options.level);
};
await updateTokenElevation(boundaryTransition, 10, false, true, true);
assert.equal(boundaryTransition.elevation, 10);
assert.equal(boundaryTransition.level, middle.id,
  "an unchanged boundary elevation still transitions to the Level which starts there");
assert.deepEqual(boundaryTransition.updateCalls.at(-1), {
  changes: {level: middle.id},
  options: {animate: false, theiksToolbagSyncElevation: true, constrainOptions: {ignoreWalls: true}}
});
assert.deepEqual(viewOptions, {level: middle.id, controlledTokens: [boundaryTransition.id]},
  "the local Scene view follows an API-driven Level transition");
canvas.level = previousCanvasLevel;
scene.isView = previousSceneIsView;
scene.view = previousSceneView;

const inferLevelFromElevation = canvas.inferLevelFromElevation;
canvas.inferLevelFromElevation = () => canvas.level;
await updateTokenElevation(transitioning, 25, false, true);
assert.equal(transitioning.level, middle.id, "an unmatched elevation leaves the current Level unchanged");
assert.deepEqual(transitioning.updateCalls.at(-1).changes, {elevation: 25});
canvas.inferLevelFromElevation = inferLevelFromElevation;

moving.movement = {
  id: "remote-movement",
  state: "pending",
  user: {isSelf: false},
  finished: new Promise(() => {})
};
assert.equal(
  await updateTokenElevation(moving, 12, false, true),
  null,
  "clients other than the movement initiator do not issue duplicate elevation or Level updates"
);
assert.equal(moving.elevation, -10);
await assert.rejects(() => updateTokenElevation(moving, "not-a-number"), /InvalidElevation/);

const updated = await changeTokenLevels([first, {document: second}, third], {
  levelId: middle.id
});
assert.equal(updated.length, 3);
assert.equal(first.level, middle.id);
assert.equal(first.elevation, middle.elevation.bottom);
assert.equal(chatMessages.length, 1, "full level changes do not count as falling by default");

await changeTokenLevels([first, second], {levelId: upper.id});
await changeTokenLevels([first, second], {levelId: middle.id, falling: true});
assert.equal(chatMessages.length, 2, "opt-in falls are summarized in one Chat message");
assert.match(chatMessages[1].content, /A &lt;Hero&gt;/);
assert.match(chatMessages[1].content, /B/);

await changeTokenLevels([first, second], {levelId: upper.id});
assert.equal(chatMessages.length, 2, "upward movement is omitted from falling messages");

settings.enableFallingMessages = false;
await changeTokenLevels([first, second], {levelId: middle.id, falling: true});
assert.equal(first.level, middle.id, "disabling messages does not prevent downward movement");
assert.equal(chatMessages.length, 2, "the falling-message setting suppresses manual fall summaries");
settings.enableFallingMessages = true;

dialogResult = {levelId: ground.id, falling: false};
assert.equal((await promptTokenLevelChange([first, second]))?.length, 2);
assert.equal(first.level, ground.id);
assert.equal(chatMessages.length, 2, "the dialog's unchecked Falling option suppresses the fall summary");

await changeTokenLevels([first, second], {levelId: upper.id, falling: false});
dialogResult = {levelId: middle.id, falling: true};
assert.equal((await promptTokenLevelChange([first, second]))?.length, 2);
assert.equal(first.level, middle.id);
assert.equal(chatMessages.length, 3, "the dialog's checked Falling option posts the fall summary");

dialogResult = null;
assert.equal(await promptTokenLevelChange([first, second]), null, "closing the input dialog cancels safely");
assert.match(dialogConfig.content, /name="falling"/, "the level dialog includes a Falling checkbox");
assert.match(
  dialogConfig.content,
  /<label for="theiks-toolbag-level-falling">[^<]+<\/label>[\s\S]*<input id="theiks-toolbag-level-falling"/,
  "the Falling label is associated with its checkbox"
);
assert.doesNotMatch(dialogConfig.content, /name="falling"[^>]*checked/, "Falling defaults to unchecked");
assert.match(dialogConfig.window.icon, /ladder/, "the level dialog uses a ladder icon");

let levelChangeListener = null;
const levelSelect = {
  value: middle.id,
  addEventListener: (type, listener) => {
    assert.equal(type, "change");
    levelChangeListener = listener;
  }
};
const fallingCheckbox = {checked: true, disabled: false};
const fallingGroup = {
  hidden: false,
  querySelector: selector => selector === '[name="falling"]' ? fallingCheckbox : null
};
const dialogElement = {
  querySelector: selector => {
    if (selector === '[name="levelId"]') return levelSelect;
    if (selector === '[data-role="falling-option"]') return fallingGroup;
    return null;
  }
};
dialogConfig.render({}, {element: dialogElement});
assert.equal(fallingGroup.hidden, true, "Falling is hidden when the target is the current Level");
assert.equal(fallingCheckbox.disabled, true);
assert.equal(fallingCheckbox.checked, false);

levelSelect.value = ground.id;
levelChangeListener();
assert.equal(fallingGroup.hidden, false, "Falling appears when the target is below the current Level");
assert.equal(fallingCheckbox.disabled, false);

fallingCheckbox.checked = true;
levelSelect.value = upper.id;
levelChangeListener();
assert.equal(fallingGroup.hidden, true, "Falling hides when the target is above the current Level");
assert.equal(fallingCheckbox.checked, false, "hiding Falling clears a stale selection");

registerLevelTools();
assert.equal(hooks.get("renderTokenHUD")?.length, 1);
assert.equal(hooks.get("updateToken")?.length, 1);

const staleDisplayToken = {
  documentName: "Token",
  elevation: 6,
  _source: {elevation: 0},
  resetCalls: 0
};
let stoppedAnimationOptions;
let elevationRenderFlags;
staleDisplayToken.reset = () => {
  staleDisplayToken.resetCalls += 1;
  staleDisplayToken.elevation = staleDisplayToken._source.elevation;
};
staleDisplayToken.object = {
  rendered: true,
  stopAnimation: options => {
    stoppedAnimationOptions = options;
    staleDisplayToken.reset();
  },
  renderFlags: {set: flags => { elevationRenderFlags = flags; }}
};
hooks.get("updateToken")[0](
  staleDisplayToken,
  {elevation: 0},
  {animate: false, theiksToolbagSyncElevation: true},
  game.user.id
);
assert.deepEqual(stoppedAnimationOptions, {reset: true});
assert.equal(staleDisplayToken.elevation, 0,
  "a completed movement's stale prepared elevation is reset from the authoritative source");
assert.deepEqual(elevationRenderFlags, {refreshElevation: true},
  "the Token elevation mesh and tooltip are refreshed after resetting its animation cache");

hooks.get("updateToken")[0](staleDisplayToken, {elevation: 3}, {animate: false}, game.user.id);
assert.equal(staleDisplayToken.resetCalls, 1,
  "unrelated non-animated Token updates are not modified by the elevation display workaround");

let appendedControl = null;
const fakeButton = {
  dataset: {},
  setAttribute: () => {},
  addEventListener: () => {}
};
const nativeLevelControl = {
  matches: selector => selector === "button, .control-icon",
  insertAdjacentElement: (position, button) => {
    assert.equal(position, "afterend");
    appendedControl = button;
  }
};
globalThis.document = {
  createElement: () => fakeButton,
  querySelectorAll: () => []
};
const hudElement = {
  querySelector: selector => {
    if (selector.includes('[data-action="level"]')) return nativeLevelControl;
    return null;
  }
};
levels.contents = [ground];
hooks.get("renderTokenHUD")[0]({setPosition: () => {}}, hudElement);
assert.equal(appendedControl, null, "single-Level Scenes do not receive the Token HUD fall control");

levels.contents = [];
hooks.get("renderTokenHUD")[0]({setPosition: () => {}}, hudElement);
assert.equal(appendedControl, null, "Scenes without Levels do not receive the Token HUD fall control");

levels.contents = [ground, middle, upper];
hooks.get("renderTokenHUD")[0]({setPosition: () => {}}, hudElement);
assert.equal(appendedControl, fakeButton, "the fall control is inserted beneath Foundry's native Level control");
assert.match(fakeButton.innerHTML, /ladder/, "the Token HUD level control uses a ladder icon");

settings.enableLevelTools = false;
appendedControl = null;
hooks.get("renderTokenHUD")[0]({setPosition: () => {}}, hudElement);
assert.equal(appendedControl, null, "the feature setting hides the Token HUD control");
await assert.rejects(
  () => changeTokenLevels([first], {levelId: ground.id}),
  /Settings\.Disabled/
);
await assert.rejects(() => updateTokenElevation(first, 2), /Settings\.Disabled/);
settings.enableLevelTools = true;
game.user.isGM = false;
appendedControl = null;
hooks.get("renderTokenHUD")[0]({setPosition: () => {}}, hudElement);
assert.equal(appendedControl, null, "players do not receive the Token HUD Level control");
await assert.rejects(
  () => changeTokenLevels([first], {levelId: ground.id}),
  /GmOnly/
);

console.log("level tools tests passed");
