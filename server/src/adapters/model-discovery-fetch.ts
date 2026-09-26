import {
  guardedRemoteHttpFetch,
  type RemoteHttpSocketFactory,
} from "../services/remote-http-fetch.js";
import { parseRemoteHttpEndpoint } from "../services/remote-http-endpoint-guard.js";

const PRIVATE_ENDPOINT_ALLOWLIST_ENV = "PAPERCLIP_MODEL_DISCOVERY_PRIVATE_ENDPOINT_ALLOWLIST";

export class ModelDiscoveryEndpointError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "ModelDiscoveryEndpointError";
    this.code = code;
  }
}

function endpointError(message: string, code: string) {
  return new ModelDiscoveryEndpointError(
    message
      .replaceAll("Remote MCP connection", "Model discovery endpoint")
      .replaceAll("Remote MCP endpoint", "Model discovery endpoint"),
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

/**
 * Origins an operator has allowed model discovery to reach over a private
 * network. A self-hosted gateway usually lives on the LAN, so without this the
 * guard below would reject the very deployment this feature exists for. The
 * opt-in is per exact origin and operator-set, so an agent config can never
 * widen it.
 */
export function modelDiscoveryPrivateEndpointAllowlist(
  raw = process.env[PRIVATE_ENDPOINT_ALLOWLIST_ENV] ?? "",
): ReadonlySet<string> {
  return new Set(
    raw
      .split(",")
      .map((entry) => normalizeAllowlistedOrigin(entry.trim()))
      .filter((entry): entry is string => entry !== null),
  );
}

type ModelDiscoveryFetchOptions = {
  privateEndpointAllowlist?: ReadonlySet<string>;
  socketFactory?: RemoteHttpSocketFactory;
  unpinnedFetch?: typeof fetch;
};

/**
 * Build the `fetch` handed to adapter model discovery for an agent-scoped
 * endpoint.
 *
 * The endpoint comes from an agent's `adapterConfig.env`, so it is
 * caller-configured rather than operator-configured. The shared remote-HTTP
 * guard therefore applies: only http/https, no link-local metadata target,
 * no private address unless its exact origin is allowlisted, and the approved
 * DNS answer is pinned so a second resolution cannot rebind the connection.
 *
 * A rejected endpoint throws, which discovery already treats as "no catalog"
 * and reports as a fallback to the built-in model list.
 */
export function createModelDiscoveryFetch(
  options: ModelDiscoveryFetchOptions = {},
): typeof fetch {
  const allowlist = options.privateEndpointAllowlist ?? modelDiscoveryPrivateEndpointAllowlist();
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input.toString();
    const endpoint = parseRemoteHttpEndpoint(url, endpointError);
    return guardedRemoteHttpFetch(endpoint, init ?? {}, {
      allowPrivateNetwork: allowlist.has(endpoint.origin.toLowerCase()),
      error: endpointError,
      socketFactory: options.socketFactory,
      unpinnedFetch: options.unpinnedFetch,
    });
  }) as typeof fetch;
}
