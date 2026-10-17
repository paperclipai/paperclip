/** Qoder clones over http(s) only; returns null for anything it cannot clone. */
export function parseHttpRepoUrl(raw: string): URL | null {
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    // "https://host" parses but names no repository.
    return url.hostname && url.pathname.split("/").filter(Boolean).length > 0 ? url : null;
  } catch {
    return null;
  }
}
