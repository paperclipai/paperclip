/**
 * Field-level merge for the company plugin config. Each settings card owns a
 * subset of the fields and saves only those on top of the freshly stored
 * config, so one card's save never restores another card's stale copy.
 * A field set to `undefined` is removed (Disconnect clears `botToken`).
 */
export type ConfigPatch = object;

export function applyConfigPatch<T extends object>(base: T, patch: ConfigPatch): T {
  const next: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete next[key];
    else next[key] = value;
  }
  return next as T;
}
