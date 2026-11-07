export function deepFreezeProtocolAction<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreezeProtocolAction(nested);
    }
    Object.freeze(value);
  }
  return value;
}
