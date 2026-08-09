import assert from "node:assert/strict";
import { calculateRubbleGeometry } from "../scripts/breakable-walls/wall-destruction.js";

const horizontal = calculateRubbleGeometry([0, 0, 125, 0]);
assert.deepEqual(
  {x: horizontal.x, y: horizontal.y, width: horizontal.width, height: horizontal.height, rotation: horizontal.rotation},
  {x: 63, y: 0, width: 125, height: 250, rotation: 0}
);
assert.ok(horizontal.positiveNormal.y > 0, "horizontal positive side points down");

const reversedHorizontal = calculateRubbleGeometry([125, 0, 0, 0]);
assert.equal(reversedHorizontal.rotation, 0, "reversing endpoints does not rotate the artwork");
assert.deepEqual(reversedHorizontal.positiveNormal, horizontal.positiveNormal);

const vertical = calculateRubbleGeometry([0, 125, 0, 0]);
assert.equal(vertical.rotation, 90, "vertical orientation is endpoint-order independent");
assert.ok(vertical.positiveNormal.x < 0, "vertical positive side points left");

const diagonal = calculateRubbleGeometry([0, 0, 100, 100]);
assert.equal(diagonal.rotation, 45);
assert.equal(diagonal.width, 141);
assert.equal(diagonal.height, 283);

assert.throws(() => calculateRubbleGeometry([1, 1, 1, 1]));

console.log("wall geometry tests passed");
