import { and, eq, inArray } from "drizzle-orm";
import { approvals, issues } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { workProductService } from "./work-products.js";

export interface NotifyKatyaPublishApprovedInput {
  companyId: string;
  approvalId: string;
  approvalType: string;
  requestedByAgentId: string | null;
  linkedIssueIds: string[];
}

function extractScheduledTime(payload: Record<string, unknown> | null | undefined): string | null {
  if (!payload) return null;
  const directCandidates = [
    payload.targetPublishAt,
    payload.publishAt,
    payload.scheduledTime,
    payload.scheduledFor,
    payload.publishWindow,
  ];
  for (const candidate of directCandidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  const windowCandidate = payload.publishWindow;
  if (windowCandidate && typeof windowCandidate === "object") {
    const windowObj = windowCandidate as Record<string, unknown>;
    const start = typeof windowObj.start === "string" ? windowObj.start.trim() : "";
    const end = typeof windowObj.end === "string" ? windowObj.end.trim() : "";
    if (start && end) return `${start} - ${end}`;
    if (start) return start;
  }
  return null;
}

/**
 * Hook for Katya publish integration when approvals are approved.
 *
 * Ensures launch checklist metadata is pre-seeded with scheduling data and
 * emits a runtime_service work product for the publish executor to pick up.
 */
export async function notifyKatyaPublishApproved(
  db: Db,
  input: NotifyKatyaPublishApprovedInput,
): Promise<void> {
  if (input.linkedIssueIds.length === 0) return;

  const approvalRow = await db
    .select({ payload: approvals.payload })
    .from(approvals)
    .where(and(eq(approvals.id, input.approvalId), eq(approvals.companyId, input.companyId)))
    .then((rows) => rows[0] ?? null);
  const approvalPayload = (approvalRow?.payload ?? {}) as Record<string, unknown>;
  const scheduledTime = extractScheduledTime(approvalPayload);

  const issueRows = await db
    .select({ id: issues.id, projectId: issues.projectId })
    .from(issues)
    .where(and(eq(issues.companyId, input.companyId), inArray(issues.id, input.linkedIssueIds)));

  const workProductsSvc = workProductService(db);

  for (const issue of issueRows) {
    const workProducts = await workProductsSvc.listForIssue(issue.id);
    const launchChecklist = workProducts.find((product) => product.externalId === "launch_checklist_v1") ?? null;
    const publishExecutor = workProducts.find((product) => product.externalId === "katya_publish_executor_v1") ?? null;

    if (scheduledTime) {
      if (launchChecklist) {
        const metadata = (launchChecklist.metadata ?? {}) as Record<string, unknown>;
        if (typeof metadata.scheduledTime !== "string" || metadata.scheduledTime.trim().length === 0) {
          await workProductsSvc.update(launchChecklist.id, {
            metadata: { ...metadata, scheduledTime },
          });
        }
      } else {
        await workProductsSvc.createForIssue(issue.id, input.companyId, {
          projectId: issue.projectId ?? null,
          type: "document",
          provider: "custom",
          externalId: "launch_checklist_v1",
          title: "Launch checklist",
          status: "active",
          reviewState: "none",
          metadata: {
            copyFinal: false,
            linksValid: false,
            scheduledTime,
            proofLine: null,
            sentLedgerEntry: null,
            proof: {
              urlOrPostId: null,
              timestamp: null,
              platformChannel: null,
            },
          },
        });
      }
    }

    const executorMetadata = {
      approvalId: input.approvalId,
      approvalType: input.approvalType,
      requestedByAgentId: input.requestedByAgentId,
      scheduledTime: scheduledTime ?? null,
    };

    if (publishExecutor) {
      await workProductsSvc.update(publishExecutor.id, {
        status: "active",
        summary: "Queued for publish executor",
        metadata: { ...(publishExecutor.metadata ?? {}), ...executorMetadata },
      });
    } else {
      await workProductsSvc.createForIssue(issue.id, input.companyId, {
        projectId: issue.projectId ?? null,
        type: "runtime_service",
        provider: "katya_publish_executor",
        externalId: "katya_publish_executor_v1",
        title: "Katya publish executor",
        status: "active",
        reviewState: "none",
        summary: "Queued for publish executor",
        metadata: executorMetadata,
      });
    }
  }
}
