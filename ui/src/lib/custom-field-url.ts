const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

export function sanitizeCustomFieldUrl(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) return null;
    return parsed.href;
  } catch {
    return null;
  }
}
