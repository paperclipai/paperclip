const SILENCED_SUCCESS_METHODS = new Set(["GET", "HEAD"]);

const SILENCED_SUCCESS_API_PATHS = [
  /^\/api\/health(?:\/|$)/,
  /^\/api\/companies\/[^/]+\/activity(?:\/|$)/,
  /^\/api\/companies\/[^/]+\/dashboard(?:\/|$)/,
  /^\/api\/companies\/[^/]+\/heartbeat-runs(?:\/|$)/,
  /^\/api\/companies\/[^/]+\/issues(?:\/|$)/,
  /^\/api\/companies\/[^/]+\/live-runs(?:\/|$)/,
  /^\/api\/companies\/[^/]+\/sidebar-badges(?:\/|$)/,
  /^\/api\/heartbeat-runs\/[^/]+\/log(?:\/|$)/,
];

const SILENCED_SUCCESS_STATIC_PREFIXES = [
  "/@fs/",
  "/@id/",
  "/@react-refresh",
  "/@vite/",
  "/_plugins/",
  "/assets/",
  "/node_modules/",
  "/src/",
];

const SILENCED_SUCCESS_STATIC_PATHS = new Set([
  "/",
  "/index.html",
  "/favicon.ico",
  "/site.webmanifest",
  "/sw.js",
]);

function normalizePath(url: string): string {
  const trimmed = url.trim();
  if (trimmed.length === 0) return "/";
  const pathname = trimmed.split("?")[0]?.trim() ?? "/";
  return pathname.length > 0 ? pathname : "/";
}

export function shouldSilenceHttpSuccessLog(method: string | undefined, url: string | undefined, statusCode: number): boolean {
  if (statusCode >= 400) return false;
  if (statusCode === 304) return true;
  if (!method || !url) return false;
  if (!SILENCED_SUCCESS_METHODS.has(method.toUpperCase())) return false;

  const pathname = normalizePath(url);
  if (SILENCED_SUCCESS_STATIC_PATHS.has(pathname)) return true;
  if (SILENCED_SUCCESS_STATIC_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return true;
  return SILENCED_SUCCESS_API_PATHS.some((pattern) => pattern.test(pathname));
}

// Two board-UI request patterns generate a large, steady stream of *expected* 404s
// (~67% + ~33% of the 404 mix observed 2026-06-16, LUN-2659/LUN-2660):
//   1. GET /api/issues/<KEY>            — issue-mention hovercard prefetch on deleted/cross-company keys
//   2. GET /api/heartbeat-runs/<ID>/log — live-runs panel polling a run before its log exists
// The durable root-cause fix is in the UI bundle (negative-cache + poll-stop), but a
// server-side downgrade of just these two patterns to `debug` keeps the warn log readable
// even before/without the UI fix. The match is intentionally narrow — GET-only, 404-only,
// exact path shapes — so every OTHER 404 (real routes, sub-paths, non-GET, UUID lookups)
// stays at `warn`. Observability loss is precisely bounded to these two expected patterns.
const EXPECTED_CLIENT_404_GET_PATHS = [
  /^\/(?:api\/)?issues\/[A-Z][A-Z0-9]*-\d+$/,
  /^\/(?:api\/)?heartbeat-runs\/[^/]+\/log$/,
];

export function isExpectedClient404(method: string | undefined, url: string | undefined, statusCode: number): boolean {
  if (statusCode !== 404) return false;
  if (!method || !url) return false;
  if (method.toUpperCase() !== "GET") return false;

  const pathname = normalizePath(url);
  return EXPECTED_CLIENT_404_GET_PATHS.some((pattern) => pattern.test(pathname));
}
