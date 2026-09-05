import assert from "node:assert/strict";
import {
  TOWARD_OFF,
  TOWARD_ON,
  getUsableStateName,
  getUsableTileData,
  normalizeUsableStates
} from "../scripts/usable-tiles/tile-config.js";

assert.deepEqual(normalizeUsableStates({2: " on.webp ", 0: " off.webp ", 1: " step.webp "}), [
  "off.webp", "step.webp", "on.webp"
]);
assert.deepEqual(normalizeUsableStates(["off.webp", "", null, " on.webp "]), ["off.webp", "on.webp"]);
assert.equal(getUsableStateName(0, 3), "off");
assert.equal(getUsableStateName(1, 3), "step");
assert.equal(getUsableStateName(2, 3), "on");

const flag = {
  enabled: true,
  states: ["off.webp", "step.webp", "on.webp"],
  index: 1,
  direction: TOWARD_OFF,
  behaviors: []
};
const tile = {getFlag: () => flag};
assert.deepEqual(getUsableTileData(tile), {
  enabled: true,
  states: flag.states,
  index: 1,
  direction: TOWARD_OFF,
  behaviors: [],
  state: "step",
  configured: true
});

flag.index = 2;
flag.direction = TOWARD_ON;
assert.equal(getUsableTileData(tile).direction, TOWARD_OFF, "the on endpoint always points back toward off");
flag.index = 0;
flag.direction = TOWARD_OFF;
assert.equal(getUsableTileData(tile).direction, TOWARD_ON, "the off endpoint always points toward on");

const malformed = {getFlag: () => ({enabled: "yes", states: ["only.webp"], index: 99, direction: "sideways"})};
assert.deepEqual(getUsableTileData(malformed), {
  enabled: false,
  states: ["only.webp"],
  index: 0,
  direction: TOWARD_ON,
  behaviors: [],
  state: "off",
  configured: false
});

console.log("usable Tile data tests passed");
