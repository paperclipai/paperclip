export function hasPersistedSource(value: Buffer | undefined): boolean {
  return Boolean(value && value.length > 0);
}

/** A Stop boundary is valid only when both facts hold at the same observation. */
export function isSavedSourceCheckpoint(
  active: boolean,
  value: Buffer | undefined,
): boolean {
  return active && hasPersistedSource(value);
}
