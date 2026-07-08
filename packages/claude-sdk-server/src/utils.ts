export function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function parseObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function parseJson(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function resolvePathValue(data: Record<string, unknown>, path: string): string {
  const value = path.split(".").reduce<unknown>((current, part) => {
    if (typeof current !== "object" || current === null || Array.isArray(current)) return "";
    return (current as Record<string, unknown>)[part];
  }, data);
  if (value == null) return "";
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value)
    : "";
}

export function renderTemplate(template: string, data: Record<string, unknown>): string {
  return template.replace(/{{\s*([a-zA-Z0-9_.-]+)\s*}}/g, (_, path: string) => resolvePathValue(data, path));
}

export function joinPromptSections(
  sections: Array<string | null | undefined>,
  separator = "\n\n",
): string {
  return sections
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter(Boolean)
    .join(separator);
}

export function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
