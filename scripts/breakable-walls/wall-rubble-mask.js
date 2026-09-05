const DEFAULT_MAX_DIMENSION = 1024;

/** Return the physical Wall segments which can stop rubble on the viewed Level. */
export function getRubbleBarrierSegments(walls, {
  sourceWallId,
  levelId,
  isDestroyed = () => false,
  constants = globalThis.CONST
} = {}) {
  const noMovement = constants?.WALL_MOVEMENT_TYPES?.NONE ?? 0;
  const noDoor = constants?.WALL_DOOR_TYPES?.NONE ?? 0;
  const openDoor = constants?.WALL_DOOR_STATES?.OPEN ?? 1;

  return Array.from(walls ?? []).flatMap(wall => {
    const document = wall?.document ?? wall;
    if (!document || document.id === sourceWallId || isDestroyed(document)) return [];
    if (!isDocumentOnLevel(document, levelId)) return [];
    const source = document._source ?? document;
    const door = Number(source.door ?? document.door ?? noDoor);
    const doorState = Number(source.ds ?? document.ds ?? 0);
    const movement = Number(source.move ?? document.move ?? noMovement);
    if (door !== noDoor && doorState === openDoor) return [];
    if (door === noDoor && movement === noMovement) return [];
    const coordinates = Array.from(source.c ?? document.c ?? []);
    return coordinates.length === 4 && coordinates.every(Number.isFinite) ? [coordinates] : [];
  });
}

/** Build an alpha mask containing only rubble pixels reachable without crossing a barrier segment. */
export function createRubbleAccessMask(geometry, destruction, segments, {
  maxDimension = DEFAULT_MAX_DIMENSION
} = {}) {
  validateGeometry(geometry);
  const limit = Number.isFinite(maxDimension) && maxDimension > 0 ? maxDimension : DEFAULT_MAX_DIMENSION;
  const resolution = Math.min(1, limit / Math.max(geometry.width, geometry.height));
  const width = Math.max(1, Math.round(geometry.width * resolution));
  const height = Math.max(2, Math.round(geometry.height * resolution));
  const barriers = new Uint8Array(width * height);
  const occluders = new Uint8Array(width * height);

  for (const segment of segments ?? []) {
    const transformed = transformSegment(segment, geometry, width, height);
    if (transformed) rasterizeLine(transformed.a, transformed.b, width, height, barriers, occluders, 1);
  }

  const centerY = Math.max(0, Math.min(height - 1, Math.round((height - 1) / 2)));

  const reachable = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  let queued = 0;
  const seedRow = row => {
    if (row < 0 || row >= height) return;
    for (let x = 0; x < width; x += 1) {
      const index = (row * width) + x;
      if (barriers[index] || reachable[index]) continue;
      reachable[index] = 1;
      queue[queued++] = index;
    }
  };

  const kind = destruction?.kind === "single" ? "single" : "both";
  if (kind === "both" || destruction?.side === "negative") seedRow(centerY - 1);
  if (kind === "both" || destruction?.side === "positive") seedRow(centerY + 1);
  floodFill(reachable, barriers, queue, queued, width, height);

  const data = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < reachable.length; index += 1) {
    const accessible = !occluders[index] && reachable[index];
    const target = index * 4;
    data[target] = 255;
    data[target + 1] = 255;
    data[target + 2] = 255;
    data[target + 3] = accessible ? 255 : 0;
  }
  return {width, height, resolution, data};
}

function transformSegment(segment, geometry, width, height) {
  if (!Array.isArray(segment) || segment.length !== 4 || !segment.every(Number.isFinite)) return null;
  const radians = geometry.rotation * Math.PI / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const transform = (x, y) => {
    const dx = x - geometry.x;
    const dy = y - geometry.y;
    return {
      x: (((cos * dx) + (sin * dy) + geometry.width / 2) / geometry.width) * (width - 1),
      y: (((-sin * dx) + (cos * dy) + geometry.height / 2) / geometry.height) * (height - 1)
    };
  };
  return clipSegment(transform(segment[0], segment[1]), transform(segment[2], segment[3]), width, height);
}

function clipSegment(a, b, width, height) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const p = [-dx, dx, -dy, dy];
  const q = [a.x, (width - 1) - a.x, a.y, (height - 1) - a.y];
  let start = 0;
  let end = 1;
  for (let index = 0; index < 4; index += 1) {
    if (p[index] === 0) {
      if (q[index] < 0) return null;
      continue;
    }
    const ratio = q[index] / p[index];
    if (p[index] < 0) start = Math.max(start, ratio);
    else end = Math.min(end, ratio);
    if (start > end) return null;
  }
  return {
    a: {x: a.x + start * dx, y: a.y + start * dy},
    b: {x: a.x + end * dx, y: a.y + end * dy}
  };
}

function rasterizeLine(a, b, width, height, barriers, target, dilation) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) * 2));
  for (let step = 0; step <= steps; step += 1) {
    const x = Math.round(a.x + (dx * step / steps));
    const y = Math.round(a.y + (dy * step / steps));
    for (let oy = -dilation; oy <= dilation; oy += 1) {
      for (let ox = -dilation; ox <= dilation; ox += 1) {
        const px = x + ox;
        const py = y + oy;
        if (px < 0 || py < 0 || px >= width || py >= height) continue;
        const index = (py * width) + px;
        barriers[index] = 1;
        target[index] = 1;
      }
    }
  }
}

function floodFill(reachable, barriers, queue, queued, width, height) {
  let cursor = 0;
  const visit = index => {
    if (index < 0 || index >= reachable.length || barriers[index] || reachable[index]) return;
    reachable[index] = 1;
    queue[queued++] = index;
  };
  while (cursor < queued) {
    const index = queue[cursor++];
    const x = index % width;
    if (x > 0) visit(index - 1);
    if (x < width - 1) visit(index + 1);
    if (index >= width) visit(index - width);
    if (index < reachable.length - width) visit(index + width);
  }
}

function isDocumentOnLevel(document, levelId) {
  const levels = normalizeLevelIds(document.levels ?? document?._source?.levels);
  if (!levels.length) return true;
  return levelId != null && levels.includes(String(levelId));
}

function normalizeLevelIds(levels) {
  if (levels == null) return [];
  try {
    const values = typeof levels === "string" ? [levels] : Array.from(levels);
    return values.map(level => level?.id ?? level?._id ?? level).filter(value => value != null).map(String);
  } catch (_error) {
    return [];
  }
}

function validateGeometry(geometry) {
  if (![geometry?.x, geometry?.y, geometry?.width, geometry?.height, geometry?.rotation].every(Number.isFinite)
    || geometry.width <= 0 || geometry.height <= 0) {
    throw new TypeError("Rubble access masking requires finite positive geometry.");
  }
}
