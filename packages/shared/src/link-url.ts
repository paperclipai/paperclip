const HTTP_PROTOCOLS = new Set(["http:", "https:"]);
const APPLE_NOTES_NATIVE_PROTOCOLS = new Set([
  "applenotes:",
  "mobilenotes:",
  "notes:",
  "x-apple-notes:",
]);
const ICLOUD_NOTES_HOSTS = new Set([
  "icloud.com",
  "www.icloud.com",
  "icloud.com.cn",
  "www.icloud.com.cn",
]);

export const STORED_LINK_URL_MAX_LENGTH = 2048;

function parseUrl(value: string) {
  try {
    return new URL(value.trim());
  } catch {
    return null;
  }
}

export function isHttpUrl(value: string) {
  const parsed = parseUrl(value);
  return parsed ? HTTP_PROTOCOLS.has(parsed.protocol.toLowerCase()) : false;
}

export function isAppleNotesDeepLinkUrl(value: string) {
  const parsed = parseUrl(value);
  if (!parsed) return false;
  return APPLE_NOTES_NATIVE_PROTOCOLS.has(parsed.protocol.toLowerCase());
}

export function isAppleNotesICloudUrl(value: string) {
  const parsed = parseUrl(value);
  if (!parsed || !HTTP_PROTOCOLS.has(parsed.protocol.toLowerCase())) return false;
  const hostname = parsed.hostname.toLowerCase();
  const pathname = parsed.pathname.toLowerCase();
  return ICLOUD_NOTES_HOSTS.has(hostname) && (pathname === "/notes" || pathname.startsWith("/notes/"));
}

export function isAppleNotesLinkUrl(value: string) {
  return isAppleNotesDeepLinkUrl(value) || isAppleNotesICloudUrl(value);
}

export function isAllowedStoredLinkUrl(value: string) {
  return isHttpUrl(value) || isAppleNotesDeepLinkUrl(value);
}

export function deriveExternalLinkTitle(value: string) {
  if (isAppleNotesLinkUrl(value)) return "Apple Note";
  const parsed = parseUrl(value);
  if (!parsed) return value;
  return parsed.hostname.replace(/^www\./i, "") || value;
}
