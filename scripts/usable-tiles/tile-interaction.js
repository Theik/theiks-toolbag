import {getTileOpaqueContours, prepareTileOpaqueContours} from "../breakable-terrain/terrain-edges.js";

/** Prepare the Tile's alpha-derived interaction shape. */
export async function prepareTileInteractionGeometry(tile) {
  return await prepareTileOpaqueContours(tile?.document ?? tile);
}

/** Return whether a Token footprint is on or adjacent to any grid space covered by a Tile. */
export function isTokenAdjacentToTile(token, tile, {grid = null, gridSize, contours} = {}) {
  const tokenDocument = token?.document ?? token;
  const tileDocument = tile?.document ?? tile;
  if (!tokenDocument || !tileDocument || !sameLevelAndElevation(tokenDocument, tileDocument)) return false;

  const tokenSource = tokenDocument._source ?? tokenDocument;
  if (grid?.testAdjacency && tokenDocument.getOccupiedGridSpaceOffsets) {
    try {
      const occupied = tokenDocument.getOccupiedGridSpaceOffsets({...tokenSource, level: null});
      const tileOffsets = getTileGridOffsets(tileDocument, grid, gridSize, contours);
      if (occupied?.length && tileOffsets.length) {
        return occupied.some(tokenOffset => tileOffsets.some(tileOffset => (
          (tokenOffset.i === tileOffset.i && tokenOffset.j === tileOffset.j)
          || grid.testAdjacency(
            {i: tokenOffset.i, j: tokenOffset.j},
            {i: tileOffset.i, j: tileOffset.j}
          )
        )));
      }
    } catch (_error) {
      // Fall through to the gridless alpha-contour check.
    }
  }

  const size = Number(gridSize);
  const tokenRect = getTokenRect(tokenDocument, size);
  const opaqueContours = resolveContours(tileDocument, contours);
  if (!tokenRect || !opaqueContours?.length || !Number.isFinite(size) || size <= 0) return false;
  return distanceBetweenRectAndOpaqueContours(tokenRect, opaqueContours) <= size + Number.EPSILON;
}

/** Test whether every reachable point on a Tile is blocked by movement walls. */
export function isTokenBlockedFromTile(token, tile, {
  collisionBackend = globalThis.CONFIG?.Canvas?.polygonBackends?.move,
  grid = null,
  gridSize,
  level = null,
  contours
} = {}) {
  const tokenDocument = token?.document ?? token;
  const tileDocument = tile?.document ?? tile;
  if (!tokenDocument || !tileDocument) return true;
  if (!collisionBackend?.testCollision) return false;
  const scene = tileDocument.parent ?? tokenDocument.parent;
  const tokenSource = tokenDocument._source ?? tokenDocument;
  const tileSource = tileDocument._source ?? tileDocument;
  const interactionLevel = level
    ?? scene?.levels?.get?.(tokenSource.level ?? tileSource.level)
    ?? (globalThis.canvas?.scene === scene ? canvas.level : null);
  if (!interactionLevel) return true;
  const origin = getTokenOrigin(tokenDocument, tokenSource, gridSize);
  if (!origin) return true;

  const points = getReachableTileInteractionPoints(tokenDocument, tileDocument, grid, gridSize, origin, contours);
  if (!points.length) return true;
  try {
    scene?.initializeEdges?.();
    return points.every(point => Boolean(collisionBackend.testCollision(origin, {
      ...point,
      elevation: origin.elevation
    }, {type: "move", mode: "any", level: interactionLevel})));
  } catch (_error) {
    return true;
  }
}

function getReachableTileInteractionPoints(token, tile, grid, gridSize, origin, contours) {
  const size = Number(gridSize ?? grid?.size);
  if (grid?.testAdjacency && token.getOccupiedGridSpaceOffsets && Number.isFinite(size) && size > 0) {
    try {
      const source = token._source ?? token;
      const occupied = token.getOccupiedGridSpaceOffsets({...source, level: null});
      const reachable = getTileGridOffsets(tile, grid, size, contours).filter(tileOffset => occupied.some(tokenOffset => (
        (tokenOffset.i === tileOffset.i && tokenOffset.j === tileOffset.j)
        || grid.testAdjacency(
          {i: tokenOffset.i, j: tokenOffset.j},
          {i: tileOffset.i, j: tileOffset.j}
        )
      )));
      if (reachable.length) return reachable.map(offset => offsetToPoint(grid, offset, size));
    } catch (_error) {
      // Fall through to the closest point on the opaque texture.
    }
  }
  const opaqueContours = resolveContours(tile, contours);
  const point = getClosestOpaquePoint(origin, opaqueContours);
  return point ? [point] : [];
}

export function findAdjacentOwnedToken(tile, user, tokens, options = {}) {
  for (const token of tokens ?? []) {
    const document = token?.document ?? token;
    if (document?.parent !== (tile?.document ?? tile)?.parent) continue;
    if (!userOwnsToken(user, document)) continue;
    if (!isTokenAdjacentToTile(document, tile, options)) continue;
    if (options.testWalls !== false && isTokenBlockedFromTile(document, tile, options)) continue;
    return token;
  }
  return null;
}

export function getTileInteractionPoints(tile, grid, gridSize, contours) {
  const size = Number(gridSize ?? grid?.size);
  const opaqueContours = resolveContours(tile, contours);
  if (!opaqueContours?.length) return [];
  if (grid && Number.isFinite(size) && size > 0) {
    return getTileGridOffsets(tile, grid, size, opaqueContours).map(offset => offsetToPoint(grid, offset, size));
  }
  const bounds = getContourBounds(opaqueContours);
  return bounds ? [{x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2}] : [];
}

function getTileGridOffsets(tile, grid, gridSize, contours) {
  const size = Number(gridSize ?? grid?.size);
  const opaqueContours = resolveContours(tile, contours);
  const rect = getContourBounds(opaqueContours);
  if (!rect || !Number.isFinite(size) || size <= 0) return [];
  if (grid?.getOffset) {
    const offsets = new Map();
    for (const y of getAxisSamples(rect.y, rect.height, size)) {
      for (const x of getAxisSamples(rect.x, rect.width, size)) {
        const offset = grid.getOffset({x, y});
        if (!Number.isInteger(offset?.i) || !Number.isInteger(offset?.j)) continue;
        offsets.set(`${offset.i}:${offset.j}`, {i: offset.i, j: offset.j});
      }
    }
    if (offsets.size) return Array.from(offsets.values()).filter(offset => {
      const center = offsetToPoint(grid, offset, size);
      return rectIntersectsOpaqueContours(insetRect({
        x: center.x - size / 2,
        y: center.y - size / 2,
        width: size,
        height: size
      }), opaqueContours);
    });
  }

  const minI = Math.floor(rect.y / size);
  const maxI = Math.floor((rect.y + Math.max(rect.height - 1e-6, 0)) / size);
  const minJ = Math.floor(rect.x / size);
  const maxJ = Math.floor((rect.x + Math.max(rect.width - 1e-6, 0)) / size);
  const offsets = [];
  for (let i = minI; i <= maxI; i += 1) {
    for (let j = minJ; j <= maxJ; j += 1) offsets.push({i, j});
  }
  return offsets.filter(offset => rectIntersectsOpaqueContours(insetRect({
    x: offset.j * size,
    y: offset.i * size,
    width: size,
    height: size
  }), opaqueContours));
}

function resolveContours(tile, contours) {
  return contours ?? getTileOpaqueContours(tile?.document ?? tile);
}

function getContourBounds(contours) {
  const points = contours?.flat?.() ?? [];
  if (!points.length) return null;
  const xs = points.map(point => point.x);
  const ys = points.map(point => point.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return {x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y};
}

function rectIntersectsOpaqueContours(rect, contours) {
  const corners = rectCorners(rect);
  if (corners.some(point => pointInOpaqueContours(point, contours))) return true;
  for (const contour of contours) {
    if (contour.some(point => pointInRect(point, rect))) return true;
    for (let index = 0; index < contour.length; index += 1) {
      const a = contour[index];
      const b = contour[(index + 1) % contour.length];
      if (rectEdges(rect).some(([c, d]) => segmentsIntersect(a, b, c, d))) return true;
    }
  }
  return false;
}

function pointInOpaqueContours(point, contours) {
  let inside = false;
  for (const contour of contours ?? []) {
    for (let index = 0, previous = contour.length - 1; index < contour.length; previous = index, index += 1) {
      const a = contour[index];
      const b = contour[previous];
      if (((a.y > point.y) !== (b.y > point.y))
        && point.x < ((b.x - a.x) * (point.y - a.y) / (b.y - a.y)) + a.x) inside = !inside;
    }
  }
  return inside;
}

function distanceBetweenRectAndOpaqueContours(rect, contours) {
  if (rectIntersectsOpaqueContours(rect, contours)) return 0;
  let distance = Infinity;
  for (const contour of contours) {
    for (let index = 0; index < contour.length; index += 1) {
      const a = contour[index];
      const b = contour[(index + 1) % contour.length];
      for (const [c, d] of rectEdges(rect)) distance = Math.min(distance, segmentDistance(a, b, c, d));
    }
  }
  return distance;
}

function getClosestOpaquePoint(point, contours) {
  if (!contours?.length) return null;
  if (pointInOpaqueContours(point, contours)) return {x: point.x, y: point.y};
  let closest = null;
  let closestDistance = Infinity;
  for (const contour of contours) {
    for (let index = 0; index < contour.length; index += 1) {
      const candidate = closestPointOnSegment(point, contour[index], contour[(index + 1) % contour.length]);
      const distance = squaredDistance(point, candidate);
      if (distance < closestDistance) {
        closest = candidate;
        closestDistance = distance;
      }
    }
  }
  return closest;
}

function rectCorners(rect) {
  return [
    {x: rect.x, y: rect.y},
    {x: rect.x + rect.width, y: rect.y},
    {x: rect.x + rect.width, y: rect.y + rect.height},
    {x: rect.x, y: rect.y + rect.height}
  ];
}

function insetRect(rect) {
  const inset = Math.min(1e-4, rect.width / 4, rect.height / 4);
  return {
    x: rect.x + inset,
    y: rect.y + inset,
    width: Math.max(0, rect.width - inset * 2),
    height: Math.max(0, rect.height - inset * 2)
  };
}

function rectEdges(rect) {
  const corners = rectCorners(rect);
  return corners.map((point, index) => [point, corners[(index + 1) % corners.length]]);
}

function pointInRect(point, rect) {
  return point.x >= rect.x && point.x <= rect.x + rect.width
    && point.y >= rect.y && point.y <= rect.y + rect.height;
}

function segmentsIntersect(a, b, c, d) {
  const cross = (p, q, r) => ((q.x - p.x) * (r.y - p.y)) - ((q.y - p.y) * (r.x - p.x));
  const abC = cross(a, b, c);
  const abD = cross(a, b, d);
  const cdA = cross(c, d, a);
  const cdB = cross(c, d, b);
  if (abC === 0 && pointOnSegment(c, a, b)) return true;
  if (abD === 0 && pointOnSegment(d, a, b)) return true;
  if (cdA === 0 && pointOnSegment(a, c, d)) return true;
  if (cdB === 0 && pointOnSegment(b, c, d)) return true;
  return (abC > 0) !== (abD > 0) && (cdA > 0) !== (cdB > 0);
}

function pointOnSegment(point, a, b) {
  return point.x >= Math.min(a.x, b.x) && point.x <= Math.max(a.x, b.x)
    && point.y >= Math.min(a.y, b.y) && point.y <= Math.max(a.y, b.y);
}

function segmentDistance(a, b, c, d) {
  if (segmentsIntersect(a, b, c, d)) return 0;
  return Math.sqrt(Math.min(
    squaredDistance(a, closestPointOnSegment(a, c, d)),
    squaredDistance(b, closestPointOnSegment(b, c, d)),
    squaredDistance(c, closestPointOnSegment(c, a, b)),
    squaredDistance(d, closestPointOnSegment(d, a, b))
  ));
}

function closestPointOnSegment(point, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (!dx && !dy) return {x: a.x, y: a.y};
  const ratio = Math.max(0, Math.min(1, (((point.x - a.x) * dx) + ((point.y - a.y) * dy)) / ((dx * dx) + (dy * dy))));
  return {x: a.x + ratio * dx, y: a.y + ratio * dy};
}

function squaredDistance(a, b) {
  return ((a.x - b.x) ** 2) + ((a.y - b.y) ** 2);
}

function getAxisSamples(start, length, size) {
  const epsilon = Math.min(1e-4, length / 4);
  const end = start + length;
  const values = new Set([start + epsilon, Math.max(start + epsilon, end - epsilon), start + length / 2]);
  for (let value = start + size / 2; value < end; value += size / 2) values.add(value);
  return Array.from(values).filter(Number.isFinite);
}

function offsetToPoint(grid, offset, size) {
  try {
    const point = grid?.getCenterPoint?.(offset);
    if ([point?.x, point?.y].every(Number.isFinite)) return {x: point.x, y: point.y};
  } catch (_error) {
    // Use square-grid coordinate conversion below.
  }
  return {x: (offset.j + 0.5) * size, y: (offset.i + 0.5) * size};
}

function getTileRect(tile) {
  const document = tile?.document ?? tile;
  const bounds = document?.object?.bounds ?? document?.bounds;
  if ([bounds?.x, bounds?.y, bounds?.width, bounds?.height].every(Number.isFinite)) {
    return {x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height};
  }
  const source = document?._source ?? document ?? {};
  const x = Number(source.x ?? document?.x);
  const y = Number(source.y ?? document?.y);
  const width = Math.abs(Number(source.width ?? document?.width));
  const height = Math.abs(Number(source.height ?? document?.height));
  if (![x, y, width, height].every(Number.isFinite)) return null;
  return {x, y, width, height};
}

function getTokenRect(token, gridSize) {
  const source = token?._source ?? token ?? {};
  const size = Number(gridSize ?? token?.parent?.grid?.size);
  const x = Number(source.x ?? token?.x);
  const y = Number(source.y ?? token?.y);
  const width = Number(source.width ?? token?.width ?? 1) * size;
  const height = Number(source.height ?? token?.height ?? 1) * size;
  if (![x, y, width, height].every(Number.isFinite) || size <= 0) return null;
  return {x, y, width, height};
}

function getTokenOrigin(token, source, gridSize) {
  try {
    const origin = token.getMovementOrigin?.(source);
    if ([origin?.x, origin?.y].every(Number.isFinite)) return origin;
  } catch (_error) {
    // Fall back to the saved rectangular footprint.
  }
  const rect = getTokenRect(token, gridSize);
  const elevation = Number(source.elevation ?? token.elevation ?? 0);
  if (!rect || !Number.isFinite(elevation)) return null;
  return {x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, elevation};
}

function sameLevelAndElevation(token, tile) {
  const tokenSource = token?._source ?? token ?? {};
  const tileSource = tile?._source ?? tile ?? {};
  const tokenLevel = tokenSource.level ?? token.level ?? null;
  const tileLevels = normalizeLevels(tileSource.levels ?? tile.levels ?? tileSource.level ?? tile.level);
  if (tokenLevel != null && tileLevels.length && !tileLevels.includes(String(tokenLevel))) return false;
  const tokenElevation = Number(tokenSource.elevation ?? token.elevation ?? 0);
  const tileElevation = Number(tileSource.elevation ?? tile.elevation ?? 0);
  return !Number.isFinite(tokenElevation) || !Number.isFinite(tileElevation)
    || Math.abs(tokenElevation - tileElevation) <= Number.EPSILON;
}

function normalizeLevels(levels) {
  if (levels == null) return [];
  try {
    const values = typeof levels === "string" ? [levels] : Array.from(levels);
    return values.map(value => value?.id ?? value?._id ?? value).filter(value => value != null).map(String);
  } catch (_error) {
    return [String(levels)];
  }
}

function userOwnsToken(user, token) {
  const ownerLevel = globalThis.CONST?.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3;
  return token?.testUserPermission?.(user, ownerLevel)
    ?? token?.actor?.testUserPermission?.(user, ownerLevel)
    ?? false;
}
