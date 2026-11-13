import { connectionManagementService } from "../../connection-management.js";
import type { ConnectionManagementContext } from "../../connection-management.js";
import { and, desc, eq, gte, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, connectionTokenIssuances, authUsers, heartbeatRuns, issues, toolActionRequests, toolConnections, toolCallEvents, toolInvocations } from "@paperclipai/db";
import type { ToolConnectionActivityResponse, ToolRunDecision, ToolRunDecisionLookup } from "@paperclipai/shared";
import { notFound } from "../../../errors.js";
import { listConnectionLifecycleEvents } from "../../tool-connection-activity.js";
import { toToolInvocation, toToolActionRequest, toToolCallEvent, userFallbackName, denialReasonForDecision } from "./projection.js";
type ConnectionLookup = (idOrUid: string, companyId?: string) => Promise<typeof toolConnections.$inferSelect>;

export function createToolActivityService(db: Db, getConnectionRow: ConnectionLookup) {
  return {
    getConnectionUsage: async (
      idOrUid: string,
      range: "7d" | "30d",
      companyId?: string,
    ) => {
      const connection = await getConnectionRow(idOrUid, companyId);
      const days = range === "30d" ? 30 : 7;
      const start = new Date();
      start.setUTCHours(0, 0, 0, 0);
      start.setUTCDate(start.getUTCDate() - days + 1);
      const [issuances, invocations] = await Promise.all([
        db
          .select({
            createdAt: connectionTokenIssuances.createdAt,
            outcome: connectionTokenIssuances.outcome,
            path: connectionTokenIssuances.path,
          })
          .from(connectionTokenIssuances)
          .where(
            and(
              eq(connectionTokenIssuances.companyId, connection.companyId),
              eq(connectionTokenIssuances.connectionId, connection.id),
              gte(connectionTokenIssuances.createdAt, start),
            ),
          ),
        db
          .select({
            createdAt: toolInvocations.createdAt,
            riskLevel: toolInvocations.riskLevel,
          })
          .from(toolInvocations)
          .where(
            and(
              eq(toolInvocations.companyId, connection.companyId),
              eq(toolInvocations.connectionId, connection.id),
              gte(toolInvocations.createdAt, start),
            ),
          ),
      ]);
      const buckets = Array.from({ length: days }, (_, offset) => {
        const date = new Date(start);
        date.setUTCDate(start.getUTCDate() + offset);
        return {
          date: date.toISOString().slice(0, 10),
          issuances: {
            total: 0,
            byOutcome: {} as Record<string, number>,
            byPath: {} as Record<string, number>,
          },
          invocations: { total: 0, byRiskLevel: {} as Record<string, number> },
          deliveries: { received: 0, forwarded: 0 },
        };
      });
      const byDate = new Map(buckets.map((bucket) => [bucket.date, bucket]));
      for (const row of issuances) {
        const bucket = byDate.get(row.createdAt.toISOString().slice(0, 10));
        if (!bucket) continue;
        bucket.issuances.total += 1;
        bucket.issuances.byOutcome[row.outcome] =
          (bucket.issuances.byOutcome[row.outcome] ?? 0) + 1;
        bucket.issuances.byPath[row.path] =
          (bucket.issuances.byPath[row.path] ?? 0) + 1;
      }
      for (const row of invocations) {
        const bucket = byDate.get(row.createdAt.toISOString().slice(0, 10));
        if (!bucket) continue;
        const riskLevel = row.riskLevel ?? "unknown";
        bucket.invocations.total += 1;
        bucket.invocations.byRiskLevel[riskLevel] =
          (bucket.invocations.byRiskLevel[riskLevel] ?? 0) + 1;
      }
      return {
        connection: { id: connection.id, uid: connection.uid },
        range,
        buckets,
      };
    },

    /** Recent tool-call events for one connection — drives App detail · Recent activity. */
listConnectionActivity: async (
      connectionId: string,
      companyId?: string,
      limit = 20,
      managementContext?: ConnectionManagementContext,
    ): Promise<ToolConnectionActivityResponse> => {
      const connection = await getConnectionRow(connectionId, companyId);
      const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
      let rows = await db
        .select()
        .from(toolCallEvents)
        .where(
          and(
            eq(toolCallEvents.companyId, connection.companyId),
            eq(toolCallEvents.connectionId, connection.id),
          ),
        )
        .orderBy(desc(toolCallEvents.createdAt))
        .limit(safeLimit);
      if (managementContext?.actor.type === "agent") {
        const management = connectionManagementService(db);
        const taskVisibility = new Map<string | null, boolean>();
        const visible: typeof rows = [];
        for (const row of rows) {
          let allowed = taskVisibility.get(row.issueId);
          if (allowed === undefined) {
            allowed = (await management.capability(managementContext.actor, "connections:audit", {
              ...managementContext.resource, connectionId: connection.id, issueId: row.issueId,
            }, { mutation: false, readContext: managementContext })).allowed;
            taskVisibility.set(row.issueId, allowed);
          }
          if (allowed) visible.push(row);
        }
        rows = visible;
      }
      const events = rows.map(toToolCallEvent);

      const issueIds = [
        ...new Set(rows.map((row) => row.issueId).filter(Boolean)),
      ] as string[];
      const issueRows = issueIds.length
        ? await db
            .select({
              id: issues.id,
              identifier: issues.identifier,
              title: issues.title,
            })
            .from(issues)
            .where(
              and(
                eq(issues.companyId, connection.companyId),
                inArray(issues.id, issueIds),
              ),
            )
        : [];
      const issueMap = Object.fromEntries(
        issueRows.map((issue) => [
          issue.id,
          {
            identifier: issue.identifier ?? issue.id,
            title: issue.title,
          },
        ]),
      );

      const actionRequestIds = [
        ...new Set(rows.map((row) => row.actionRequestId).filter(Boolean)),
      ] as string[];
      const requestRows = actionRequestIds.length
        ? await db
            .select({
              id: toolActionRequests.id,
              status: toolActionRequests.status,
              resolvedByAgentId: toolActionRequests.resolvedByAgentId,
              resolvedByUserId: toolActionRequests.resolvedByUserId,
            })
            .from(toolActionRequests)
            .where(
              and(
                eq(toolActionRequests.companyId, connection.companyId),
                inArray(toolActionRequests.id, actionRequestIds),
              ),
            )
        : [];

      const resolverAgentIds = [
        ...new Set(
          requestRows.map((row) => row.resolvedByAgentId).filter(Boolean),
        ),
      ] as string[];
      const resolverUserIds = [
        ...new Set(
          requestRows.map((row) => row.resolvedByUserId).filter(Boolean),
        ),
      ] as string[];
      const resolverAgents = resolverAgentIds.length
        ? await db
            .select({ id: agents.id, name: agents.name })
            .from(agents)
            .where(
              and(
                eq(agents.companyId, connection.companyId),
                inArray(agents.id, resolverAgentIds),
              ),
            )
        : [];
      const resolverUsers = resolverUserIds.length
        ? await db
            .select({
              id: authUsers.id,
              name: authUsers.name,
              email: authUsers.email,
            })
            .from(authUsers)
            .where(inArray(authUsers.id, resolverUserIds))
        : [];
      const resolverAgentNames = new Map(
        resolverAgents.map((agent) => [agent.id, agent.name]),
      );
      const resolverUserNames = new Map(
        resolverUsers.map((user) => [
          user.id,
          user.name?.trim() || user.email?.trim() || user.id,
        ]),
      );
      const actionRequestMap = Object.fromEntries(
        requestRows.map((request) => [
          request.id,
          {
            status: request.status,
            resolverDisplayName: request.resolvedByAgentId
              ? (resolverAgentNames.get(request.resolvedByAgentId) ??
                request.resolvedByAgentId)
              : request.resolvedByUserId
                ? (resolverUserNames.get(request.resolvedByUserId) ??
                  userFallbackName(request.resolvedByUserId))
                : null,
            resolvedByAgentId: request.resolvedByAgentId,
            resolvedByUserId: request.resolvedByUserId,
          },
        ]),
      );

      const lifecycleEvents = await listConnectionLifecycleEvents(db, {
        companyId: connection.companyId,
        connectionIds: [connection.id],
        limit: safeLimit,
      });

      return {
        connectionId: connection.id,
        events,
        lifecycleEvents,
        issues: issueMap,
        actionRequests: actionRequestMap,
      };
    },

    getRunDecisionLookup: async (
      companyId: string,
      runId: string,
    ): Promise<ToolRunDecisionLookup> => {
      const [run] = await db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.id, runId),
            eq(heartbeatRuns.companyId, companyId),
          ),
        )
        .limit(1);
      if (!run) throw notFound("Run not found");

      const invocationRows = await db
        .select()
        .from(toolInvocations)
        .where(
          and(
            eq(toolInvocations.companyId, companyId),
            eq(toolInvocations.runId, runId),
          ),
        )
        .orderBy(desc(toolInvocations.createdAt));
      const invocationIds = invocationRows.map((row) => row.id);
      const [actionRequestRows, auditEventRows] =
        invocationIds.length > 0
          ? await Promise.all([
              db
                .select()
                .from(toolActionRequests)
                .where(
                  and(
                    eq(toolActionRequests.companyId, companyId),
                    inArray(toolActionRequests.invocationId, invocationIds),
                  ),
                ),
              db
                .select()
                .from(toolCallEvents)
                .where(
                  and(
                    eq(toolCallEvents.companyId, companyId),
                    eq(toolCallEvents.runId, runId),
                    inArray(toolCallEvents.invocationId, invocationIds),
                  ),
                )
                .orderBy(desc(toolCallEvents.createdAt)),
            ])
          : [[], []];

      const actionRequestByInvocation = new Map(
        actionRequestRows.map((row) => [row.invocationId, row]),
      );
      const auditEventsByInvocation = new Map<
        string,
        (typeof toolCallEvents.$inferSelect)[]
      >();
      for (const event of auditEventRows) {
        if (!event.invocationId) continue;
        const events = auditEventsByInvocation.get(event.invocationId) ?? [];
        events.push(event);
        auditEventsByInvocation.set(event.invocationId, events);
      }

      const decisions: ToolRunDecision[] = invocationRows.map((invocation) => {
        const actionRequest =
          actionRequestByInvocation.get(invocation.id) ?? null;
        const auditEvents = auditEventsByInvocation.get(invocation.id) ?? [];
        const latestAuditEvent = auditEvents[0] ?? null;
        const apiInvocation = toToolInvocation(invocation);
        const apiActionRequest = actionRequest
          ? toToolActionRequest(actionRequest)
          : null;
        const apiAuditEvents = auditEvents.map(toToolCallEvent);
        const apiLatestAuditEvent = latestAuditEvent
          ? toToolCallEvent(latestAuditEvent)
          : null;
        const pendingAction =
          actionRequest && actionRequest.status === "pending"
            ? {
                actionRequestId: actionRequest.id,
                issueId: actionRequest.issueId,
                interactionId: actionRequest.interactionId,
                approvalId: actionRequest.approvalId,
                status: actionRequest.status,
                previewMarkdown: actionRequest.previewMarkdown,
              }
            : null;
        return {
          invocation: apiInvocation,
          actionRequest: apiActionRequest,
          auditEvents: apiAuditEvents,
          latestAuditEvent: apiLatestAuditEvent,
          decision: latestAuditEvent?.decision ?? invocation.policyDecision,
          outcome: latestAuditEvent?.outcome ?? null,
          reasonCode: latestAuditEvent?.reasonCode ?? invocation.errorCode,
          denialReason: denialReasonForDecision(invocation, latestAuditEvent),
          pendingAction,
        } satisfies ToolRunDecision;
      });

      return { runId, decisions };
    }
  };
}
