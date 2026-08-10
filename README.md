# Theik's Toolbag

A collection of helpful tools for Foundry Virtual Tabletop v14.

## Settings

The module's **Breakable Walls**, **Breakable Terrain**, and **Visible Lights**
features can each be enabled or disabled from **Game Settings → Theik's
Toolbag**. All three are enabled by default. Disabling a feature hides its
configuration and controls, removes its runtime canvas elements, and prevents
its macro actions without deleting any saved document flags.

## Breakable walls

Edit a Wall and use the **Breakable Wall** fieldset to mark it as destructible
and select rubble images. The same fields are available in Foundry v14's Wall
Palette for bulk editing and for setting defaults on newly drawn walls.

GMs can then select **Wall Destruction Mode** from the Walls controls and click
the explosion marker over a configured wall. The wall becomes nonblocking and
its rubble artwork is rendered directly on the canvas, centered on the wall and
sized to one wall-length by two wall-lengths. No Tile is created and the Wall
document is retained.

Destroyed walls show a green repair marker in the same mode. Click it once to
restore the wall's exact original movement, sight, light, sound, door type, and
door state. Rubble Tiles created by older versions are left unchanged.

Macros can invoke the same feature without duplicating its placement logic. This
safe example reports a warning instead of throwing if the module is missing or
inactive, or if no Wall is selected:

```js
const toolbag = game.modules.get("theiks-toolbag");
const wallApi = toolbag?.active ? toolbag.api?.breakableWalls : null;
const wall = canvas.walls?.controlled?.[0]?.document;

if (!wallApi) {
  ui.notifications.warn("Theik's Toolbag is not installed or active.");
} else if (!wall) {
  ui.notifications.warn("Select a Wall first.");
} else {
  try {
    await wallApi.prompt(wall);
  } catch (error) {
    ui.notifications.error(error?.message ?? String(error));
  }
}
```

For a non-interactive macro, call the same service directly:

```js
const toolbag = game.modules.get("theiks-toolbag");
const wallApi = toolbag?.active ? toolbag.api?.breakableWalls : null;
const wall = canvas.walls?.controlled?.[0]?.document;

if (!wallApi) {
  ui.notifications.warn("Theik's Toolbag is not installed or active.");
} else if (!wall) {
  ui.notifications.warn("Select a Wall first.");
} else {
  try {
    await wallApi.destroy(wall, {kind: "single", side: "positive"});
    // In a repair macro, replace the line above with: await wallApi.repair(wall);
  } catch (error) {
    ui.notifications.error(error?.message ?? String(error));
  }
}
```

`destroy` resolves to that updated `WallDocument`, rather than a rubble Tile.
`toggle` opens the destruction prompt for an intact wall and immediately repairs
a destroyed wall.

## Breakable terrain

Edit a Tile and use the **Breakable Terrain** fieldset to make it destroyable,
make its opaque artwork block movement, and/or make it block light and vision.
Add one or more destroyed-state images in order; the final image represents
fully destroyed terrain. A state may have an empty image, which hides the Tile
at that stage. For the best effect, use images with the same dimensions for
every state. The same settings are available in Foundry v14's Tile Palette for
defaults and bulk editing.

GMs can select **Terrain Destruction Mode** from the Tiles controls, or use the
top-level **Destruction Mode** control to show both terrain and wall markers.
Left-click an orange explosion marker to advance the Tile by one destroyed
state, and right-click to move back by one state. The Tile's blocking silhouette
follows the opaque pixels of every image. Movement uses the exact opaque
contours. Vision uses one terrain-wall envelope around the whole image, so all
of the Tile remains visible while light and sight are blocked behind it. At the
final state all movement, light, and vision blocking is removed and the marker turns green.
Left-click the green marker to restore the exact original image immediately.

Blocking is implemented with transient Foundry canvas edges. No helper Wall or
Tile documents are created, and Tile rotation, anchors, scaling, texture fit,
and Scene Levels are respected.

Macros can safely invoke any transition by changing `action` to `"advance"`,
`"retreat"`, or `"restore"`:

```js
const action = "advance";
const toolbag = game.modules.get("theiks-toolbag");
const terrainApi = toolbag?.active ? toolbag.api?.breakableTerrain : null;
const operation = terrainApi?.[action];
const tile = canvas.tiles?.controlled?.[0]?.document;

if (!terrainApi) {
  ui.notifications.warn("Theik's Toolbag is not installed or active.");
} else if (typeof operation !== "function") {
  ui.notifications.warn(`Unknown terrain action: ${action}`);
} else if (!tile) {
  ui.notifications.warn("Select a Tile first.");
} else {
  try {
    await operation(tile);
  } catch (error) {
    ui.notifications.error(error?.message ?? String(error));
  }
}
```

## Visible lights

Edit an Ambient Light and use the **Visible Light** fieldset to choose square
artwork for its on, off, and destroyed states. The current artwork is centered
on the light and rendered at one grid space in each direction. It follows the
light when the light is moved without creating extra Tile documents.

While the normal Token controls are active, a light control appears over each
configured fixture. A GM can left-click it to switch the light on or off from
anywhere, or right-click it to destroy the fixture and switch it off. A player
only sees the left-click control when one of their selected, owned tokens is
next to the light. Destroyed lights cannot be toggled by players; a GM can clear
the **Destroyed** checkbox in the Light configuration to repair one.

Macros can use the same state-changing services. Set `action` to `"toggle"` or,
for a GM destruction macro, `"destroy"`:

```js
const action = "toggle";
const toolbag = game.modules.get("theiks-toolbag");
const lightApi = toolbag?.active ? toolbag.api?.visibleLights : null;
const operation = lightApi?.[action];
const light = canvas.lighting?.controlled?.[0]?.document;

if (!lightApi) {
  ui.notifications.warn("Theik's Toolbag is not installed or active.");
} else if (typeof operation !== "function") {
  ui.notifications.warn(`Unknown visible-light action: ${action}`);
} else if (!light) {
  ui.notifications.warn("Select an Ambient Light first.");
} else {
  try {
    await operation(light);
  } catch (error) {
    ui.notifications.error(error?.message ?? String(error));
  }
}
```

## Development installation

Clone this repository into Foundry's `Data/modules/theiks-toolbag` directory, restart
Foundry, and enable **Theik's Toolbag** from **Manage Modules** in your world.

## Release installation

Published releases can be installed using this manifest URL:

```text
https://github.com/Theik/theiks-toolbag/releases/latest/download/module.json
```
