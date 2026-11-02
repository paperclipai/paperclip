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

/** Narrowly substitute proven rows while leaving every other ingress predicate intact. */
export function incomingWakeWorkCheck(query: string, proof?: IdleIncomingWakeProof, continuityConnectionIds: readonly string[] = []): SQL {
  if (proof?.capability.routes.includes("tenant-api-http-v1") && (query.startsWith("SELECT 1 FROM agent_api_keys ") || query.startsWith("SELECT 1 FROM board_api_keys "))) return sql`false`;
  const endpointPrefix = "SELECT 1 FROM chat_endpoints endpoint WHERE ";
  const connectionPrefix = "SELECT 1 FROM tool_connections c WHERE ";
  const connectionIds = [...proof?.connectionIds ?? [], ...proof?.requiredContinuityConnectionIds.filter(id => continuityConnectionIds.includes(id)) ?? []];
  if (proof?.endpointIds.length && query.startsWith(endpointPrefix)) return sql`EXISTS (SELECT 1 FROM chat_endpoints endpoint WHERE endpoint.id NOT IN (${sql.join(proof.endpointIds.map(id => sql`${id}::uuid`),sql`, `)}) AND (${sql.raw(query.slice(endpointPrefix.length))}))`;
  if (connectionIds.length && query.startsWith(connectionPrefix)) return sql`EXISTS (SELECT 1 FROM tool_connections c WHERE c.id NOT IN (${sql.join(connectionIds.map(id => sql`${id}::uuid`),sql`, `)}) AND (${sql.raw(query.slice(connectionPrefix.length))}))`;
  return sql`EXISTS (${sql.raw(query)})`;
}
