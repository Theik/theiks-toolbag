import assert from "node:assert/strict";

const hookHandlers = new Map();
globalThis.Hooks = {
  on: (name, callback) => {
    const callbacks = hookHandlers.get(name) ?? [];
    callbacks.push(callback);
    hookHandlers.set(name, callbacks);
  }
};

const settings = {
  enableBreakableTerrain: true,
  enableLevelTools: true,
  enableFallingMessages: true
};
globalThis.game = {
  user: {id: "gm", isGM: true},
  settings: {get: (_namespace, key) => settings[key]},
  i18n: {
    localize: key => key,
    format: (key, data) => `${key}:${JSON.stringify(data)}`
  }
};

const errors = [];
globalThis.ui = {
  notifications: {
    error: message => errors.push(message),
    warn: () => {}
  }
};

let dialogCalls = 0;
let dialogSelection = ["on-platform"];
globalThis.foundry = {
  utils: {escapeHTML: value => String(value).replaceAll("<", "&lt;").replaceAll(">", "&gt;")},
  applications: {
    api: {
      DialogV2: {
        wait: async config => {
          dialogCalls += 1;
          if (dialogSelection === null) return "cancel";
          return config.buttons[0].callback(null, {
            form: {
              querySelectorAll: () => dialogSelection.map(value => ({value}))
            }
          });
        }
      }
    }
  },
  canvas: {
    loadTexture: async src => ({src, valid: true, width: 2, height: 2}),
    TextureLoader: {
      getTextureAlphaData: () => ({
        width: 2,
        height: 2,
        minX: 0,
        minY: 0,
        maxX: 2,
        maxY: 2,
        data: new Uint8Array([255, 255, 255, 255])
      })
    }
  }
};

const ground = {id: "ground", name: "Ground", elevation: {bottom: -10, top: 0}};
const middle = {id: "middle", name: "Middle", elevation: {bottom: 10, top: 20}};
const upper = {id: "upper", name: "Upper", elevation: {bottom: 30, top: 40}};
const levels = new Map([[ground.id, ground], [middle.id, middle], [upper.id, upper]]);
levels.contents = [ground, middle, upper];
const tiles = new Map();
const tokens = new Map();
const scene = {id: "scene", levels, tiles, tokens, grid: {size: 100}};
for (const level of levels.values()) level.parent = scene;

function createToken({id, name, level, elevation, x, y, fail = false}) {
  const token = {
    documentName: "Token",
    id,
    name,
    parent: scene,
    level,
    elevation,
    _source: {level, elevation, x, y, width: 1, height: 1},
    getCenterPoint: () => ({x: token._source.x, y: token._source.y}),
    update: async changes => {
      if (fail) throw new Error("token update failed");
      token.level = token._source.level = changes.level;
      token.elevation = token._source.elevation = changes.elevation;
      return token;
    }
  };
  tokens.set(id, token);
  return token;
}

const onPlatform = createToken({
  id: "on-platform",
  name: "Hero <One>",
  level: upper.id,
  elevation: 35,
  x: 50,
  y: 50
});
const failing = createToken({
  id: "failing",
  name: "Stuck",
  level: upper.id,
  elevation: 32,
  x: 60,
  y: 60,
  fail: true
});
createToken({id: "outside", name: "Outside", level: upper.id, elevation: 35, x: 150, y: 50});
const underneath = createToken({
  id: "underneath",
  name: "Underneath",
  level: middle.id,
  elevation: 10,
  x: 40,
  y: 40
});

globalThis.canvas = {
  ready: true,
  scene,
  level: upper,
  grid: {size: 100},
  inferLevelFromElevation: elevation => levels.contents.find(
    level => elevation >= level.elevation.bottom && elevation <= level.elevation.top
  ) ?? null
};

const chatMessages = [];
globalThis.ChatMessage = {create: async data => { chatMessages.push(data); return data; }};

const {registerBreakableTerrainConfig} = await import("../scripts/breakable-terrain/terrain-config.js");
const {advanceTerrainDestruction} = await import("../scripts/breakable-terrain/terrain-destruction.js");
const {
  completePlatformCollapse,
  getPlatformLevels,
  getPlatformTokenContext,
  promptPlatformCollapse
} = await import("../scripts/breakable-terrain/platform-collapse.js");
registerBreakableTerrainConfig();

function createTile({
  id,
  states = ["destroyed.webp"],
  platform = true,
  platformMessage = "",
  levelIds = [upper.id]
}) {
  const flag = {
    enabled: true,
    platform,
    platformMessage,
    blocksMovement: true,
    blocksVision: true,
    states,
    stage: 0,
    restoreSrc: null
  };
  const tile = {
    documentName: "Tile",
    id,
    uuid: `Scene.scene.Tile.${id}`,
    name: `Platform ${id}`,
    parent: scene,
    levels: new Set(levelIds),
    _source: {
      levels: levelIds,
      texture: {src: "platform.webp", alphaThreshold: 0.75}
    },
    texture: {src: "platform.webp", alphaThreshold: 0.75},
    shape: {testPoint: ({x, y}) => x >= 0 && x <= 100 && y >= 0 && y <= 100},
    getFlag: () => flag,
    update: async (changes, options = {}) => {
      for (const callback of hookHandlers.get("preUpdateTile") ?? []) callback(tile, changes, options, game.user.id);
      if (Object.hasOwn(changes, "texture.src")) tile._source.texture.src = tile.texture.src = changes["texture.src"];
      if (Object.hasOwn(changes, "flags.theiks-toolbag.breakableTerrain.stage")) {
        flag.stage = changes["flags.theiks-toolbag.breakableTerrain.stage"];
      }
      if (Object.hasOwn(changes, "flags.theiks-toolbag.breakableTerrain.restoreSrc")) {
        flag.restoreSrc = changes["flags.theiks-toolbag.breakableTerrain.restoreSrc"];
      }
      return tile;
    }
  };
  tiles.set(id, tile);
  return {tile, flag};
}

const inspection = createTile({id: "inspection"});
assert.deepEqual(getPlatformLevels(inspection.tile), [{platformLevel: upper, lowerLevel: middle}]);
const context = getPlatformTokenContext(inspection.tile);
assert.deepEqual(context.candidates.map(token => token.id), [onPlatform.id, failing.id]);
assert.deepEqual(context.underneath.map(token => token.id), [underneath.id]);

dialogSelection = [onPlatform.id, failing.id];
const collapse = createTile({id: "collapse", platformMessage: "The balcony <snaps>!"});
const originalConsoleError = console.error;
const loggedErrors = [];
console.error = (...args) => loggedErrors.push(args);
assert.equal(await advanceTerrainDestruction(collapse.tile), collapse.tile);
console.error = originalConsoleError;
assert.equal(collapse.flag.stage, 1);
assert.equal(onPlatform.level, middle.id);
assert.equal(onPlatform.elevation, middle.elevation.bottom);
assert.equal(failing.level, upper.id, "one failed Token does not prevent the other fall");
assert.equal(chatMessages.length, 1, "platform collapse emits one combined Chat message");
assert.match(chatMessages[0].content, /The balcony &lt;snaps&gt;!/);
assert.doesNotMatch(chatMessages[0].content, /Platform\.Chat\.Collapsed/);
assert.match(chatMessages[0].content, /Hero &lt;One&gt;/);
assert.match(chatMessages[0].content, /Underneath/);
assert.equal(errors.length, 1, "failed Token moves notify the GM");
assert.equal(loggedErrors.length, 1, "failed Token moves are logged for diagnosis");

// A Tile assigned to multiple Levels gathers and moves Tokens independently on every one.
onPlatform.level = onPlatform._source.level = upper.id;
onPlatform.elevation = onPlatform._source.elevation = 35;
underneath.level = underneath._source.level = middle.id;
underneath.elevation = underneath._source.elevation = 10;
dialogSelection = [onPlatform.id, underneath.id];
const multiple = createTile({id: "multiple", levelIds: [upper.id, middle.id]});
const multipleContext = getPlatformTokenContext(multiple.tile);
assert.deepEqual(multipleContext.candidates.map(token => token.id), [
  onPlatform.id,
  failing.id,
  underneath.id
]);
const messagesBeforeMultiple = chatMessages.length;
await advanceTerrainDestruction(multiple.tile);
assert.equal(onPlatform.level, middle.id, "the upper Token falls to the middle Level");
assert.equal(underneath.level, ground.id, "the middle Token falls to the ground Level");
assert.equal(chatMessages.length, messagesBeforeMultiple + 1, "all Levels share one collapse message");
assert.doesNotMatch(
  chatMessages.at(-1).content,
  /gives way|Platform\.Chat\.Collapsed/,
  "a blank custom message omits the introductory collapse sentence"
);

onPlatform.level = onPlatform._source.level = upper.id;
onPlatform.elevation = onPlatform._source.elevation = 35;
dialogSelection = [onPlatform.id];
settings.enableFallingMessages = false;
const silent = createTile({id: "silent"});
const messagesBeforeSilentCollapse = chatMessages.length;
await advanceTerrainDestruction(silent.tile);
assert.equal(silent.flag.stage, 1, "disabling messages does not prevent platform destruction");
assert.equal(onPlatform.level, middle.id, "disabling messages does not prevent platform falls");
assert.equal(chatMessages.length, messagesBeforeSilentCollapse, "platform-collapse messages can be suppressed");
settings.enableFallingMessages = true;

// Reset the successful Token for cancellation and revalidation scenarios.
onPlatform.level = onPlatform._source.level = upper.id;
onPlatform.elevation = onPlatform._source.elevation = 35;
dialogSelection = null;
const canceled = createTile({id: "canceled"});
assert.equal(await advanceTerrainDestruction(canceled.tile), null);
assert.equal(canceled.flag.stage, 0, "canceling leaves the Tile at its previous stage");

dialogSelection = [onPlatform.id];
const staged = createTile({id: "staged", states: ["cracked.webp", "destroyed.webp"]});
const beforeDialogs = dialogCalls;
await advanceTerrainDestruction(staged.tile);
assert.equal(staged.flag.stage, 1);
assert.equal(dialogCalls, beforeDialogs, "non-final damage does not prompt for a collapse");
await advanceTerrainDestruction(staged.tile);
assert.equal(staged.flag.stage, 2);
assert.equal(dialogCalls, beforeDialogs + 1);

onPlatform.level = onPlatform._source.level = upper.id;
onPlatform.elevation = onPlatform._source.elevation = 35;
settings.enableLevelTools = false;
const disabled = createTile({id: "disabled"});
const disabledDialogs = dialogCalls;
await advanceTerrainDestruction(disabled.tile);
assert.equal(disabled.flag.stage, 1);
assert.equal(dialogCalls, disabledDialogs);
assert.equal(onPlatform.level, upper.id, "disabled Level Tools makes the Tile ordinary terrain");
settings.enableLevelTools = true;

const ambiguous = createTile({id: "ambiguous", levelIds: []});
await assert.rejects(() => advanceTerrainDestruction(ambiguous.tile), /PlatformLevelRequired/);
assert.equal(ambiguous.flag.stage, 0);
const lowest = createTile({id: "lowest", levelIds: [ground.id]});
await assert.rejects(() => advanceTerrainDestruction(lowest.tile), /NoLevelBelow/);
assert.equal(lowest.flag.stage, 0);

onPlatform.level = onPlatform._source.level = upper.id;
onPlatform.elevation = onPlatform._source.elevation = 35;
onPlatform._source.x = 50;
onPlatform._source.y = 50;
dialogSelection = [onPlatform.id];
const revalidationPlan = await promptPlatformCollapse(inspection.tile);
onPlatform._source.x = 150;
await completePlatformCollapse(inspection.tile, revalidationPlan);
assert.equal(onPlatform.level, upper.id, "a chosen Token that leaves the platform before collapse is skipped");

onPlatform._source.x = 50;
onPlatform.level = onPlatform._source.level = upper.id;
onPlatform.elevation = onPlatform._source.elevation = 35;
const changedLevelPlan = await promptPlatformCollapse(multiple.tile);
onPlatform.level = onPlatform._source.level = middle.id;
await completePlatformCollapse(multiple.tile, changedLevelPlan);
assert.equal(onPlatform.level, middle.id, "a chosen Token that changes assigned platform Levels is skipped");
assert.equal(onPlatform.elevation, 35, "skipping a changed-Level Token preserves its elevation");

console.log("platform collapse tests passed");
