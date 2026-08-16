# Development

## Install dependencies

```powershell
npm ci
```

## Compendium workflow

The readable JSON under `packs-src/` is the source-controlled compendium source. The LevelDB databases under `packs/` are generated and ignored by Git.

Build the databases before opening Foundry after a fresh clone:

```powershell
npm run packs:build
```

To edit compendium content:

1. Build the packs if needed.
2. Open Foundry and edit the module compendium normally.
3. Close Foundry completely.
4. Extract the updated database back to JSON:

```powershell
npm run packs:extract
npm run packs:verify
```

Review and commit the changes under `packs-src/`. Never commit files from `packs/`.

## Release workflow

`npm run release:build` rebuilds and verifies every compendium, then creates:

- `dist/theiks-toolbag.zip`
- `dist/module.json`

Pushing a tag matching the version in `module.json` (for example `v1.0.0`) runs the test suite, creates these assets, and publishes a GitHub release. The `download` URL in `module.json` must use that same tag.
