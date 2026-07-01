/**
 * HTTP (multi-tenant) authentication for the Paperclip MCP server.
 *
 * A caller presents a bearer token; the token is resolved via SSM to a binding
 * of `{ companyId, agentId, apiKey }` and combined with the server-fixed
 * control-plane URL to produce a per-request {@link PaperclipMcpConfig}.
 */
import {
  TokenBindingError,
  createSsmTokenAuthenticator,
  type SsmParameterReader,
} from "@paperclipai/mcp-transport";
import { readServerApiUrl, type PaperclipMcpConfig } from "./config.js";

/** Default SSM parameter path prefix for MCP HTTP tokens. */
export const DEFAULT_TOKEN_PREFIX = "/paperclip/mcp/tokens";

function bindingString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export interface HttpAuthenticatorOptions {
  env?: NodeJS.ProcessEnv;
  /** Override the SSM reader (native SDK in prod, stub in tests). */
  readParameter?: SsmParameterReader;
}

/**
 * Build the request → {@link PaperclipMcpConfig} authenticator for --http mode.
 *
 * The SSM binding must supply `apiKey`. `companyId`/`agentId`/`runId` are
 * optional here (a tool call may still pass them explicitly), mirroring the
 * env-scoped stdio config. The control-plane `apiUrl` is pinned by the server
 * env (`PAPERCLIP_API_URL`) and never taken from the token.
 */
export function createPaperclipHttpAuthenticator(options: HttpAuthenticatorOptions = {}) {
  const env = options.env ?? process.env;
  const apiUrl = readServerApiUrl(env);
  const paramPrefix = bindingString(env.PAPERCLIP_MCP_TOKEN_PREFIX) ?? DEFAULT_TOKEN_PREFIX;

  return createSsmTokenAuthenticator<PaperclipMcpConfig>({
    paramPrefix,
    readParameter: options.readParameter,
    toConfig: (binding) => {
      const apiKey = bindingString(binding.apiKey);
      if (!apiKey) {
        throw new TokenBindingError("Token binding missing required field: apiKey");
      }
      return {
        apiUrl,
        apiKey,
        companyId: bindingString(binding.companyId),
        agentId: bindingString(binding.agentId),
        runId: bindingString(binding.runId),
      };
    },
  });
}
