import {
  MODULE_ID,
  VISIBLE_LIGHT_FLAG,
  getVisibleLightData,
  getVisibleLightState,
  isVisibleLightConfigured
} from "./light-config.js";
import {
  FEATURES,
  FEATURE_SETTING_CHANGED_HOOK,
  assertFeatureEnabled,
  createFeatureDisabledError,
  isFeatureEnabled
} from "../settings.js";
import {queueEventBehaviors} from "../script-events.js";

const SOCKET_CHANNEL = `module.${MODULE_ID}`;
const SOCKET_REQUEST = "visibleLightToggleRequest";
const SOCKET_RESULT = "visibleLightToggleResult";
const MARKER_TEXTURE = "icons/svg/light.svg";
const REPAIR_MARKER_TEXTURE = "icons/svg/regen.svg";
const DESTROYED_FIELD = `flags.${MODULE_ID}.${VISIBLE_LIGHT_FLAG}.destroyed`;
const REQUEST_TIMEOUT_MS = 5000;
const TOKEN_SYNC_TIMEOUT_MS = 750;
const TOKEN_SYNC_POLL_MS = 25;
const TOKEN_STATE_NUMERIC_FIELDS = ["x", "y", "width", "height", "depth", "elevation", "shape"];
const STATE_COLORS = {
  on: 0xFFD166,
  off: 0x8A8A8A,
  destroyed: 0x4CAF50
};

const inProgress = new Set();
const reconciliationInProgress = new Set();
const pendingRequests = new Map();
let markerContainer = null;
let markerRefreshId = 0;
let markerRefreshQueued = false;

/** Register visible-light controls, authorization, and socket hooks. */
export function registerVisibleLightControls() {
  Hooks.once("ready", registerSocket);
  Hooks.on("canvasReady", queueMarkerRefresh);
  Hooks.on("canvasTearDown", clearMarkers);
  Hooks.on("activateCanvasLayer", refreshForActiveLayer);
  Hooks.on("controlToken", queueMarkerRefresh);
  Hooks.on("updateToken", refreshForDocumentChange);
  Hooks.on("createWall", refreshForDocumentChange);
  Hooks.on("updateWall", refreshForDocumentChange);
  Hooks.on("deleteWall", refreshForDocumentChange);
  Hooks.on("createAmbientLight", refreshForDocumentChange);
  Hooks.on("updateAmbientLight", refreshForDocumentChange);
  Hooks.on("updateAmbientLight", reconcileDestroyedLight);
  Hooks.on("deleteAmbientLight", refreshForDocumentChange);
  Hooks.on("preUpdateAmbientLight", keepDestroyedLightOff);
  Hooks.on("canvasReady", reconcileCurrentSceneDestroyedLights);
  Hooks.on(FEATURE_SETTING_CHANGED_HOOK, handleFeatureSettingChange);
}

/**
 * Test whether a Token occupies the light's grid space or a directly adjacent one.
 * On gridded Scenes, reach is determined entirely from grid-space membership. Foundry snaps the
 * Token footprint by its center before returning occupied spaces, so small pixel offsets do not
 * change which neighboring spaces it can reach. Rectangular distance is only a gridless fallback.
 *
 * @param {TokenDocument|foundry.canvas.placeables.Token|object} token
 * @param {AmbientLightDocument|foundry.canvas.placeables.AmbientLight|object} light
 * @param {{grid?: object|null, gridSize?: number}} [options]
 * @returns {boolean}
 */
export function isTokenAdjacentToLight(token, light, {grid = null, gridSize} = {}) {
  const tokenDocument = token?.document ?? token;
  const lightDocument = light?.document ?? light;
  if (!tokenDocument || !lightDocument) return false;

  // Use source data so the player and the authoritative GM compare the same geometry. Prepared
  // Token values can vary by client because Levels, Regions, and surfaces constrain them locally.
  const tokenSource = tokenDocument._source ?? tokenDocument;
  const lightSource = lightDocument._source ?? lightDocument;
  const tokenGeometry = {
    x: tokenSource.x ?? tokenDocument.x,
    y: tokenSource.y ?? tokenDocument.y,
    width: tokenSource.width ?? tokenDocument.width,
    height: tokenSource.height ?? tokenDocument.height,
    depth: tokenSource.depth ?? tokenDocument.depth,
    elevation: tokenSource.elevation ?? tokenDocument.elevation,
    shape: tokenSource.shape ?? tokenDocument.shape,
    // Occupancy is a geometric test here. Supplying no Level prevents Foundry from filtering the
    // footprint through client-local walls and surfaces before the GM validates the request.
    level: null
  };
  const lightX = lightSource.x ?? lightDocument.x;
  const lightY = lightSource.y ?? lightDocument.y;
  const tokenElevation = Number(tokenGeometry.elevation ?? 0);
  const lightElevation = Number(lightSource.elevation ?? lightDocument.elevation ?? 0);
  if (Number.isFinite(tokenElevation) && Number.isFinite(lightElevation)
    && Math.abs(tokenElevation - lightElevation) > Number.EPSILON) return false;

  if (grid?.getOffset && grid?.testAdjacency && tokenDocument.getOccupiedGridSpaceOffsets) {
    try {
      const lightOffset = grid.getOffset({
        x: lightX,
        y: lightY,
        elevation: lightElevation
      });
      const occupied = tokenDocument.getOccupiedGridSpaceOffsets(tokenGeometry);
      if (occupied?.length && Number.isInteger(lightOffset?.i) && Number.isInteger(lightOffset?.j)) {
        return occupied.some(offset => {
          const sameElevation = !Number.isInteger(offset.k) || !Number.isInteger(lightOffset.k)
            || offset.k === lightOffset.k;
          if (!sameElevation) return false;
          const sameSpace = offset.i === lightOffset.i && offset.j === lightOffset.j;
          return sameSpace || grid.testAdjacency(
            {i: offset.i, j: offset.j},
            {i: lightOffset.i, j: lightOffset.j}
          );
        });
      }
    } catch (error) {
      console.debug(`${MODULE_ID} | Falling back to pixel light adjacency`, error);
    }
  }

  return isWithinRectangularGridRange(tokenGeometry, lightX, lightY, gridSize);
}

/** Test a light point against the Token footprint with a half-grid radius around that point. */
function isWithinRectangularGridRange(tokenGeometry, lightX, lightY, gridSize) {
  const size = Number(gridSize);
  const x = Number(tokenGeometry.x);
  const y = Number(tokenGeometry.y);
  const width = Number(tokenGeometry.width ?? 1) * size;
  const height = Number(tokenGeometry.height ?? 1) * size;
  const numericLightX = Number(lightX);
  const numericLightY = Number(lightY);
  if (![size, x, y, width, height, numericLightX, numericLightY].every(Number.isFinite) || size <= 0) {
    return false;
  }

  const half = size / 2;
  const gapX = Math.max(x - (numericLightX + half), (numericLightX - half) - (x + width), 0);
  const gapY = Math.max(y - (numericLightY + half), (numericLightY - half) - (y + height), 0);
  return gapX <= Number.EPSILON && gapY <= Number.EPSILON;
}

/**
 * Test whether a movement-blocking Wall separates a Token from a visible-light fixture.
 * The movement backend makes open doors and walls which do not restrict movement passable while
 * still respecting wall direction and the Token's native Scene Level.
 *
 * @param {TokenDocument|foundry.canvas.placeables.Token|object} token
 * @param {AmbientLightDocument|foundry.canvas.placeables.AmbientLight|object} light
 * @param {{collisionBackend?: object|null, gridSize?: number, level?: object|null}} [options]
 * @returns {boolean}
 */
export function isTokenBlockedFromLight(token, light, {
  collisionBackend = globalThis.CONFIG?.Canvas?.polygonBackends?.move,
  gridSize,
  level = null
} = {}) {
  const tokenDocument = token?.document ?? token;
  const lightDocument = light?.document ?? light;
  if (!tokenDocument || !lightDocument) return true;
  if (!collisionBackend?.testCollision) return false;

  const scene = lightDocument.parent ?? tokenDocument.parent;
  const tokenSource = tokenDocument._source ?? tokenDocument;
  const lightSource = lightDocument._source ?? lightDocument;
  const interactionLevel = level
    ?? scene?.levels?.get?.(tokenSource.level ?? lightSource.level)
    ?? (globalThis.canvas?.scene === scene ? canvas.level : null);
  // A v14 Scene always has a Level. If it cannot be resolved, do not silently bypass walls.
  if (!interactionLevel) return true;

  const origin = getTokenInteractionOrigin(tokenDocument, tokenSource, gridSize);
  const destination = {
    x: Number(lightSource.x ?? lightDocument.x),
    y: Number(lightSource.y ?? lightDocument.y),
    elevation: origin?.elevation
  };
  if (!origin || ![destination.x, destination.y].every(Number.isFinite)) return true;

  try {
    scene?.initializeEdges?.();
    return Boolean(collisionBackend.testCollision(origin, destination, {
      type: "move",
      mode: "any",
      level: interactionLevel
    }));
  } catch (error) {
    console.warn(`${MODULE_ID} | Failed to test visible-light wall collision`, error);
    return true;
  }
}

/** Derive the Token's saved movement origin without using an animated or client-prepared position. */
function getTokenInteractionOrigin(token, source, gridSize) {
  if (typeof token.getMovementOrigin === "function") {
    try {
      const origin = token.getMovementOrigin(source);
      if ([origin?.x, origin?.y].every(Number.isFinite)) return origin;
    } catch (error) {
      console.debug(`${MODULE_ID} | Falling back to rectangular Token center`, error);
    }
  }

  const size = Number(gridSize ?? token.parent?.grid?.size);
  const x = Number(source.x ?? token.x);
  const y = Number(source.y ?? token.y);
  const width = Number(source.width ?? token.width ?? 1) * size;
  const height = Number(source.height ?? token.height ?? 1) * size;
  const elevation = Number(source.elevation ?? token.elevation ?? 0);
  if (![size, x, y, width, height, elevation].every(Number.isFinite) || size <= 0) return null;
  return {x: x + (width / 2), y: y + (height / 2), elevation};
}

/**
 * Find a controlled, owned Token that authorizes this user to toggle the light.
 *
 * @param {AmbientLightDocument} light
 * @param {User} user
 * @param {Iterable<foundry.canvas.placeables.Token>} tokens
 * @param {{grid?: object|null, gridSize?: number, collisionBackend?: object|null,
 *   level?: object|null, testWalls?: boolean}} options
 * @returns {foundry.canvas.placeables.Token|null}
 */
export function findAdjacentOwnedToken(light, user, tokens, options) {
  for (const token of tokens ?? []) {
    const document = token.document ?? token;
    if (document.parent !== light.parent) continue;
    if (!userOwnsToken(user, document)) continue;
    if (!isTokenAdjacentToLight(document, light, options)) continue;
    if (options?.testWalls !== false && isTokenBlockedFromLight(document, light, options)) continue;
    return token;
  }
  return null;
}

/**
 * Toggle a configured, non-destroyed visible light.
 *
 * @param {AmbientLightDocument} light
 * @returns {Promise<AmbientLightDocument>}
 */
export async function toggleVisibleLight(light) {
  validateLight(light);
  if (getVisibleLightData(light).destroyed) throw new Error(localize("Errors.Destroyed"));
  const user = game.user;
  if (!user?.active) throw new Error(localize("Errors.InactiveUser"));
  if (user.isGM) return await applyVisibleLightToggle(light, {user});

  const options = getAdjacencyOptions(light.parent);
  const controlled = globalThis.canvas?.tokens?.controlled ?? [];
  const token = findAdjacentOwnedToken(light, user, controlled, options);
  if (!token) {
    const adjacent = findAdjacentOwnedToken(light, user, controlled, {...options, testWalls: false});
    throw new Error(localize(adjacent ? "Errors.WallBlocked" : "Errors.TokenRequired"));
  }
  await requestToggle(light, token.document ?? token);
  return light;
}

/**
 * Put a configured light into its destroyed state. GMs only.
 *
 * @param {AmbientLightDocument} light
 * @returns {Promise<AmbientLightDocument>}
 */
export async function destroyVisibleLight(light) {
  validateLight(light);
  const user = game.user;
  if (!user?.isGM) throw new Error(localize("Errors.GmDestroyOnly"));
  const data = getVisibleLightData(light);
  if (data.destroyed) throw new Error(localize("Errors.AlreadyDestroyed"));

  const previous = getVisibleLightEventState(light);
  const updated = await runLightUpdate(light, {
    hidden: true,
    [DESTROYED_FIELD]: true
  });
  queueEventBehaviors({
    behaviors: getVisibleLightData(updated).behaviors,
    document: updated,
    alias: "light",
    name: "destroyed",
    previous,
    current: getVisibleLightEventState(updated)
  });
  return updated;
}

/** Repair a destroyed visible light while leaving the fixture switched off. GMs only. */
export async function repairVisibleLight(light) {
  return await repairVisibleLightState(light, {emitBehaviors: true});
}

/** Repair a destroyed visible light without emitting Toolbag repair behaviors. */
export async function repairVisibleLightSilently(light) {
  return await repairVisibleLightState(light, {emitBehaviors: false});
}

/** Repair a destroyed visible light while preserving its switched-off state. */
async function repairVisibleLightState(light, {emitBehaviors}) {
  validateLight(light);
  const user = game.user;
  if (!user?.isGM) throw new Error(localize("Errors.GmRepairOnly"));
  if (!getVisibleLightData(light).destroyed) throw new Error(localize("Errors.NotDestroyed"));

  const previous = getVisibleLightEventState(light);
  const updated = await runLightUpdate(light, {
    [DESTROYED_FIELD]: false
  });
  if (emitBehaviors) {
    queueEventBehaviors({
      behaviors: getVisibleLightData(updated).behaviors,
      document: updated,
      alias: "light",
      name: "repaired",
      previous,
      current: getVisibleLightEventState(updated)
    });
  }
  return updated;
}

/**
 * Apply an authorized toggle locally. This is intentionally private so public callers cannot
 * inject a different User or an unselected Token to bypass the normal interaction policy.
 *
 * @param {AmbientLightDocument} light
 * @param {{user: User, token?: TokenDocument|null, expectedHidden?: boolean}} options
 */
async function applyVisibleLightToggle(light, {user, token = null, expectedHidden} = {}) {
  validateLight(light);
  const data = getVisibleLightData(light);
  if (data.destroyed) throw new Error(localize("Errors.Destroyed"));
  validateUserAccess(light, user, token);
  if (typeof expectedHidden === "boolean" && Boolean(light.hidden) !== expectedHidden) {
    throw new Error(localize("Errors.StateChanged"));
  }

  const previous = getVisibleLightEventState(light);
  const updated = await runLightUpdate(light, {hidden: !Boolean(light.hidden)});
  const current = getVisibleLightEventState(updated);
  const switchedOn = current.hidden === false;
  queueEventBehaviors({
    behaviors: getVisibleLightData(updated).behaviors,
    document: updated,
    alias: "light",
    name: switchedOn ? "toggledOn" : "toggledOff",
    previous,
    current,
    user
  });
  return updated;
}

/** Create the stable light-state snapshot supplied to event scripts. */
export function getVisibleLightEventState(light) {
  const data = getVisibleLightData(light);
  return {
    hidden: Boolean(light?.hidden),
    destroyed: data.destroyed,
    state: data.destroyed ? "destroyed" : (light?.hidden ? "off" : "on")
  };
}

/** @param {AmbientLightDocument} light @param {object} changes */
async function runLightUpdate(light, changes) {
  const progressKey = light.uuid ?? `${light.parent?.id}.${light.id}`;
  if (inProgress.has(progressKey)) throw new Error(localize("Errors.InProgress"));
  inProgress.add(progressKey);
  try {
    const updated = await light.update(changes);
    if (!updated) throw new Error(localize("Errors.UpdateFailed"));
    return updated;
  } finally {
    inProgress.delete(progressKey);
  }
}

/** @param {AmbientLightDocument} light */
function validateLight(light) {
  assertFeatureEnabled(FEATURES.visibleLights);
  if (light?.documentName !== "AmbientLight") throw new Error(localize("Errors.InvalidLight"));
  if (!light.parent || light.parent.lights?.get?.(light.id) !== light) {
    throw new Error(localize("Errors.LightUnavailable"));
  }
  if (!isVisibleLightConfigured(light)) throw new Error(localize("Errors.NotConfigured"));
}

/** @param {AmbientLightDocument} light @param {User} user @param {TokenDocument|null} token */
function validateUserAccess(light, user, token) {
  validateUserAndToken(light, user, token);
  if (user.isGM) return;

  const options = getAdjacencyOptions(light.parent);
  if (!isTokenAdjacentToLight(token, light, options)) {
    throw new Error(localize("Errors.NotAdjacent"));
  }
  if (isTokenBlockedFromLight(token, light, options)) throw new Error(localize("Errors.WallBlocked"));
}

/** Validate identity, Scene membership, and ownership without making a geometric decision. */
function validateUserAndToken(light, user, token) {
  if (!user?.active) throw new Error(localize("Errors.InactiveUser"));
  if (user.isGM) return;
  if (!token || token.parent !== light.parent) throw new Error(localize("Errors.TokenRequired"));
  if (!userOwnsToken(user, token)) throw new Error(localize("Errors.TokenNotOwned"));
}

/** @param {User} user @param {TokenDocument} token */
function userOwnsToken(user, token) {
  const ownerLevel = globalThis.CONST?.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3;
  if (typeof token?.testUserPermission === "function") {
    return token.testUserPermission(user, ownerLevel);
  }
  return Boolean(token?.actor?.testUserPermission?.(user, ownerLevel));
}

/** @param {Scene} scene */
function getAdjacencyOptions(scene) {
  const viewedScene = globalThis.canvas?.scene;
  const sceneGrid = scene?.grid;
  const grid = sceneGrid?.getOffset && sceneGrid?.testAdjacency
    ? sceneGrid
    : viewedScene === scene ? canvas.grid : null;

  return {
    grid,
    gridSize: grid?.size ?? sceneGrid?.size
      ?? (viewedScene === scene ? canvas.dimensions?.size : undefined),
    collisionBackend: globalThis.CONFIG?.Canvas?.polygonBackends?.move
  };
}

/** Return the saved Token geometry that is synchronized between clients. */
function getTokenState(token) {
  const source = token?._source ?? token ?? {};
  return {
    x: Number(source.x ?? token?.x),
    y: Number(source.y ?? token?.y),
    width: Number(source.width ?? token?.width ?? 1),
    height: Number(source.height ?? token?.height ?? 1),
    depth: Number(source.depth ?? token?.depth ?? 1),
    elevation: Number(source.elevation ?? token?.elevation ?? 0),
    shape: Number(source.shape ?? token?.shape ?? 0),
    level: source.level ?? token?.level ?? null
  };
}

/** Treat a socket Token-state value only as a synchronization hint, never as authorization. */
function parseTokenState(state) {
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    throw new Error(localize("Errors.InvalidRequest"));
  }

  const normalized = {};
  for (const field of TOKEN_STATE_NUMERIC_FIELDS) {
    const value = state[field];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(localize("Errors.InvalidRequest"));
    }
    normalized[field] = value;
  }
  if (normalized.width <= 0 || normalized.height <= 0 || normalized.depth <= 0
    || !Number.isInteger(normalized.shape)) {
    throw new Error(localize("Errors.InvalidRequest"));
  }
  if (state.level !== null && typeof state.level !== "string") {
    throw new Error(localize("Errors.InvalidRequest"));
  }
  normalized.level = state.level;
  return normalized;
}

function tokenStateMatches(token, expected) {
  const current = getTokenState(token);
  return TOKEN_STATE_NUMERIC_FIELDS.every(field => current[field] === expected[field])
    && current.level === expected.level;
}

/**
 * Let the active GM finish applying a Token movement received immediately before this request.
 * The client snapshot is used only to detect synchronization; final adjacency is always computed
 * from the GM's authoritative Scene document.
 */
async function synchronizeTokenForRequest(scene, tokenId, light, expectedState) {
  const options = getAdjacencyOptions(scene);
  let token = scene.tokens.get(tokenId);
  if (!token || isTokenAdjacentToLight(token, light, options) || tokenStateMatches(token, expectedState)) return token;

  const deadline = Date.now() + TOKEN_SYNC_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, TOKEN_SYNC_POLL_MS));
    token = scene.tokens.get(tokenId);
    if (!token || isTokenAdjacentToLight(token, light, options) || tokenStateMatches(token, expectedState)) break;
  }
  return token;
}

function registerSocket() {
  game.socket.on(SOCKET_CHANNEL, onSocketMessage);
}

/** @param {object} message */
function onSocketMessage(message, senderUserId) {
  if (!message || typeof message !== "object") return;
  if (message.type === SOCKET_REQUEST) {
    if (game.users.activeGM?.id === game.user.id) return handleToggleRequest(message, senderUserId);
    return;
  }
  if (message.type === SOCKET_RESULT && message.userId === game.user.id) {
    resolveToggleRequest(message, senderUserId);
  }
}

/** @param {object} message @param {string} senderUserId */
async function handleToggleRequest(message, senderUserId) {
  let errorMessage = null;
  try {
    if (![senderUserId, message.sceneId, message.lightId, message.tokenId, message.requestId]
      .every(value => typeof value === "string" && value.length > 0)) {
      throw new Error(localize("Errors.InvalidRequest"));
    }
    if (typeof message.expectedHidden !== "boolean") throw new Error(localize("Errors.InvalidRequest"));

    const user = game.users.get(senderUserId);
    if (!user || user.isGM) throw new Error(localize("Errors.InvalidRequester"));
    const scene = game.scenes.get(message.sceneId);
    if (!scene || user.viewedScene !== scene.id) throw new Error(localize("Errors.InvalidRequester"));
    const light = scene?.lights.get(message.lightId);
    let token = scene?.tokens.get(message.tokenId);
    const expectedTokenState = parseTokenState(message.tokenState);
    validateLight(light);
    validateUserAndToken(light, user, token);
    token = await synchronizeTokenForRequest(scene, message.tokenId, light, expectedTokenState);
    await applyVisibleLightToggle(light, {
      user,
      token,
      expectedHidden: message.expectedHidden
    });
  } catch (error) {
    errorMessage = error.message;
    console.warn(`${MODULE_ID} | Rejected visible-light toggle request`, error);
  }

  game.socket.emit(SOCKET_CHANNEL, {
    type: SOCKET_RESULT,
    requestId: message.requestId,
    userId: senderUserId,
    ok: !errorMessage,
    error: errorMessage
  });
}

/** @param {object} message @param {string} senderUserId */
function resolveToggleRequest(message, senderUserId) {
  const pending = pendingRequests.get(message.requestId);
  if (!pending || pending.gmId !== senderUserId) return;
  pendingRequests.delete(message.requestId);
  clearTimeout(pending.timeoutId);
  if (message.ok) pending.resolve();
  else pending.reject(new Error(message.error || localize("Errors.RequestRejected")));
}

/** @param {AmbientLightDocument} light @param {TokenDocument} token */
function requestToggle(light, token) {
  const gmId = game.users.activeGM?.id;
  if (!gmId) return Promise.reject(new Error(localize("Errors.NoActiveGm")));
  if (!light?.parent || !token) return Promise.reject(new Error(localize("Errors.TokenRequired")));
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
      sceneId: light.parent.id,
      lightId: light.id,
      tokenId: token.id,
      tokenState: getTokenState(token),
      expectedHidden: Boolean(light.hidden)
    });
  });
}

/** @param {foundry.canvas.layers.InteractionLayer} layer */
function refreshForActiveLayer(layer) {
  if (layer === canvas.tokens) queueMarkerRefresh();
  else clearMarkers();
}

/** @param {TokenDocument|AmbientLightDocument} document */
function refreshForDocumentChange(document) {
  if (document.parent === canvas.scene) queueMarkerRefresh();
}

/** Draw toggle markers only while the normal Token layer is active. */
function queueMarkerRefresh() {
  if (!isFeatureEnabled(FEATURES.visibleLights)) {
    clearMarkers();
    return;
  }
  if (markerRefreshQueued) return;
  markerRefreshQueued = true;
  queueMicrotask(() => {
    markerRefreshQueued = false;
    if (canvas.ready && canvas.activeLayer === canvas.tokens) void refreshMarkers();
    else clearMarkers();
  });
}

async function refreshMarkers() {
  const currentRefresh = ++markerRefreshId;
  destroyMarkerContainer();
  if (!isFeatureEnabled(FEATURES.visibleLights)
    || !canvas.ready || !canvas.controls || canvas.activeLayer !== canvas.tokens) return;

  const container = new PIXI.Container();
  container.name = `${MODULE_ID}.visibleLightMarkers`;
  container.eventMode = "passive";
  canvas.controls.addChild(container);
  markerContainer = container;

  const options = getAdjacencyOptions(canvas.scene);
  const candidates = [];
  for (const light of canvas.lighting.placeables) {
    if (!isVisibleLightConfigured(light.document)) continue;
    const data = getVisibleLightData(light.document);
    if (data.destroyed) {
      if (game.user.isGM) candidates.push(light);
      continue;
    }
    if (game.user.isGM) candidates.push(light);
    else {
      const token = findAdjacentOwnedToken(light.document, game.user, canvas.tokens.controlled, options);
      if (token) candidates.push(light);
    }
  }

  await Promise.all(candidates.map(async light => {
    try {
      const marker = await createMarker(light);
      if (currentRefresh !== markerRefreshId || !isFeatureEnabled(FEATURES.visibleLights)
        || markerContainer !== container || !container.parent) {
        marker.destroy({children: true});
        return;
      }
      container.addChild(marker);
    } catch (error) {
      console.error(`${MODULE_ID} | Failed to draw a visible-light control`, error);
    }
  }));
}

/**
 * @param {foundry.canvas.placeables.AmbientLight} light
 * @returns {Promise<foundry.canvas.containers.ControlIcon>}
 */
async function createMarker(light) {
  const state = getVisibleLightState(light.document);
  const destroyed = state === "destroyed";
  const color = STATE_COLORS[state];
  const size = 32 * canvas.dimensions.uiScale;
  const marker = new foundry.canvas.containers.ControlIcon({
    texture: destroyed ? REPAIR_MARKER_TEXTURE : MARKER_TEXTURE,
    size,
    borderColor: color,
    tint: color
  });
  await marker.draw();
  marker.position.set(light.document.x, light.document.y);
  marker.alpha = 0.82;

  marker.on("pointerover", event => {
    event.stopPropagation();
    marker.alpha = 1;
    marker.icon.tint = color;
  });
  marker.on("pointerout", event => {
    event.stopPropagation();
    marker.alpha = 0.82;
    marker.icon.tint = color;
  });
  marker.on("pointerdown", event => {
    event.stopPropagation();
    const button = event.button ?? event.nativeEvent?.button ?? 0;
    if (destroyed) {
      if (button === 0 && game.user.isGM) void activateRepair(marker, light.id);
      return;
    }
    if (button === 2) {
      if (game.user.isGM) void activateDestroy(marker, light.id);
      return;
    }
    if (button === 0) void activateToggle(marker, light.id);
  });

  return marker;
}

/** @param {foundry.canvas.containers.ControlIcon} marker @param {string} lightId */
async function activateToggle(marker, lightId) {
  if (marker.eventMode === "none") return;
  marker.eventMode = "none";
  marker.alpha = 0.45;

  try {
    const light = canvas.scene?.lights.get(lightId);
    await toggleVisibleLight(light);
  } catch (error) {
    ui.notifications.warn(error.message);
    console.warn(`${MODULE_ID} | Visible-light toggle failed`, error);
  } finally {
    if (marker.parent) {
      marker.eventMode = "static";
      marker.alpha = 0.82;
    }
  }
}

/** @param {foundry.canvas.containers.ControlIcon} marker @param {string} lightId */
async function activateDestroy(marker, lightId) {
  if (marker.eventMode === "none") return;
  marker.eventMode = "none";
  marker.alpha = 0.45;

  try {
    await destroyVisibleLight(canvas.scene?.lights.get(lightId));
  } catch (error) {
    ui.notifications.warn(error.message);
    console.warn(`${MODULE_ID} | Visible-light destruction failed`, error);
  } finally {
    if (marker.parent) {
      marker.eventMode = "static";
      marker.alpha = 0.82;
    }
  }
}

/** @param {foundry.canvas.containers.ControlIcon} marker @param {string} lightId */
async function activateRepair(marker, lightId) {
  if (marker.eventMode === "none") return;
  marker.eventMode = "none";
  marker.alpha = 0.45;

  try {
    await repairVisibleLight(canvas.scene?.lights.get(lightId));
  } catch (error) {
    ui.notifications.warn(error.message);
    console.warn(`${MODULE_ID} | Visible-light repair failed`, error);
  } finally {
    if (marker.parent) {
      marker.eventMode = "static";
      marker.alpha = 0.82;
    }
  }
}

/** Ensure checking Destroyed in the config also switches the source off. */
function keepDestroyedLightOff(light, changes) {
  if (!isFeatureEnabled(FEATURES.visibleLights)) return;
  const hasDestroyedChange = Object.hasOwn(changes, DESTROYED_FIELD)
    || foundry.utils.hasProperty(changes, DESTROYED_FIELD);
  const destroyedChange = Object.hasOwn(changes, DESTROYED_FIELD)
    ? changes[DESTROYED_FIELD]
    : foundry.utils.getProperty(changes, DESTROYED_FIELD);
  const destroyed = hasDestroyedChange ? destroyedChange === true : getVisibleLightData(light).destroyed;
  if (destroyed && (light.hidden === false || changes.hidden === false)) changes.hidden = true;
}

/** Reconcile cross-client races so a destroyed light can never remain switched on. */
function reconcileDestroyedLight(light) {
  if (!isFeatureEnabled(FEATURES.visibleLights)) return;
  if (game.users?.activeGM?.id !== game.user.id) return;
  if (!getVisibleLightData(light).destroyed || light.hidden) return;

  const progressKey = light.uuid ?? `${light.parent?.id}.${light.id}`;
  if (reconciliationInProgress.has(progressKey)) return;
  reconciliationInProgress.add(progressKey);
  void light.update({hidden: true}).catch(error => {
    console.error(`${MODULE_ID} | Failed to switch a destroyed visible light off`, error);
  }).finally(() => reconciliationInProgress.delete(progressKey));
}

function reconcileCurrentSceneDestroyedLights() {
  if (!isFeatureEnabled(FEATURES.visibleLights) || game.users?.activeGM?.id !== game.user.id) return;
  const lights = canvas.scene?.lights?.contents ?? Array.from(canvas.scene?.lights?.values?.() ?? []);
  for (const light of lights) reconcileDestroyedLight(light);
}

function clearMarkers() {
  ++markerRefreshId;
  markerRefreshQueued = false;
  destroyMarkerContainer();
}

function handleFeatureSettingChange(feature, enabled) {
  if (feature !== FEATURES.visibleLights) return;
  if (enabled) {
    reconcileCurrentSceneDestroyedLights();
    queueMarkerRefresh();
    return;
  }

  clearMarkers();
  const error = createFeatureDisabledError(FEATURES.visibleLights);
  for (const pending of pendingRequests.values()) {
    clearTimeout(pending.timeoutId);
    pending.reject(error);
  }
  pendingRequests.clear();
}

function destroyMarkerContainer() {
  if (!markerContainer) return;
  markerContainer.removeFromParent();
  markerContainer.destroy({children: true});
  markerContainer = null;
}

/** @param {string} key */
function localize(key) {
  return game.i18n.localize(`THEIKS_TOOLBAG.VisibleLights.${key}`);
}
