import {
  guardedRemoteHttpFetch,
  type GuardedRemoteHttpFetchOptions,
} from "../../services/remote-http-fetch.js";
import { parseRemoteHttpEndpoint } from "../../services/remote-http-endpoint-guard.js";

const PRIVATE_ENDPOINT_ALLOWLIST_ENV = "PAPERCLIP_HTTP_ADAPTER_PRIVATE_ENDPOINT_ALLOWLIST";

export class HttpAdapterEndpointError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "HttpAdapterEndpointError";
    this.code = code;
  }
}

function endpointError(message: string, code: string) {
  return new HttpAdapterEndpointError(
    message
      .replaceAll("Remote MCP connection", "HTTP adapter endpoint")
      .replaceAll("Remote MCP endpoint", "HTTP adapter endpoint"),
    code,
  );
}

function normalizeAllowlistedOrigin(value: string): string | null {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    return null;
  }
  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") return null;
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) return null;
  if (endpoint.pathname !== "/") return null;
  return endpoint.origin.toLowerCase();
}

export function httpAdapterPrivateEndpointAllowlist(
  raw = process.env[PRIVATE_ENDPOINT_ALLOWLIST_ENV] ?? "",
): ReadonlySet<string> {
  return new Set(
    raw
      .split(",")
      .map((entry) => normalizeAllowlistedOrigin(entry.trim()))
      .filter((entry): entry is string => entry !== null),
  );
}

type HttpAdapterFetchOptions = Omit<
  GuardedRemoteHttpFetchOptions,
  "allowPrivateNetwork" | "error"
> & {
  privateEndpointAllowlist?: ReadonlySet<string>;
};

/**
 * Guard every HTTP-adapter request at the actual socket boundary. Public
 * endpoints are allowed by default. An exact operator-configured origin can
 * opt into private networking, while the shared guard continues to reject
 * link-local metadata targets and pins DNS results to prevent rebinding.
 */
export async function guardedHttpAdapterFetch(
  url: string | URL,
  init: RequestInit,
  options: HttpAdapterFetchOptions = {},
): Promise<Response> {
  const endpoint = parseRemoteHttpEndpoint(url.toString(), endpointError);
  const allowlist = options.privateEndpointAllowlist ?? httpAdapterPrivateEndpointAllowlist();
  return guardedRemoteHttpFetch(endpoint, init, {
    ...options,
    allowPrivateNetwork: allowlist.has(endpoint.origin.toLowerCase()),
    error: endpointError,
  });
}
