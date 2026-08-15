import assert from "node:assert/strict";
import {
  getVisibleLightData,
  getVisibleLightImage,
  getVisibleLightState,
  isVisibleLightConfigured
} from "../scripts/visible-lights/light-config.js";
import {calculateLightArtworkGeometry} from "../scripts/visible-lights/light-art.js";

const stored = {
  destroyed: false,
  images: {on: "on.webp", off: "off.webp", destroyed: "broken.webp"},
  scripts: {toggledOn: "on();", toggledOff: "off();", destroyed: "destroy();"}
};
const light = {
  hidden: false,
  getFlag: () => stored
};

const normalizedStored = getVisibleLightData(light);
assert.deepEqual({...normalizedStored, behaviors: undefined}, {...stored, behaviors: undefined});
assert.deepEqual(normalizedStored.behaviors.map(({id, events, source}) => ({id, events, source})), [
  {id: "legacy-toggledOn", events: ["toggledOn"], source: "on();"},
  {id: "legacy-toggledOff", events: ["toggledOff"], source: "off();"},
  {id: "legacy-destroyed", events: ["destroyed"], source: "destroy();"}
]);
assert.equal(isVisibleLightConfigured(light), true);
assert.equal(getVisibleLightState(light), "on");
assert.equal(getVisibleLightImage(light), "on.webp");

light.hidden = true;
assert.equal(getVisibleLightState(light), "off");
assert.equal(getVisibleLightImage(light), "off.webp");

stored.destroyed = true;
light.hidden = false;
assert.equal(getVisibleLightState(light), "destroyed", "destroyed takes precedence over Foundry's hidden state");
assert.equal(getVisibleLightImage(light), "broken.webp");

assert.deepEqual(
  calculateLightArtworkGeometry({x: 125, y: 250, rotation: 135}, 100),
  {x: 125, y: 250, width: 100, height: 100, rotation: 135}
);
assert.equal(calculateLightArtworkGeometry({x: 0, y: 0}, 100).rotation, 0);
assert.throws(() => calculateLightArtworkGeometry({x: 0, y: 0}, 0));
assert.throws(() => calculateLightArtworkGeometry({x: 0, y: 0, rotation: Number.NaN}, 100));

const malformed = {
  getFlag: () => ({destroyed: "yes", images: {on: null, off: 4}})
};
assert.deepEqual(getVisibleLightData(malformed), {
  destroyed: false,
  images: {on: "", off: "", destroyed: ""},
  behaviors: [],
  scripts: {toggledOn: "", toggledOff: "", destroyed: ""}
});
assert.equal(isVisibleLightConfigured(malformed), false);

console.log("visible light data tests passed");
