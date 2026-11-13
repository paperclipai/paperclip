import { issues } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { LOW_TRUST_REVIEW_PRESET, LOW_TRUST_REVIEW_PRESET_VERSION, LOW_TRUST_REVIEW_RAW_OUTPUT_DISPOSITION } from "@paperclipai/shared";
import type { DbOrTransaction, EndpointRow } from "../runtime-types.js";

function policyRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export async function applyChatTaskReviewContainment(taskTx: DbOrTransaction, endpoint: EndpointRow, issue: typeof issues.$inferSelect): Promise<void> {
  const reviewPreset = {
    id: LOW_TRUST_REVIEW_PRESET,
    version: LOW_TRUST_REVIEW_PRESET_VERSION,
    rawOutputDisposition: LOW_TRUST_REVIEW_RAW_OUTPUT_DISPOSITION,
  } as const;
  await taskTx
    .update(issues)
    .set({
      sourceTrust: {
        preset: LOW_TRUST_REVIEW_PRESET,
        disposition: "quarantined",
        sourceIssueId: issue.id,
      },
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [],
        ...issue.executionPolicy,
        reviewPreset,
        authorizationPolicy: {
          ...policyRecord(issue.executionPolicy?.authorizationPolicy),
          trustPreset: LOW_TRUST_REVIEW_PRESET,
          reviewPreset,
          trustBoundary: {
            mode: LOW_TRUST_REVIEW_PRESET,
            companyId: endpoint.companyId,
            rootIssueId: issue.id,
            issueIds: [issue.id],
            allowedAgentIds: [endpoint.assignedAgentId],
            allowedToolClasses: [
              "git.read",
              "github.pr.read",
              "tests.local",
            ],
            ...policyRecord(policyRecord(issue.executionPolicy?.authorizationPolicy)?.trustBoundary),
          },
        },
      },
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(issues.id, issue.id),
        eq(issues.companyId, endpoint.companyId),
      ),
    );
}
