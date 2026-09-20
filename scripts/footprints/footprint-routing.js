const MAX_ENDPOINTS = 24;
const SEARCH_RADIUS_GRIDS = 2;
const MAX_EXTRA_GRIDS = 4;
// Leave room for the visible print and the artwork around the wall line.
const PRINT_RADIUS_GRIDS = 0.35;

function documents(collection) {
  if (Array.isArray(collection?.contents)) return collection.contents;
  if (Array.isArray(collection)) return collection;
  return Array.from(collection?.values?.() ?? []);
}

function closestPoint(point, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length2 = dx * dx + dy * dy;
  const t = length2 ? Math.max(0, Math.min(1,
    ((point.x - a.x) * dx + (point.y - a.y) * dy) / length2)) : 0;
  return {x: a.x + t * dx, y: a.y + t * dy};
}

function pointSegmentDistance(point, a, b) {
  const closest = closestPoint(point, a, b);
  return Math.hypot(point.x - closest.x, point.y - closest.y);
}

function wallGeometry(scene, level) {
  const ends = [];
  const segments = [];
  for (const wall of documents(scene?.walls)) {
    const document = wall.document ?? wall;
    if (Number(document.move ?? document._source?.move ?? 0) === 0
      || document.isOpen === true || wall.isOpen === true) continue;
    if (typeof document.includedInLevel === "function") {
      try { if (!document.includedInLevel(level)) continue; }
      catch (_error) { continue; }
    }
    const c = document.c ?? document._source?.c ?? wall.coords;
    if (!c || c.length !== 4 || !c.every(Number.isFinite)) continue;
    const a = {x: c[0], y: c[1]};
    const b = {x: c[2], y: c[3]};
    if (Math.hypot(b.x - a.x, b.y - a.y) < 1) continue;
    segments.push({a, b});
    ends.push({point: a, other: b}, {point: b, other: a});
  }
  return {ends, segments};
}

/** Find a visual ground route without changing Foundry's Token movement. */
export function createFootprintRouter(scene, grid) {
  const backend = globalThis.CONFIG?.Canvas?.polygonBackends?.move;
  if (!backend?.testCollision || !scene?.walls) return null;
  try { scene.initializeEdges?.(); }
  catch (error) {
    console.warn("theiks-toolbag | Failed to prepare footprint wall routing", error);
    return {route: () => null, placeFoot: (_levelId, point) => point,
      placeCenter: (_levelId, point) => point};
  }
  const levels = new Map();
  let warned = false;
  function blocked(a, b, level, elevation) {
    try {
      return Boolean(backend.testCollision(
        {x: a.x, y: a.y, elevation}, {x: b.x, y: b.y, elevation},
        {type: "move", mode: "any", level}
      ));
    } catch (error) {
      if (!warned) console.warn("theiks-toolbag | Failed to test footprint wall collision", error);
      warned = true;
      return true;
    }
  }
  function getLevel(id) {
    if (levels.has(id)) return levels.get(id);
    const level = scene.levels?.get?.(id)
      ?? scene.levels?.contents?.find?.(entry => String(entry.id) === id)
      ?? null;
    const result = level ? {level, ...wallGeometry(scene, level)} : null;
    levels.set(id, result);
    return result;
  }
  function route(levelId, start, end, scale, elevation) {
    const context = getLevel(levelId);
    if (!context) return null;
    const {level, ends} = context;
    if (!blocked(start, end, level, elevation)) return [start, end];

    const direct = Math.hypot(end.x - start.x, end.y - start.y);
    const radius = SEARCH_RADIUS_GRIDS * grid;
    const clearance = (0.12 + PRINT_RADIUS_GRIDS + 0.02) * scale * grid;
    const selected = ends.map(entry => ({...entry,
      distance: pointSegmentDistance(entry.point, start, end)}))
      .filter(entry => entry.distance <= radius)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, MAX_ENDPOINTS);
    const nodes = [start, end];
    const seen = new Set();
    for (const {point, other} of selected) {
      const length = Math.hypot(point.x - other.x, point.y - other.y);
      const ux = (point.x - other.x) / length;
      const uy = (point.y - other.y) / length;
      for (const sign of [-1, 1]) {
        const candidate = {
          x: point.x + (ux - sign * uy) * clearance,
          y: point.y + (uy + sign * ux) * clearance
        };
        if (pointSegmentDistance(candidate, start, end) > radius) continue;
        const key = `${Math.round(candidate.x * 10)},${Math.round(candidate.y * 10)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        nodes.push(candidate);
      }
    }

    const maxLength = direct + MAX_EXTRA_GRIDS * grid;
    const distances = nodes.map(() => Infinity);
    const previous = nodes.map(() => -1);
    const visited = new Set();
    distances[0] = 0;
    while (visited.size < nodes.length) {
      let current = -1;
      for (let i = 0; i < nodes.length; i += 1) {
        if (!visited.has(i) && (current < 0 || distances[i] < distances[current])) current = i;
      }
      if (current < 0 || distances[current] > maxLength) break;
      if (current === 1) {
        const path = [];
        for (let i = current; i >= 0; i = previous[i]) path.push(nodes[i]);
        return path.reverse();
      }
      visited.add(current);
      for (let i = 1; i < nodes.length; i += 1) {
        if (i === current || visited.has(i)) continue;
        const length = Math.hypot(nodes[current].x - nodes[i].x, nodes[current].y - nodes[i].y);
        const next = distances[current] + length;
        if (next >= distances[i] || next > maxLength
          || blocked(nodes[current], nodes[i], level, elevation)) continue;
        distances[i] = next;
        previous[i] = current;
      }
    }
    return null;
  }
  function placeFoot(levelId, ground, candidate, scale, elevation) {
    const context = getLevel(levelId);
    if (!context) return null;
    const radius = PRINT_RADIUS_GRIDS * scale * grid;
    const dx = candidate.x - ground.x;
    const dy = candidate.y - ground.y;
    const desired = Math.hypot(dx, dy);
    if (!(desired > 0)) return null;
    const ux = dx / desired;
    const uy = dy / desired;
    function safe(offset) {
      const foot = {x: ground.x + ux * offset, y: ground.y + uy * offset};
      if (context.segments.some(({a, b}) => pointSegmentDistance(foot, a, b) < radius - 0.5)
        || blocked(ground, foot, context.level, elevation)) return null;
      return foot;
    }
    const original = safe(desired);
    if (original) return original;

    // Move across the route only. Moving a print along it can stack successive steps.
    const step = 0.01 * scale * grid;
    const limit = 0.75 * scale * grid;
    for (let delta = step; delta <= limit + desired; delta += step) {
      for (const offset of [desired - delta, desired + delta]) {
        if (Math.abs(offset) > limit) continue;
        const foot = safe(offset);
        if (foot) return foot;
      }
    }
    return null;
  }
  function placeCenter(levelId, ground, scale) {
    const context = getLevel(levelId);
    if (!context) return null;
    const radius = PRINT_RADIUS_GRIDS * scale * grid;
    return context.segments.some(({a, b}) => pointSegmentDistance(ground, a, b) < radius - 0.5)
      ? null : ground;
  }
  return {route, placeFoot, placeCenter};
}
