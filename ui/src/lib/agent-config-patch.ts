function hasOwn(value: object, key: string) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function buildEditedAgentAdapterConfig(
  existing: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const merged = { ...existing, ...patch };

  // Clearing env from the editor currently becomes `undefined`. Preserve an
  // explicit empty object so JSON serialization does not drop the key and
  // accidentally keep the old persisted environment.
  if (hasOwn(patch, "env") && patch.env === undefined) {
    merged.env = {};
  }

  return merged;
}
