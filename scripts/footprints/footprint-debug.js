import {getStoredTrails, MODULE_ID, TRAILS_FLAG} from "./footprint-data.js";

export const FOOTPRINT_OVERLAY_NAME = `${MODULE_ID}.footprintPaths`;
const MAX_SECTIONS = 30;
const COLORS = {
  saved: 0x5ccaff,
  raw: 0xffb347,
  corrected: 0x00e5e5,
  left: 0x4cf58a,
  right: 0xe87aff,
  blocked: 0xff4d4d,
  overlap: 0xffd84d,
  offset: 0xffffff
};

let enabled = false;
let overlay = null;
let tracedScene = null;
let sections = [];

/** Local GM debug view. Omit force to flip it, or pass a boolean to set it. */
export function toggleFootprintOverlay(force) {
  if (!globalThis.game?.user?.isGM) {
    enabled = false;
    sections = [];
    tracedScene = null;
    destroyOverlay();
    return false;
  }
  enabled = force === true ? true : force === false ? false : !enabled;
  if (!enabled) {
    sections = [];
    tracedScene = null;
    destroyOverlay();
  } else refreshFootprintOverlay();
  return enabled;
}

export function isFootprintOverlayEnabled() {
  return enabled && globalThis.game?.user?.isGM === true;
}

export function registerFootprintDebug() {
  globalThis.Hooks?.on?.("canvasReady", refreshFootprintOverlay);
  globalThis.Hooks?.on?.("canvasTearDown", () => {
    sections = [];
    tracedScene = null;
    destroyOverlay();
  });
  globalThis.Hooks?.on?.("updateScene", (scene, changes) => {
    if (scene?.id !== globalThis.canvas?.scene?.id || !enabled) return;
    const flags = changes?.flags?.[MODULE_ID] ?? {};
    if (Object.hasOwn(flags, TRAILS_FLAG) || Object.hasOwn(flags, `-=${TRAILS_FLAG}`)) {
      if (!Object.keys(getStoredTrails(scene).trails).length) {
        sections = [];
        tracedScene = null;
      }
    }
    refreshFootprintOverlay();
  });
}

export function recordFootprintDebug(scene, key, debug) {
  if (!isFootprintOverlayEnabled() || scene?.id !== globalThis.canvas?.scene?.id
    || !Array.isArray(debug)) return;
  if (tracedScene !== scene.id) {
    tracedScene = scene.id;
    sections = [];
  }
  sections = sections.filter(entry => entry.key !== key);
  for (const section of debug) sections.push({key, ...section});
  sections = sections.slice(-MAX_SECTIONS);
  refreshFootprintOverlay();
}

export function clearFootprintDebug(scene) {
  if (scene?.id !== tracedScene) return;
  sections = [];
  tracedScene = null;
  refreshFootprintOverlay();
}

export function refreshFootprintOverlay() {
  if (!isFootprintOverlayEnabled()) {
    destroyOverlay();
    return;
  }
  const canvas = globalThis.canvas;
  const scene = canvas?.scene;
  const parent = canvas?.interface ?? canvas?.stage;
  const levelId = String(canvas?.level?.id ?? scene?.initialLevel ?? "");
  if (!canvas?.ready || !scene || !parent) {
    destroyOverlay();
    return;
  }
  const graphics = ensureOverlay(parent);
  if (!graphics) return;
  graphics.clear?.();
  paintSavedPrints(graphics, scene, levelId);
  if (tracedScene !== scene.id) return;
  for (const section of sections) {
    if (String(section.levelId) !== levelId) continue;
    drawPath(graphics, section.raw, COLORS.raw, 2, 0.85);
    if (section.corrected) drawPath(graphics, section.corrected, COLORS.corrected, 3, 0.9);
    else cross(graphics, midpoint(section.raw), COLORS.blocked, 8);
    for (const attempt of section.attempts) {
      if (attempt.result === "placed") {
        stroke(graphics, {x: attempt.groundX, y: attempt.groundY}, attempt,
          COLORS.offset, 1, 0.6);
        circle(graphics, attempt, attempt.side === 0 ? COLORS.left : COLORS.right, 4);
      } else cross(graphics, attempt,
        attempt.result === "overlap" ? COLORS.overlap : COLORS.blocked, 5);
    }
  }
}

function paintSavedPrints(graphics, scene, levelId) {
  for (const trail of Object.values(getStoredTrails(scene).trails)) {
    let previous = null;
    for (const print of trail.prints ?? []) {
      if (String(print.levelId) !== levelId) { previous = null; continue; }
      const ground = {x: print.groundX ?? print.x, y: print.groundY ?? print.y};
      if (previous?.segmentId === print.segmentId) {
        stroke(graphics, previous.ground, ground, COLORS.saved, 1.5, 0.55);
      }
      stroke(graphics, ground, print, COLORS.offset, 1, 0.6);
      circle(graphics, print, print.side === 0 ? COLORS.left : COLORS.right, 4);
      previous = {ground, segmentId: print.segmentId};
    }
  }
}

function midpoint(points) {
  if (!points?.length) return {x: 0, y: 0};
  const a = points[0];
  const b = points.at(-1);
  return {x: (a.x + b.x) / 2, y: (a.y + b.y) / 2};
}

function drawPath(graphics, points, color, width, alpha) {
  for (let i = 1; i < (points?.length ?? 0); i += 1) {
    stroke(graphics, points[i - 1], points[i], color, width, alpha);
  }
}

function stroke(graphics, a, b, color, width, alpha = 1) {
  if (typeof graphics.lineStyle === "function") {
    graphics.lineStyle(width, color, alpha);
    graphics.moveTo(a.x, a.y);
    graphics.lineTo(b.x, b.y);
    return;
  }
  graphics.moveTo?.(a.x, a.y);
  graphics.lineTo?.(b.x, b.y);
  graphics.stroke?.({color, width, alpha});
}

function circle(graphics, point, color, radius) {
  if (typeof graphics.beginFill === "function") {
    graphics.beginFill(color, 0.95);
    graphics.drawCircle?.(point.x, point.y, radius);
    graphics.endFill?.();
    return;
  }
  graphics.circle?.(point.x, point.y, radius);
  graphics.fill?.({color, alpha: 0.95});
}

function cross(graphics, point, color, radius) {
  stroke(graphics, {x: point.x - radius, y: point.y - radius},
    {x: point.x + radius, y: point.y + radius}, color, 2);
  stroke(graphics, {x: point.x - radius, y: point.y + radius},
    {x: point.x + radius, y: point.y - radius}, color, 2);
}

function ensureOverlay(parent) {
  if (overlay && overlay.parent === parent && overlay.destroyed !== true) return overlay;
  destroyOverlay();
  const Graphics = globalThis.PIXI?.Graphics;
  if (typeof Graphics !== "function") return null;
  overlay = new Graphics();
  overlay.name = FOOTPRINT_OVERLAY_NAME;
  overlay.eventMode = "none";
  overlay.interactive = false;
  overlay.zIndex = 10000;
  if (parent.sortableChildren != null) parent.sortableChildren = true;
  parent.addChild?.(overlay);
  return overlay;
}

function destroyOverlay() {
  if (!overlay) return;
  overlay.removeFromParent?.();
  overlay.destroy?.();
  overlay = null;
}
