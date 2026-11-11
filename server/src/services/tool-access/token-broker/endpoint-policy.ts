import { badRequest } from "../../../errors.js";
import { assertPublicRemoteHttpEndpoint, parseRemoteHttpEndpoint } from "../../remote-http-endpoint-guard.js";
import { type GuardedRemoteHttpFetchOptions } from "../../remote-http-fetch.js";
import { configuredTokenBrokerExchangeUrls } from "./configuration.js";
function normalizeTokenBrokerAllowedHost(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(
      trimmed.includes("://") ? trimmed : `http://${trimmed}`,
    );
    return (
      parsed.hostname
        .replace(/^\[|\]$/g, "")
        .replace(/\.$/, "")
        .toLowerCase() || null
    );
  } catch {
    // Invalid allowlist entries grant no access. The configured broker URL is
    // still evaluated under the public-only policy below.
    return null;
  }
}

function tokenBrokerAllowedPrivateHosts(): Set<string> {
  const configured = (process.env.PAPERCLIP_TOKEN_BROKER_ALLOWED_HOSTS ?? "")
    .split(/[,\s]+/)
    .map(normalizeTokenBrokerAllowedHost)
    .filter((host): host is string => host !== null);
  const pagesApiHost = normalizeTokenBrokerAllowedHost(
    process.env.PAPERCLIP_PAGES_API_URL ?? "",
  );
  if (pagesApiHost) configured.push(pagesApiHost);
  return new Set(configured);
}

function tokenBrokerAllowsPrivateNetwork(endpoint: URL): boolean {
  const hostname = endpoint.hostname
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .toLowerCase();
  return tokenBrokerAllowedPrivateHosts().has(hostname);
}

export function tokenBrokerHttpFetchOptions(
  endpoint: URL,
): GuardedRemoteHttpFetchOptions {
  return {
    allowPrivateNetwork: tokenBrokerAllowsPrivateNetwork(endpoint),
    error: (message, code) => badRequest(message, { code }),
  };
}

async function assertTokenBrokerHttpUrlAllowed(
  value: string,
): Promise<string> {
  const endpoint = parseRemoteHttpEndpoint(value, (message, code) =>
    badRequest(message, { code }),
  );
  await assertPublicRemoteHttpEndpoint(
    endpoint,
    { allowPrivateNetwork: tokenBrokerAllowsPrivateNetwork(endpoint) },
    (message, code) => badRequest(message, { code }),
  );
  return endpoint.toString();
}

export async function assertConfiguredTokenBrokerEndpointsAllowed(
  config: Record<string, unknown>,
): Promise<void> {
  for (const url of configuredTokenBrokerExchangeUrls(config)) {
    await assertTokenBrokerHttpUrlAllowed(url);
  }
}
