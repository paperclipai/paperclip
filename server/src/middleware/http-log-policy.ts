const SILENCED_SUCCESS_METHODS = new Set(["GET", "HEAD"]);

const SILENCED_SUCCESS_API_PATHS = [
  /^\/api\/muse\/v1\/signal$/i,
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

/**
 * A fixed label for the policy branch that made a request secret-sensitive.
 * Labels come from this closed list, never from the request URL.
 */
export type SecretSensitiveRouteFamily =
  | "provider_webhook"
  | "muse"
  | "mcp_files"
  | "agent_commentary"
  | "agent_observability"
  | "mcp_runner"
  | "agent_avatar"
  | "chat_slack_oauth"
  | "chat_endpoint_slack"
  | "voice_sessions"
  | "mcp_oauth"
  | "api_mcp"
  | "chat_endpoint_setup";

const SECRET_SENSITIVE_HTTP_PATHS: ReadonlyArray<readonly [SecretSensitiveRouteFamily, RegExp]> = [
  ["voice_sessions", /^\/api\/companies\/[^/]+\/voice-sessions(?:\/|$)/],
  ["mcp_oauth", /^\/mcp\/(?:oauth|paperclip)(?:\/|$)/],
  ["api_mcp", /^\/api\/mcp(?:\/|$)/],
  ["chat_endpoint_setup", /^\/api\/chat-endpoints\/[^/]+\/setup(?:-secret)?(?:\/|$)/],
];
const SECRET_SENSITIVE_HTTP_METHODS = new Set(["POST", "PUT", "PATCH"]);

/** Free-form agent feedback must never be copied into HTTP diagnostics. */
export function isPrivateAgentCommentaryHttpRequest(url: string | undefined): boolean {
  if (!url) return false;
  // Express routes are case-insensitive and also accept absolute-form URLs.
  const pathname = normalizePath(url).replace(/^https?:\/\/[^/]*/i, "");
  return /^\/api\/companies\/[^/]+\/agent-commentary(?:\/|$)/i.test(pathname);
}

/** Destination credentials stay private even on malformed settings requests. */
export function isPrivateAgentObservabilityHttpRequest(url: string | undefined): boolean {
  if (!url) return false;
  const pathname = normalizePath(url).replace(/^https?:\/\/[^/]*/i, "");
  return /^\/api\/companies\/[^/]+\/observability(?:\/|$)/i.test(pathname);
}

/** Muse OAuth and worker payloads stay private even on malformed/rejected paths. */
export function isPrivateMuseHttpRequest(url:string|undefined):boolean {
  if(!url)return false;
  let pathname=normalizePath(url).replace(/^https?:\/\/[^/]*/i, "");
  for(let depth=0;depth<4;depth++) {
    if(/^\/api\/muse(?:\/|$)/i.test(pathname) || /^\/api\/companies\/[^/]+\/(?:muse-invitations|agents\/[^/]+\/muse-binding)(?:\/|$)/i.test(pathname))return true;
    try {const decoded=decodeURIComponent(pathname);if(decoded===pathname)break;pathname=decoded;} catch {break;}
  }
  return false;
}

/** Provider payloads are private even when a method/signature is rejected. */
export function isPrivateWebhookHttpRequest(
  method: string | undefined,
  url: string | undefined,
): boolean {
  if (!method || !url) return false;
  let pathname = normalizePath(url);
  if (/^https?:\/\//i.test(pathname)) {
    // Do not let URL dot-segment normalization erase an explicitly supplied
    // ingress namespace on a malformed absolute-form callback.
    const rawPath = pathname.replace(/^https?:\/\/[^/]*/i, "");
    if (/^\/api\/(?:chat-webhooks|voice-webhooks|routine-triggers\/public)(?:\/|$)/i.test(rawPath)) return true;
    try {
      pathname = new URL(url).pathname;
    } catch {
      return false;
    }
  }
  // This namespace is reserved for provider ingress, including malformed or
  // unknown callback paths. Rejecting a route must not make its payload public.
  return /^\/api\/(?:chat-webhooks|voice-webhooks|routine-triggers\/public)(?:\/|$)/i.test(pathname);
}

/**
 * These routes accept or create one-time connector credentials. A provider or
 * validation error can echo credential material in its message even after the
 * structured request body has been redacted, so HTTP failure logs use generic
 * error metadata for the whole route. Webhook failures also use generic error
 * metadata: raw provider text/files/credentials cannot be named-field redacted.
 */
export function isSecretSensitiveHttpRequest(
  method: string | undefined,
  url: string | undefined,
): boolean {
  return secretSensitiveRouteFamily(method, url) !== null;
}

/** The policy branch that makes a request secret-sensitive, or `null`. */
export function secretSensitiveRouteFamily(
  method: string | undefined,
  url: string | undefined,
): SecretSensitiveRouteFamily | null {
  if (isPrivateWebhookHttpRequest(method, url)) return "provider_webhook";
  if (isPrivateMuseHttpRequest(url)) return "muse";
  if (url && normalizePath(url).startsWith("/mcp/files/")) return "mcp_files";
  if (isPrivateAgentCommentaryHttpRequest(url)) return "agent_commentary";
  // Custom OTLP header values are arbitrary credentials, including on rejected
  // methods or malformed subpaths. Named-field redaction cannot identify them.
  if (isPrivateAgentObservabilityHttpRequest(url)) return "agent_observability";
  // Avatar uploads and dedicated Dot MCP calls may contain private image bytes.
  if (url && /^\/mcp\/runner(?:\/|$)/i.test(normalizePath(url).replace(/^https?:\/\/[^/]*/i, ""))) return "mcp_runner";
  if (url && /^\/api\/companies\/[^/]+\/agents\/[^/]+\/avatar(?:\/|$)/i.test(normalizePath(url).replace(/^https?:\/\/[^/]*/i, ""))) return "agent_avatar";
  if (!method || !url) return null;
  if (/^\/api\/chat-slack\/(?:managed\/)?oauth(?:\/|$)/i.test(normalizePath(url).replace(/^https?:\/\/[^/]*/i, ""))) return "chat_slack_oauth";
  if (/^\/api\/chat-endpoints\/[^/]+\/slack(?:\/|$)/i.test(normalizePath(url).replace(/^https?:\/\/[^/]*/i, ""))) return "chat_endpoint_slack";
  if (!SECRET_SENSITIVE_HTTP_METHODS.has(method.toUpperCase())) return null;
  const pathname = normalizePath(url);
  return SECRET_SENSITIVE_HTTP_PATHS.find(([, pattern]) => pattern.test(pathname))?.[0] ?? null;
}

export function shouldSilenceHttpSuccessLog(
  method: string | undefined,
  url: string | undefined,
  statusCode: number,
): boolean {
  if (statusCode >= 400) return false;
  if (statusCode === 304) return true;
  if (!method || !url) return false;
  if (!SILENCED_SUCCESS_METHODS.has(method.toUpperCase())) return false;

  const pathname = normalizePath(url);
  if (SILENCED_SUCCESS_STATIC_PATHS.has(pathname)) return true;
  if (
    SILENCED_SUCCESS_STATIC_PREFIXES.some((prefix) =>
      pathname.startsWith(prefix),
    )
  )
    return true;
  return SILENCED_SUCCESS_API_PATHS.some((pattern) => pattern.test(pathname));
}
