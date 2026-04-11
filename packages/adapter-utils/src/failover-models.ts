export function parseFailoverModelList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return Array.from(
      new Set(
        value
          .filter((entry): entry is string => typeof entry === "string")
          .map((entry) => entry.trim())
          .filter(Boolean),
      ),
    );
  }

  if (typeof value !== "string") {
    return [];
  }

  return Array.from(
    new Set(
      value
        .split(/[\r\n,]+/)
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  );
}

export function serializeFailoverModelList(value: unknown): string {
  return parseFailoverModelList(value).join("\n");
}
