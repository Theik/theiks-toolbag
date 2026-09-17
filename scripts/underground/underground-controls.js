import {
  digUnderground,
  getUndergroundData,
  isDugSubcell,
  isUndergroundAvailable,
  isViewedUndergroundLevel,
  repairUnderground
} from "./underground-data.js";
import {diskSubcellIndexes} from "./underground-geometry.js";

const CONTROL_NAME = "theiksToolbagDestruction";
const MODE_TOOL_NAME = "theiksToolbagDestructionMode";
const RESET_TOOL_NAME = "theiksToolbagResetDestructables";
const TOOL_NAME = "theiksToolbagExcavate";
const REPAIR_TOOL_NAME = "theiksToolbagExcavateRepair";
const BRUSH_SIZE = 1;
const DESTRUCTION_CONTROL_IDS = new Set([
  CONTROL_NAME, MODE_TOOL_NAME, RESET_TOOL_NAME, TOOL_NAME, REPAIR_TOOL_NAME
]);

let active = false;
let repairMode = false;
let brush = null;
let drawing = false;
let stroke = new Set();
let preview = null;
let currentHover = [];
let canvasEl = null;
let mouseMoveRegistered = false;

export function registerUndergroundControls() {
  Hooks.on("getSceneControlButtons", addControls);
  Hooks.on("canvasReady", onCanvasReady);
  Hooks.on("canvasTearDown", onCanvasTearDown);
  Hooks.on("renderSceneControls", onSceneControlsRender);
  Hooks.on("activateSceneControls", onSceneControlsRender);
}

function onCanvasReady() {
  if (!mouseMoveRegistered && typeof canvas.registerMouseMoveHandler === "function") {
    canvas.registerMouseMoveHandler(onRegisteredMouseMove, 100, null, true);
    mouseMoveRegistered = true;
  }
  bindCanvasElement();
}

function onCanvasTearDown() {
  setExcavationActive(false);
  unbindCanvasElement();
}

let registeredTools = null;
let syncingButtons = false;

function addControls(controls) {
  const data = safelyReadCurrentData();
  const control = controls[CONTROL_NAME];
  if (!control || !game.user?.isGM || !isUndergroundAvailable() || !data) return;
  registeredTools = control.tools;
  control.tools[TOOL_NAME] = {
    name: TOOL_NAME,
    order: 3,
    title: "THEIKS_TOOLBAG.Underground.Controls.Excavate",
    icon: "fa-solid fa-person-digging",
    visible: true,
    toggle: true,
    active: brush === "dig",
    interaction: false,
    control: false,
    onChange: (_event, enabled) => setBrush(enabled ? "dig" : (brush === "dig" ? null : brush))
  };
  control.tools[REPAIR_TOOL_NAME] = {
    name: REPAIR_TOOL_NAME,
    order: 4,
    title: "THEIKS_TOOLBAG.Underground.Controls.Repair",
    icon: "fa-solid fa-fill-drip",
    visible: true,
    toggle: true,
    active: brush === "repair",
    onChange: (_event, enabled) => setBrush(enabled ? "repair" : (brush === "repair" ? null : brush))
  };
}

export function setExcavationActive(enabled) {
  setBrush(enabled ? (brush === "repair" ? "repair" : "dig") : null);
}

function setBrush(next) {
  if (next && !(game.user?.isGM && isUndergroundAvailable() && safelyReadCurrentData())) next = null;
  if (next !== "dig" && next !== "repair") next = null;
  const enabled = next !== null;
  brush = next;
  repairMode = next === "repair";
  if (enabled === active) {
    syncBrushButtons();
    if (active) redrawPreview();
    return;
  }
  active = enabled;
  if (active) attachInteraction();
  else detachInteraction();
  syncBrushButtons();
}

function syncBrushButtons() {
  const groups = [
    registeredTools,
    globalThis.ui?.controls?.controls?.[CONTROL_NAME]?.tools,
    globalThis.ui?.controls?.control?.tools
  ];
  for (const tools of groups) {
    if (!tools) continue;
    if (tools[TOOL_NAME]) tools[TOOL_NAME].active = brush === "dig";
    if (tools[REPAIR_TOOL_NAME]) tools[REPAIR_TOOL_NAME].active = brush === "repair";
  }
  const controls = globalThis.ui?.controls;
  if (typeof controls?.render !== "function" || !isDestructionControlActive()) return;
  if (syncingButtons) return;
  syncingButtons = true;
  queueMicrotask(() => {
    try {
      controls.render();
    } finally {
      syncingButtons = false;
    }
  });
}

function attachInteraction() {
  if (!canvas.stage || !canvas.controls) return;
  preview = new PIXI.Graphics();
  preview.name = "theiks-toolbag.undergroundPreview";
  preview.eventMode = "none";
  preview.zIndex = 10000;
  canvas.controls.sortableChildren = true;
  canvas.controls.addChild(preview);
  bindCanvasElement();
  canvas.stage.on("pointermove", onPointerMove);
  canvas.stage.on("pointerdown", onPointerDown);
  canvas.stage.on("pointerup", onPointerUp);
  canvas.stage.on("pointerupoutside", onPointerUp);
  globalThis.window?.addEventListener?.("keydown", onKeyDown);
  globalThis.window?.addEventListener?.("pointerup", onWindowPointerUp, true);
  globalThis.window?.addEventListener?.("pointercancel", onWindowPointerUp, true);
  globalThis.window?.addEventListener?.("mouseup", onWindowPointerUp, true);
}

function detachInteraction() {
  drawing = false;
  stroke.clear();
  currentHover = [];
  canvas.stage?.off?.("pointermove", onPointerMove);
  canvas.stage?.off?.("pointerdown", onPointerDown);
  canvas.stage?.off?.("pointerup", onPointerUp);
  canvas.stage?.off?.("pointerupoutside", onPointerUp);
  globalThis.window?.removeEventListener?.("keydown", onKeyDown);
  globalThis.window?.removeEventListener?.("pointerup", onWindowPointerUp, true);
  globalThis.window?.removeEventListener?.("pointercancel", onWindowPointerUp, true);
  globalThis.window?.removeEventListener?.("mouseup", onWindowPointerUp, true);
  preview?.removeFromParent();
  preview?.destroy?.();
  preview = null;
}

function resolveCanvasElement() {
  return canvas.app?.renderer?.canvas
    ?? canvas.app?.canvas
    ?? canvas.app?.view
    ?? canvas.element
    ?? globalThis.document?.getElementById?.("board")
    ?? null;
}

function bindCanvasElement() {
  const next = resolveCanvasElement();
  if (next === canvasEl) return;
  unbindCanvasElement();
  canvasEl = next;
  canvasEl?.addEventListener("pointerdown", onElementPointerDown, true);
  canvasEl?.addEventListener("pointerup", onElementPointerUp, true);
  canvasEl?.addEventListener("pointercancel", onElementPointerUp, true);
}

function unbindCanvasElement() {
  canvasEl?.removeEventListener("pointerdown", onElementPointerDown, true);
  canvasEl?.removeEventListener("pointerup", onElementPointerUp, true);
  canvasEl?.removeEventListener("pointercancel", onElementPointerUp, true);
  canvasEl = null;
}

function onRegisteredMouseMove(position) {
  if (!active) return;
  updateHover(position);
}

function onPointerMove(event) {
  if (!active) return;
  updateHover(pointerCanvasPoint(event));
}

function onPointerDown(event) {
  beginStroke(event, pointerCanvasPoint(event));
}

function onElementPointerDown(event) {
  beginStroke(event, pointerCanvasPoint(event));
}

function beginStroke(event, point) {
  if (!active || pointerButton(event) !== 0) return false;
  if (drawing) {
    updateHover(point);
    return true;
  }
  drawing = true;
  stroke = new Set();
  updateHover(point);
  return true;
}

async function onPointerUp(_event) {
  if (!active || !drawing) return;
  await commitStroke();
}

async function onElementPointerUp(_event) {
  if (!active || !drawing) return;
  await commitStroke();
}

async function onWindowPointerUp(_event) {
  if (!active || !drawing) return;
  await commitStroke();
}

function onSceneControlsRender() {
  if (!active || isDestructionControlActive()) return;
  setBrush(null);
}

function isDestructionControlActive() {
  const name = currentSceneControlName();
  if (DESTRUCTION_CONTROL_IDS.has(name)) return true;
  const group = globalThis.ui?.controls?.control;
  const tools = group?.tools;
  if (!tools) return false;
  if (tools[TOOL_NAME] || tools[MODE_TOOL_NAME]) return true;
  return Object.values(tools).some(tool => DESTRUCTION_CONTROL_IDS.has(tool?.name));
}

function currentSceneControlName() {
  const controls = globalThis.ui?.controls;
  if (!controls) return null;
  if (typeof controls.control === "string" && controls.control) return controls.control;
  if (controls.control?.name) return controls.control.name;
  if (typeof controls.activeControl === "string" && controls.activeControl) return controls.activeControl;
  return null;
}

async function commitStroke() {
  drawing = false;
  const cells = Array.from(stroke);
  stroke.clear();
  redrawPreview();
  if (!cells.length) return;
  try {
    const action = repairMode ? repairUnderground : digUnderground;
    await action(canvas.scene, cells);
  } catch (error) {
    console.error("theiks-toolbag | Underground brush update failed", error);
    ui.notifications?.error?.(game.i18n.localize("THEIKS_TOOLBAG.Underground.Errors.UpdateFailed"));
  }
}

function onKeyDown(event) {
  if (event.key !== "Escape") return;
  event.preventDefault?.();
  drawing = false;
  stroke.clear();
  redrawPreview();
}

function updateHover(point) {
  const data = safelyReadCurrentData();
  if (!data || !point) return;
  currentHover = diskSubcellIndexes(data, point, BRUSH_SIZE);
  if (drawing) currentHover.forEach(index => stroke.add(index));
  redrawPreview(data);
}

function pointerCanvasPoint(event) {
  if (Number.isFinite(canvas.mousePosition?.x) && Number.isFinite(canvas.mousePosition?.y)) {
    return {x: canvas.mousePosition.x, y: canvas.mousePosition.y};
  }
  const clientX = event?.clientX ?? event?.nativeEvent?.clientX;
  const clientY = event?.clientY ?? event?.nativeEvent?.clientY;
  if (Number.isFinite(clientX) && Number.isFinite(clientY)
    && typeof canvas.canvasCoordinatesFromClient === "function") {
    return canvas.canvasCoordinatesFromClient({x: clientX, y: clientY});
  }
  return event?.getLocalPosition?.(canvas.stage) ?? null;
}

function pointerButton(event) {
  if (Number.isInteger(event?.button)) return event.button;
  if (Number.isInteger(event?.nativeEvent?.button)) return event.nativeEvent.button;
  return 0;
}

function redrawPreview(data = safelyReadCurrentData()) {
  if (!preview || !data) return;
  preview.clear();
  const cells = drawing ? Array.from(stroke) : currentHover;
  const color = repairMode ? 0x4CAF50 : 0xFF9829;
  for (const index of cells) {
    if (repairMode ? !isDugSubcell(data, index) : isDugSubcell(data, index)) continue;
    const x = index % data.subWidth;
    const y = Math.floor(index / data.subWidth);
    fillPreviewCell(
      preview,
      data.origin.x + x * data.subGridSize,
      data.origin.y + y * data.subGridSize,
      data.subGridSize,
      color
    );
  }
}

function fillPreviewCell(graphics, x, y, size, color) {
  if (typeof graphics.rect === "function" && typeof graphics.fill === "function") {
    graphics.rect(x, y, size, size).fill({color, alpha: 0.35});
    return;
  }
  graphics.beginFill?.(color, 0.35);
  graphics.drawRect?.(x, y, size, size);
  graphics.endFill?.();
}

function safelyReadCurrentData() {
  if (!globalThis.canvas?.ready || !canvas.scene) return null;
  try {
    const data = getUndergroundData(canvas.scene, {level: canvas.level});
    if (!data?.enabled) return null;
    return isViewedUndergroundLevel(data, {scene: canvas.scene, level: canvas.level}) ? data : null;
  } catch (_error) {
    return null;
  }
}
