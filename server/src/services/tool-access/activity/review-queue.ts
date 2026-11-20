import { writeToolReviewChange } from "../../tool-review-work-notifications.js";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { toolApplications, toolActionRequests, toolCatalogEntries, toolConnections, toolInvocations } from "@paperclipai/db";
import type { ToolActionRequestListItem, ToolActionRequestStatus } from "@paperclipai/shared";
import { readSignedToolArgumentsPayload, TOOL_ACTION_REQUEST_SIGNING_GRACE_MS } from "../../tool-content-guards.js";
import { toToolActionRequest } from "./projection.js";
/** Pending requests stay hidden until signing completes; invalid signatures are cancelled. */
export function createToolActionReviewQueue(db: Db) {
  return {
    /**
     * List "Ask first" action requests for the review queue, enriched with the
     * connection/app context the prosumer card renders. Defaults to pending.
     */
listActionRequests: async (
      companyId: string,
      status: ToolActionRequestStatus = "pending",
    ): Promise<ToolActionRequestListItem[]> => {
      const requests = await db
        .select()
        .from(toolActionRequests)
        .where(
          and(
            eq(toolActionRequests.companyId, companyId),
            eq(toolActionRequests.status, status),
          ),
        )
        .orderBy(desc(toolActionRequests.createdAt));
      if (requests.length === 0) return [];

      const invocationIds = [
        ...new Set(requests.map((request) => request.invocationId)),
      ];
      const invocations = await db
        .select()
        .from(toolInvocations)
        .where(
          and(
            eq(toolInvocations.companyId, companyId),
            inArray(toolInvocations.id, invocationIds),
          ),
        );
      const invocationById = new Map(
        invocations.map((invocation) => [invocation.id, invocation]),
      );
      let visibleRequests = requests;
      if (status === "pending") {
        // A pending request that the creator has not signed yet is still being
        // set up. The gateway creates the row (signedArguments = null) and signs
        // it in a second step, so a review-queue read can observe the row inside
        // that window. Hide such a request from the queue, but do not cancel it —
        // cancelling here races the two-step create and makes the later approve
        // fail with action_not_pending. Only cancel a request that carries a
        // signature we cannot verify (secret rotation or tampering), or an
        // unsigned row whose creator has exceeded the signing grace period.
        const unsignedRequestIds = new Set<string>();
        const invalidRequestIds: string[] = [];
        for (const request of requests) {
          const invocation = invocationById.get(request.invocationId);
          if (!invocation) {
            invalidRequestIds.push(request.id);
            continue;
          }
          if (request.signedArguments === null) {
            if (
              Date.now() - request.createdAt.getTime() >=
              TOOL_ACTION_REQUEST_SIGNING_GRACE_MS
            ) {
              invalidRequestIds.push(request.id);
            } else {
              unsignedRequestIds.add(request.id);
            }
            continue;
          }
          let readable = false;
          try {
            readable = Boolean(
              readSignedToolArgumentsPayload({
                signedArguments: request.signedArguments,
                invocationId: invocation.id,
                toolName: invocation.toolName,
              }),
            );
          } catch {
            readable = false;
          }
          if (!readable) invalidRequestIds.push(request.id);
        }
        if (invalidRequestIds.length > 0) {
          await writeToolReviewChange(db, companyId, tx => tx
            .update(toolActionRequests)
            .set({
              status: "cancelled",
              resolvedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(toolActionRequests.companyId, companyId),
                eq(toolActionRequests.status, "pending"),
                inArray(toolActionRequests.id, invalidRequestIds),
              ),
            ));
        }
        const hiddenIds = new Set([
          ...invalidRequestIds,
          ...unsignedRequestIds,
        ]);
        if (hiddenIds.size > 0) {
          visibleRequests = requests.filter(
            (request) => !hiddenIds.has(request.id),
          );
        }
      }
      if (visibleRequests.length === 0) return [];

      const visibleInvocations = visibleRequests
        .map((request) => invocationById.get(request.invocationId))
        .filter(
          (invocation): invocation is typeof toolInvocations.$inferSelect =>
            Boolean(invocation),
        );
      const connectionIds = [
        ...new Set(
          visibleInvocations
            .map((invocation) => invocation.connectionId)
            .filter(Boolean),
        ),
      ] as string[];
      const connections = connectionIds.length
        ? await db
            .select()
            .from(toolConnections)
            .where(inArray(toolConnections.id, connectionIds))
        : [];
      const connectionById = new Map(
        connections.map((connection) => [connection.id, connection]),
      );

      const applicationIds = [
        ...new Set(
          connections
            .map((connection) => connection.applicationId)
            .filter(Boolean),
        ),
      ] as string[];
      const applications = applicationIds.length
        ? await db
            .select()
            .from(toolApplications)
            .where(inArray(toolApplications.id, applicationIds))
        : [];
      const applicationById = new Map(
        applications.map((application) => [application.id, application]),
      );

      const catalogEntryIds = [
        ...new Set(
          visibleInvocations
            .map((invocation) => invocation.catalogEntryId)
            .filter(Boolean),
        ),
      ] as string[];
      const catalogEntries = catalogEntryIds.length
        ? await db
            .select()
            .from(toolCatalogEntries)
            .where(inArray(toolCatalogEntries.id, catalogEntryIds))
        : [];
      const catalogById = new Map(
        catalogEntries.map((entry) => [entry.id, entry]),
      );

      return visibleRequests.map((request) => {
        const invocation = invocationById.get(request.invocationId);
        const connection = invocation?.connectionId
          ? connectionById.get(invocation.connectionId)
          : undefined;
        const application = connection?.applicationId
          ? applicationById.get(connection.applicationId)
          : undefined;
        const catalogEntry = invocation?.catalogEntryId
          ? catalogById.get(invocation.catalogEntryId)
          : undefined;
        return {
          request: toToolActionRequest(request),
          toolName: invocation?.toolName ?? catalogEntry?.toolName ?? "",
          toolTitle: catalogEntry?.title ?? null,
          connectionId: connection?.id ?? invocation?.connectionId ?? null,
          connectionName: connection?.name ?? null,
          applicationName: application?.name ?? null,
          riskLevel: catalogEntry?.riskLevel ?? null,
          requestedByAgentId: request.requestedByAgentId ?? null,
        };
      });
    }
  };
}
