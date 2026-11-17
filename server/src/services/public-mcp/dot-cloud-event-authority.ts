import { z } from "zod";
import { getCloudRuntimeIdentity } from "../cloud-runtime-identity.js";
import { createPaperclipCloudConnector, paperclipCloudConnectorConfigFromEnv } from "../paperclip-cloud-connector.js";
import { McpEventError, type EventFetch } from "./event-webhooks.js";
import type { CloudEventAuthority } from "./cloud-event-authority.js";
import type { McpPrincipal, PublicMcpOAuth } from "./oauth.js";

const authoritySchema = z.object({ version: z.literal(1), stackId: z.string().min(1), instanceId: z.string().min(1),
  userId: z.string().min(1), companyId: z.uuid(), grantId: z.uuid(), clientId: z.string().min(1),
  upstreamClientId: z.string().min(1), resource: z.string().url(), expiresAt: z.number().int().positive().safe() }).strict();

export function currentDotEventNamespace(oauth: Pick<PublicMcpOAuth, "config">) {
  const identity = getCloudRuntimeIdentity();
  if (!identity || oauth.config.origin !== identity.canonicalOrigin
    || oauth.config.resource !== identity.canonicalOrigin + "/mcp/runner"
    || oauth.config.authorizationOrigin !== undefined && oauth.config.authorizationOrigin !== identity.canonicalOrigin) {
    throw new McpEventError(-32602, "Hosted Dot subscription authority is unavailable.");
  }
  return identity;
}

/** A wrapped Dot proof is checked through the existing enrolled connector.
 * Raw awake Dot grants retain local authorization; this is not an identity tool. */
export async function authorizeDotCloudEvent(oauth: PublicMcpOAuth, principal: McpPrincipal,
  authority: CloudEventAuthority, fetcher: EventFetch, now: () => number) {
  try {
    if (authority.transport !== "tenant-dot-v1" || authority.expiresAt <= now()) throw new Error();
    const identity = currentDotEventNamespace(oauth), config = paperclipCloudConnectorConfigFromEnv();
    if (!identity || !config || oauth.config.origin !== identity.canonicalOrigin
      || oauth.config.resource !== identity.canonicalOrigin + "/mcp/runner"
      || oauth.config.authorizationOrigin !== undefined && oauth.config.authorizationOrigin !== identity.canonicalOrigin) throw new Error();
    const connector = createPaperclipCloudConnector({ config, now, request: (url, init) =>
      fetcher(typeof url === "string" ? url : url instanceof URL ? url.href : url.url, init ?? {}) });
    const value = authoritySchema.parse(await connector.dotSubscriptionAuthority({ subject: principal.grant.userId,
      companyId: principal.grant.companyId, serialized: JSON.stringify({ proof: authority.token, resource: oauth.config.resource }) }));
    const current = getCloudRuntimeIdentity(), currentConfig = paperclipCloudConnectorConfigFromEnv();
    if (!current || !currentConfig || current.stackId !== identity.stackId || current.claimId !== identity.claimId
      || current.canonicalOrigin !== identity.canonicalOrigin || currentConfig.instanceId !== config.instanceId
      || currentConfig.baseUrl !== config.baseUrl || value.stackId !== identity.stackId || value.instanceId !== config.instanceId
      || value.userId !== principal.grant.userId || value.companyId !== principal.grant.companyId
      || value.grantId !== principal.grant.id || value.upstreamClientId !== principal.grant.clientId
      || value.resource !== oauth.config.resource || value.expiresAt !== authority.expiresAt || value.expiresAt <= now()) throw new Error();
    // Re-check original grant, membership, enabled flag and operator authorization
    // after the remote wait. No Cloud projection creates a local grant.
    const authorized = await oauth.authorizeGrant(principal.grant.id);
    if (authorized.grant.userId !== value.userId || authorized.grant.companyId !== value.companyId
      || authorized.grant.clientId !== value.upstreamClientId || authorized.grant.resource !== value.resource) throw new Error();
  } catch {
    throw new McpEventError(-32602, "Hosted Dot subscription authority is unavailable.");
  }
}
