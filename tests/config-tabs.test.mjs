import assert from "node:assert/strict";
import {
  TOOLBAG_TAB_ID,
  mountToolbagConfigTab,
  removeToolbagConfigTabs
} from "../scripts/config-tabs.js";

class ClassList {
  constructor(element) {
    this.element = element;
    this.values = new Set();
  }
  add(...values) { values.forEach(value => this.values.add(value)); }
  remove(...values) { values.forEach(value => this.values.delete(value)); }
  contains(value) { return this.values.has(value); }
  toggle(value, force) {
    const enabled = force ?? !this.contains(value);
    if (enabled) this.add(value);
    else this.remove(value);
    return enabled;
  }
  set(value) { this.values = new Set(String(value).split(/\s+/).filter(Boolean)); }
  toString() { return [...this.values].join(" "); }
}

class FakeElement {
  constructor(tagName, ownerDocument) {
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = ownerDocument;
    this.dataset = {};
    this.attributes = new Map();
    this.children = [];
    this.parentElement = null;
    this.classList = new ClassList(this);
    this.innerHTML = "";
  }
  get className() { return this.classList.toString(); }
  set className(value) { this.classList.set(value); }
  append(...children) {
    for (const child of children) {
      child.parentElement?.removeChild(child);
      child.parentElement = this;
      this.children.push(child);
    }
  }
  before(sibling) {
    const index = this.parentElement.children.indexOf(this);
    this.parentElement.insertBefore(sibling, this.parentElement.children[index]);
  }
  insertBefore(child, reference) {
    child.parentElement?.removeChild(child);
    child.parentElement = this;
    const index = reference ? this.children.indexOf(reference) : -1;
    if (index < 0) this.children.push(child);
    else this.children.splice(index, 0, child);
  }
  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    child.parentElement = null;
  }
  remove() { this.parentElement?.removeChild(this); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  insertAdjacentHTML(_position, html) { this.innerHTML += html; }
  closest(selector) {
    for (let current = this; current; current = current.parentElement) {
      if (matches(current, selector)) return current;
    }
    return null;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  querySelectorAll(selector) {
    const selectors = selector.split(",").map(value => value.trim());
    const results = [];
    for (const part of selectors) {
      if (part.startsWith(":scope > ")) {
        const direct = part.slice(9);
        results.push(...this.children.filter(child => matches(child, direct)));
        continue;
      }
      const pieces = part.split(/\s+/);
      for (const candidate of descendants(this)) {
        if (!matches(candidate, pieces.at(-1))) continue;
        let ancestor = candidate.parentElement;
        let matched = true;
        for (let index = pieces.length - 2; index >= 0; index -= 1) {
          while (ancestor && !matches(ancestor, pieces[index])) ancestor = ancestor.parentElement;
          if (!ancestor) { matched = false; break; }
          ancestor = ancestor.parentElement;
        }
        if (matched && !results.includes(candidate)) results.push(candidate);
      }
    }
    return results;
  }
}

class FakeDocument {
  constructor() { this.body = new FakeElement("body", this); }
  createElement(tagName) { return new FakeElement(tagName, this); }
  querySelectorAll(selector) { return this.body.querySelectorAll(selector); }
}

function* descendants(root) {
  for (const child of root.children) {
    yield child;
    yield* descendants(child);
  }
}

function matches(element, selector) {
  const notClass = selector.match(/:not\(\.([\w-]+)\)/)?.[1];
  selector = selector.replace(/:not\([^)]*\)/g, "");
  if (notClass && element.classList.contains(notClass)) return false;
  const tag = selector.match(/^[a-z][\w-]*/i)?.[0];
  if (tag && element.tagName !== tag.toUpperCase()) return false;
  for (const className of selector.matchAll(/\.([\w-]+)/g)) {
    if (!element.classList.contains(className[1])) return false;
  }
  for (const attribute of selector.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)) {
    const [, name, expected] = attribute;
    const actual = name.startsWith("data-")
      ? element.dataset[name.slice(5).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase())]
      : element.attributes.get(name);
    if (actual === undefined || (expected !== undefined && actual !== expected)) return false;
  }
  return true;
}

globalThis.game = {i18n: {localize: key => key === "THEIKS_TOOLBAG.ConfigTabs.Toolbag" ? "Theik's Toolbag" : key}};

const normalDocument = new FakeDocument();
globalThis.document = normalDocument;
const normalForm = normalDocument.createElement("form");
const nativeNavigation = normalDocument.createElement("nav");
nativeNavigation.className = "sheet-tabs tabs top-tabs";
const nativeControl = normalDocument.createElement("a");
nativeControl.dataset.group = "sheet";
nativeControl.dataset.tab = "basic";
nativeNavigation.append(nativeControl);
const nativePanel = normalDocument.createElement("section");
nativePanel.className = "tab standard-form scrollable active";
nativePanel.dataset.group = "sheet";
nativePanel.dataset.tab = "basic";
const footer = normalDocument.createElement("footer");
normalForm.append(nativeNavigation, nativePanel, footer);
normalDocument.body.append(normalForm);

const normalApp = {form: normalForm, tabGroups: {sheet: "basic"}};
const mountedNormal = mountToolbagConfigTab({
  application: normalApp,
  element: normalForm,
  content: "<fieldset>Toolbag</fieldset>",
  feature: "visibleLights",
  nativeTab: "basic",
  nativeLabel: "Light",
  nativeIcon: "fa-solid fa-lightbulb"
});
assert.equal(mountedNormal.panel.dataset.tab, TOOLBAG_TAB_ID);
assert.equal(mountedNormal.panel.innerHTML, "<fieldset>Toolbag</fieldset>");
assert.equal(normalForm.children.at(-1), footer, "the form footer remains outside tab content");
assert.equal(nativeNavigation.children.length, 2);
assert.equal(
  mountToolbagConfigTab({
    application: normalApp,
    element: normalForm,
    content: "duplicate",
    feature: "visibleLights",
    nativeTab: "basic",
    nativeLabel: "Light",
    nativeIcon: "fa-solid fa-lightbulb"
  }).panel,
  mountedNormal.panel,
  "rerender protection returns the existing panel"
);
removeToolbagConfigTabs("visibleLights", normalDocument);
assert.equal(nativeNavigation.children.length, 1);
assert.equal(normalForm.querySelector(".theiks-toolbag-config-tab"), null);

const generatedDocument = new FakeDocument();
globalThis.document = generatedDocument;
const generatedForm = generatedDocument.createElement("form");
const generatedBody = generatedDocument.createElement("div");
generatedBody.className = "standard-form scrollable";
const generatedFooter = generatedDocument.createElement("footer");
generatedForm.append(generatedBody, generatedFooter);
generatedDocument.body.append(generatedForm);

const generatedApp = {form: generatedForm, tabGroups: {}};
const mountedGenerated = mountToolbagConfigTab({
  application: generatedApp,
  element: generatedForm,
  content: "<fieldset>Wall tools</fieldset>",
  feature: "breakableWalls",
  nativeLabel: "Wall",
  nativeIcon: "fa-solid fa-block-brick"
});
assert.equal(generatedForm.children[0].tagName, "NAV");
assert.equal(generatedForm.children[1], generatedBody);
assert.equal(generatedForm.children[2], mountedGenerated.panel);
assert.equal(generatedForm.children[3], generatedFooter);
assert.equal(generatedBody.classList.contains("tab"), true);
assert.equal(generatedBody.classList.contains("active"), true);
assert.equal(generatedForm.children[0].children.length, 2);

removeToolbagConfigTabs("breakableWalls", generatedDocument);
assert.deepEqual(generatedForm.children, [generatedBody, generatedFooter]);
assert.equal(generatedBody.classList.contains("tab"), false);
assert.equal(generatedBody.dataset.tab, undefined);

console.log("config tab tests passed");
