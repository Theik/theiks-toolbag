const inProgress = new Set();

/** Return a stable Scene-local key shared by every Tile state subsystem. */
export function getTileTransitionKey(tile) {
  return tile?.uuid ?? `${tile?.parent?.id ?? "scene"}.${tile?.id ?? "tile"}`;
}

/** Attempt to reserve a Tile for one state transition. */
export function acquireTileTransition(tile) {
  const key = getTileTransitionKey(tile);
  if (inProgress.has(key)) return null;
  inProgress.add(key);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    inProgress.delete(key);
  };
}
