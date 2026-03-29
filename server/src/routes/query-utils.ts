export function readQueryString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const strings = value.filter((entry): entry is string => typeof entry === "string");
    if (strings.length === 0) return undefined;
    const firstNonEmpty = strings.find((entry) => entry.trim().length > 0);
    return firstNonEmpty ?? strings[0];
  }
  return undefined;
}
