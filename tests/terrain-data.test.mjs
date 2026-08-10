import assert from "node:assert/strict";
import {
  getBreakableTerrainData,
  normalizeTerrainStates
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
  restoreSrc: null
};
const tile = {getFlag: () => flag};

assert.deepEqual(getBreakableTerrainData(tile), {
  enabled: true,
  platform: false,
  platformMessage: "",
  blocksMovement: true,
  blocksVision: false,
  states: ["cracked.webp", "rubble.webp"],
  stage: 0,
  restoreSrc: null,
  damaged: false,
  fullyDestroyed: false,
  canAdvance: true,
  blocks: true
});

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
  damaged: false,
  fullyDestroyed: false,
  canAdvance: false,
  blocks: false
});

console.log("terrain data tests passed");
