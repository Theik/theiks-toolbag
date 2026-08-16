import assert from "node:assert/strict";
import {readdir, readFile, rm, stat, unlink} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";

import {compilePack, extractPack} from "@foundryvtt/foundryvtt-cli";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST_PATH = path.join(ROOT, "module.json");
const PACK_SOURCE_ROOT = path.join(ROOT, "packs-src");
const RUNTIME_FILES = ["LOCK", "LOG", "LOG.old"];

async function loadPacks() {
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, "utf8"));
  const packs = manifest.packs ?? [];

  if (!packs.length) throw new Error("module.json does not declare any compendium packs.");

  return packs.map(pack => {
    if (!pack.name || !pack.path) throw new Error("Every compendium pack requires both name and path.");

    return {
      ...pack,
      database: path.resolve(ROOT, pack.path),
      source: path.join(PACK_SOURCE_ROOT, pack.name)
    };
  });
}

function extractionOptions() {
  return {
    clean: true,
    expandAdventures: true,
    folders: true,
    jsonOptions: {space: 2},
    log: true,
    omitVolatile: true,
    transformSerialized: serialized => `${serialized.trimEnd()}\n`
  };
}

async function pathExists(target) {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function removeRuntimeFiles(database) {
  for (const filename of RUNTIME_FILES) {
    try {
      await unlink(path.join(database, filename));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

async function findJsonFiles(directory) {
  const files = [];

  async function visit(current) {
    for (const entry of await readdir(current, {withFileTypes: true})) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile() && entry.name.endsWith(".json")) {
        files.push(path.relative(directory, absolute).split(path.sep).join("/"));
      }
    }
  }

  await visit(directory);
  return files.sort();
}

async function assertEquivalentSources(expectedDirectory, actualDirectory, packName) {
  const expectedFiles = await findJsonFiles(expectedDirectory);
  const actualFiles = await findJsonFiles(actualDirectory);
  assert.deepEqual(actualFiles, expectedFiles, `${packName}: round-trip JSON file list differs.`);

  for (const relative of expectedFiles) {
    const expected = JSON.parse(await readFile(path.join(expectedDirectory, relative), "utf8"));
    const actual = JSON.parse(await readFile(path.join(actualDirectory, relative), "utf8"));
    assert.deepEqual(actual, expected, `${packName}: ${relative} changed during the pack round trip.`);
  }
}

export async function extractPacks() {
  for (const pack of await loadPacks()) {
    if (!(await pathExists(pack.database))) {
      throw new Error(`${pack.name}: generated database does not exist at ${pack.database}`);
    }

    console.log(`Extracting ${pack.name} to ${path.relative(ROOT, pack.source)}...`);
    await extractPack(pack.database, pack.source, extractionOptions());
  }
}

export async function buildPacks({destinationRoot} = {}) {
  for (const pack of await loadPacks()) {
    if (!(await pathExists(pack.source))) {
      throw new Error(`${pack.name}: source directory does not exist at ${pack.source}`);
    }

    const database = destinationRoot
      ? path.join(destinationRoot, path.relative(ROOT, pack.database))
      : pack.database;

    console.log(`Building ${pack.name} from ${path.relative(ROOT, pack.source)}...`);
    await rm(database, {force: true, recursive: true, maxRetries: 10});
    await compilePack(pack.source, database, {log: true, recursive: true});
    await removeRuntimeFiles(database);
  }
}

export async function verifyPacks() {
  const temporaryRoot = path.join(os.tmpdir(), `theiks-toolbag-packs-${process.pid}-${Date.now()}`);

  try {
    await buildPacks({destinationRoot: temporaryRoot});

    for (const pack of await loadPacks()) {
      const database = path.join(temporaryRoot, path.relative(ROOT, pack.database));
      const extracted = path.join(temporaryRoot, "extracted", pack.name);
      await extractPack(database, extracted, extractionOptions());
      await assertEquivalentSources(pack.source, extracted, pack.name);
      console.log(`Verified ${pack.name}: JSON survives a complete LevelDB round trip.`);
    }
  } finally {
    await rm(temporaryRoot, {force: true, recursive: true, maxRetries: 10});
  }
}

async function main() {
  const command = process.argv[2];

  if (command === "extract") return extractPacks();
  if (command === "build") return buildPacks();
  if (command === "verify") return verifyPacks();

  throw new Error("Usage: node tools/compendium-packs.mjs <extract|build|verify>");
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
