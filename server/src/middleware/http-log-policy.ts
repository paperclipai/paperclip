const SILENCED_SUCCESS_API_PATHS = [
  /^\/api\/health(?:\/|$)/,
  /^\/api\/companies\/[^/]+\/heartbeat-runs(?:\/|$)/,
  /^\/api\/companies\/[^/]+\/live-runs(?:\/|$)/,
  /^\/api\/companies\/[^/]+\/sidebar-badges(?:\/|$)/,
  /^\/api\/heartbeat-runs\/[^/]+\/log(?:\/|$)/,
  /^\/api\/heartbeat-runs\/[^/]+\/log\/stream(?:\/|$)/,
];

const SILENCED_SUCCESS_STATIC_PREFIXES = [
  "/assets/",
  "/@vite/",
  "/@fs/",
  "/node_modules/",
  "/favicon.",
];

export function shouldSilenceHttpSuccessLog(method: string, url: string, statusCode: number): boolean {
  if (method !== "GET" && method !== "HEAD") return false;
  if (statusCode !== 200 && statusCode !== 304) return false;

  for (const pattern of SILENCED_SUCCESS_API_PATHS) {
    if (pattern.test(url)) return true;
  }

  for (const prefix of SILENCED_SUCCESS_STATIC_PREFIXES) {
    if (url.startsWith(prefix)) return true;
  }

  return false;
}
