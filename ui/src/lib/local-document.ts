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

export const DOCUMENT_OPENER_BASE_URL = "http://127.0.0.1:19327";

export type DocumentOpenerStatus = "ready" | "unavailable";

async function callOpener(route: "open" | "reveal", path: string): Promise<void> {
  const normalized = normalizeLocalPath(path);
  let res: Response;
  try {
    res = await fetch(`${DOCUMENT_OPENER_BASE_URL}/${route}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: normalized }),
    });
  } catch (err) {
    throw new Error(
      `Document-Opener nicht erreichbar (${(err as Error).message}). Läuft der Helper-Service?`,
    );
  }
  if (!res.ok) {
    let errorMsg = `${route} failed (HTTP ${res.status})`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) errorMsg = body.error;
    } catch {
      // body wasn't JSON; keep the generic message
    }
    throw new Error(errorMsg);
  }
}

export function openDocument(path: string): Promise<void> {
  return callOpener("open", path);
}

export function revealDocument(path: string): Promise<void> {
  return callOpener("reveal", path);
}

export async function documentOpenerHealth(): Promise<DocumentOpenerStatus> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(`${DOCUMENT_OPENER_BASE_URL}/health`, {
      signal: controller.signal,
    });
    clearTimeout(timer);
    return res.status === 200 ? "ready" : "unavailable";
  } catch {
    return "unavailable";
  }
}
