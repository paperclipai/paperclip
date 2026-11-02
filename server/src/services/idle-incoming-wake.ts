import { createHash } from "node:crypto";
import { and, eq, sql, type SQL } from "drizzle-orm";
import { chatEndpoints, chatGitHubRegistrations, connectionGrants, toolConnections, type Db } from "@paperclipai/db";
import type { IdleIncomingWakeCapability, VerifiedIdleCapabilities } from "./idle-incoming-wake-capability.js";
import { githubConnectionEventBindings } from "./github-connection-events.js";
import { paperclipCloudConnectorConfigFromEnv } from "./paperclip-cloud-connector.js";
import { hasConnectionEventWakeReceiver } from "./connection-event-wake.js";

export interface IdleIncomingWakeProof {
  capability: IdleIncomingWakeCapability;
  connectionIds: string[];
  endpointIds: string[];
  /** A broker enrollment cannot discharge these credential continuity obligations. */
  requiredContinuityConnectionIds: string[];
}
export const incomingWakeFingerprint = (bindings: string[][]) => createHash("sha256").update(JSON.stringify(bindings.map(b => [...b]).sort((a,b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0))).digest("hex");

/** Read current binding authority in the safety transaction. No network call, renewal or write. */
export async function readIdleIncomingWakeProof(tx: Pick<Db, "select" | "execute">, input: {
  capabilities?: VerifiedIdleCapabilities; ownerId: string; receiverOwner: object;
}): Promise<IdleIncomingWakeProof | undefined> {
  const capability = input.capabilities?.incomingWake;
  if (!capability) return;
  if (capability.ownerId !== input.ownerId) throw new Error("Incoming wake owner changed");
  const proof: IdleIncomingWakeProof = { capability, connectionIds: [], endpointIds: [], requiredContinuityConnectionIds: [] };
  if (!capability.routes.includes("github-broker-events-v1")) return proof;
  const broker = capability.githubBroker;
  const config = paperclipCloudConnectorConfigFromEnv();
  if (!broker || config?.instanceId !== broker.instanceId || !hasConnectionEventWakeReceiver(input.receiverOwner))
    throw new Error("Incoming GitHub receiver is not bound");
  const rows = await tx.select({ grant: connectionGrants, connection: toolConnections }).from(connectionGrants)
    .innerJoin(toolConnections, and(eq(toolConnections.id, connectionGrants.connectionId), eq(toolConnections.companyId, connectionGrants.companyId)))
    .where(and(eq(connectionGrants.status, "active"), eq(toolConnections.status, "active"), eq(toolConnections.enabled, true),
      sql`${toolConnections.config}->>'sourceTemplateKey' = 'github'`, sql`${toolConnections.config}->'oauth'->>'connectorProfile' = 'github.code'`,
      sql`exists (select 1 from companies where id=${connectionGrants.companyId} and status <> 'archived')`));
  if (rows.length > 1000) throw new Error("Too many GitHub bindings to inspect");
  for (const { grant, connection } of rows) {
    const github = grant.providerTenant?.github;
    if (!github || !Array.isArray(github.installationIds) || !github.installationIds.length || github.bindingSync || github.continuityRetry
      || github.installationIds.some(id => typeof id !== "string" || !/^[0-9]+$/.test(id))) throw new Error("Unsettled GitHub authority");
    proof.requiredContinuityConnectionIds.push(connection.id);
  }
  const bindings = githubConnectionEventBindings(rows);
  if (bindings.length !== rows.reduce((n,r) => n + r.grant.providerTenant!.github!.installationIds.length, 0)) throw new Error("Incomplete GitHub binding");
  const tuples = bindings.map(b => [b.id,b.companyId,b.subject,"github.code",b.installationId,b.connectionId,b.grantId]);
  const endpoints = await tx.select({ endpoint: chatEndpoints, connection: toolConnections }).from(chatEndpoints)
    .innerJoin(toolConnections, and(eq(toolConnections.id,chatEndpoints.connectionId),eq(toolConnections.companyId,chatEndpoints.companyId)))
    .where(and(eq(chatEndpoints.provider,"github"),eq(chatEndpoints.status,"active"),eq(toolConnections.status,"active"),eq(toolConnections.enabled,true),
      eq(toolConnections.transport,"chat_sdk"),eq(toolConnections.connectionPurpose,"channel"),
      sql`exists (select 1 from companies where id=${chatEndpoints.companyId} and status <> 'archived')`));
  for (const { endpoint, connection } of endpoints) {
    const registration = endpoint.setup.github?.cloudRegistrationId;
    if (!registration || !/^[A-Za-z0-9_-]{43}$/.test(registration)) continue;
    const registrations = await tx.select({ userId: chatGitHubRegistrations.userId }).from(chatGitHubRegistrations)
      .where(and(eq(chatGitHubRegistrations.endpointId, endpoint.id), eq(chatGitHubRegistrations.companyId, endpoint.companyId),
        eq(chatGitHubRegistrations.status, "completed"), sql`${chatGitHubRegistrations.handoff}->>'cloudId' = ${registration}`)).limit(2);
    if (registrations.length !== 1 || !registrations[0]!.userId) throw new Error("GitHub registration authority changed");
    tuples.push([`github-app:${registration}`,endpoint.companyId,registrations[0]!.userId,"github.bot",`gateway:${registration}`,registration,registration]);
    proof.connectionIds.push(connection.id); proof.endpointIds.push(endpoint.id);
  }
  if (incomingWakeFingerprint(tuples) !== broker.bindingsFingerprint) throw new Error("GitHub wake bindings changed");
  return proof;
}

/** Exact domain predicates selected by stable inventory reason, never SQL-text identity. */
export function incomingWakeWorkQuery(reason: string, proof?: IdleIncomingWakeProof, continuityConnectionIds: readonly string[] = []): SQL | undefined {
  const connectionIds = [...proof?.connectionIds ?? [], ...proof?.requiredContinuityConnectionIds.filter(id => continuityConnectionIds.includes(id)) ?? []];
  if (reason === "agent_api_keys") return proof?.capability.routes.includes("tenant-api-http-v1") ? sql`SELECT 1 WHERE false` : sql`SELECT 1 FROM agent_api_keys WHERE revoked_at IS NULL`;
  if (reason === "board_api_keys") return proof?.capability.routes.includes("tenant-api-http-v1") ? sql`SELECT 1 WHERE false` : sql`SELECT 1 FROM board_api_keys WHERE revoked_at IS NULL
    AND (expires_at IS NULL OR expires_at > now())`;
  if (reason === "chat_endpoints") {
    const ids = proof?.endpointIds ?? [];
    return sql`SELECT 1 FROM chat_endpoints endpoint WHERE ((endpoint.provider = 'slack'
    AND endpoint.status = 'draft' AND endpoint.setup->>'step' = 'provider_setup'
    AND (endpoint.setup - ARRAY['step', 'command']) = '{}'::jsonb
    AND (endpoint.setup->'command' IS NULL OR endpoint.setup->'command' = 'null'::jsonb
      OR jsonb_typeof(endpoint.setup->'command') = 'string')
    AND endpoint.activated_at IS NULL AND endpoint.provider_account_id IS NULL
    AND endpoint.bot_external_id IS NULL AND endpoint.bot_username IS NULL
    AND endpoint.last_event_at IS NULL AND endpoint.last_publication_at IS NULL
    AND endpoint.health_message IS NULL AND endpoint.last_error IS NULL
    AND NOT EXISTS (SELECT 1 FROM chat_slack_registrations registration WHERE registration.endpoint_id = endpoint.id)
    AND EXISTS (SELECT 1 FROM tool_connections draft_connection
      WHERE draft_connection.id = endpoint.connection_id AND draft_connection.company_id = endpoint.company_id
        AND draft_connection.connection_purpose = 'channel' AND draft_connection.transport = 'chat_sdk'
        AND draft_connection.status = 'draft' AND draft_connection.enabled = false)) IS NOT TRUE) AND ${ids.length ? sql`endpoint.id NOT IN (${sql.join(ids.map(id => sql`${id}::uuid`), sql`, `)})` : sql`true`}`;
  }
  if (reason === "tool_connections") {
    const ids = connectionIds;
    return sql`SELECT 1 FROM tool_connections c WHERE (c.status <> 'archived' AND (
    (c.status = 'draft' AND c.enabled = false)
    OR (c.status = 'active' AND c.connection_purpose = 'ai' AND c.transport = 'runtime_auth')
    OR (c.status = 'active' AND c.connection_purpose = 'tool' AND c.transport = 'mcp_remote'
      AND NOT EXISTS (SELECT 1 FROM connection_grants g WHERE g.connection_id = c.id
        AND (g.company_id <> c.company_id OR g.provider_tenant->'github' IS NOT NULL)))
    ) IS NOT TRUE) AND ${ids.length ? sql`c.id NOT IN (${sql.join(ids.map(id => sql`${id}::uuid`), sql`, `)})` : sql`true`}`;
  }
  return undefined;
}
