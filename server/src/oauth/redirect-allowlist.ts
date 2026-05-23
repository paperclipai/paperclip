const ALLOWED_PREFIXES = ["/settings/", "/agents/", "/runs/"];
const SAFE_DEFAULT = "/settings/connections";

export function validateReturnUrl(url: string | undefined, publicUrl: string): string {
  if (!url || typeof url !== "string") return SAFE_DEFAULT;
  if (/^\s*[/\\]{2,}/.test(url)) return SAFE_DEFAULT;

  let parsed: URL;
  try {
    parsed = new URL(url, publicUrl);
  } catch {
    return SAFE_DEFAULT;
  }

  const expected = new URL(publicUrl);
  if (parsed.origin !== expected.origin) return SAFE_DEFAULT;
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return SAFE_DEFAULT;

  const allowed = ALLOWED_PREFIXES.some((p) => parsed.pathname.startsWith(p));
  if (!allowed) return SAFE_DEFAULT;

  return parsed.pathname + parsed.search + parsed.hash;
}
