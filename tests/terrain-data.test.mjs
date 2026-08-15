import assert from "node:assert/strict";
import {
  getBreakableTerrainData,
  normalizeTerrainStates,
  shouldShowIntermediateTerrainScripts
} from "../scripts/breakable-terrain/terrain-config.js";

assert.deepEqual(normalizeTerrainStates(["", " cracked.webp ", null, "rubble.webp"]), [
  "",
  "cracked.webp",
  "rubble.webp"
]);
assert.deepEqual(normalizeTerrainStates({2: "third.webp", 0: "first.webp", 1: ""}), [
  "first.webp",
  "",
  "third.webp"
]);
assert.deepEqual(normalizeTerrainStates("only.webp"), ["only.webp"]);
assert.deepEqual(normalizeTerrainStates(""), [""], "one empty picker remains an intentional hidden state");
assert.equal(shouldShowIntermediateTerrainScripts(["destroyed.webp"]), false);
assert.equal(shouldShowIntermediateTerrainScripts(["cracked.webp", "destroyed.webp"]), true);
assert.equal(shouldShowIntermediateTerrainScripts(["destroyed.webp"], [{
  getFlag: () => ({states: ["cracked.webp", "destroyed.webp"]})
}]), true, "a mixed terrain selection shows intermediate scripts when any selected tile uses them");

const hiddenState = {
  getFlag: () => ({enabled: true, states: [""], stage: 0})
};
assert.equal(getBreakableTerrainData(hiddenState).canAdvance, true, "an empty image is a valid hidden damage state");

const flag = {
  enabled: true,
  platform: false,
  platformMessage: "",
  blocksMovement: true,
  blocksVision: false,
  states: ["cracked.webp", "rubble.webp"],
  stage: 0,
  restoreSrc: null,
  behaviors: undefined,
  scripts: {
    damaged: "damage();",
    destroyed: "destroy();",
    repairedPartial: "partial();",
    repaired: "repair();"
  }
};
const tile = {getFlag: () => flag};

const normalizedFlag = getBreakableTerrainData(tile);
assert.deepEqual({...normalizedFlag, behaviors: undefined}, {
  enabled: true,
  platform: false,
  platformMessage: "",
  blocksMovement: true,
  blocksVision: false,
  states: ["cracked.webp", "rubble.webp"],
  stage: 0,
  restoreSrc: null,
  behaviors: undefined,
  scripts: {
    damaged: "damage();",
    destroyed: "destroy();",
    repairedPartial: "partial();",
    repaired: "repair();"
  },
  damaged: false,
  fullyDestroyed: false,
  canAdvance: true,
  blocks: true
});
assert.deepEqual(normalizedFlag.behaviors.map(({id, events, source}) => ({id, events, source})), [
  {id: "legacy-damaged", events: ["damaged"], source: "damage();"},
  {id: "legacy-destroyed", events: ["destroyed"], source: "destroy();"},
  {id: "legacy-repairedPartial", events: ["repairedPartial"], source: "partial();"},
  {id: "legacy-repaired", events: ["repaired"], source: "repair();"}
]);

flag.platform = true;
assert.equal(getBreakableTerrainData(tile).platform, true);
flag.platformMessage = "  The bridge snaps!  ";
assert.equal(getBreakableTerrainData(tile).platformMessage, "The bridge snaps!");

flag.stage = 1;
flag.restoreSrc = "statue.webp";
assert.equal(getBreakableTerrainData(tile).damaged, true);
assert.equal(getBreakableTerrainData(tile).fullyDestroyed, false);
assert.equal(getBreakableTerrainData(tile).canAdvance, true);
assert.equal(getBreakableTerrainData(tile).blocks, true);

flag.stage = 2;
assert.equal(getBreakableTerrainData(tile).fullyDestroyed, true);
assert.equal(getBreakableTerrainData(tile).canAdvance, false);
assert.equal(getBreakableTerrainData(tile).blocks, false);

flag.states = [];
assert.equal(getBreakableTerrainData(tile).fullyDestroyed, true, "a damaged tile with missing states fails open");

const malformed = {
  getFlag: () => ({
    enabled: "yes",
    platformMessage: 7,
    blocksMovement: 1,
    blocksVision: null,
    states: "broken.webp",
    stage: -2,
    restoreSrc: 4
  })
};
assert.deepEqual(getBreakableTerrainData(malformed), {
  enabled: false,
  platform: false,
  platformMessage: "",
  blocksMovement: false,
  blocksVision: false,
  states: ["broken.webp"],
  stage: 0,
  restoreSrc: null,
  behaviors: [],
  scripts: {damaged: "", destroyed: "", repairedPartial: "", repaired: ""},
  damaged: false,
  fullyDestroyed: false,
  canAdvance: false,
  blocks: false
});

console.log("terrain data tests passed");
