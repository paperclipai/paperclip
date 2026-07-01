/**
 * HTTP (multi-tenant) authentication for the Paperclip MCP server.
 *
 * A caller presents a bearer token; the token is resolved via SSM to a binding
 * of `{ companyId, agentId, apiKey }` and combined with the server-fixed
 * control-plane URL to produce a per-request {@link PaperclipMcpConfig}.
 */
import {
  TokenBindingError,
  UnauthorizedError,
  createSsmTokenAuthenticator,
  type SsmParameterReader,
} from "@paperclipai/mcp-transport";
import { readServerApiUrl, type PaperclipMcpConfig } from "./config.js";

/** Default SSM parameter path prefix for MCP HTTP tokens. */
export const DEFAULT_TOKEN_PREFIX = "/paperclip/mcp/tokens";

function bindingString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Parse an optional token expiry. Accepts an ISO 8601 string (preferred) or an
 * epoch-milliseconds number, and returns the expiry as epoch ms — or null when
 * absent (a non-expiring token). Throws {@link TokenBindingError} for a present
 * but unparseable value so a malformed expiry fails closed rather than being
 * silently ignored.
 */
function parseExpiry(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const ms = Date.parse(value.trim());
    if (!Number.isNaN(ms)) return ms;
  }
  throw new TokenBindingError("Token binding has an invalid expiresAt");
}

export interface HttpAuthenticatorOptions {
  env?: NodeJS.ProcessEnv;
  /** Override the SSM reader (native SDK in prod, stub in tests). */
  readParameter?: SsmParameterReader;
  /** Clock for expiry checks (epoch ms). Injectable for tests; defaults to Date.now. */
  now?: () => number;
}

/**
 * Build the request → {@link PaperclipMcpConfig} authenticator for --http mode,
 * enforcing the MCP HTTP token policy (see docs/mcp-token-policy.md):
 *
 *   - `apiKey` is required.
 *   - `companyId` is required — an HTTP token is scoped to exactly one company
 *     (single-company scope); it can never act across companies.
 *   - `expiresAt` (optional ISO 8601 string or epoch ms) is enforced: a token
 *     at or past its expiry is rejected as unauthorized. This is the mechanism
 *     behind TTLs and revocation-by-expiry.
 *   - The control-plane `apiUrl` is pinned by the server env (`PAPERCLIP_API_URL`)
 *     and never taken from the token, so a token cannot redirect calls elsewhere.
 */
export function createPaperclipHttpAuthenticator(options: HttpAuthenticatorOptions = {}) {
  const env = options.env ?? process.env;
  const apiUrl = readServerApiUrl(env);
  const paramPrefix = bindingString(env.PAPERCLIP_MCP_TOKEN_PREFIX) ?? DEFAULT_TOKEN_PREFIX;
  const now = options.now ?? Date.now;

  return createSsmTokenAuthenticator<PaperclipMcpConfig>({
    paramPrefix,
    readParameter: options.readParameter,
    toConfig: (binding) => {
      const apiKey = bindingString(binding.apiKey);
      if (!apiKey) {
        throw new TokenBindingError("Token binding missing required field: apiKey");
      }
      const companyId = bindingString(binding.companyId);
      if (!companyId) {
        throw new TokenBindingError("Token binding missing required field: companyId");
      }
      const expiresAt = parseExpiry(binding.expiresAt);
      if (expiresAt !== null && now() >= expiresAt) {
        throw new UnauthorizedError("Unauthorized: Token expired");
      }
      return {
        apiUrl,
        apiKey,
        companyId,
        agentId: bindingString(binding.agentId),
        runId: bindingString(binding.runId),
      };
    },
  });
}
