# Theik's Toolbag

A collection of helpful tools for Foundry Virtual Tabletop v14.

## Breakable walls

Edit a Wall and use the **Breakable Wall** fieldset to mark it as destructible
and select rubble images. The same fields are available in Foundry v14's Wall
Palette for bulk editing and for setting defaults on newly drawn walls.

GMs can then select **Wall Destruction Mode** from the Walls controls and click
the explosion marker over a configured wall. The created rubble Tile is centered
on the wall, locked, and sized to one wall-length by two wall-lengths.

Macros can invoke the same feature without duplicating its placement logic:

```js
const wall = canvas.walls.controlled[0]?.document;
await game.modules.get("theiks-toolbag").api.breakableWalls.prompt(wall);
```

For a non-interactive macro, call the same service directly:

```js
const wall = canvas.walls.controlled[0]?.document;
await game.modules.get("theiks-toolbag").api.breakableWalls.destroy(wall, {
  kind: "single",
  side: "positive"
});
```

## Development installation

Clone this repository into Foundry's `Data/modules/theiks-toolbag` directory, restart
Foundry, and enable **Theik's Toolbag** from **Manage Modules** in your world.

## Release installation

Published releases can be installed using this manifest URL:

```text
https://github.com/Theik/theiks-toolbag/releases/latest/download/module.json
```
