import assert from "node:assert/strict";
import test from "node:test";

globalThis.game = {
  i18n: {
    localize: key => key,
    format: (key, data) => `${key}:${data?.name ?? ""}`
  }
};

const {
  createOccupancyTropeCycler,
  openUndergroundProgressDialog
} = await import("../scripts/underground/underground-progress.js");

test("occupancy trope cycler walks the list", () => {
  const tropes = ["A", "B", "C"];
  const cycler = createOccupancyTropeCycler({tropes, random: () => 0});
  assert.equal(tropes.includes(cycler.current()), true);
  assert.equal(tropes.includes(cycler.next()), true);
});

test("renders cancellable occupancy progress and disables cancellation during persist", async () => {
  const status = {textContent: ""};
  const cancelButton = {disabled: false};
  let dialogOptions;
  let closes = 0;
  let clearedTimer = null;
  const timers = [];
  const createTropeCycler = () => ({
    current: () => "Checking which dirt is still dirt…",
    next: () => "Politely asking the dungeon to stay put…"
  });
  class FakeDialogV2 {
    constructor(options) {
      dialogOptions = options;
      this.rendered = false;
      this.element = {querySelector: selector => (
        selector === "[data-underground-status]" ? status
          : selector === '[data-action="cancel"]' ? cancelButton
            : null
      )};
      this.window = {content: this.element, close: {disabled: false}};
    }

    async render() {
      this.rendered = true;
      return this;
    }

    async close() {
      closes += 1;
      this.rendered = false;
      dialogOptions.close?.();
    }
  }

  const controller = new AbortController();
  const progress = await openUndergroundProgressDialog("Basement", controller, {
    DialogV2: FakeDialogV2,
    renderTemplate: async (_template, data) => {
      status.textContent = data.status;
      assert.equal(data.message.includes("Basement"), true);
      assert.equal(data.icon, "modules/theiks-toolbag/assets/images/tabletop-by-theik-icon.png");
      return "<div></div>";
    },
    createTropeCycler,
    waitForPaint: async () => {},
    setIntervalFn: callback => {
      const timer = {callback, cleared: false};
      timers.push(timer);
      return timer;
    },
    clearIntervalFn: timer => {
      clearedTimer = timer;
      timer.cleared = true;
    },
    tropeIntervalMs: 50
  });
  assert.equal(progress.dialog.rendered, true);
  assert.equal(dialogOptions.id, "theiks-toolbag-underground-progress");
  assert.equal(dialogOptions.form.closeOnSubmit, false);
  assert.equal(status.textContent, "Checking which dirt is still dirt…");

  timers[0].callback();
  assert.equal(status.textContent, "Politely asking the dungeon to stay put…");

  dialogOptions.buttons[0].callback();
  assert.equal(controller.signal.aborted, true);

  const persistenceController = new AbortController();
  const persistenceProgress = await openUndergroundProgressDialog("Basement", persistenceController, {
    DialogV2: FakeDialogV2,
    renderTemplate: async (_template, data) => {
      status.textContent = data.status;
      return "<div></div>";
    },
    createTropeCycler,
    waitForPaint: async () => {},
    setIntervalFn: callback => {
      const timer = {callback, cleared: false};
      timers.push(timer);
      return timer;
    },
    clearIntervalFn: timer => {
      clearedTimer = timer;
      timer.cleared = true;
    },
    tropeIntervalMs: 50
  });
  persistenceProgress.setCreating();
  dialogOptions.buttons[0].callback();
  assert.equal(persistenceController.signal.aborted, false);
  assert.equal(cancelButton.disabled, true);

  await persistenceProgress.finish();
  assert.equal(closes >= 1, true);
  assert.equal(clearedTimer?.cleared, true);
  await persistenceProgress.finish();
});
