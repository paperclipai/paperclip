const LOCAL_PATH_PATTERNS = [
  /^\/Users\//,       // macOS user home
  /^\/Volumes\//,     // macOS mounted volumes
  /^~\//,             // tilde (any OS)
  /^file:\/\/\//,     // file:// URLs (all platforms)
  /^[a-zA-Z]:[\\/]/, // Windows drive letter: C:\ or C:/
  /^\\\\[^\\]/,       // Windows UNC: \\server\share
];

export function isLocalFileHref(href: string): boolean {
  if (!href) return false;
  return LOCAL_PATH_PATTERNS.some((re) => re.test(href));
}

export function normalizeLocalPath(href: string): string {
  let value = href;

  if (value.startsWith("file:///")) {
    value = value.slice("file:///".length);
    // For Windows drive-letter forms, the result is "C:/foo/x.md"
    // For POSIX, prepend the slash we just stripped
    if (!/^[a-zA-Z]:/.test(value)) {
      value = "/" + value;
    }
  } else if (value.startsWith("file://")) {
    value = value.slice("file://".length);
  }

  try {
    value = decodeURIComponent(value);
  } catch {
    // leave as-is on malformed percent-encoding
  }

  return value;
}
