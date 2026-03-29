export function readQueryString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const first = value.find((entry): entry is string => typeof entry === "string");
    return first;
  }
  return undefined;
}
