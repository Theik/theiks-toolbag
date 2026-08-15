import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

globalThis.foundry = {utils: {equals: (left, right) => JSON.stringify(left) === JSON.stringify(right)}};
const {hasIdenticalBehaviorLists} = await import("../scripts/script-behaviors-ui.js");

const behavior = {
  id: "one",
  type: "executeScript",
  name: "Example",
  disabled: false,
  events: ["destroyed"],
  source: "run();"
};
assert.equal(hasIdenticalBehaviorLists([]), true);
assert.equal(hasIdenticalBehaviorLists([[behavior], [structuredClone(behavior)]]), true);
assert.equal(hasIdenticalBehaviorLists([[behavior], [{...behavior, disabled: true}]]), false);

const list = await readFile(new URL("../templates/script-behavior-list.hbs", import.meta.url), "utf8");
assert.match(list, /data-toolbag-behavior-action="add"/);
assert.match(list, /data-toolbag-behavior-action="toggle"/);
assert.match(list, /data-toolbag-behavior-action="edit"/);
assert.match(list, /data-toolbag-behavior-action="delete"/);
assert.match(list, /MultipleValues/);

const editor = await readFile(new URL("../templates/script-behavior-config.hbs", import.meta.url), "utf8");
assert.match(editor, /name="name"/);
assert.match(editor, /name="disabled"/);
assert.match(editor, /<multi-select name="events">/);
assert.match(editor, /<code-mirror name="source"/);

console.log("script behavior UI tests passed");
