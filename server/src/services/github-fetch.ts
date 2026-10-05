import { HttpError, unprocessable } from "../errors.js";
import { parsePrivateEndpointAllowlist, parseRemoteHttpEndpoint } from "./remote-http-endpoint-guard.js";
import { guardedRemoteHttpFetch, type GuardedRemoteHttpFetchOptions } from "./remote-http-fetch.js";

const PRIVATE_ENDPOINT_ALLOWLIST_ENV = "PAPERCLIP_GITHUB_PRIVATE_ENDPOINT_ALLOWLIST";

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
 * - never follows a redirect, so a `Location` pointing at an internal address is
 *   a failed fetch rather than an unguarded second hop, and an authorization
 *   header this request carries cannot be replayed to another origin.
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
  const endpoint = parseRemoteHttpEndpoint(url, endpointError);
  const allowlist = options.privateEndpointAllowlist ?? gitHubPrivateEndpointAllowlist();
  try {
    return await guardedRemoteHttpFetch(endpoint, init ?? {}, {
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
}
