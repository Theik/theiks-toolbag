import {
  MODULE_ID,
  TOWARD_OFF,
  TOWARD_ON,
  USABLE_TILE_FIELDS,
  authorizeUsableTileTransition,
  getUsableTileData,
  revokeUsableTileTransition
} from "./tile-config.js";
import {
  findAdjacentOwnedToken,
  isTokenAdjacentToTile,
  isTokenBlockedFromTile,
  prepareTileInteractionGeometry
} from "./tile-interaction.js";
import {getBreakableTerrainData} from "../breakable-terrain/terrain-config.js";
import {getTerrainMarkerPosition} from "../breakable-terrain/terrain-edges.js";
import {isTerrainDestructionModeActive, TERRAIN_DESTRUCTION_MODE_CHANGED_HOOK} from "../breakable-terrain/destruction-mode.js";
import {
  FEATURES,
  FEATURE_SETTING_CHANGED_HOOK,
  assertFeatureEnabled,
  createFeatureDisabledError,
  isFeatureEnabled
} from "../settings.js";
import {queueEventBehaviors} from "../script-events.js";
import {acquireTileTransition} from "../tile-transition-lock.js";

const SOCKET_CHANNEL = `module.${MODULE_ID}`;
const SOCKET_REQUEST = "usableTileUseRequest";
const SOCKET_RESULT = "usableTileUseResult";
const MARKER_TEXTURE = "icons/svg/lever.svg";
const REQUEST_TIMEOUT_MS = 5000;
const pendingRequests = new Map();
let markerContainer = null;
let markerRefreshId = 0;
let markerRefreshQueued = false;
let transitionSequence = 0;

export function registerUsableTileControls() {
  Hooks.once("ready", registerSocket);
  Hooks.on("canvasReady", queueMarkerRefresh);
  Hooks.on("canvasTearDown", clearMarkers);
  Hooks.on("activateCanvasLayer", refreshForActiveLayer);
  Hooks.on("controlToken", queueMarkerRefresh);
  for (const hook of ["updateToken", "createWall", "updateWall", "deleteWall", "createTile", "updateTile", "deleteTile"] ) {
    Hooks.on(hook, refreshForDocumentChange);
  }
  Hooks.on("refreshTile", refreshMarkerPosition);
  Hooks.on(TERRAIN_DESTRUCTION_MODE_CHANGED_HOOK, queueMarkerRefresh);
  Hooks.on(FEATURE_SETTING_CHANGED_HOOK, handleFeatureSettingChange);
}

/** Use a configured Tile directly as GM or request the active GM as a player. */
export async function useUsableTile(tile) {
  validateTile(tile);
  const user = game.user;
  if (!user?.active) throw new Error(localize("Errors.InactiveUser"));
  if (user.isGM) return await applyUse(tile, {user});
  await prepareTileInteractionGeometry(tile);
  const options = getInteractionOptions(tile.parent);
  const controlled = globalThis.canvas?.tokens?.controlled ?? [];
  const token = findAdjacentOwnedToken(tile, user, controlled, options);
  if (!token) {
    const adjacent = findAdjacentOwnedToken(tile, user, controlled, {...options, testWalls: false});
    throw new Error(localize(adjacent ? "Errors.WallBlocked" : "Errors.TokenRequired"));
  }
  await requestUse(tile, token.document ?? token);
  return tile;
}

async function applyUse(tile, {user, token = null, expectedIndex, expectedDirection} = {}) {
  validateTile(tile);
  if (!user?.isGM) await prepareTileInteractionGeometry(tile);
  validateUserAccess(tile, user, token);
  const initial = getUsableTileData(tile);
  if (expectedIndex !== undefined && (initial.index !== expectedIndex || initial.direction !== expectedDirection)) {
    throw new Error(localize("Errors.StateChanged"));
  }
  const releaseTransition = acquireTileTransition(tile);
  if (!releaseTransition) throw new Error(localize("Errors.InProgress"));
  try {
    const current = getUsableTileData(tile);
    validateUsableState(tile, current);
    const delta = current.direction === TOWARD_OFF ? -1 : 1;
    const targetIndex = current.index + delta;
    const targetSrc = current.states[targetIndex];
    const texture = await foundry.canvas.loadTexture(targetSrc);
    if (!texture || texture.valid === false) {
      throw new Error(game.i18n.format("THEIKS_TOOLBAG.UsableTiles.Errors.ImageLoad", {src: targetSrc}));
    }
    const latest = getUsableTileData(tile);
    if (latest.index !== current.index || latest.direction !== current.direction
      || !foundry.utils.equals(latest.states, current.states) || getBreakableTerrainData(tile).damaged) {
      throw new Error(localize("Errors.StateChanged"));
    }
    const targetDirection = targetIndex === current.states.length - 1
      ? TOWARD_OFF
      : (targetIndex === 0 ? TOWARD_ON : current.direction);
    const previous = getUsableTileEventState(tile, current);
    const nonce = `${game.user?.id ?? "gm"}:${Date.now()}:${++transitionSequence}`;
    const options = authorizeUsableTileTransition(tile, nonce);
    try {
      const updated = await tile.update({
        "texture.src": targetSrc,
        [USABLE_TILE_FIELDS.index]: targetIndex,
        [USABLE_TILE_FIELDS.direction]: targetDirection
      }, options);
      if (!updated) throw new Error(localize("Errors.UpdateFailed"));
      const currentState = getUsableTileEventState(updated);
      queueEventBehaviors({
        behaviors: getUsableTileData(updated).behaviors,
        document: updated,
        alias: "tile",
        name: currentState.state,
        previous,
        current: currentState,
        user
      });
      return updated;
    } finally {
      revokeUsableTileTransition(tile, nonce);
    }
  } finally {
    releaseTransition();
  }
}

export function getUsableTileEventState(tile, data = getUsableTileData(tile)) {
  return {
    index: data.index,
    direction: data.direction,
    state: data.state,
    textureSrc: tile?._source?.texture?.src ?? tile?.texture?.src ?? null
  };
}

function validateTile(tile) {
  assertFeatureEnabled(FEATURES.usableTiles);
  if (tile?.documentName !== "Tile") throw new Error(localize("Errors.InvalidTile"));
  if (!tile.parent || tile.parent.tiles?.get?.(tile.id) !== tile) throw new Error(localize("Errors.TileUnavailable"));
  validateUsableState(tile, getUsableTileData(tile));
}

function validateUsableState(tile, data) {
  if (!data.enabled) throw new Error(localize("Errors.NotUsable"));
  if (data.states.length < 2) throw new Error(localize("Errors.StatesRequired"));
  if (getBreakableTerrainData(tile).damaged) throw new Error(localize("Errors.Damaged"));
}

function validateUserAccess(tile, user, token) {
  if (!user?.active) throw new Error(localize("Errors.InactiveUser"));
  if (user.isGM) return;
  if (!token || token.parent !== tile.parent) throw new Error(localize("Errors.TokenRequired"));
  const ownerLevel = globalThis.CONST?.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3;
  if (!(token.testUserPermission?.(user, ownerLevel) ?? token.actor?.testUserPermission?.(user, ownerLevel))) {
    throw new Error(localize("Errors.TokenNotOwned"));
  }
  const options = getInteractionOptions(tile.parent);
  if (!isTokenAdjacentToTile(token, tile, options)) throw new Error(localize("Errors.NotAdjacent"));
  if (isTokenBlockedFromTile(token, tile, options)) throw new Error(localize("Errors.WallBlocked"));
}

function getInteractionOptions(scene) {
  const viewed = globalThis.canvas?.scene;
  const grid = scene?.grid?.testAdjacency ? scene.grid : (viewed === scene ? canvas.grid : null);
  return {
    grid,
    gridSize: grid?.size ?? scene?.grid?.size ?? (viewed === scene ? canvas.dimensions?.size : undefined),
    collisionBackend: globalThis.CONFIG?.Canvas?.polygonBackends?.move
  };
}

function getTokenState(token) {
  const source = token?._source ?? token ?? {};
  return {
    x: Number(source.x ?? token.x), y: Number(source.y ?? token.y),
    width: Number(source.width ?? token.width ?? 1), height: Number(source.height ?? token.height ?? 1),
    elevation: Number(source.elevation ?? token.elevation ?? 0), level: source.level ?? token.level ?? null
  };
}

function registerSocket() {
  game.socket.on(SOCKET_CHANNEL, onSocketMessage);
}

function onSocketMessage(message, senderUserId) {
  if (!message || typeof message !== "object") return;
  if (message.type === SOCKET_REQUEST && game.users.activeGM?.id === game.user.id) {
    void handleUseRequest(message, senderUserId);
  } else if (message.type === SOCKET_RESULT && message.userId === game.user.id) {
    resolveUseRequest(message, senderUserId);
  }
}

async function handleUseRequest(message, senderUserId) {
  let errorMessage = null;
  try {
    if (![senderUserId, message.sceneId, message.tileId, message.tokenId, message.requestId]
      .every(value => typeof value === "string" && value)) throw new Error(localize("Errors.InvalidRequest"));
    if (!Number.isInteger(message.expectedIndex) || ![TOWARD_ON, TOWARD_OFF].includes(message.expectedDirection)) {
      throw new Error(localize("Errors.InvalidRequest"));
    }
    const user = game.users.get(senderUserId);
    if (!user || user.isGM) throw new Error(localize("Errors.InvalidRequester"));
    const scene = game.scenes.get(message.sceneId);
    if (!scene || user.viewedScene !== scene.id) throw new Error(localize("Errors.InvalidRequester"));
    const tile = scene.tiles.get(message.tileId);
    let token = scene.tokens.get(message.tokenId);
    const tokenState = validateTokenSnapshot(message.tokenState);
    token = await synchronizeTokenForRequest(scene, token, tile, tokenState);
    await applyUse(tile, {
      user,
      token,
      expectedIndex: message.expectedIndex,
      expectedDirection: message.expectedDirection
    });
  } catch (error) {
    errorMessage = error.message;
    console.warn(`${MODULE_ID} | Rejected usable Tile request`, error);
  }
  game.socket.emit(SOCKET_CHANNEL, {
    type: SOCKET_RESULT,
    requestId: message.requestId,
    userId: senderUserId,
    ok: !errorMessage,
    error: errorMessage
  });
}

function validateTokenSnapshot(state) {
  if (!state || typeof state !== "object") throw new Error(localize("Errors.InvalidRequest"));
  for (const field of ["x", "y", "width", "height", "elevation"]) {
    if (!Number.isFinite(state[field])) throw new Error(localize("Errors.InvalidRequest"));
  }
  if (state.level !== null && typeof state.level !== "string") throw new Error(localize("Errors.InvalidRequest"));
  return {
    x: state.x, y: state.y, width: state.width, height: state.height,
    elevation: state.elevation, level: state.level
  };
}

async function synchronizeTokenForRequest(scene, token, tile, expected) {
  const matches = current => {
    const state = getTokenState(current);
    return ["x", "y", "width", "height", "elevation"].every(field => state[field] === expected[field])
      && state.level === expected.level;
  };
  const options = getInteractionOptions(scene);
  if (!token || isTokenAdjacentToTile(token, tile, options) || matches(token)) return token;
  const deadline = Date.now() + 750;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 25));
    token = scene.tokens.get(token.id);
    if (!token || isTokenAdjacentToTile(token, tile, options) || matches(token)) break;
  }
  return token;
}

function requestUse(tile, token) {
  const gmId = game.users.activeGM?.id;
  if (!gmId) return Promise.reject(new Error(localize("Errors.NoActiveGm")));
  const data = getUsableTileData(tile);
  const requestId = foundry.utils.randomID();
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error(localize("Errors.RequestTimeout")));
    }, REQUEST_TIMEOUT_MS);
    pendingRequests.set(requestId, {resolve, reject, timeoutId, gmId});
    game.socket.emit(SOCKET_CHANNEL, {
      type: SOCKET_REQUEST,
      requestId,
      sceneId: tile.parent.id,
      tileId: tile.id,
      tokenId: token.id,
      tokenState: getTokenState(token),
      expectedIndex: data.index,
      expectedDirection: data.direction
    });
  });
}

function resolveUseRequest(message, senderUserId) {
  const pending = pendingRequests.get(message.requestId);
  if (!pending || pending.gmId !== senderUserId) return;
  pendingRequests.delete(message.requestId);
  clearTimeout(pending.timeoutId);
  if (message.ok) pending.resolve();
  else pending.reject(new Error(message.error || localize("Errors.RequestRejected")));
}

function refreshForActiveLayer(layer) {
  if (layer === canvas.tokens) queueMarkerRefresh();
  else clearMarkers();
}

function refreshForDocumentChange(document) {
  if (document?.parent === canvas.scene) queueMarkerRefresh();
}

function queueMarkerRefresh() {
  if (!isFeatureEnabled(FEATURES.usableTiles) || isTerrainDestructionModeActive()) {
    clearMarkers();
    return;
  }
  if (markerRefreshQueued) return;
  markerRefreshQueued = true;
  queueMicrotask(() => {
    markerRefreshQueued = false;
    if (canvas.ready && canvas.activeLayer === canvas.tokens && !isTerrainDestructionModeActive()) void refreshMarkers();
    else clearMarkers();
  });
}

async function refreshMarkers() {
  const refresh = ++markerRefreshId;
  destroyMarkerContainer();
  if (!isFeatureEnabled(FEATURES.usableTiles) || !canvas.ready || !canvas.controls
    || canvas.activeLayer !== canvas.tokens || isTerrainDestructionModeActive()) return;
  const container = new PIXI.Container();
  container.name = `${MODULE_ID}.usableTileMarkers`;
  container.eventMode = "passive";
  canvas.controls.addChild(container);
  markerContainer = container;
  const options = getInteractionOptions(canvas.scene);
  let candidates = (canvas.tiles?.placeables ?? []).filter(tile => {
    const data = getUsableTileData(tile.document);
    return data.configured && !getBreakableTerrainData(tile.document).damaged;
  });
  const prepared = await Promise.all(candidates.map(async tile => {
    try {
      await prepareTileInteractionGeometry(tile.document);
      return {tile, ready: true};
    } catch (error) {
      console.warn(`${MODULE_ID} | Failed to prepare usable Tile interaction shape for ${tile.id}`, error);
      return {tile, ready: false};
    }
  }));
  candidates = prepared.filter(({tile, ready}) => game.user.isGM || (ready
    && findAdjacentOwnedToken(tile.document, game.user, canvas.tokens.controlled, options)))
    .map(({tile}) => tile);
  await Promise.all(candidates.map(async tile => {
    const marker = await createMarker(tile);
    if (refresh !== markerRefreshId || markerContainer !== container || !container.parent
      || isTerrainDestructionModeActive()) return marker.destroy({children: true});
    container.addChild(marker);
  }));
}

async function createMarker(tile) {
  const marker = new foundry.canvas.containers.ControlIcon({
    texture: MARKER_TEXTURE,
    size: 32 * canvas.dimensions.uiScale,
    borderColor: 0xFFFFFF,
    tint: 0xFFFFFF
  });
  await marker.draw();
  setMarkerDirection(marker, getUsableTileData(tile.document).direction);
  marker.position.set(...getTerrainMarkerPosition(tile.document));
  marker.alpha = 0.82;
  marker.on("pointerover", event => { event.stopPropagation(); marker.alpha = 1; });
  marker.on("pointerout", event => { event.stopPropagation(); marker.alpha = 0.82; });
  marker.on("pointerdown", event => {
    event.stopPropagation();
    if ((event.button ?? event.nativeEvent?.button ?? 0) === 0) void activateMarker(marker, tile.id);
  });
  return marker;
}

function setMarkerDirection(marker, direction) {
  const icon = marker.icon;
  const scale = icon?.scale;
  if (!scale) return;
  const magnitude = Math.abs(Number(scale.x)) || 1;
  if (direction === TOWARD_ON) {
    if (Number.isFinite(icon.anchor?.x)) icon.anchor.x = 1 - icon.anchor.x;
    scale.x = -magnitude;
  } else scale.x = magnitude;
}

async function activateMarker(marker, tileId) {
  if (marker.eventMode === "none") return;
  marker.eventMode = "none";
  marker.alpha = 0.45;
  try {
    await useUsableTile(canvas.scene?.tiles.get(tileId));
  } catch (error) {
    ui.notifications.warn(error.message);
    console.warn(`${MODULE_ID} | Usable Tile action failed`, error);
  } finally {
    if (marker.parent) { marker.eventMode = "static"; marker.alpha = 0.82; }
  }
}

function refreshMarkerPosition(tile) {
  if (!markerContainer) return;
  queueMarkerRefresh();
}

function clearMarkers() {
  ++markerRefreshId;
  markerRefreshQueued = false;
  destroyMarkerContainer();
}

function destroyMarkerContainer() {
  if (!markerContainer) return;
  markerContainer.removeFromParent();
  markerContainer.destroy({children: true});
  markerContainer = null;
}

function handleFeatureSettingChange(feature, enabled) {
  if (feature !== FEATURES.usableTiles) return;
  if (enabled) queueMarkerRefresh();
  else {
    clearMarkers();
    for (const [id, pending] of pendingRequests) {
      pendingRequests.delete(id);
      clearTimeout(pending.timeoutId);
      pending.reject(createFeatureDisabledError(FEATURES.usableTiles));
    }
  }
}

function localize(key) {
  return game.i18n.localize(`THEIKS_TOOLBAG.UsableTiles.${key}`);
}
