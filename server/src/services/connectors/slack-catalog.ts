import { createHash } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { SLACK_TOOLS } from "@paperclipai/shared";
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
import { resolveSlackTaskAuthority } from "./slack-authority.js";
export async function syncSlackBotTools(
  tx: Parameters<Parameters<Db["transaction"]>[0]>[0],
  endpoint: typeof chatEndpoints.$inferSelect,
  userId: string,
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
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`slack-catalog:${endpoint.id}`}, 0))`,
  );
  const existingEntries = await tx
    .select()
    .from(toolCatalogEntries)
    .where(eq(toolCatalogEntries.connectionId, connection.id));
  const entriesByName = new Map(
    existingEntries.map((entry) => [entry.name, entry]),
  );
  for (const tool of SLACK_TOOLS) {
    const hash = createHash("sha256")
      .update(
        JSON.stringify({
          name: tool.name,
          inputSchema: tool.inputSchema,
          risk: tool.risk,
          scopes: tool.scopes,
        }),
      )
      .digest("hex");
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
      status: enabled ? ("active" as const) : ("removed" as const),
      reviewedByUserId: userId,
      reviewedAt: new Date(),
      updatedAt: new Date(),
    };
    const existing = entriesByName.get(values.name);
    if (existing?.versionHash === hash) continue;
    await tx
      .insert(toolCatalogEntries)
      .values(values)
      .onConflictDoUpdate({
        target: [toolCatalogEntries.connectionId, toolCatalogEntries.name],
        set: {
          ...values,
          ...(existing
            ? {
                status: existing.status,
                reviewedByUserId: existing.reviewedByUserId,
                reviewedAt: existing.reviewedAt,
              }
            : {}),
        },
      });
  }
  const profileKey = `slack-bot:${endpoint.id}`;
  const [priorProfile] = await tx
    .select()
    .from(toolProfiles)
    .where(
      and(
        eq(toolProfiles.companyId, endpoint.companyId),
        eq(toolProfiles.profileKey, profileKey),
      ),
    );
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

export async function slackToolsForSession(
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
): Promise<ToolGatewayDescriptor[]> {
  if (!session.agentId || !session.runId || !session.issueId) return [];
  let authority;
  try {
    authority = await resolveSlackTaskAuthority(db, {
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
    .where(
      and(
        eq(toolCatalogEntries.companyId, session.companyId),
        eq(toolCatalogEntries.connectionId, authority.endpoint.connectionId),
        eq(toolCatalogEntries.status, "active"),
        isNull(toolCatalogEntries.quarantinedAt),
      ),
    );
  return entries
    .filter(({ entry }) => SLACK_TOOLS.some((t) => t.name === entry.toolName))
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
