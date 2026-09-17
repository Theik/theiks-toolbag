import {
  MODULE_ID,
  getUndergroundData,
  isUndergroundSubcell,
  isViewedUndergroundLevel
} from "./underground-data.js";

export const UNDERGROUND_OVERLAY_NAME = `${MODULE_ID}.undergroundOverlay`;
const OVERLAY_COLOR = 0x00BFFF;
const OVERLAY_ALPHA = 0.4;

let enabled = false;
let overlay = null;

export function isUndergroundOverlayEnabled() {
  return enabled === true;
}

/** GM-only occupancy overlay. Omit `force` to flip; pass a boolean to set. */
export function toggleUndergroundOverlay(force) {
  if (!globalThis.game?.user?.isGM) {
    enabled = false;
    destroyOverlay();
    return false;
  }
  enabled = force === true ? true : force === false ? false : !enabled;
  if (!enabled) destroyOverlay();
  else refreshUndergroundOverlay();
  return enabled;
}

export function refreshUndergroundOverlay() {
  if (!enabled) {
    destroyOverlay();
    return;
  }
  if (!globalThis.game?.user?.isGM) {
    enabled = false;
    destroyOverlay();
    return;
  }
  const parent = overlayParent();
  const data = overlayData();
  if (!parent || !data) {
    destroyOverlay();
    return;
  }
  const graphics = ensureOverlay(parent);
  if (!graphics) return;
  paintOverlay(graphics, occupancyOverlayRects(data));
}

export function registerUndergroundDebug() {
  globalThis.Hooks?.on?.("canvasReady", refreshUndergroundOverlay);
  globalThis.Hooks?.on?.("canvasTearDown", destroyOverlay);
  globalThis.Hooks?.on?.("updateScene", refreshForSceneUpdate);
  globalThis.Hooks?.on?.("updateLevel", refreshForLevelUpdate);
}

/** Merged world-space rectangles covering every sourceMask subcell. */
export function occupancyOverlayRects(data) {
  const rects = [];
  if (!data) return rects;
  const sub = data.subGridSize;
  for (let sy = 0; sy < data.subHeight; sy += 1) {
    let runStart = -1;
    for (let sx = 0; sx <= data.subWidth; sx += 1) {
      const occupied = sx < data.subWidth
        && isUndergroundSubcell(data, (sy * data.subWidth) + sx);
      if (occupied) {
        if (runStart < 0) runStart = sx;
        continue;
      }
      if (runStart < 0) continue;
      rects.push({
        x: data.origin.x + runStart * sub,
        y: data.origin.y + sy * sub,
        width: (sx - runStart) * sub,
        height: sub
      });
      runStart = -1;
    }
  }
  return rects;
}

function refreshForSceneUpdate(scene) {
  if (scene !== globalThis.canvas?.scene) return;
  refreshUndergroundOverlay();
}

function refreshForLevelUpdate(level) {
  const scene = level?.parent ?? globalThis.canvas?.scene;
  if (!scene || scene !== globalThis.canvas?.scene) return;
  refreshUndergroundOverlay();
}

function overlayData() {
  const scene = globalThis.canvas?.scene;
  if (!scene) return null;
  try {
    const data = getUndergroundData(scene);
    if (!data?.enabled || !isViewedUndergroundLevel(data)) return null;
    return data;
  } catch (_error) {
    return null;
  }
}

function overlayParent() {
  const current = globalThis.canvas;
  return current?.interface ?? current?.stage ?? null;
}

function ensureOverlay(parent) {
  if (overlay && overlay.parent === parent && overlay.destroyed !== true) {
    overlay.clear?.();
    return overlay;
  }
  destroyOverlay();
  const Graphics = globalThis.PIXI?.Graphics;
  if (typeof Graphics !== "function") return null;
  overlay = new Graphics();
  overlay.name = UNDERGROUND_OVERLAY_NAME;
  overlay.eventMode = "none";
  overlay.interactive = false;
  overlay.zIndex = 10000;
  if (parent.sortableChildren != null) parent.sortableChildren = true;
  parent.addChild?.(overlay);
  return overlay;
}

function paintOverlay(graphics, rects) {
  graphics.clear?.();
  for (const rect of rects) fillOverlayRect(graphics, rect);
}

function fillOverlayRect(graphics, rect) {
  if (typeof graphics.beginFill === "function" && typeof graphics.drawRect === "function") {
    graphics.beginFill(OVERLAY_COLOR, OVERLAY_ALPHA);
    graphics.drawRect(rect.x, rect.y, rect.width, rect.height);
    graphics.endFill?.();
    return;
  }
  graphics.rect?.(rect.x, rect.y, rect.width, rect.height);
  graphics.fill?.({color: OVERLAY_COLOR, alpha: OVERLAY_ALPHA});
}

function destroyOverlay() {
  if (!overlay) return;
  overlay.removeFromParent?.();
  overlay.destroy?.();
  overlay = null;
}
