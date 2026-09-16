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
const TOOL_NAME = "theiksToolbagExcavate";
const REPAIR_TOOL_NAME = "theiksToolbagExcavateRepair";
const BRUSH_SIZE = 1;

let active = false;
let repairMode = false;
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

function addControls(controls) {
  const data = safelyReadCurrentData();
  const control = controls[CONTROL_NAME];
  if (!control || !game.user?.isGM || !isUndergroundAvailable() || !data) return;
  control.tools[TOOL_NAME] = {
    name: TOOL_NAME,
    order: 3,
    title: "THEIKS_TOOLBAG.Underground.Controls.Excavate",
    icon: "fa-solid fa-person-digging",
    visible: true,
    interaction: false,
    control: false,
    onChange: (_event, enabled) => setExcavationActive(enabled)
  };
  control.tools[REPAIR_TOOL_NAME] = {
    name: REPAIR_TOOL_NAME,
    order: 4,
    title: "THEIKS_TOOLBAG.Underground.Controls.Repair",
    icon: "fa-solid fa-fill-drip",
    visible: true,
    toggle: true,
    active: repairMode,
    onChange: (_event, enabled) => { repairMode = enabled; redrawPreview(); }
  };
}

export function setExcavationActive(enabled) {
  const next = enabled === true && game.user?.isGM && isUndergroundAvailable() && safelyReadCurrentData();
  if (Boolean(next) === active) return;
  active = Boolean(next);
  if (active) attachInteraction();
  else detachInteraction();
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
  preview?.removeFromParent();
  preview?.destroy?.();
  preview = null;
}

function bindCanvasElement() {
  const next = canvas.app?.renderer?.canvas ?? canvas.app?.view ?? null;
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
  if (!beginStroke(event, pointerCanvasPoint(event))) return;
  event.stopPropagation?.();
}

function onElementPointerDown(event) {
  if (!beginStroke(event, pointerCanvasPoint(event))) return;
  event.preventDefault?.();
  event.stopPropagation?.();
}

function beginStroke(event, point) {
  if (!active || pointerButton(event) !== 0) return false;
  updateHover(point);
  if (!currentHover.length) return false;
  drawing = true;
  stroke = new Set(currentHover);
  redrawPreview();
  return true;
}

async function onPointerUp(event) {
  if (!active || !drawing) return;
  event.stopPropagation?.();
  await commitStroke();
}

async function onElementPointerUp(event) {
  if (!active || !drawing) return;
  event.preventDefault?.();
  event.stopPropagation?.();
  await commitStroke();
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
  const clientX = event?.clientX ?? event?.nativeEvent?.clientX;
  const clientY = event?.clientY ?? event?.nativeEvent?.clientY;
  if (Number.isFinite(clientX) && Number.isFinite(clientY)
    && typeof canvas.canvasCoordinatesFromClient === "function") {
    return canvas.canvasCoordinatesFromClient({x: clientX, y: clientY});
  }
  if (Number.isFinite(canvas.mousePosition?.x) && Number.isFinite(canvas.mousePosition?.y)) {
    return {x: canvas.mousePosition.x, y: canvas.mousePosition.y};
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
    const data = getUndergroundData(canvas.scene);
    if (!data?.enabled) return null;
    return isViewedUndergroundLevel(data, {scene: canvas.scene, level: canvas.level}) ? data : null;
  } catch (_error) {
    return null;
  }
}
