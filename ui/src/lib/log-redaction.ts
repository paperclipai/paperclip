function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeHomePathSeparators(value: string): string[] {
  const normalized = value.replace(/\\/g, "/");
  if (!normalized) return [];
  const variants = new Set<string>([value, normalized]);
  if (!normalized.endsWith("/")) {
    variants.add(`${normalized}/`);
  }
  return Array.from(variants).filter(Boolean);
}

function replaceCurrentUserLabel(value: string, currentUserId: string | null | undefined): string {
  if (!currentUserId || !value.includes(currentUserId)) return value;
  const escaped = escapeRegExp(currentUserId);
  return value.replace(new RegExp(`\\b${escaped}\\b`, "g"), "current user");
}

function redactGenericHomePaths(value: string): string {
  return value
    .replace(/\/Users\/[^/\s]+\/?/g, (match) => (match.endsWith("/") ? "~/" : "~"))
    .replace(/\/home\/[^/\s]+\/?/g, (match) => (match.endsWith("/") ? "~/" : "~"))
    .replace(/[A-Za-z]:\\Users\\[^\\\s]+\\?/g, (match) => (match.endsWith("\\") ? "~\\" : "~"))
    .replace(/[A-Za-z]:\/Users\/[^/\s]+\/?/g, (match) => (match.endsWith("/") ? "~/" : "~"));
}

export function redactOperatorFacingText(
  value: string,
  options?: { homeDir?: string | null; currentUserId?: string | null },
): string {
  let redacted = redactGenericHomePaths(replaceCurrentUserLabel(value, options?.currentUserId));
  const homeDir = options?.homeDir?.trim();
  if (!homeDir) return redacted;

  for (const variant of normalizeHomePathSeparators(homeDir)) {
    redacted = redacted.split(variant).join(variant.endsWith("/") ? "~/" : "~");
  }

  return redacted;
}

export function redactOperatorFacingUnknown<T>(
  value: T,
  options?: { homeDir?: string | null; currentUserId?: string | null },
): T {
  if (typeof value === "string") {
    return redactOperatorFacingText(value, options) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactOperatorFacingUnknown(item, options)) as T;
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  const nextEntries = Object.entries(value as Record<string, unknown>).map(([key, entryValue]) => [
    key,
    redactOperatorFacingUnknown(entryValue, options),
  ]);
  return Object.fromEntries(nextEntries) as T;
}
