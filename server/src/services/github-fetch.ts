import { HttpError, unprocessable } from "../errors.js";
import { parsePrivateEndpointAllowlist, parseRemoteHttpEndpoint } from "./remote-http-endpoint-guard.js";
import { guardedRemoteHttpFetch, type GuardedRemoteHttpFetchOptions } from "./remote-http-fetch.js";

const PRIVATE_ENDPOINT_ALLOWLIST_ENV = "PAPERCLIP_GITHUB_PRIVATE_ENDPOINT_ALLOWLIST";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * GitHub chains at most two hops on the reads this server makes — a rename
 * followed by the handoff to the asset host. Five leaves room for an
 * Enterprise instance behind a reverse proxy without letting a remote server
 * walk this process round a loop.
 */
const MAX_REDIRECTS = 5;

/** Headers a hop to another origin must not carry. */
const CREDENTIAL_HEADERS = ["authorization", "cookie", "proxy-authorization"];

export function isGitHubDotCom(hostname: string) {
  const h = hostname.toLowerCase();
  return h === "github.com" || h === "www.github.com";
}

export function gitHubApiBase(hostname: string) {
  return isGitHubDotCom(hostname) ? "https://api.github.com" : `https://${hostname}/api/v3`;
}

export function resolveRawGitHubUrl(hostname: string, owner: string, repo: string, ref: string, filePath: string) {
  const p = filePath.replace(/^\/+/, "");
  return isGitHubDotCom(hostname)
    ? `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${p}`
    : `https://${hostname}/raw/${owner}/${repo}/${ref}/${p}`;
}

export type GitHubFetchOptions = Pick<
  GuardedRemoteHttpFetchOptions,
  "lookup" | "dnsTimeoutMs" | "socketFactory" | "connectTimeoutMs" | "responseTimeoutMs" | "unpinnedFetch"
> & {
  /** Exact origins an operator has declared reachable on a private network. */
  privateEndpointAllowlist?: ReadonlySet<string>;
};

function endpointError(message: string, code: string) {
  return unprocessable(
    message
      .replaceAll("Remote MCP connection requires config.url", "GitHub source URL is missing")
      .replaceAll("Remote MCP connection", "GitHub source")
      .replaceAll("Remote MCP endpoint", "GitHub source"),
    { code },
  );
}

/**
 * Origins an operator has declared reachable even though they resolve onto a
 * private network — a GitHub Enterprise instance inside the deployment's own
 * network being the case this exists for. Anything that is not a bare
 * `scheme://host[:port]` origin is dropped.
 */
export function gitHubPrivateEndpointAllowlist(
  raw = process.env[PRIVATE_ENDPOINT_ALLOWLIST_ENV] ?? "",
): ReadonlySet<string> {
  return parsePrivateEndpointAllowlist(raw);
}

/**
 * Fetch a GitHub or GitHub Enterprise URL whose hostname a caller supplied.
 *
 * Every hostname that reaches here came from content someone typed: a skill
 * import source, a catalog origin, a portable-company bundle. The server is the
 * one that resolves it and connects, so an unguarded fetch turns that hostname
 * into an instruction to the server to request anything it can see — a service
 * on the private network behind it, or a cloud metadata endpoint — and returns
 * the body to the caller. The shared remote-HTTP guard:
 *
 * - refuses private, reserved and link-local destinations;
 * - resolves the hostname once and dials the address it approved, so the socket
 *   layer cannot be handed a different answer a moment later; and
 * - hands a redirect back instead of following it.
 *
 * GitHub does redirect on reads this server makes — a renamed owner or
 * repository answers the API with a 301, and release and archive downloads are
 * handed off to another host — so refusing to follow one would break imports
 * that work today. This function follows them itself, putting every hop through
 * the same guard as the first, and dropping credentials when a hop leaves the
 * origin they were issued for. A `Location` pointing at an internal address is
 * therefore a failed fetch, not an unguarded second request.
 *
 * A deployment whose GitHub Enterprise instance genuinely sits on a private
 * network names that one origin in
 * `PAPERCLIP_GITHUB_PRIVATE_ENDPOINT_ALLOWLIST`.
 */
export async function ghFetch(
  url: string,
  init?: RequestInit,
  options: GitHubFetchOptions = {},
): Promise<Response> {
  const allowlist = options.privateEndpointAllowlist ?? gitHubPrivateEndpointAllowlist();
  let endpoint = parseRemoteHttpEndpoint(url, endpointError);
  let request: RequestInit = init ?? {};

  for (let hop = 0; ; hop += 1) {
    let response: Response;
    try {
      response = await guardedRemoteHttpFetch(endpoint, request, {
        ...options,
        allowPrivateNetwork: allowlist.has(endpoint.origin.toLowerCase()),
        error: endpointError,
      });
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw unprocessable(
        `Could not connect to ${endpoint.hostname} — ensure the URL points to a GitHub or GitHub Enterprise instance`,
      );
    }

    const location = isRedirect(response.status) ? response.headers.get("location") : null;
    if (location === null) return response;
    if (request.redirect === "manual") return response;
    if (request.redirect === "error") {
      throw unprocessable(`${endpoint.href} redirected and this request does not follow redirects`, {
        code: "github_redirect_refused",
      });
    }
    if (hop >= MAX_REDIRECTS) {
      throw unprocessable(`Too many redirects fetching ${endpoint.href}`, {
        code: "github_too_many_redirects",
      });
    }

    let target: URL;
    try {
      target = new URL(location, endpoint);
    } catch {
      throw unprocessable(`${endpoint.href} redirected to an unreadable location`, {
        code: "github_invalid_redirect",
      });
    }
    // The hop is a fresh caller-supplied URL as far as the guard is concerned:
    // it comes from the remote server, not from us. Re-parsing rejects a
    // `file:` or `gopher:` scheme before anything is dialled.
    const next = parseRemoteHttpEndpoint(target.href, endpointError);
    // The body is never read on a hop; releasing it closes the socket rather
    // than leaving it held open until the garbage collector runs.
    await response.body?.cancel().catch(() => {});
    request = redirectedRequest(request, response.status, endpoint, next);
    endpoint = next;
  }
}

function isRedirect(status: number): boolean {
  return REDIRECT_STATUSES.has(status);
}

/**
 * Build the follow-up request, matching what the platform `fetch` would have
 * done before this guard took over:
 *
 * - 303 always becomes a GET, and so does a 301 or 302 on a POST, because that
 *   is what every HTTP client has done since long before the specification
 *   caught up with them; the body goes with the method.
 * - 307 and 308 keep the method and the body, which is the point of them.
 * - credentials are stripped when the hop leaves the origin that issued them,
 *   so a `Location` an attacker controls cannot collect a GitHub token.
 */
function redirectedRequest(init: RequestInit, status: number, from: URL, to: URL): RequestInit {
  const method = (init.method ?? "GET").toUpperCase();
  const next: RequestInit = { ...init };

  if (status === 303 || ((status === 301 || status === 302) && method === "POST")) {
    next.method = "GET";
    delete next.body;
  }

  if (from.origin.toLowerCase() !== to.origin.toLowerCase()) {
    next.headers = withoutCredentialHeaders(init.headers);
  }

  return next;
}

function withoutCredentialHeaders(headers: HeadersInit | undefined): HeadersInit {
  const kept = new Headers(headers);
  for (const name of CREDENTIAL_HEADERS) kept.delete(name);
  return kept;
}
