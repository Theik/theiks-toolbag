import {getFootprintImageSetting} from "../settings.js";

export const MODULE_ID = "theiks-toolbag";
export const CONFIG_FLAG = "footprintConfig";
export const TRAILS_FLAG = "footprintTrails";
export const REGION_TYPE = `${MODULE_ID}.footprints`;
export const MAX_PRINTS = 100;
export const TRAILS_VERSION = 1;

const MODES = new Set(["inherit", "suppress", "enable", "situational"]);
const COLOR = /^#[\da-f]{6}$/i;

function flag(document, key) {
  return document?.getFlag?.(MODULE_ID, key) ?? document?.flags?.[MODULE_ID]?.[key] ?? {};
}

function image(value) { return typeof value === "string" ? value.trim() : ""; }
function color(value) { return typeof value === "string" && COLOR.test(value) ? value : ""; }

export function getSceneFootprintConfig(scene) {
  const stored = flag(scene, CONFIG_FLAG);
  return {enabled: stored.enabled === true, image: image(stored.image), tint: color(stored.tint) || "#ffffff"};
}

export function getLevelFootprintConfig(level, scene = level?.parent) {
  const base = getSceneFootprintConfig(scene);
  if (!level) return base;
  const stored = flag(level, CONFIG_FLAG);
  return {
    enabled: stored.enabled === "true" ? true : stored.enabled === "false" ? false : base.enabled,
    image: image(stored.image) || base.image,
    tint: stored.tintOverride === true ? (color(stored.tint) || "#ffffff") : base.tint
  };
}

export function getTokenFootprintConfig(token) {
  const stored = flag(token, CONFIG_FLAG);
  return {noFootprints: stored.noFootprints === true, image: image(stored.image)};
}

export function getStoredTrails(scene) {
  const stored = flag(scene, TRAILS_FLAG);
  return stored?.version === TRAILS_VERSION && stored.trails && typeof stored.trails === "object"
    ? {version: TRAILS_VERSION, trails: stored.trails}
    : {version: TRAILS_VERSION, trails: {}};
}

function levelFor(scene, id) {
  if (id == null) return null;
  return scene?.levels?.get?.(String(id))
    ?? scene?.levels?.contents?.find?.(level => String(level.id) === String(id))
    ?? null;
}

function list(collection) {
  if (!collection) return [];
  if (Array.isArray(collection.contents)) return collection.contents;
  if (Array.isArray(collection)) return collection;
  return Array.from(collection.values?.() ?? []);
}

function matchingRegion(region, level, point) {
  if (region.hidden === true || region._source?.hidden === true) return false;
  if (level && typeof region.includedInLevel === "function") {
    try { if (!region.includedInLevel(level)) return false; }
    catch (_error) { return false; }
  }
  const assigned = region.levels ?? region._source?.levels;
  if (level && assigned && typeof region.includedInLevel !== "function") {
    const ids = typeof assigned === "string" ? [assigned] : Array.from(assigned, entry => String(entry?.id ?? entry));
    if (ids.length && !ids.includes(String(level.id))) return false;
  }
  try {
    if (typeof region.testPoint === "function") return region.testPoint(point) === true;
    return region.object?.testPoint?.(point) === true;
  }
  catch (_error) { return false; }
}

/** Resolve one point, carrying prior enablement through situational regions. */
export function resolveFootprintPoint(scene, levelId, point, cameFromEnabled = false, token = null) {
  const level = levelFor(scene, levelId);
  const base = getLevelFootprintConfig(level, scene);
  let suppress = false;
  let enable = false;
  let situational = false;
  let regionImage = "";
  let regionTint = "";
  for (const region of list(scene?.regions)) {
    if (!matchingRegion(region, level, point)) continue;
    for (const behavior of list(region.behaviors)) {
      if (behavior.disabled === true || behavior._source?.disabled === true) continue;
      if ((behavior.type ?? behavior._source?.type) !== REGION_TYPE) continue;
      const system = behavior.system ?? behavior._source?.system ?? {};
      const mode = MODES.has(system.mode) ? system.mode : "inherit";
      if (mode === "suppress") suppress = true;
      else if (mode === "enable") enable = true;
      else if (mode === "situational") situational = true;
      if (image(system.image)) regionImage = image(system.image);
      if (color(system.tint)) regionTint = color(system.tint);
    }
  }
  const enabled = suppress ? false : enable ? true : situational ? cameFromEnabled : base.enabled;
  const tokenConfig = getTokenFootprintConfig(token);
  return {
    enabled: enabled && !tokenConfig.noFootprints,
    image: tokenConfig.image || regionImage || base.image || getFootprintImageSetting(),
    tint: regionTint || base.tint
  };
}

/** Check whether a historical print still belongs to an enabled area. */
export function printStillEnabled(scene, print) {
  return resolveFootprintPoint(scene, print.levelId,
    {x: print.groundX ?? print.x, y: print.groundY ?? print.y, elevation: print.elevation},
    print.cameFromEnabled === true).enabled;
}

/** Produce marks for actual passed waypoints. State spans consecutive movement sections. */
export function sampleFootprints(scene, token, waypoints, movementId, previousState = null) {
  const grid = Number(scene?.grid?.size);
  if (!(grid > 0) || !Array.isArray(waypoints) || waypoints.length < 2
    || getTokenFootprintConfig(token).noFootprints) return {prints: [], state: previousState};
  const prints = [];
  let state = previousState ? {...previousState} : null;
  let segmentNumber = 0;
  let routeDistance = 0;
  for (let i = 1; i < waypoints.length; i += 1) {
    const a = waypoints[i - 1];
    const b = waypoints[i];
    const levelId = String(b.level ?? a.level ?? token.level ?? scene.initialLevel ?? "");
    if (a.level != null && b.level != null && a.level !== b.level) { state = null; continue; }
    if (String(b.action ?? "").toLowerCase().includes("teleport")) { state = null; continue; }
    const scale = Math.max(0.1, Math.min(Number(b.width ?? token.width ?? 1), Number(b.height ?? token.height ?? 1)));
    const ax = Number(a.x) + (Number(a.width ?? token.width ?? 1) * grid / 2);
    const ay = Number(a.y) + (Number(a.height ?? token.height ?? 1) * grid / 2);
    const bx = Number(b.x) + (Number(b.width ?? token.width ?? 1) * grid / 2);
    const by = Number(b.y) + (Number(b.height ?? token.height ?? 1) * grid / 2);
    const dx = bx - ax;
    const dy = by - ay;
    const length = Math.hypot(dx, dy) / grid;
    if (!(length > 0) || !Number.isFinite(length)) continue;
    const elevation = Number(b.elevation ?? a.elevation ?? token.elevation ?? 0);
    if (!state || state.levelId !== levelId || state.scale !== scale
      || Math.hypot((state.lastX ?? Infinity) - ax, (state.lastY ?? Infinity) - ay) > grid / 20) {
      state = freshState(scene, token, levelId, {x: ax, y: ay, elevation}, scale, movementId, segmentNumber++);
    }
    let traveled = 0;
    while (traveled < length - 1e-8) {
      const advance = Math.min(length - traveled, 0.125, state.next);
      if (!(advance > 1e-8)) state.next = 0.35 * scale;
      traveled += advance;
      const fraction = traveled / length;
      const groundX = ax + (dx * fraction);
      const groundY = ay + (dy * fraction);
      const before = state.enabled;
      const appearance = resolveFootprintPoint(scene, levelId,
        {x: groundX, y: groundY, elevation}, before, token);
      if (!appearance.enabled) {
        state.enabled = false;
        state.next = 0.175 * scale;
        continue;
      }
      if (!before) {
        state.segmentId = `${movementId}:${segmentNumber++}`;
        state.distance = 0;
        state.side = 0;
        state.next = 0.175 * scale;
      } else state.next -= advance;
      state.enabled = true;
      state.distance += advance;
      if (state.next > 1e-7) continue;
      const sideSign = state.side === 0 ? 1 : -1;
      const lateral = 0.12 * scale * grid * sideSign;
      prints.push({
        x: groundX + (dy / (length * grid) * lateral),
        y: groundY - (dx / (length * grid) * lateral),
        groundX, groundY, elevation, levelId,
        rotation: (Math.atan2(dy, dx) * 180 / Math.PI) + 90,
        side: state.side, scale, image: appearance.image, tint: appearance.tint,
        segmentId: state.segmentId, distance: state.distance,
        cameFromEnabled: before, progress: routeDistance + traveled
      });
      state.side = 1 - state.side;
      state.next = 0.35 * scale;
    }
    state.lastX = bx;
    state.lastY = by;
    routeDistance += length;
  }
  return {prints, state};
}

function freshState(scene, token, levelId, point, scale, movementId, index) {
  const enabled = resolveFootprintPoint(scene, levelId, point, false, token).enabled;
  return {
    levelId, scale, segmentId: `${movementId}:${index}`, distance: 0,
    next: 0.175 * scale, side: 0, enabled, lastX: point.x, lastY: point.y
  };
}

export function appendFootprints(stored, tokenId, prints, state) {
  const trails = {...(stored?.trails ?? {})};
  const existing = trails[tokenId] ?? {prints: [], state: null};
  trails[tokenId] = {prints: [...existing.prints, ...prints].slice(-MAX_PRINTS), state};
  return {version: TRAILS_VERSION, trails};
}

export function pruneDisabledPrints(stored, scene) {
  const trails = {};
  let changed = false;
  for (const [id, trail] of Object.entries(stored?.trails ?? {})) {
    const prints = (trail.prints ?? []).filter(print => printStillEnabled(scene, print));
    if (prints.length !== (trail.prints ?? []).length) changed = true;
    trails[id] = {...trail, prints};
  }
  return {changed, stored: {version: TRAILS_VERSION, trails}};
}

export function printAlpha(distanceFromEnd, cutoff) {
  if (!(cutoff > 0) || distanceFromEnd >= cutoff) return 0;
  const fadeStart = cutoff / 2;
  if (distanceFromEnd <= fadeStart) return 1;
  const remaining = Math.max(0, (cutoff - distanceFromEnd) / fadeStart);
  return remaining * remaining;
}
