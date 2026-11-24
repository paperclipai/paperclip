const FALLBACK_BASE = "https://paperclip.invalid/";

function currentBase(): string {
  return typeof window !== "undefined" && window.location?.href ? window.location.href : FALLBACK_BASE;
}

function isHttpProtocol(protocol: string): boolean {
  return protocol === "http:" || protocol === "https:";
}

function hasScheme(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(value.replace(/[\t\n\r]/g, ""));
}

export function safeNavigableUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/[\u0000-\u001f]/.test(trimmed)) return null;
  try {
    const url = new URL(trimmed, currentBase());
    return isHttpProtocol(url.protocol) ? trimmed : null;
  } catch {
    return null;
  }
}

export function safeExternalHttpUrl(value: unknown): string | null {
  const safe = safeNavigableUrl(value);
  return safe && hasScheme(safe) ? safe : null;
}

export function openSafeUrl(value: unknown): boolean {
  const safe = safeNavigableUrl(value);
  if (!safe) return false;
  window.open(safe, "_blank", "noopener,noreferrer");
  return true;
}
