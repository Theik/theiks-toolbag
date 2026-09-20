import {getFootprintImageSetting} from "../settings.js";
import {createFootprintRouter} from "./footprint-routing.js";

export const MODULE_ID = "theiks-toolbag";
export const CONFIG_FLAG = "footprintConfig";
export const TRAILS_FLAG = "footprintTrails";
export const REGION_TYPE = `${MODULE_ID}.footprints`;
export const MAX_PRINTS = 100;
export const TRAILS_VERSION = 1;

const MODES = new Set(["inherit", "suppress", "enable", "situational"]);
const MOVEMENT_TYPES = new Set(["bipedal", "quadruped", "quadrupedAlternating", "slither"]);
const ALTERNATE_SIDES = new Set(["none", "left", "right"]);
const GAITS = Object.freeze({
  bipedal: [{leg: "foot", side: 0}, {leg: "foot", side: 1}],
  quadruped: [
    {leg: "hind", side: 0}, {leg: "front", side: 1},
    {leg: "front", side: 0}, {leg: "hind", side: 1}
  ],
  quadrupedAlternating: [
    {leg: "hind", side: 0}, {leg: "front", side: 1},
    {leg: "hind", side: 1}, {leg: "front", side: 0}
  ],
  slither: [{leg: "body", side: 0}, {leg: "body", side: 1}]
});
const COLOR = /^#[\da-f]{6}$/i;

function flag(document, key) {
  return document?.getFlag?.(MODULE_ID, key) ?? document?.flags?.[MODULE_ID]?.[key] ?? {};
}

function image(value) { return typeof value === "string" ? value.trim() : ""; }
function color(value) { return typeof value === "string" && COLOR.test(value) ? value : ""; }

function isTeleportAction(action) {
  const name = String(action ?? "");
  const configured = globalThis.CONFIG?.Token?.movement?.actions?.[name];
  if (configured) return configured.teleport === true;
  return ["blink", "displace", "teleport"].includes(name.toLowerCase());
}

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
  return {
    noFootprints: stored.noFootprints === true,
    image: image(stored.image),
    movementType: MOVEMENT_TYPES.has(stored.movementType) ? stored.movementType : "bipedal",
    alternateSide: ALTERNATE_SIDES.has(stored.alternateSide) ? stored.alternateSide : "none",
    alternateImage: image(stored.alternateImage),
    frontImage: image(stored.frontImage),
    frontAlternateSide: ALTERNATE_SIDES.has(stored.frontAlternateSide) ? stored.frontAlternateSide : "none",
    frontAlternateImage: image(stored.frontAlternateImage)
  };
}

function imageForStep(baseImage, tokenConfig, leg, side) {
  if (leg === "body") return baseImage;
  const chosenSide = side === 0 ? "left" : "right";
  const backAlternate = tokenConfig.alternateSide === chosenSide ? tokenConfig.alternateImage : "";
  if (leg !== "front") return backAlternate || baseImage;
  const frontBase = tokenConfig.frontImage || baseImage;
  const frontAlternate = tokenConfig.frontAlternateSide === chosenSide
    ? tokenConfig.frontAlternateImage : "";
  if (frontAlternate) return frontAlternate;
  const inheritBackPattern = !tokenConfig.frontImage
    && tokenConfig.frontAlternateSide === "none";
  return (inheritBackPattern && backAlternate) || frontBase;
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

function isOnLevelSurface(scene, levelId, elevation) {
  const bottom = levelFor(scene, levelId)?.elevation?.bottom;
  return bottom != null && Number.isFinite(Number(bottom))
    && Number.isFinite(elevation) && elevation === Number(bottom);
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
export function sampleFootprints(scene, token, waypoints, movementId, previousState = null, options = {}) {
  const grid = Number(scene?.grid?.size);
  const tokenConfig = getTokenFootprintConfig(token);
  if (!(grid > 0) || !Array.isArray(waypoints) || waypoints.length < 2
    || tokenConfig.noFootprints) return {prints: [], state: previousState};
  const movementType = tokenConfig.movementType;
  const gait = GAITS[movementType];
  const prints = [];
  const debug = options.debug === true ? [] : null;
  const router = createFootprintRouter(scene, grid);
  let state = previousState ? {...previousState} : null;
  let segmentNumber = 0;
  let routeDistance = 0;
  let broken = false;
  for (let i = 1; i < waypoints.length; i += 1) {
    const a = waypoints[i - 1];
    const b = waypoints[i];
    const levelId = String(b.level ?? a.level ?? token.level ?? scene.initialLevel ?? "");
    const breakSegment = (a.level != null && b.level != null && a.level !== b.level)
      || isTeleportAction(b.action);
    const scale = Math.max(0.1, Math.min(Number(b.width ?? token.width ?? 1), Number(b.height ?? token.height ?? 1)));
    const ax = Number(a.x) + (Number(a.width ?? token.width ?? 1) * grid / 2);
    const ay = Number(a.y) + (Number(a.height ?? token.height ?? 1) * grid / 2);
    const bx = Number(b.x) + (Number(b.width ?? token.width ?? 1) * grid / 2);
    const by = Number(b.y) + (Number(b.height ?? token.height ?? 1) * grid / 2);
    const dx = bx - ax;
    const dy = by - ay;
    const length = Math.hypot(dx, dy) / grid;
    const fromElevation = Number(a.elevation ?? b.elevation ?? token.elevation ?? 0);
    const elevation = Number(b.elevation ?? a.elevation ?? token.elevation ?? 0);
    if (breakSegment || fromElevation !== elevation
      || !isOnLevelSurface(scene, levelId, elevation)) {
      state = null;
      broken = true;
      if (Number.isFinite(length)) routeDistance += length;
      continue;
    }
    if (!(length > 0) || !Number.isFinite(length)) continue;
    const path = router
      ? router.route(levelId, {x: ax, y: ay}, {x: bx, y: by}, scale, elevation)
      : [{x: ax, y: ay}, {x: bx, y: by}];
    const debugSection = debug && {
      levelId, raw: [{x: ax, y: ay}, {x: bx, y: by}], corrected: path,
      attempts: []
    };
    if (debugSection) debug.push(debugSection);
    if (!path) {
      state = null;
      broken = true;
      routeDistance += length;
      continue;
    }
    const pathLength = path.slice(1).reduce((sum, point, index) => sum
      + Math.hypot(point.x - path[index].x, point.y - path[index].y), 0) / grid;
    const quadruped = movementType === "quadruped" || movementType === "quadrupedAlternating";
    const stride = (movementType === "quadrupedAlternating" ? 0.5
      : quadruped ? 0.25 : 0.35) * scale;
    if (!state || state.levelId !== levelId || state.scale !== scale
      || (state.movementType ?? "bipedal") !== movementType
      || (quadruped && state.stride !== stride)
      || Math.hypot((state.lastX ?? Infinity) - ax, (state.lastY ?? Infinity) - ay) > grid / 20) {
      state = freshState(scene, token, levelId, {x: ax, y: ay, elevation}, scale,
        movementId, segmentNumber++, movementType, stride);
    }
    let distanceOnPath = 0;
    for (let j = 1; j < path.length; j += 1) {
      const start = path[j - 1];
      const end = path[j];
      const pieceX = end.x - start.x;
      const pieceY = end.y - start.y;
      const pieceLength = Math.hypot(pieceX, pieceY) / grid;
      if (!(pieceLength > 0)) continue;
      let traveled = 0;
      while (traveled < pieceLength - 1e-8) {
        const advance = Math.min(pieceLength - traveled, 0.125, state.next);
        if (!(advance > 1e-8)) state.next = stride;
        traveled += advance;
        const fraction = traveled / pieceLength;
        const groundX = start.x + (pieceX * fraction);
        const groundY = start.y + (pieceY * fraction);
        const before = state.enabled;
        const appearance = resolveFootprintPoint(scene, levelId,
          {x: groundX, y: groundY, elevation}, before, token);
        if (!appearance.enabled) {
          state.enabled = false;
          state.next = movementType === "quadrupedAlternating" ? stride / 4 : stride / 2;
          continue;
        }
        if (!before) {
          state.segmentId = `${movementId}:${segmentNumber++}`;
          state.distance = 0;
          state.side = 0;
          state.gaitIndex = 0;
          state.next = movementType === "quadrupedAlternating" ? stride / 4 : stride / 2;
          state.lastPrintX = null;
          state.lastPrintY = null;
        } else state.next -= advance;
        state.enabled = true;
        state.distance += advance;
        if (state.next > 1e-7) continue;
        const pair = movementType === "quadrupedAlternating"
          && gait[state.gaitIndex ?? 0].leg === "hind";
        for (let stepAtPoint = 0; stepAtPoint < (pair ? 2 : 1); stepAtPoint += 1) {
          const gaitIndex = state.gaitIndex ?? state.side ?? 0;
          const step = gait[gaitIndex];
          const sideSign = step.side === 0 ? 1 : -1;
          const lateral = 0.12 * scale * grid * sideSign;
          const ground = {x: groundX, y: groundY};
          const candidate = movementType === "slither" ? ground : {
            x: groundX + (pieceY / (pieceLength * grid) * lateral),
            y: groundY - (pieceX / (pieceLength * grid) * lateral)
          };
          const foot = router
            ? movementType === "slither"
              ? router.placeCenter(levelId, ground, scale, elevation)
              : router.placeFoot(levelId, ground, candidate, scale, elevation)
            : candidate;
          // Tight turns and doorway clearance can bring two print centers together.
          const separation = (movementType === "quadrupedAlternating" ? 0.2
            : movementType === "quadruped" ? 0.3
              : movementType === "slither" ? 0.25 : 0.4) * scale * grid;
          const separated = foot && (state.lastPrintX == null || Math.hypot(
            foot.x - state.lastPrintX, foot.y - state.lastPrintY) >= separation);
          if (debugSection && debugSection.attempts.length < 200) {
            debugSection.attempts.push({
              x: foot?.x ?? candidate.x, y: foot?.y ?? candidate.y,
              groundX, groundY, side: step.side, leg: step.leg,
              result: !foot ? "blocked" : separated ? "placed" : "overlap"
            });
          }
          if (!separated) {
            // Keep the missing foot pending and retry shortly farther along the route.
            state.next = 0.1 * scale;
            break;
          }
          prints.push({
            x: foot.x, y: foot.y, groundX, groundY, elevation, levelId,
            rotation: (Math.atan2(pieceY, pieceX) * 180 / Math.PI) + 90,
            side: step.side, leg: step.leg, movementType, scale,
            image: imageForStep(appearance.image, tokenConfig, step.leg, step.side),
            tint: appearance.tint,
            segmentId: state.segmentId, distance: state.distance,
            cameFromEnabled: before,
            progress: routeDistance + length * ((distanceOnPath + traveled) / pathLength)
          });
          state.lastPrintX = foot.x;
          state.lastPrintY = foot.y;
          state.gaitIndex = (gaitIndex + 1) % gait.length;
          state.side = gait[state.gaitIndex].side;
          state.next = stride;
        }
      }
      distanceOnPath += pieceLength;
    }
    state.lastX = bx;
    state.lastY = by;
    state.lastElevation = elevation;
    routeDistance += length;
  }
  return {prints, state, broken, ...(debug ? {debug} : {})};
}

function freshState(scene, token, levelId, point, scale, movementId, index, movementType, stride) {
  const enabled = resolveFootprintPoint(scene, levelId, point, false, token).enabled;
  return {
    levelId, scale, movementType, stride, segmentId: `${movementId}:${index}`, distance: 0,
    next: movementType === "quadrupedAlternating" ? stride / 4 : stride / 2,
    gaitIndex: 0, side: 0, enabled, lastX: point.x, lastY: point.y,
    lastElevation: point.elevation,
    lastPrintX: null, lastPrintY: null
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
