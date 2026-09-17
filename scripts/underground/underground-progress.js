import {MODULE_ID} from "./underground-data.js";

const LOADING_TROPE_INTERVAL_MS = 3000;
const PROGRESS_TEMPLATE = `modules/${MODULE_ID}/templates/underground-progress.hbs`;

export const OCCUPANCY_TROPES = Object.freeze([
  "Checking which dirt is still dirt…",
  "Politely asking the dungeon to stay put…",
  "Counting transparent pixels, one handful at a time…",
  "Convincing packed earth it does not belong in the hallway…",
  "Shaking pebbles out of the basement map…",
  "Looking for floor under all that black…",
  "Telling the moles to wait their turn…",
  "Measuring the hole where a room used to be…",
  "Wiping mud off the grid lines…",
  "Asking the cave-in to be slightly more rectangular…",
  "Sorting rubble from actual architecture…",
  "Waiting for the last pixel to admit it is see-through…"
]);

export function shuffleTropes(tropes, random = Math.random) {
  const order = tropes.slice();
  for (let index = order.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [order[index], order[swapIndex]] = [order[swapIndex], order[index]];
  }
  return order;
}

export function createOccupancyTropeCycler({
  tropes = OCCUPANCY_TROPES,
  random = Math.random
} = {}) {
  let order = shuffleTropes(tropes, random);
  let index = 0;

  const reshuffle = previous => {
    let attempts = 0;
    do {
      order = shuffleTropes(tropes, random);
      attempts += 1;
    } while (order[0] === previous && attempts < 8);
    index = 0;
  };

  return {
    current() {
      return order[index];
    },
    next() {
      index += 1;
      if (index >= order.length) reshuffle(order[order.length - 1]);
      return order[index];
    }
  };
}

/** Open a modal occupancy scan dialog with a cycling status line. */
export async function openUndergroundProgressDialog(name, abortController, {
  DialogV2 = foundry.applications.api.DialogV2,
  renderTemplate = foundry.applications.handlebars.renderTemplate,
  createTropeCycler = createOccupancyTropeCycler,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  tropeIntervalMs = LOADING_TROPE_INTERVAL_MS,
  waitForPaint = defaultWaitForPaint
} = {}) {
  const tropeCycler = createTropeCycler();
  const content = await renderTemplate(PROGRESS_TEMPLATE, {
    icon: `modules/${MODULE_ID}/assets/images/tabletop-by-theik-icon.png`,
    message: format("Progress.Intro", {name: name || localize("Progress.Untitled")}),
    status: tropeCycler.current(),
    cancel: localize("Progress.Cancel")
  });
  let settled = false;
  let persistenceStarted = false;
  let statusElement = null;
  let cancelButton = null;
  let closeButton = null;
  let tropeTimer = null;
  const cancel = () => {
    if (!settled && !persistenceStarted) abortController.abort();
  };
  const dialog = new DialogV2({
    id: `${MODULE_ID}-underground-progress`,
    window: {
      title: localize("Progress.Title"),
      icon: "fa-solid fa-shovel"
    },
    classes: ["theiks-toolbag"],
    form: {closeOnSubmit: false},
    content,
    buttons: [{
      action: "cancel",
      label: localize("Progress.Cancel"),
      icon: "fa-solid fa-xmark",
      callback: cancel
    }],
    close: cancel,
    modal: true
  });
  await dialog.render({force: true});
  await waitForPaint();
  statusElement = dialog.element?.querySelector?.("[data-underground-status]")
    ?? dialog.window?.content?.querySelector?.("[data-underground-status]")
    ?? null;
  cancelButton = dialog.element?.querySelector?.('[data-action="cancel"]') ?? null;
  closeButton = dialog.window?.close ?? null;
  tropeTimer = setIntervalFn(() => {
    if (statusElement) statusElement.textContent = tropeCycler.next();
  }, tropeIntervalMs);

  return {
    dialog,
    update() {},
    setCreating() {
      persistenceStarted = true;
      if (cancelButton) cancelButton.disabled = true;
      if (closeButton) closeButton.disabled = true;
    },
    async finish() {
      if (settled) return;
      settled = true;
      if (tropeTimer !== null) clearIntervalFn(tropeTimer);
      if (cancelButton) cancelButton.disabled = false;
      if (closeButton) closeButton.disabled = false;
      if (dialog.rendered !== false) await dialog.close();
    }
  };
}

function defaultWaitForPaint() {
  return new Promise(resolve => {
    if (typeof globalThis.requestAnimationFrame === "function") {
      globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(() => resolve()));
      return;
    }
    setTimeout(resolve, 32);
  });
}

function localize(key) {
  return globalThis.game?.i18n?.localize?.(`THEIKS_TOOLBAG.Underground.${key}`) ?? key;
}

function format(key, data) {
  return globalThis.game?.i18n?.format?.(`THEIKS_TOOLBAG.Underground.${key}`, data) ?? key;
}
