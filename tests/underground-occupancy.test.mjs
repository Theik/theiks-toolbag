import assert from "node:assert/strict";
import test from "node:test";

globalThis.game = {
  user: {isGM: true},
  settings: {get: () => true},
  i18n: {localize: key => key, format: key => key}
};

const {
  collectSceneUndergroundSubcellIndexes,
  createUndergroundSourceFromScene,
  getSceneBackgroundOccupancyTile,
  getSceneUndergroundBounds,
  getTileTextureTransform,
  tilePixelOccupancy,
  worldPointToTileUv
} = await import("../scripts/underground/underground-occupancy.js");
const {getUndergroundData, isUndergroundSubcell} = await import("../scripts/underground/underground-data.js");

function scene(overrides = {}) {
  return {
    initialLevel: "level-1",
    grid: {size: 100},
    dimensions: {sceneX: 0, sceneY: 0, sceneWidth: 200, sceneHeight: 200},
    tiles: [],
    ...overrides
  };
}

function tile(overrides = {}) {
  const {texture, ...rest} = overrides;
  return {
    hidden: false,
    x: 50,
    y: 50,
    width: 100,
    height: 100,
    rotation: 0,
    levels: [],
    ...rest,
    texture: {
      src: "floor.webp",
      width: 10,
      height: 10,
      anchorX: 0.5,
      anchorY: 0.5,
      scaleX: 1,
      scaleY: 1,
      fit: "fill",
      alphaThreshold: 0.75,
      ...texture
    }
  };
}

function occupancyOptions(sampleTileAlpha, extra = {}) {
  return {
    subdivision: 4,
    sampleTileAlpha,
    getTextureSize: current => ({
      width: Number(current?.texture?.width) > 0 ? Number(current.texture.width) : 10,
      height: Number(current?.texture?.height) > 0 ? Number(current.texture.height) : 10
    }),
    ...extra
  };
}

function attachLevel(target, overrides = {}) {
  const {background, textures, ...rest} = overrides;
  const level = {
    id: "level-1",
    _id: "level-1",
    background: {color: "#000000", ...background},
    textures: {
      fit: "fill",
      anchorX: 0.5,
      anchorY: 0.5,
      scaleX: 1,
      scaleY: 1,
      rotation: 0,
      offsetX: 0,
      offsetY: 0,
      ...textures
    },
    ...rest
  };
  target.levels = {
    contents: [level],
    get(id) { return id === level.id ? level : null; }
  };
  return target;
}

test("playable Scene bounds become a logical underground grid", () => {
  const bounds = getSceneUndergroundBounds(scene({
    grid: {size: 100},
    dimensions: {sceneX: 200, sceneY: 300, sceneWidth: 250, sceneHeight: 150}
  }));
  assert.deepEqual(bounds, {origin: {x: 200, y: 300}, width: 3, height: 2, gridSize: 100});
});

test("transparent and near-black pixels count as empty cutouts, not dungeon floor", () => {
  assert.equal(tilePixelOccupancy(0, 0, 0, 0), 0);
  assert.equal(tilePixelOccupancy(0, 0, 0, 1), 0);
  assert.equal(tilePixelOccupancy(8, 4, 2, 1), 0);
  assert.ok(tilePixelOccupancy(186, 162, 124, 1) > 0);
  assert.ok(tilePixelOccupancy(8, 4, 2, 1, {inkedBlack: false}) > 0,
    "scene rasters keep opaque dark stone and dirt as floor");
});

test("an empty Scene fills every subcell", async () => {
  const cells = await collectSceneUndergroundSubcellIndexes(scene(), occupancyOptions(async () => 1));
  assert.equal(cells.length, 64);
  assert.deepEqual(cells, Array.from({length: 64}, (_, index) => index));
});

test("opaque pixels punch holes and transparent pixels stay earth", async () => {
  const opaque = await collectSceneUndergroundSubcellIndexes(scene({
    tiles: [tile()]
  }), occupancyOptions(async () => 1));
  assert.equal(opaque.includes(0), false);
  assert.equal(opaque.includes(3), false);
  assert.equal(opaque.includes(27), false);
  assert.equal(opaque.includes(4), true);
  assert.equal(opaque.length, 48);

  const clear = await collectSceneUndergroundSubcellIndexes(scene({
    tiles: [tile()]
  }), occupancyOptions(async () => 0));
  assert.equal(clear.length, 64);
});

test("hidden and wrong-Level Tiles are ignored", async () => {
  const hidden = await collectSceneUndergroundSubcellIndexes(scene({
    tiles: [tile({hidden: true})]
  }), occupancyOptions(async () => 1));
  assert.equal(hidden.length, 64);

  const otherLevel = await collectSceneUndergroundSubcellIndexes(scene({
    tiles: [tile({levels: ["other"]})]
  }), occupancyOptions(async () => 1, {levelId: "level-1"}));
  assert.equal(otherLevel.length, 64);

  const matching = await collectSceneUndergroundSubcellIndexes(scene({
    tiles: [tile({levels: ["level-1"]})]
  }), occupancyOptions(async () => 1, {levelId: "level-1"}));
  assert.equal(matching.length, 48);
});

test("tile AABB sampling does not visit far-away subcells", async () => {
  const sampled = [];
  await collectSceneUndergroundSubcellIndexes(scene({
    tiles: [tile()]
  }), occupancyOptions(async (_tile, u, v) => {
    sampled.push([u, v]);
    return 1;
  }));
  assert.ok(sampled.length > 0);
  assert.ok(sampled.length <= 16);
  for (const [u, v] of sampled) {
    assert.ok(u >= 0 && u <= 1);
    assert.ok(v >= 0 && v <= 1);
  }
});

test("world points invert the Tile texture transform", () => {
  const transform = getTileTextureTransform(tile(), {width: 10, height: 10});
  assert.deepEqual(worldPointToTileUv(transform, 50, 50), {u: 0.5, v: 0.5});
  assert.deepEqual(worldPointToTileUv(transform, 0, 0), {u: 0, v: 0});
  assert.deepEqual(worldPointToTileUv(transform, 100, 100), {u: 1, v: 1});
  assert.equal(worldPointToTileUv(transform, 150, 150), null);

  const shifted = getTileTextureTransform(tile({
    texture: {offsetX: 5, offsetY: 5}
  }), {width: 10, height: 10});
  assert.deepEqual(worldPointToTileUv(shifted, 50, 50), {u: 0, v: 0});
});

test("Level background artwork punches opaque pixels and leaves transparent pixels as earth", async () => {
  const opaque = await collectSceneUndergroundSubcellIndexes(attachLevel(scene(), {
    background: {src: "basement.webp", alphaThreshold: 0.75}
  }), occupancyOptions(async () => 1));
  assert.equal(opaque.length, 0);

  const clear = await collectSceneUndergroundSubcellIndexes(attachLevel(scene(), {
    background: {src: "basement.webp"}
  }), occupancyOptions(async () => 0));
  assert.equal(clear.length, 64);
});

test("background color without src still fills empty space", async () => {
  const cells = await collectSceneUndergroundSubcellIndexes(attachLevel(scene(), {
    background: {color: "#000000"}
  }), occupancyOptions(async () => 1));
  assert.equal(cells.length, 64);
  assert.equal(getSceneBackgroundOccupancyTile(attachLevel(scene(), {
    background: {color: "#000000"}
  }), {levelId: "level-1"}), null);
});

test("Scene background is sampled when the Level has no image", async () => {
  const cells = await collectSceneUndergroundSubcellIndexes(scene({
    background: {src: "map.webp"}
  }), occupancyOptions(async () => 1));
  assert.equal(cells.length, 0);
});

test("foreground artwork is not occupancy", async () => {
  const cells = await collectSceneUndergroundSubcellIndexes(attachLevel(scene(), {
    foreground: {src: "roof.webp"}
  }), occupancyOptions(async () => 1));
  assert.equal(cells.length, 64);
});

test("Tiles still punch holes on top of a transparent Level background", async () => {
  const cells = await collectSceneUndergroundSubcellIndexes(attachLevel(scene({
    tiles: [tile()]
  }), {
    background: {src: "basement.webp"}
  }), occupancyOptions(async (current) => current.texture.src === "floor.webp" ? 1 : 0));
  assert.equal(cells.length, 48);
  assert.equal(cells.includes(0), false);
  assert.equal(cells.includes(4), true);
});

test("includedInLevel false excludes a Tile even when levels list is empty", async () => {
  const ignored = await collectSceneUndergroundSubcellIndexes(scene({
    tiles: [tile({includedInLevel: () => false})]
  }), occupancyOptions(async () => 1, {levelId: "level-1"}));
  assert.equal(ignored.length, 64);
});

test("a Level background that cannot be rasterized does not occupy the whole map", async () => {
  const previousFoundry = globalThis.foundry;
  const previousFetch = globalThis.fetch;
  globalThis.foundry = {
    canvas: {loadTexture: async () => ({width: 10, height: 10, source: {}})},
    utils: {getRoute: src => `/routed/${src}`}
  };
  const fetched = [];
  globalThis.fetch = async url => {
    fetched.push(url);
    return {ok: false};
  };
  try {
    const target = attachLevel(scene(), {
      background: {src: "basement.webp", width: 10, height: 10, alphaThreshold: 0.75}
    });
    assert.equal(getSceneBackgroundOccupancyTile(target, {levelId: "level-1"}).occupancyFallback, "empty");
    const cells = await collectSceneUndergroundSubcellIndexes(target, {subdivision: 4, levelId: "level-1"});
    assert.equal(cells.length, 64);
    assert.deepEqual(fetched, ["/routed/basement.webp"]);
  } finally {
    globalThis.foundry = previousFoundry;
    globalThis.fetch = previousFetch;
  }
});

test("a Tile that cannot be rasterized still occupies its AABB", async () => {
  const previousFoundry = globalThis.foundry;
  const previousFetch = globalThis.fetch;
  globalThis.foundry = {
    canvas: {loadTexture: async () => null},
    utils: {getRoute: src => src}
  };
  globalThis.fetch = async () => ({ok: false});
  try {
    const cells = await collectSceneUndergroundSubcellIndexes(scene({
      tiles: [tile()]
    }), {subdivision: 4});
    assert.equal(cells.length, 48);
  } finally {
    globalThis.foundry = previousFoundry;
    globalThis.fetch = previousFetch;
  }
});

test("the viewed Level background mesh supplies occupancy position and anchor", async () => {
  const target = attachLevel(scene(), {background: {src: "basement.webp"}});
  const previous = globalThis.canvas;
  globalThis.canvas = {
    scene: target,
    level: {id: "level-1"},
    primary: {
      background: {
        destroyed: false,
        width: 200,
        height: 200,
        position: {x: 100, y: 100},
        anchor: {x: 0.5, y: 0.5},
        angle: 0,
        texture: {width: 10, height: 10}
      }
    }
  };
  try {
    const occupancyTile = getSceneBackgroundOccupancyTile(target, {levelId: "level-1"});
    assert.equal(occupancyTile.x, 100);
    assert.equal(occupancyTile.y, 100);
    assert.equal(occupancyTile.width, 200);
    assert.equal(occupancyTile.occupancyFallback, "empty");
    assert.equal(occupancyTile.texture.anchorX, 0.5);
    const opaque = await collectSceneUndergroundSubcellIndexes(
      target,
      occupancyOptions(async () => 1, {levelId: "level-1"})
    );
    assert.equal(opaque.length, 0);
  } finally {
    globalThis.canvas = previous;
  }
});

test("an aborted occupancy scan throws AbortError", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => collectSceneUndergroundSubcellIndexes(
      scene({tiles: [tile()]}),
      occupancyOptions(async () => 1, {signal: controller.signal})
    ),
    error => error.name === "AbortError"
  );
});

test("createSourceFromScene fills empty space and defaults blocking on", async () => {
  const source = await createUndergroundSourceFromScene(scene(), {
    intactSrc: "earth.webp",
    dugSrc: "rubble.webp",
    intactGrid: 5,
    dugGrid: 2,
    sampleTileAlpha: async () => 0,
    getTextureSize: () => ({width: 10, height: 10})
  });
  const data = getUndergroundData({
    getFlag: () => source,
    flags: {"theiks-toolbag": {undergroundTerrain: source}}
  });
  assert.equal(source.levelId, "level-1");
  assert.equal(data.width, 2);
  assert.equal(data.height, 2);
  assert.equal(data.intactGrid, 5);
  assert.equal(data.dugGrid, 2);
  assert.equal(data.blocksMovement, true);
  assert.equal(data.blocksVision, true);
  assert.equal(isUndergroundSubcell(data, 0), true);
  assert.equal([...Array(64).keys()].every(index => isUndergroundSubcell(data, index)), true);
});

function pyramidScene() {
  const target = attachLevel(scene({
    flags: {
      "theiks-ktx2-renderer": {mapPyramid: {manifest: "modules/map/pyramid/manifest.json"}}
    }
  }), {
    background: {src: "modules/map/pyramid/z0/0-0.ktx2", alphaThreshold: 0.75}
  });
  target.getFlag = (module, key) => target.flags?.[module]?.[key];
  return target;
}

function rgbaBuffer(width, height, pixel) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const color = pixel(x, y);
      const index = ((y * width) + x) * 4;
      data[index] = color[0];
      data[index + 1] = color[1];
      data[index + 2] = color[2];
      data[index + 3] = color[3];
    }
  }
  return data;
}

function imageCanvas(width, height, pixel) {
  const data = rgbaBuffer(width, height, pixel);
  return {
    width,
    height,
    getContext() {
      return {
        drawImage() {},
        getImageData() { return {data}; }
      };
    }
  };
}

test("a KTX2 pyramid thumbnail punches opaque floors and keeps black padding as earth", async () => {
  const target = pyramidScene();
  const previous = {
    canvas: globalThis.canvas,
    foundry: globalThis.foundry,
    fetch: globalThis.fetch,
    document: globalThis.document,
    createImageBitmap: globalThis.createImageBitmap
  };
  globalThis.canvas = undefined;
  globalThis.foundry = {utils: {getRoute: src => src}};
  globalThis.document = {createElement: tag => tag === "canvas" ? imageCanvas(4, 4, (x) => {
    return x < 2 ? [186, 162, 124, 255] : [0, 0, 0, 0];
  }) : {}};
  globalThis.createImageBitmap = async () => ({width: 4, height: 4, naturalWidth: 4, naturalHeight: 4});
  globalThis.fetch = async url => {
    if (String(url).includes("manifest.json")) {
      return {
        ok: true,
        json: async () => ({
          levels: [{id: "level-1", tiers: [{id: "z0", tiles: [{blank: true}]}]}],
          thumbnail: {path: "modules/map/pyramid/thumb.webp"}
        })
      };
    }
    return {ok: true, blob: async () => ({})};
  };
  try {
    const cells = await collectSceneUndergroundSubcellIndexes(target, {subdivision: 4, levelId: "level-1"});
    assert.equal(cells.includes(9), false, "opaque thumbnail interior is dungeon floor");
    assert.equal(cells.includes(15), true, "transparent thumbnail padding stays earth");
    assert.ok(cells.length < 64);
    assert.ok(cells.length > 0);
  } finally {
    globalThis.canvas = previous.canvas;
    globalThis.foundry = previous.foundry;
    globalThis.fetch = previous.fetch;
    globalThis.document = previous.document;
    globalThis.createImageBitmap = previous.createImageBitmap;
  }
});

test("opaque dark pyramid pixels stay dungeon floor, not earth cutouts", async () => {
  const target = pyramidScene();
  const previous = globalThis.canvas;
  const extracted = imageCanvas(4, 4, () => [8, 4, 2, 255]);
  globalThis.canvas = {
    scene: target,
    manager: {
      scene: target,
      manifest: {levels: [{id: "level-1", tiers: [{tiles: []}]}]},
      containers: new Map([["level-1", {
        children: [{
          destroyed: false,
          width: 200,
          height: 200,
          position: {x: 0, y: 0}
        }]
      }]])
    },
    app: {renderer: {extract: {
      canvas: value => (value?.target ?? value)?.width === 200 ? extracted : null
    }}}
  };
  try {
    const cells = await collectSceneUndergroundSubcellIndexes(target, {subdivision: 4, levelId: "level-1"});
    assert.equal(cells.length, 0, "opaque dark dirt and grout stay dungeon floor");
  } finally {
    globalThis.canvas = previous;
  }
});

test("live KTX2 pyramid meshes occupy only their scene rectangle", async () => {
  const target = pyramidScene();
  const previous = globalThis.canvas;
  const extracted = imageCanvas(4, 4, () => [186, 162, 124, 255]);
  globalThis.canvas = {
    scene: target,
    manager: {
      scene: target,
      manifest: {levels: [{id: "level-1", tiers: [{tiles: []}]}]},
      containers: new Map([["level-1", {
        children: [{
          destroyed: false,
          width: 100,
          height: 100,
          position: {x: 0, y: 0}
        }]
      }]])
    },
    app: {renderer: {extract: {
      canvas: value => (value?.target ?? value)?.width === 100 ? extracted : null
    }}}
  };
  try {
    const cells = await collectSceneUndergroundSubcellIndexes(target, {subdivision: 4, levelId: "level-1"});
    assert.equal(cells.includes(0), false, "the pyramid mesh punches occupancy");
    assert.equal(cells.includes(4), true, "subcells beside the mesh stay earth");
    assert.equal(cells.length, 48);
  } finally {
    globalThis.canvas = previous;
  }
});

