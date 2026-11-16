import { prepareSlackEndpoints } from "./slack-endpoint-preparation.js";
import { ChatTaskBoundaryError } from "../chat-channels/run-origin.js";
import { createHash } from "node:crypto";
import { measureRunPhase } from "../execution-preparation-timing.js";
import { measureRunTransaction } from "../execution-transaction-timing.js";
import { and, eq, isNull, sql } from "drizzle-orm";
import { SLACK_TOOLS, slackOptInGroupsForTool } from "@paperclipai/shared";
import {
  chatEndpoints,
  toolConnections,
  toolCatalogEntries,
  toolConnectionInstalls,
  toolProfiles,
  toolProfileEntries,
  toolProfileBindings,
  type Db,
} from "@paperclipai/db";
import type {
  ToolGatewayDescriptor,
  ToolGatewaySession,
} from "../tool-gateway.js";
import {
  resolveSlackTaskAuthorization,
  slackEndpointCandidates,
  type SlackTaskAuthorization,
} from "./slack-authority.js";
import {
  isSlackToolEnabledForOptIns,
  isSlackToolEnabledForSetup,
  slackEnabledOptInGroups,
  slackEndpointOptInsForGating,
  type SlackSetupOptIns,
} from "./slack-opt-ins.js";
const catalogDefinitions = SLACK_TOOLS.map(tool => ({
  tool,
  hash: createHash("sha256").update(JSON.stringify({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    risk: tool.risk,
    scopes: tool.scopes,
  })).digest("hex"),
}));

/** Shared by gateway dispatch, native discovery and the settings projection. */
function slackCallableCatalogPredicate(endpoint: { companyId: string; connectionId: string }) {
  return and(
    eq(toolCatalogEntries.companyId, endpoint.companyId),
    eq(toolCatalogEntries.connectionId, endpoint.connectionId),
    eq(toolCatalogEntries.entryKind, "tool"),
    eq(toolCatalogEntries.status, "active"),
    isNull(toolCatalogEntries.quarantinedAt),
    eq(toolConnections.companyId, endpoint.companyId),
    eq(toolConnections.enabled, true),
    eq(toolConnections.status, "active"),
  );
}

export async function slackActiveCatalogToolNames(
  db: Pick<Db, "select">,
  endpoint: { companyId: string; connectionId: string },
): Promise<Set<string>> {
  const entries = await db.select({ toolName: toolCatalogEntries.toolName })
    .from(toolCatalogEntries)
    .innerJoin(toolConnections, eq(toolConnections.id, toolCatalogEntries.connectionId))
    .where(slackCallableCatalogPredicate(endpoint));
  return new Set(entries.map(entry => entry.toolName).filter((name): name is string => name !== null));
}

/** Refresh consent-driven catalog state without restoring operator restrictions. */
export async function ensureSlackBotCatalogCurrent(db: Db, endpoint: typeof chatEndpoints.$inferSelect, userId: string | null) {
  if (!await slackBotCatalogIsCurrent(db, endpoint)) {
    await measureRunTransaction(db, "connectors.slack.catalog", tx => syncSlackBotTools(tx, endpoint, userId, true));
  }
}

export async function slackBotCatalogIsCurrent(
  db: Db,
  endpoint: {
    id: string;
    companyId: string;
    connectionId: string;
    setup?: typeof chatEndpoints.$inferSelect.setup | null;
  },
): Promise<boolean> {
  const [entries, profiles] = await Promise.all([
    db.select({ name: toolCatalogEntries.name, versionHash: toolCatalogEntries.versionHash, status: toolCatalogEntries.status })
      .from(toolCatalogEntries).where(and(
        eq(toolCatalogEntries.companyId, endpoint.companyId),
        eq(toolCatalogEntries.connectionId, endpoint.connectionId),
      )),
    db.select({ id: toolProfiles.id }).from(toolProfiles).where(and(
      eq(toolProfiles.companyId, endpoint.companyId),
      eq(toolProfiles.profileKey, `slack-bot:${endpoint.id}`),
    )).limit(1),
  ]);
  if (profiles.length === 0) return false;
  const byName = new Map(entries.map(entry => [entry.name, entry]));
  if (!catalogDefinitions.every(({ tool, hash }) => byName.get(`slack_bot:${tool.name}`)?.versionHash === hash))
    return false;
  // A definition hash says nothing about permission state. Enabling and
  // installing an opt-in group (or removing one) changes which gated tools are
  // active while every hash stays the same, so the caller would skip the sync
  // and keep the old statuses indefinitely. Treat a mismatch between the
  // enabled set and the stored statuses as stale.
  if (endpoint.setup === undefined) return false;
  return (await slackCatalogStatusMatches(db, endpoint, byName));
}

/**
 * Whether every catalog entry's status already reflects the endpoint's current
 * permission state. Only gated tools are judged: an ungated tool is active or
 * disabled by the operator, never by opt-ins.
 */
async function slackCatalogStatusMatches(
  db: Db,
  endpoint: { id: string; companyId: string; setup?: typeof chatEndpoints.$inferSelect.setup | null },
  byName: Map<string, { status: string }>,
): Promise<boolean> {
  const setup: SlackSetupOptIns = endpoint.setup ?? {};
  const optIns = slackEnabledOptInGroups(
    setup,
    await slackEndpointOptInsForGating(db, { ...endpoint, setup }),
  );
  return catalogDefinitions.every(({ tool }) => {
    if (slackOptInGroupsForTool(tool).length === 0) return true;
    const stored = byName.get(`slack_bot:${tool.name}`);
    if (!stored) return false;
    // Operator disables and quarantines are deliberate restrictions, not
    // stale permission state that a catalog sync may restore.
    if (stored.status === "disabled" || stored.status === "quarantined") return true;
    return (stored.status === "active") === isSlackToolEnabledForOptIns(tool, optIns);
  });
}

export async function syncSlackBotTools(
  tx: Parameters<Parameters<Db["transaction"]>[0]>[0],
  endpoint: typeof chatEndpoints.$inferSelect,
  userId: string | null,
  enabled: boolean,
) {
  const [connection] = await tx
    .select()
    .from(toolConnections)
    .where(
      and(
        eq(toolConnections.companyId, endpoint.companyId),
        eq(toolConnections.id, endpoint.connectionId),
      ),
    );
  if (!connection) return;
  await measureRunPhase("connectors.slack.catalog.lock", () => tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`slack-catalog:${endpoint.id}`}, 0))`,
  ));
  const existingEntries = await measureRunPhase("connectors.slack.catalog.entries", () => tx
    .select()
    .from(toolCatalogEntries)
    .where(eq(toolCatalogEntries.connectionId, connection.id)));
  const entriesByName = new Map(
    existingEntries.map((entry) => [entry.name, entry]),
  );
  // TECH-7988: a gated tool this agent has not enabled is never activated, so
  // the connection's catalog never advertises an ability Slack would refuse.
  // Gating is requested-and-installed; a removed group stays off even if Slack
  // kept its scope. A legacy install keeps its implied grant until first edit.
  const optIns = slackEnabledOptInGroups(
    endpoint.setup,
    await slackEndpointOptInsForGating(tx, endpoint),
  );
  for (const { tool, hash } of catalogDefinitions) {
    const activated = enabled && isSlackToolEnabledForOptIns(tool, optIns);
    const gated = slackOptInGroupsForTool(tool).length > 0;
    const existing = entriesByName.get(`slack_bot:${tool.name}`);
    // An operator turning a tool off is a deliberate decision, distinct from
    // this sync removing a tool because its opt-in group is not enabled. Only
    // opt-in-driven removal is re-activated when the group comes back.
    const operatorStatus = existing?.status === "disabled" || existing?.status === "quarantined"
      ? existing.status : undefined;
    const status = operatorStatus ?? (activated ? "active" as const : "removed" as const);
    const values = {
      companyId: endpoint.companyId,
      applicationId: connection.applicationId,
      connectionId: connection.id,
      entryKind: "tool" as const,
      name: `slack_bot:${tool.name}`,
      toolName: tool.name,
      title: tool.description.split(".")[0],
      description: tool.description,
      inputSchema: tool.inputSchema,
      riskLevel: tool.risk === "read" ? ("read" as const) : ("write" as const),
      isReadOnly: tool.risk === "read",
      isWrite: tool.risk !== "read",
      versionHash: hash,
      schemaHash: hash,
      status,
      reviewedByUserId: userId,
      reviewedAt: new Date(),
      updatedAt: new Date(),
    };
    // A gated tool's status follows the enabled opt-in set on every sync, so
    // enabling or dropping a group flips it even when the definition hash is
    // unchanged. Operator-disabled/quarantined entries and ungated tools keep
    // their own status.
    if (existing?.versionHash === hash && (!gated || existing.status === values.status))
      continue;
    await measureRunPhase("connectors.slack.catalog.write", () => tx
      .insert(toolCatalogEntries)
      .values(values)
      .onConflictDoUpdate({
        target: [toolCatalogEntries.connectionId, toolCatalogEntries.name],
        set: {
          ...values,
          ...(existing
            ? {
                status: values.status,
                reviewedByUserId: existing.reviewedByUserId,
                reviewedAt: existing.reviewedAt,
              }
            : {}),
        },
      }));
  }
  const profileKey = `slack-bot:${endpoint.id}`;
  const [priorProfile] = await measureRunPhase("connectors.slack.catalog.profile", () => tx
    .select()
    .from(toolProfiles)
    .where(
      and(
        eq(toolProfiles.companyId, endpoint.companyId),
        eq(toolProfiles.profileKey, profileKey),
      ),
    ));
  if (priorProfile) return;
  const [profile] = await tx
    .insert(toolProfiles)
    .values({
      companyId: endpoint.companyId,
      profileKey,
      name: `Slack bot ${endpoint.id}`,
      description: "Task-scoped tools using this bot's App connection",
      defaultAction: "deny",
      status: enabled ? "active" : "disabled",
      metadata: { slackChatEndpointId: endpoint.id },
    })
    .onConflictDoUpdate({
      target: [toolProfiles.companyId, toolProfiles.profileKey],
      set: {
        description:
          "Task-scoped Slack tools; existing action policies remain in effect.",
      },
    })
    .returning();
  // Provision defaults once. Removing a binding/entry is an operator decision;
  // resolving a retained run must never restore revoked grants.
  if (enabled)
    await tx
      .insert(toolConnectionInstalls)
      .values({
        companyId: endpoint.companyId,
        connectionId: connection.id,
        targetType: "agent",
        targetId: endpoint.assignedAgentId,
        createdByUserId: userId,
      })
      .onConflictDoNothing();

  const [existingEntry] = await tx
    .select({ id: toolProfileEntries.id })
    .from(toolProfileEntries)
    .where(
      and(
        eq(toolProfileEntries.profileId, profile!.id),
        eq(toolProfileEntries.connectionId, connection.id),
      ),
    );
  if (!existingEntry)
    await tx
      .insert(toolProfileEntries)
      .values({
        companyId: endpoint.companyId,
        profileId: profile!.id,
        selectorType: "connection",
        connectionId: connection.id,
        effect: "include",
      })
      .onConflictDoNothing();
  await tx
    .insert(toolProfileBindings)
    .values({
      companyId: endpoint.companyId,
      profileId: profile!.id,
      targetType: "agent",
      targetId: endpoint.assignedAgentId,
      createdByUserId: userId,
      metadata: { slackChatEndpointId: endpoint.id },
    })
    .onConflictDoNothing();
}

async function slackToolsForEndpoint(
  db: Db,
  session: Pick<
    ToolGatewaySession,
    | "companyId"
    | "agentId"
    | "runId"
    | "issueId"
    | "identityContextId"
    | "approvedSlackInvocationId"
  >,
  endpointId: string,
): Promise<ToolGatewayDescriptor[]> {
  if (!session.agentId || !session.runId || !session.issueId) return [];
  let authority: SlackTaskAuthorization;
  try {
    authority = await resolveSlackTaskAuthorization(db, {
      endpointId,
      companyId: session.companyId,
      agentId: session.agentId,
      runId: session.runId,
      issueId: session.issueId,
      identityContextId: session.identityContextId,
      approvedInvocationId: session.approvedSlackInvocationId,
    });
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "status" in error &&
      error.status === 403
    )
      return [];
    throw error;
  }
  await ensureSlackBotCatalogCurrent(db, authority.endpoint, authority.userId);
  const entries = await db
    .select({
      entry: toolCatalogEntries,
      applicationId: toolConnections.applicationId,
    })
    .from(toolCatalogEntries)
    .innerJoin(
      toolConnections,
      eq(toolConnections.id, toolCatalogEntries.connectionId),
    )
    .where(slackCallableCatalogPredicate(authority.endpoint));
  const gating = await slackEndpointOptInsForGating(db, authority.endpoint);
  return entries
    .filter(({ entry }) => {
      const tool = SLACK_TOOLS.find((t) => t.name === entry.toolName);
      if (!tool) return false;
      // Never offer a tool whose opt-in group this agent has not enabled:
      // Slack would reject the call. Uses the same helper as dispatch.
      return isSlackToolEnabledForSetup(authority.endpoint.setup, tool, gating);
    })
    .map(({ entry, applicationId }) => ({
      name: `slack-bot.${authority.endpoint.id}:${entry.toolName}`,
      displayName: entry.title ?? entry.toolName,
      description: entry.description ?? "",
      parametersSchema: entry.inputSchema,
      pluginId: `slack-bot:${authority.endpoint.id}`,
      providerType: "paperclip_slack_chat",
      risk: entry.riskLevel === "read" ? "read" : "write",
      applicationId,
      applicationKey: "slack-chat",
      applicationDisplayName: "Slack bot",
      connectionId: authority.endpoint.connectionId,
      catalogEntryId: entry.id,
      upstreamToolName: entry.toolName,
      providerMetadata: { endpointId: authority.endpoint.id },
    }));
}

export async function slackToolsForSession(
  db: Db,
  session: Parameters<typeof slackToolsForEndpoint>[1],
): Promise<ToolGatewayDescriptor[]> {
  if (!session.agentId || !session.runId || !session.issueId) return [];
  const endpoints = await slackEndpointCandidates(db, {
    companyId: session.companyId,
    agentId: session.agentId,
  });
  // A task another agent created and assigned never owns a Slack requester: omit that endpoint's tools
  // rather than failing discovery for the whole gateway. Calls still re-verify authority and fail closed.
  return prepareSlackEndpoints(endpoints, endpoint => slackToolsForEndpoint(db, session, endpoint.id)
    .catch(error => { if (error instanceof ChatTaskBoundaryError) return []; throw error; }));
}
