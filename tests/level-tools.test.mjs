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

const ground = {id: "ground", name: "Ground", elevation: {bottom: -10, top: 0}};
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
    _source: {level, elevation}
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
  promptTokenLevelChange,
  registerLevelTools
} = await import("../scripts/levels/level-tools.js");

assert.deepEqual(getSceneLevels(scene), [ground, middle, upper]);
assert.equal(getTokenLevel(first, scene), upper);
assert.equal(getLevelBelow(upper, scene), middle, "the nearest non-overlapping lower Level wins");
assert.equal(getLevelBelow(middle, scene), ground);
assert.equal(getLevelBelow(ground, scene), null);

const updated = await changeTokenLevels([first, {document: second}, third], {
  levelId: middle.id
});
assert.equal(updated.length, 3);
assert.equal(first.level, middle.id);
assert.equal(first.elevation, middle.elevation.bottom);
assert.equal(chatMessages.length, 1, "all falls are summarized in one Chat message");
assert.match(chatMessages[0].content, /A &lt;Hero&gt;/);
assert.match(chatMessages[0].content, /B/);
assert.doesNotMatch(chatMessages[0].content, />C</, "a Token moving upward is omitted from the fall summary");

await changeTokenLevels([first, second], {levelId: upper.id});
assert.equal(chatMessages.length, 1, "upward movement is omitted from falling messages");

settings.enableFallingMessages = false;
await changeTokenLevels([first, second], {levelId: middle.id});
assert.equal(first.level, middle.id, "disabling messages does not prevent downward movement");
assert.equal(chatMessages.length, 1, "the falling-message setting suppresses manual fall summaries");
settings.enableFallingMessages = true;

dialogResult = null;
assert.equal(await promptTokenLevelChange([first, second]), null, "closing the input dialog cancels safely");
assert.doesNotMatch(dialogConfig.content, /name="falling"/, "the fall action has no optional Falling checkbox");

registerLevelTools();
assert.equal(hooks.get("renderTokenHUD")?.length, 1);

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
hooks.get("renderTokenHUD")[0]({setPosition: () => {}}, hudElement);
assert.equal(appendedControl, fakeButton, "the fall control is inserted beneath Foundry's native Level control");
assert.match(fakeButton.innerHTML, /person-falling/);

settings.enableLevelTools = false;
appendedControl = null;
hooks.get("renderTokenHUD")[0]({setPosition: () => {}}, hudElement);
assert.equal(appendedControl, null, "the feature setting hides the Token HUD control");
await assert.rejects(
  () => changeTokenLevels([first], {levelId: ground.id}),
  /Settings\.Disabled/
);
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
