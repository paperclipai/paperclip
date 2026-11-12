import { Client } from "../../../server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StreamableHTTPClientTransport } from "../../../server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
import type { ProviderBinding } from "./external-fixtures.js";
import { selectedExternalCredential } from "./external-fixtures.js";
import { assertNotionConnection } from "./external-notion-provider.js";
import { notionSelfWorkspaceMatches } from "./external-notion-oauth-contract.js";
/** Exact selected official read-only MCP probe. Never stores raw account/tool
 * output, and never supplies a refresh client or performs provider discovery. */
export async function probeNotionAuthorization(
  ctx: ChatCatalogContext,
  binding: ProviderBinding,
) {
  assertNotionConnection(binding);
  const token = selectedExternalCredential(
    ctx,
    binding,
    "expiredAuthorizationEnv",
  );
  let denied = false,
    calls = 0;
  const client = new Client({
    name: "paperclip-notion-expiry-control",
    version: "1.0.0",
  });
  client.onerror = () => undefined;
  const transport = new StreamableHTTPClientTransport(
    new URL(binding.prerequisites.mcpUrl!),
    {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
      fetch: async (url, init) => {
        const target = new URL(String(url));
        if (target.href !== "https://mcp.notion.com/mcp" || ++calls > 5)
          throw new Error(
            "Notion expiry probe exceeded fixed resource/request bounds",
          );
        const response = await fetch(target, {
          ...init,
          redirect: "error",
          signal: AbortSignal.timeout(15000),
        });
        if (response.status === 401) denied = true;
        return response;
      },
      reconnectionOptions: {
        maxRetries: 0,
        initialReconnectionDelay: 100,
        maxReconnectionDelay: 100,
        reconnectionDelayGrowFactor: 1,
      },
    },
  );
  try {
    await client.connect(transport);
    const result = await client.callTool(
      { name: "notion-get-self", arguments: {} },
      undefined,
      { timeout: 15000 },
    );
    return {
      validWorkspace:
        result.isError !== true &&
        notionSelfWorkspaceMatches(result, binding.prerequisites.workspaceId!),
      authenticationDenied: false,
    };
  } catch {
    return { validWorkspace: false, authenticationDenied: denied };
  } finally {
    await client.close().catch(() => undefined);
  }
}
export function qualifiedNotionExpiry(
  prerequisites: Record<string, string>,
  now: number,
) {
  const expiresAt = Date.parse(prerequisites.authorizationExpiresAt ?? "");
  return (
    prerequisites.authorizationFailureKind === "natural-expiry" &&
    Number.isFinite(expiresAt) &&
    expiresAt >= now + 120000 &&
    expiresAt <= now + 480000
  );
}
