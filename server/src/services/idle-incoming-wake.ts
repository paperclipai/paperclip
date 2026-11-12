import { idleChatHistoryChecksForOwner } from "./chat-channels/idle-history-proof.js";
import { readSlackIdleIncomingProof, slackHasRegisteredOptionsAtCurrentBuild } from "./chat-channels/slack/idle-incoming.js";
import { readIdleMcpSleepProof, type IdleMcpSleepProof } from "./public-mcp/idle-sleep-proof.js";
import { idleMcpWorkQuery } from "./public-mcp/idle-work-query.js";
import { idleExternalAgentIncomingWorkQuery } from "../modules/external-agents/index.js";
import { apiWakeFingerprint, createApiWakeAdmission, type ApiWakeAdmission } from "./idle-api-wake-admission.js";
import { createHash } from "node:crypto";
import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import {
  chatEndpoints,
  chatGitHubRegistrations,
  connectionGrants,
  toolConnections,
  type Db,
} from "@paperclipai/db";
import type {
  IdleIncomingWakeCapability,
  VerifiedIdleCapabilities,
} from "./idle-incoming-wake-capability.js";
import { githubConnectionEventBindings } from "./github-connection-events.js";
import { paperclipCloudConnectorConfigFromEnv } from "./paperclip-cloud-connector.js";
import { hasConnectionEventWakeReceiver } from "./connection-event-wake.js";

export interface IdleIncomingWakeProof {
  capability: IdleIncomingWakeCapability;
  apiWakeAdmission?: ApiWakeAdmission;
  completedActionIds?: readonly string[];
  mcp?: IdleMcpSleepProof;
  connectionIds: string[];
  endpointIds: string[];
  /** A broker enrollment cannot discharge these credential continuity obligations. */
  requiredContinuityConnectionIds: string[];
}
export const incomingWakeFingerprint = (bindings: string[][]) =>
  createHash("sha256")
    .update(
      JSON.stringify(
        bindings
          .map((b) => [...b])
          .sort((a, b) =>
            JSON.stringify(a) < JSON.stringify(b)
              ? -1
              : JSON.stringify(a) > JSON.stringify(b)
                ? 1
                : 0,
          ),
      ),
    )
    .digest("hex");

/** Read current binding authority in the safety transaction. No network call, renewal or write. */
export async function readIdleIncomingWakeProof(
  tx: Pick<Db, "select" | "execute">,
  input: {
    capabilities?: VerifiedIdleCapabilities;
    ownerId: string;
    receiverOwner: object;
    now?: () => number;
    inspectionNow?: number;
  },
): Promise<IdleIncomingWakeProof | undefined> {
  const capability = input.capabilities?.incomingWake;
  if (!capability) return;
  if (capability.ownerId !== input.ownerId)
    throw new Error("Incoming wake owner changed");
  const proof: IdleIncomingWakeProof = {
    capability,
    connectionIds: [],
    endpointIds: [],
    requiredContinuityConnectionIds: [],
  };
  const monotonic = input.now ?? (() => performance.now());
  const started = monotonic();
  const remaining = () => {
    const ms = 2_000 - (monotonic() - started);
    if (!Number.isFinite(ms) || ms <= 0)
      throw new Error("Incoming wake inspection budget exhausted");
    return Math.max(1, Math.floor(ms));
  };
  let queries = 0;
  const inspectionNow = input.inspectionNow ?? Date.now();
  const beforeRead = async () => {

    if ((queries += 2) > 64) throw new Error("Incoming wake query budget exhausted");
    // One shared owner budget, not five seconds multiplied by the row count.
    await tx.execute(
      sql`SELECT set_config('statement_timeout', ${`${remaining()}ms`}, true)`,
    );
    remaining();
  };
  if (capability.routes.includes("tenant-api-http-v2")) {
    const stackId = process.env.PAPERCLIP_CLOUD_STACK_ID;
    if (!stackId || !capability.apiKeyProof) throw new Error("API wake challenge is missing");
    await beforeRead();
    const rows = await tx.execute<{ keyHash: string; expiresAt: Date | null }>(sql`
      SELECT key_hash AS "keyHash", NULL::timestamptz AS "expiresAt" FROM agent_api_keys WHERE revoked_at IS NULL
      UNION ALL SELECT key_hash AS "keyHash", expires_at AS "expiresAt" FROM board_api_keys
        WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now()) LIMIT 1001`);
    remaining();
    if (rows.length > 1000) throw new Error("Too many API keys to certify wake admission");
    proof.apiWakeAdmission = createApiWakeAdmission({ stackId, ownerId: input.ownerId,
      capabilityGeneration: capability.generation, challenge: capability.apiKeyProof.challenge,
      keys: rows.map(row => ({ fingerprint: apiWakeFingerprint({ stackId, ownerId: input.ownerId,
        challenge: capability.apiKeyProof!.challenge, keyHash: row.keyHash }),
        expiresAt: row.expiresAt === null ? null : new Date(row.expiresAt).toISOString() })),
    });
  }
  if (capability.routes.includes("slack-broker-events-v1")) {
    const config = paperclipCloudConnectorConfigFromEnv();
    const slack = await readSlackIdleIncomingProof(tx, { capabilities: input.capabilities,
      identity: config ? { instanceId: config.instanceId, environment: config.environment } : undefined,
      receiverBound: hasConnectionEventWakeReceiver(input.receiverOwner), beforeRead, remaining,
      registeredOptions: slackHasRegisteredOptionsAtCurrentBuild });
    if (slack) {
      proof.endpointIds.push(...slack.endpointIds);
      proof.connectionIds.push(...slack.connectionIds);
      if (slack.completedActionIds.length) proof.completedActionIds = slack.completedActionIds;
    }
  }
  if (capability.routes.includes("mcp-oauth-http-v1")) {
    const stackId = process.env.PAPERCLIP_CLOUD_STACK_ID;
    if (!stackId || !capability.mcpOAuthProof) throw new Error("MCP wake challenge is missing");
    proof.mcp = await readIdleMcpSleepProof(tx, input.receiverOwner, { stackId, ownerId: input.ownerId,
      capabilityGeneration: capability.generation, challenge: capability.mcpOAuthProof.challenge, now: inspectionNow, budget: { beforeRead, check: () => { remaining(); } } });
    remaining();
  }
  if (!capability.routes.includes("github-broker-events-v1")) {
    await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
    remaining();
    return proof;
  }
  const broker = capability.githubBroker;
  const config = paperclipCloudConnectorConfigFromEnv();
  if (
    !broker ||
    config?.instanceId !== broker.instanceId ||
    !hasConnectionEventWakeReceiver(input.receiverOwner)
  )
    throw new Error("Incoming GitHub receiver is not bound");
  await beforeRead();
  const rows = await tx
    .select({ grant: connectionGrants, connection: toolConnections })
    .from(connectionGrants)
    .innerJoin(
      toolConnections,
      and(
        eq(toolConnections.id, connectionGrants.connectionId),
        eq(toolConnections.companyId, connectionGrants.companyId),
      ),
    )
    .where(
      and(
        eq(connectionGrants.status, "active"),
        eq(toolConnections.status, "active"),
        eq(toolConnections.enabled, true),
        sql`${toolConnections.config}->>'sourceTemplateKey' = 'github'`,
        sql`${toolConnections.config}->'oauth'->>'connectorProfile' = 'github.code'`,
        sql`exists (select 1 from companies where id=${connectionGrants.companyId} and status <> 'archived')`,
      ),
    )
    .limit(1001);
  if (rows.length > 1000)
    throw new Error("Too many GitHub bindings to inspect");
  remaining();
  let bindingCount = 0;
  for (const { grant, connection } of rows) {
    const github = grant.providerTenant?.github;
    if (
      !github ||
      !Array.isArray(github.installationIds) ||
      !github.installationIds.length ||
      github.installationIds.length > 1000 ||
      github.bindingSync ||
      github.continuityRetry ||
      github.installationIds.some(
        (id) => typeof id !== "string" || !/^[0-9]+$/.test(id),
      )
    )
      throw new Error("Unsettled GitHub authority");
    bindingCount += github.installationIds.length;
    if (bindingCount > 1000)
      throw new Error("Too many GitHub bindings to inspect");
    proof.requiredContinuityConnectionIds.push(connection.id);
  }
  const bindings = githubConnectionEventBindings(rows);
  if (
    bindings.length !==
    rows.reduce(
      (n, r) => n + r.grant.providerTenant!.github!.installationIds.length,
      0,
    )
  )
    throw new Error("Incomplete GitHub binding");
  const tuples = bindings.map((b) => [
    b.id,
    b.companyId,
    b.subject,
    "github.code",
    b.installationId,
    b.connectionId,
    b.grantId,
  ]);
  await beforeRead();
  const endpoints = await tx
    .select({ endpoint: chatEndpoints, connection: toolConnections })
    .from(chatEndpoints)
    .innerJoin(
      toolConnections,
      and(
        eq(toolConnections.id, chatEndpoints.connectionId),
        eq(toolConnections.companyId, chatEndpoints.companyId),
      ),
    )
    .where(
      and(
        eq(chatEndpoints.provider, "github"),
        eq(chatEndpoints.status, "active"),
        eq(toolConnections.status, "active"),
        eq(toolConnections.enabled, true),
        eq(toolConnections.transport, "chat_sdk"),
        eq(toolConnections.connectionPurpose, "channel"),
        sql`exists (select 1 from companies where id=${chatEndpoints.companyId} and status <> 'archived')`,
      ),
    )
    .limit(1001);
  if (endpoints.length > 1000)
    throw new Error("Too many GitHub endpoints to inspect");
  remaining();
  const brokerEndpointIds = endpoints
    .filter(
      ({ endpoint }) =>
        typeof endpoint.setup.github?.cloudRegistrationId === "string",
    )
    .map(({ endpoint }) => endpoint.id);
  const registrationUsers = new Map<string, string[]>();
  if (brokerEndpointIds.length) {
    await beforeRead();
    const registrations = await tx
      .select({
        endpointId: chatGitHubRegistrations.endpointId,
        companyId: chatGitHubRegistrations.companyId,
        userId: chatGitHubRegistrations.userId,
        cloudId: sql<string>`${chatGitHubRegistrations.handoff}->>'cloudId'`,
      })
      .from(chatGitHubRegistrations)
      .where(
        and(
          inArray(chatGitHubRegistrations.endpointId, brokerEndpointIds),
          eq(chatGitHubRegistrations.status, "completed"),
        ),
      )
      .limit(10001);
    remaining();
    if (registrations.length > 10000)
      throw new Error("Too many GitHub registrations to inspect");
    for (const registration of registrations) {
      const key = JSON.stringify([
        registration.endpointId,
        registration.companyId,
        registration.cloudId,
      ]);
      const users = registrationUsers.get(key) ?? [];
      users.push(registration.userId);
      registrationUsers.set(key, users);
    }
  }
  for (const { endpoint, connection } of endpoints) {
    const registration = endpoint.setup.github?.cloudRegistrationId;
    if (!registration || !/^[A-Za-z0-9_-]{43}$/.test(registration)) continue;
    if (
      endpoint.setup.step !== "complete" ||
      endpoint.setup.github?.registrationStatus !== "completed" ||
      endpoint.setup.github.initialSetupPending ||
      endpoint.setup.github.initialRepositoryImportPending ||
      !endpoint.activatedAt ||
      !endpoint.botExternalId ||
      !endpoint.providerAccountId
    )
      throw new Error("GitHub bot setup has unfinished work");
    const users = registrationUsers.get(
      JSON.stringify([endpoint.id, endpoint.companyId, registration]),
    );
    if (users?.length !== 1 || !users[0])
      throw new Error("GitHub registration authority changed");
    tuples.push([
      `github-app:${registration}`,
      endpoint.companyId,
      users[0],
      "github.bot",
      `gateway:${registration}`,
      registration,
      registration,
    ]);
    proof.connectionIds.push(connection.id);
    proof.endpointIds.push(endpoint.id);
  }
  remaining();
  if (tuples.length > 1000)
    throw new Error("Too many GitHub bindings to inspect");
  if (incomingWakeFingerprint(tuples) !== broker.bindingsFingerprint)
    throw new Error("GitHub wake bindings changed");
  remaining();
  await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
  remaining();
  return proof;
}

/** Exact domain predicates selected by stable inventory reason, never SQL-text identity. */
export function incomingWakeWorkQuery(
  reason: string,
  proof?: IdleIncomingWakeProof,
  continuityConnectionIds: readonly string[] = [],
): SQL | undefined {
  const mcp = proof?.mcp;
  const mcpQuery = idleMcpWorkQuery(reason, { ingress: mcp?.ingress, subscriptions: mcp?.subscriptions, transfers: mcp?.transfers, handoffs: mcp?.handoffs })
    ?? idleExternalAgentIncomingWorkQuery(reason, mcp?.ingress);
  if (mcpQuery) return mcpQuery;
  const connectionIds = [
    ...(proof?.connectionIds ?? []),
    ...(proof?.requiredContinuityConnectionIds.filter((id) =>
      continuityConnectionIds.includes(id),
    ) ?? []),
  ];
  if ((reason === "chat_actions" || reason === "chat_deliveries") && proof?.completedActionIds?.length) {
    const check = idleChatHistoryChecksForOwner(proof.completedActionIds).find(value => value.reason === reason);
    if (!check) throw new Error("Chat history owner query missing");
    return typeof check.query === "string" ? sql.raw(check.query) : check.query;
  }
  if (reason === "agent_api_keys")
    return proof?.apiWakeAdmission !== undefined
      ? sql`SELECT 1 WHERE false`
      : sql`SELECT 1 FROM agent_api_keys WHERE revoked_at IS NULL`;
  if (reason === "board_api_keys")
    return proof?.apiWakeAdmission !== undefined
      ? sql`SELECT 1 WHERE false`
      : sql`SELECT 1 FROM board_api_keys WHERE revoked_at IS NULL
    AND (expires_at IS NULL OR expires_at > now())`;
  if (reason === "chat_endpoints") {
    const ids = proof?.endpointIds ?? [];
    // Only the supported GitHub webhook path gains a removed-history proof.
    // Archival commits before cleanup, so status alone cannot discharge work.
    return sql`SELECT 1 FROM chat_endpoints endpoint WHERE (((endpoint.provider = 'github'
    AND endpoint.status = 'archived' AND endpoint.archived_at IS NOT NULL
    AND jsonb_typeof(endpoint.setup) = 'object'
    AND CASE WHEN jsonb_typeof(endpoint.setup->'runtimeGeneration') = 'number'
      THEN (endpoint.setup->>'runtimeGeneration')::numeric >= 1
        AND trunc((endpoint.setup->>'runtimeGeneration')::numeric) = (endpoint.setup->>'runtimeGeneration')::numeric
      ELSE false END
    AND EXISTS (SELECT 1 FROM tool_connections removed_connection
      WHERE removed_connection.id = endpoint.connection_id AND removed_connection.company_id = endpoint.company_id
        AND removed_connection.connection_purpose = 'channel' AND removed_connection.transport = 'chat_sdk'
        AND removed_connection.status = 'archived' AND removed_connection.enabled = false
        AND removed_connection.credential_secret_refs = '[]'::jsonb)
    AND NOT EXISTS (SELECT 1 FROM chat_endpoint_leases lease WHERE lease.endpoint_id = endpoint.id)
    AND NOT EXISTS (SELECT 1 FROM chat_slack_registrations registration WHERE registration.endpoint_id = endpoint.id)
    AND NOT EXISTS (SELECT 1 FROM chat_github_registrations registration WHERE registration.endpoint_id = endpoint.id
      AND (registration.company_id = endpoint.company_id AND registration.status = 'completed'
        AND registration.consumed_at IS NOT NULL) IS NOT TRUE))
    OR (endpoint.provider = 'slack'
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
        AND draft_connection.status = 'draft' AND draft_connection.enabled = false))) IS NOT TRUE) AND ${
          ids.length
            ? sql`endpoint.id NOT IN (${sql.join(
                ids.map((id) => sql`${id}::uuid`),
                sql`, `,
              )})`
            : sql`true`
        }`;
  }
  if (reason === "tool_connections") {
    const ids = connectionIds;
    return sql`SELECT 1 FROM tool_connections c WHERE (c.status <> 'archived' AND (
    (c.status = 'draft' AND c.enabled = false)
    OR (c.status = 'active' AND c.connection_purpose = 'ai' AND c.transport = 'runtime_auth')
    OR (c.status = 'active' AND c.connection_purpose = 'tool' AND c.transport = 'mcp_remote'
      AND NOT EXISTS (SELECT 1 FROM connection_grants g WHERE g.connection_id = c.id
        AND (g.company_id <> c.company_id OR g.provider_tenant->'github' IS NOT NULL)))
    ) IS NOT TRUE) AND ${
      ids.length
        ? sql`c.id NOT IN (${sql.join(
            ids.map((id) => sql`${id}::uuid`),
            sql`, `,
          )})`
        : sql`true`
    }`;
  }
  return undefined;
}
