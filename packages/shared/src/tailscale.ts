/**
 * Tailscale connector contract shared by the server and the board UI.
 *
 * The connector is a server-side REST credential: the OAuth client lives in the
 * instance vault, the server exchanges it for short-lived API tokens, and no
 * agent-facing tool is exposed in this version. See doc/connections/TAILSCALE.md.
 */
export const TAILSCALE_APP_SLUG = "tailscale";
export const TAILSCALE_METHOD_KEY = "oauth-client";
export const TAILSCALE_API_URL = "https://api.tailscale.com/api/v2";
/** `-` asks the API for the tailnet that owns the authenticated OAuth client. */
export const TAILSCALE_DEFAULT_TAILNET = "-";
export const TAILSCALE_DEFAULT_AGENT_TAG = "tag:paperclip-agent";
/** Lifetime of the one-off ephemeral key minted by the health check. */
export const TAILSCALE_TEST_KEY_EXPIRY_SECONDS = 300;

/** Scopes that let the client read the tailnet device list. */
export const TAILSCALE_DEVICE_READ_SCOPES = ["all", "all:read", "devices", "devices:core", "devices:core:read"] as const;
/** Scopes that let the client mint and delete auth keys. */
export const TAILSCALE_AUTH_KEY_WRITE_SCOPES = ["all", "auth_keys"] as const;

export const TAILSCALE_HEALTH_CODES = [
  "tailscale_client_invalid",
  "tailscale_scope_devices_missing",
  "tailscale_scope_auth_keys_missing",
  "tailscale_tag_not_owned",
  "tailscale_tailnet_not_found",
  "tailscale_rate_limited",
  "tailscale_unreachable",
  "tailscale_test_key_cleanup_failed",
  "tailscale_request_failed",
  "tailscale_connection_changed",
] as const;
export type TailscaleHealthCode = (typeof TAILSCALE_HEALTH_CODES)[number];

/** Redacted summary persisted on the connection after a successful check. */
export interface TailscaleConnectionHealth {
  tailnet: string;
  /** Scopes granted to the token, as reported by the token endpoint. */
  scopes: string[];
  /** Tags the client was able to assign to a test key. */
  tags: string[];
  deviceCount: number;
  checkedAt: string;
  /**
   * Hash of the settings and vault secret versions the check used. The server
   * reuses a recent summary only while this still matches the connection.
   */
  probeFingerprint?: string;
}

export function tailscaleScopeCovers(scopes: readonly string[], accepted: readonly string[]): boolean {
  return scopes.some((scope) => accepted.includes(scope));
}
