import {
  FEATURES, FEATURE_SETTING_CHANGED_HOOK, FOOTPRINT_CUTOFF_CHANGED_HOOK,
  getFootprintCutoff, isFeatureEnabled
} from "../settings.js";
import {
  MODULE_ID, TRAILS_FLAG, MAX_PRINTS, appendFootprints, getStoredTrails,
  getTokenFootprintConfig, printAlpha, printStillEnabled, pruneDisabledPrints, sampleFootprints
} from "./footprint-data.js";
import {
  clearFootprintDebug, isFootprintOverlayEnabled, recordFootprintDebug, refreshFootprintOverlay
} from "./footprint-debug.js";

const live = new Map();
const movementStates = new Map();
const seenSections = new Set();
const renderMeshes = new Map();
const textures = new Map();
const writeQueues = new Map();
const epochs = new Map();
const missingImages = new Set();
let renderQueued = false;
let renderRevision = 0;

export function registerFootprintRuntime() {
  Hooks.on("moveToken", onMoveToken);
  Hooks.on("canvasReady", queueRender);
  Hooks.on("canvasTearDown", clearCanvas);
  Hooks.on("updateScene", onSceneChange);
  Hooks.on("updateLevel", onLevelChange);
  Hooks.on("deleteToken", token => {
    if (token?.parent?.id) movementStates.delete(sceneKey(token.parent, token.id));
  });
  for (const hook of ["createRegion", "updateRegion", "deleteRegion", "createRegionBehavior", "updateRegionBehavior", "deleteRegionBehavior"]) {
    Hooks.on(hook, onRegionChange);
  }
  Hooks.on("sightRefresh", queueRender);
  Hooks.on("visibilityRefresh", queueRender);
  Hooks.on(FOOTPRINT_CUTOFF_CHANGED_HOOK, queueRender);
  Hooks.on(FEATURE_SETTING_CHANGED_HOOK, (feature, enabled) => {
    if (feature !== FEATURES.footprints) return;
    if (enabled) queueRender();
    else clearMeshes();
  });
}

function sceneKey(scene, tokenId) { return `${scene.id}:${tokenId}`; }

function onMoveToken(token, movement, operation, _user) {
  if (!isFeatureEnabled(FEATURES.footprints)) return;
  const scene = token?.parent;
  if (!scene?.id || !token?.id || !movement?.id) return;
  if (getTokenFootprintConfig(token).noFootprints) {
    breakFootprintMovement(scene, token, movement);
    return;
  }
  if (["paste", "undo", "teleport"].includes(String(movement.method ?? "").toLowerCase())
    || operation?.isPaste === true || operation?.isUndo === true || operation?.teleport === true
    || movement.constrainOptions?.ignoreWalls === true) {
    breakFootprintMovement(scene, token, movement);
    return;
  }
  const passed = movement.passed?.waypoints;
  if (!Array.isArray(passed) || !passed.length) return;
  const route = movement.origin ? [movement.origin, ...passed] : passed;
  if (route.length < 2) return;
  const key = sceneKey(scene, token.id);
  const previous = movementStates.get(key) ?? getStoredTrails(scene).trails[token.id]?.state ?? null;
  const waypoints = previous?.lastMovementId === movement.id
    ? unprocessedWaypoints(route, previous, scene.grid.size)
    : route;
  if (waypoints.length < 2) return;
  const section = `${scene.id}:${token.id}:${movement.id}:${pathHash(waypoints)}`;
  if (seenSections.has(section)) return;
  seenSections.add(section);
  if (seenSections.size > 5000) seenSections.clear();
  const result = sampleFootprints(scene, token, waypoints, movement.id, previous,
    {debug: isFootprintOverlayEnabled()});
  if (result.debug) recordFootprintDebug(scene, section, result.debug);
  if (result.state) result.state.lastMovementId = movement.id;
  if (result.state) movementStates.set(key, result.state);
  else if (result.broken) movementStates.set(key,
    resetMovementState(scene, token, movement, waypoints));
  const prints = result.prints.map((print, index) => ({...print, id: `${section}:${index}`, movementKey: section}));
  if (prints.length) {
    const existing = live.get(key) ?? [];
    live.set(key, [...existing, ...prints].slice(-MAX_PRINTS));
    beginLiveReveal(scene, token, movement, waypoints, section, prints);
    queueRender();
  }
  if (game.users?.activeGM?.id !== game.user?.id) return;
  const epoch = epochs.get(scene.id) ?? 0;
  enqueueSceneWrite(scene, async () => {
    try { await movement.animation?.ended; }
    catch (_error) { /* save the passed section even if its animation stops */ }
    if ((epochs.get(scene.id) ?? 0) !== epoch) return;
    const current = getStoredTrails(scene);
    const ids = new Set(current.trails[token.id]?.prints?.map(print => print.id));
    const unique = prints.filter(print => !ids.has(print.id)).map(({movementKey, progress, ...print}) => print);
    if (!unique.length && !result.state
      && (!result.broken || !current.trails[token.id]?.state)) return;
    await scene.setFlag(MODULE_ID, TRAILS_FLAG, appendFootprints(current, token.id, unique, result.state));
  });
}

function resetMovementState(scene, token, movement, waypoints) {
  const point = waypoints?.at(-1) ?? movement.passed?.waypoints?.at(-1) ?? movement.destination;
  const grid = Number(scene.grid?.size);
  if (!point || !(grid > 0)) return {reset: true};
  return {
    reset: true, lastMovementId: movement.id,
    lastX: Number(point.x) + Number(point.width ?? token.width ?? 1) * grid / 2,
    lastY: Number(point.y) + Number(point.height ?? token.height ?? 1) * grid / 2,
    lastElevation: Number(point.elevation ?? token.elevation ?? 0)
  };
}

function breakFootprintMovement(scene, token, movement) {
  const tokenId = token.id;
  movementStates.set(sceneKey(scene, tokenId), resetMovementState(scene, token, movement));
  if (game.users?.activeGM?.id !== game.user?.id) return;
  const epoch = epochs.get(scene.id) ?? 0;
  enqueueSceneWrite(scene, async () => {
    if ((epochs.get(scene.id) ?? 0) !== epoch) return;
    const current = getStoredTrails(scene);
    if (!current.trails[tokenId]?.state) return;
    await scene.setFlag(MODULE_ID, TRAILS_FLAG, appendFootprints(current, tokenId, [], null));
  });
}

function pathHash(waypoints) {
  let hash = 2166136261;
  for (const waypoint of waypoints) {
    for (const char of `${waypoint.x},${waypoint.y},${waypoint.level},${waypoint.elevation};`) {
      hash ^= char.charCodeAt(0);
      hash = Math.imul(hash, 16777619);
    }
  }
  return (hash >>> 0).toString(36);
}

function unprocessedWaypoints(waypoints, state, grid) {
  if (!state || !(grid > 0)) return waypoints;
  let index = -1;
  for (let i = 1; i < waypoints.length; i += 1) {
    const point = waypoints[i];
    const x = Number(point.x) + Number(point.width ?? 1) * grid / 2;
    const y = Number(point.y) + Number(point.height ?? 1) * grid / 2;
    if (Math.hypot(x - state.lastX, y - state.lastY) <= grid / 20
      && Number(point.elevation ?? state.lastElevation) === state.lastElevation) index = i;
  }
  return index > 0 ? waypoints.slice(index) : waypoints;
}

function beginLiveReveal(scene, token, movement, waypoints, key, prints) {
  const status = {value: 0};
  const thresholds = prints.map(print => print.progress).sort((a, b) => a - b);
  let revealed = 0;
  const duration = Number(movement.animation?.duration ?? 0);
  if (!token.object || !duration || typeof globalThis.requestAnimationFrame !== "function") {
    return;
  }
  liveProgress.set(key, status);
  let stopped = false;
  Promise.resolve(movement.animation?.ended).finally(() => {
    stopped = true;
    liveProgress.delete(key);
    queueRender();
  });
  Promise.resolve(movement.animation?.started).then(() => {
    function tick() {
      if (stopped || scene !== canvas.scene) return;
      const center = token.object?.center;
      if (center) status.value = Math.max(status.value, pathProgress(waypoints, center, scene.grid.size));
      while (revealed < thresholds.length && thresholds[revealed] <= status.value) revealed += 1;
      if (revealed > 0 && revealed !== status.revealed) {
        status.revealed = revealed;
        queueRender();
      }
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  });
}

const liveProgress = new Map();

function pathProgress(waypoints, point, grid) {
  let distance = 0;
  let best = 0;
  let nearest = Infinity;
  for (let i = 1; i < waypoints.length; i += 1) {
    const a = waypoints[i - 1];
    const b = waypoints[i];
    const ax = Number(a.x) + Number(a.width ?? 1) * grid / 2;
    const ay = Number(a.y) + Number(a.height ?? 1) * grid / 2;
    const bx = Number(b.x) + Number(b.width ?? 1) * grid / 2;
    const by = Number(b.y) + Number(b.height ?? 1) * grid / 2;
    const dx = bx - ax;
    const dy = by - ay;
    const length2 = dx * dx + dy * dy;
    if (!(length2 > 0)) continue;
    const t = Math.max(0, Math.min(1, ((point.x - ax) * dx + (point.y - ay) * dy) / length2));
    const x = ax + t * dx;
    const y = ay + t * dy;
    const error = Math.hypot(point.x - x, point.y - y);
    const length = Math.sqrt(length2) / grid;
    if (error < nearest) { nearest = error; best = distance + t * length; }
    distance += length;
  }
  return best;
}

function enqueueSceneWrite(scene, action) {
  const before = writeQueues.get(scene.id) ?? Promise.resolve();
  const next = before.catch(() => {}).then(action).catch(error => {
    console.error(`${MODULE_ID} | Failed to save footprints`, error);
  });
  writeQueues.set(scene.id, next);
  return next;
}

export async function clearSceneFootprints(scene) {
  if (!game.user?.isGM) throw new Error("Only a GM can clear footprints.");
  if (!scene?.id) return;
  epochs.set(scene.id, (epochs.get(scene.id) ?? 0) + 1);
  for (const key of [...live.keys()]) if (key.startsWith(`${scene.id}:`)) live.delete(key);
  for (const key of [...movementStates.keys()]) if (key.startsWith(`${scene.id}:`)) movementStates.delete(key);
  if (scene.id === canvas.scene?.id) clearMeshes();
  clearFootprintDebug(scene);
  await enqueueSceneWrite(scene, () => scene.unsetFlag(MODULE_ID, TRAILS_FLAG));
  if (scene.id === canvas.scene?.id) queueRender();
}

function onSceneChange(scene, changes) {
  if (scene?.id === canvas.scene?.id) {
    if (changedFlag(changes, TRAILS_FLAG)) {
      const saved = getStoredTrails(scene).trails;
      const cleared = Object.keys(saved).length === 0;
      if (cleared) {
        epochs.set(scene.id, (epochs.get(scene.id) ?? 0) + 1);
        for (const key of [...movementStates.keys()]) {
          if (key.startsWith(`${scene.id}:`)) movementStates.delete(key);
        }
      }
      for (const [key, prints] of live) {
        if (!key.startsWith(`${scene.id}:`)) continue;
        if (cleared) { live.delete(key); continue; }
        const tokenId = key.slice(scene.id.length + 1);
        const ids = new Set(saved[tokenId]?.prints?.map(print => print.id));
        const remaining = prints.filter(print => !ids.has(print.id));
        if (remaining.length) live.set(key, remaining);
        else live.delete(key);
      }
    }
    queueRender();
  }
  if (changedFlag(changes, "footprintConfig")) {
    pruneLive(scene);
    queuePrune(scene);
  }
}

function changedFlag(changes, flag) {
  return changes?.flags?.[MODULE_ID]?.[flag] !== undefined
    || Object.hasOwn(changes?.flags?.[MODULE_ID] ?? {}, `-=${flag}`)
    || Object.keys(changes ?? {}).some(key => key.startsWith(`flags.${MODULE_ID}.${flag}`)
      || key === `flags.${MODULE_ID}.-=${flag}`);
}

function onLevelChange(level, changes) {
  if (level?.parent === canvas.scene) queueRender();
  if (changedFlag(changes, "footprintConfig")) {
    pruneLive(level?.parent);
    queuePrune(level?.parent);
  }
}

function onRegionChange(document) {
  const scene = document?.documentName === "RegionBehavior" ? document.parent?.parent : document?.parent;
  if (scene === canvas.scene) queueRender();
  pruneLive(scene);
  queuePrune(scene);
}

function pruneLive(scene) {
  if (!scene?.id) return;
  for (const [key, prints] of live) {
    if (!key.startsWith(`${scene.id}:`)) continue;
    live.set(key, prints.filter(print => printStillEnabled(scene, print)));
  }
}

function queuePrune(scene) {
  if (!scene?.id || game.users?.activeGM?.id !== game.user?.id) return;
  enqueueSceneWrite(scene, async () => {
    const {changed, stored} = pruneDisabledPrints(getStoredTrails(scene), scene);
    if (changed) await scene.setFlag(MODULE_ID, TRAILS_FLAG, stored);
  });
}

function queueRender() {
  if (renderQueued) return;
  renderQueued = true;
  queueMicrotask(() => {
    renderQueued = false;
    void renderCurrent();
  });
}

async function renderCurrent() {
  const revision = ++renderRevision;
  const scene = globalThis.canvas?.scene;
  refreshFootprintOverlay();
  if (!isFeatureEnabled(FEATURES.footprints) || !canvas?.ready || !canvas.primary || !scene) {
    clearMeshes();
    return;
  }
  const cutoff = getFootprintCutoff();
  if (!cutoff) { clearMeshes(); return; }
  const levelId = String(canvas.level?.id ?? scene.initialLevel ?? "");
  const selected = new Map();
  const stored = getStoredTrails(scene).trails;
  const ids = new Set([...Object.keys(stored), ...[...live.keys()]
    .filter(key => key.startsWith(`${scene.id}:`)).map(key => key.slice(scene.id.length + 1))]);
  for (const tokenId of ids) {
    const saved = stored[tokenId]?.prints ?? [];
    const combined = new Map(saved.map(print => [print.id, print]));
    for (const print of live.get(sceneKey(scene, tokenId)) ?? []) if (!combined.has(print.id)) combined.set(print.id, print);
    const prints = [...combined.values()].filter(print =>
      !print.movementKey || print.progress <= (liveProgress.get(print.movementKey)?.value ?? Infinity)
    ).slice(-MAX_PRINTS);
    let span = 0;
    for (let i = 1; i < prints.length; i += 1) {
      span += Math.hypot(
        (prints[i].groundX ?? prints[i].x) - (prints[i - 1].groundX ?? prints[i - 1].x),
        (prints[i].groundY ?? prints[i].y) - (prints[i - 1].groundY ?? prints[i - 1].y)
      ) / scene.grid.size;
    }
    const visibleCutoff = prints.length === MAX_PRINTS && span > 0 ? Math.min(cutoff, span) : cutoff;
    let age = 0;
    let newer = null;
    for (let i = prints.length - 1; i >= 0; i -= 1) {
      const print = prints[i];
      if (newer) age += Math.hypot(
        (newer.groundX ?? newer.x) - (print.groundX ?? print.x),
        (newer.groundY ?? newer.y) - (print.groundY ?? print.y)
      ) / scene.grid.size;
      newer = print;
      const alpha = printAlpha(age, visibleCutoff);
      if (!alpha) break;
      if (String(print.levelId) !== levelId) continue;
      if (!printStillEnabled(scene, print)) continue;
      if (!alpha || !isVisibleToViewer(print, scene)) continue;
      selected.set(print.id, {...print, alpha});
    }
  }
  for (const [id, mesh] of renderMeshes) {
    if (selected.has(id)) continue;
    destroyMesh(mesh);
    renderMeshes.delete(id);
  }
  const missing = [...selected.values()].filter(print => !renderMeshes.has(print.id));
  const loaded = await Promise.all(missing.map(async print => ({print, texture: await loadTexture(print.image)})));
  if (revision !== renderRevision || scene !== canvas.scene) return;
  for (const {print, texture} of loaded) {
    if (!texture || renderMeshes.has(print.id)) continue;
    const mesh = createPrintMesh(print, texture, scene.grid.size);
    if (!mesh) continue;
    canvas.primary.addChild(mesh);
    renderMeshes.set(print.id, mesh);
  }
  for (const [id, print] of selected) {
    const mesh = renderMeshes.get(id);
    if (mesh) mesh.alpha = print.alpha;
  }
  canvas.primary.sortChildren();
  canvas.primary.renderDirty = true;
  canvas.primary.update?.();
}

function isVisibleToViewer(print, scene) {
  if (game.user?.isGM || scene.tokenVision === false) return true;
  return canvas.visibility?.testVisibility?.({x: print.x, y: print.y, elevation: print.elevation}) === true;
}

function createPrintMesh(print, texture, grid) {
  const Mesh = foundry.canvas?.primary?.PrimarySpriteMesh;
  if (!Mesh) return null;
  const mesh = new Mesh({name: `${MODULE_ID}.footprint.${print.id}`, object: canvas.scene, texture});
  mesh.anchor.set(0.5);
  mesh.resize(grid * print.scale, grid * print.scale, {fit: "fill"});
  if (print.side === 1) mesh.scale.x = -Math.abs(mesh.scale.x);
  mesh.position.set(print.x, print.y);
  mesh.angle = print.rotation;
  mesh.elevation = Number(print.elevation) || 0;
  mesh.sortLayer = canvas.primary.constructor.SORT_LAYERS.DRAWINGS;
  mesh.sort = Number.MAX_SAFE_INTEGER;
  mesh.tint = Number.parseInt(String(print.tint ?? "#ffffff").slice(1), 16);
  mesh.alpha = print.alpha;
  mesh.eventMode = "none";
  return mesh;
}

async function loadTexture(src) {
  if (!src) return null;
  if (!textures.has(src)) textures.set(src, foundry.canvas.loadTexture(src).catch(error => {
    if (!missingImages.has(src)) {
      missingImages.add(src);
      console.warn(`${MODULE_ID} | Footprint image could not be loaded: ${src}`, error);
    }
    return null;
  }));
  return textures.get(src);
}

function clearCanvas() {
  ++renderRevision;
  renderQueued = false;
  clearMeshes();
  live.clear();
  movementStates.clear();
  liveProgress.clear();
  seenSections.clear();
  textures.clear();
}

function clearMeshes() {
  ++renderRevision;
  for (const mesh of renderMeshes.values()) destroyMesh(mesh);
  renderMeshes.clear();
  if (globalThis.canvas?.primary) canvas.primary.renderDirty = true;
}

function destroyMesh(mesh) {
  if (mesh?.destroyed) return;
  mesh?.removeFromParent?.();
  mesh?.destroy?.({children: true, texture: false, baseTexture: false});
}
