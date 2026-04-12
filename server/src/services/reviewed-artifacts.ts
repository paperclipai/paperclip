import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { reviewedArtifactItems, reviewedArtifactSets } from "@paperclipai/db";
import {
  createReviewedArtifactSetSchema,
  type CreateReviewedArtifactSet,
  type ReviewedArtifactItem,
  type ReviewedArtifactSet,
  type ReviewedArtifactSource,
} from "@paperclipai/shared";

type ReviewedArtifactSetRow = typeof reviewedArtifactSets.$inferSelect;
type ReviewedArtifactItemRow = typeof reviewedArtifactItems.$inferSelect;

function requireValue(value: string | null, field: string, itemId: string): string {
  if (value) return value;
  throw new Error(`Reviewed artifact item ${itemId} is missing ${field}`);
}

function toReviewedArtifactSource(row: ReviewedArtifactItemRow): ReviewedArtifactSource {
  switch (row.sourceType) {
    case "issue_document":
      return {
        type: row.sourceType,
        issueId: requireValue(row.sourceIssueId, "sourceIssueId", row.id),
        documentKey: requireValue(row.sourceDocumentKey, "sourceDocumentKey", row.id),
        revisionId: row.sourceDocumentRevisionId ?? null,
      };
    case "issue_attachment":
      return {
        type: row.sourceType,
        issueId: requireValue(row.sourceIssueId, "sourceIssueId", row.id),
        attachmentId: requireValue(row.sourceIssueAttachmentId, "sourceIssueAttachmentId", row.id),
      };
    case "issue_work_product":
      return {
        type: row.sourceType,
        issueId: requireValue(row.sourceIssueId, "sourceIssueId", row.id),
        workProductId: requireValue(row.sourceIssueWorkProductId, "sourceIssueWorkProductId", row.id),
      };
    case "external_url":
      return {
        type: row.sourceType,
        url: requireValue(row.sourceExternalUrl, "sourceExternalUrl", row.id),
      };
    case "approval_payload":
      return {
        type: row.sourceType,
        pointer: requireValue(row.sourceApprovalPayloadPointer, "sourceApprovalPayloadPointer", row.id),
      };
    case "workspace_file":
      return {
        type: row.sourceType,
        issueId: requireValue(row.sourceIssueId, "sourceIssueId", row.id),
        executionWorkspaceId: requireValue(row.sourceExecutionWorkspaceId, "sourceExecutionWorkspaceId", row.id),
        runId: row.sourceRunId ?? null,
        path: requireValue(row.sourceWorkspacePath, "sourceWorkspacePath", row.id),
      };
  }
}

function toReviewedArtifactItem(row: ReviewedArtifactItemRow): ReviewedArtifactItem {
  return {
    id: row.id,
    companyId: row.companyId,
    setId: row.setId,
    orderIndex: row.orderIndex,
    sourceType: row.sourceType,
    source: toReviewedArtifactSource(row),
    title: row.title ?? null,
    description: row.description ?? null,
    displayHint: row.displayHint ?? null,
    isPrimary: row.isPrimary,
    required: row.required,
    selectedExplicitly: row.selectedExplicitly,
    metadata: row.metadata ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toReviewedArtifactSet(row: ReviewedArtifactSetRow, items: ReviewedArtifactItem[]): ReviewedArtifactSet {
  return {
    id: row.id,
    companyId: row.companyId,
    contextType: row.contextType,
    contextIssueId: row.contextIssueId ?? null,
    approvalId: row.approvalId ?? null,
    selectionMode: row.selectionMode,
    title: row.title ?? null,
    description: row.description ?? null,
    supersededBySetId: row.supersededBySetId ?? null,
    supersededAt: row.supersededAt ?? null,
    createdByAgentId: row.createdByAgentId ?? null,
    createdByUserId: row.createdByUserId ?? null,
    createdByRunId: row.createdByRunId ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    items,
  };
}

function sourceToColumns(source: ReviewedArtifactSource) {
  const base = {
    sourceIssueId: null as string | null,
    sourceDocumentKey: null as string | null,
    sourceDocumentRevisionId: null as string | null,
    sourceIssueAttachmentId: null as string | null,
    sourceIssueWorkProductId: null as string | null,
    sourceExternalUrl: null as string | null,
    sourceApprovalPayloadPointer: null as string | null,
    sourceExecutionWorkspaceId: null as string | null,
    sourceRunId: null as string | null,
    sourceWorkspacePath: null as string | null,
  };

  switch (source.type) {
    case "issue_document":
      return {
        ...base,
        sourceIssueId: source.issueId,
        sourceDocumentKey: source.documentKey,
        sourceDocumentRevisionId: source.revisionId ?? null,
      };
    case "issue_attachment":
      return {
        ...base,
        sourceIssueId: source.issueId,
        sourceIssueAttachmentId: source.attachmentId,
      };
    case "issue_work_product":
      return {
        ...base,
        sourceIssueId: source.issueId,
        sourceIssueWorkProductId: source.workProductId,
      };
    case "external_url":
      return {
        ...base,
        sourceExternalUrl: source.url,
      };
    case "approval_payload":
      return {
        ...base,
        sourceApprovalPayloadPointer: source.pointer,
      };
    case "workspace_file":
      return {
        ...base,
        sourceIssueId: source.issueId,
        sourceExecutionWorkspaceId: source.executionWorkspaceId,
        sourceRunId: source.runId ?? null,
        sourceWorkspacePath: source.path,
      };
  }
}

async function getSetWithItems(queryDb: any, setId: string) {
  const set = await queryDb
    .select()
    .from(reviewedArtifactSets)
    .where(eq(reviewedArtifactSets.id, setId))
    .then((rows: ReviewedArtifactSetRow[]) => rows[0] ?? null);
  if (!set) return null;

  const items = await queryDb
    .select()
    .from(reviewedArtifactItems)
    .where(eq(reviewedArtifactItems.setId, setId))
    .orderBy(asc(reviewedArtifactItems.orderIndex), asc(reviewedArtifactItems.createdAt))
    .then((rows: ReviewedArtifactItemRow[]) => rows.map(toReviewedArtifactItem));

  return toReviewedArtifactSet(set, items);
}

function activeContextConditions(input: CreateReviewedArtifactSet | { companyId: string; context: { type: "issue_review"; issueId: string } | { type: "approval"; approvalId: string } }) {
  const contextConditions = input.context.type === "issue_review"
    ? [
        eq(reviewedArtifactSets.contextType, "issue_review"),
        eq(reviewedArtifactSets.contextIssueId, input.context.issueId),
      ]
    : [
        eq(reviewedArtifactSets.contextType, "approval"),
        eq(reviewedArtifactSets.approvalId, input.context.approvalId),
      ];
  return [
    eq(reviewedArtifactSets.companyId, input.companyId),
    isNull(reviewedArtifactSets.supersededAt),
    ...contextConditions,
  ];
}

export function reviewedArtifactService(db: Db) {
  return {
    getById: (setId: string) => getSetWithItems(db, setId),

    getActiveForIssueReview: async (companyId: string, issueId: string) => {
      const set = await db
        .select()
        .from(reviewedArtifactSets)
        .where(and(...activeContextConditions({
          companyId,
          context: { type: "issue_review", issueId },
        })))
        .orderBy(desc(reviewedArtifactSets.createdAt))
        .then((rows) => rows[0] ?? null);
      return set ? getSetWithItems(db, set.id) : null;
    },

    getActiveForApproval: async (companyId: string, approvalId: string) => {
      const set = await db
        .select()
        .from(reviewedArtifactSets)
        .where(and(...activeContextConditions({
          companyId,
          context: { type: "approval", approvalId },
        })))
        .orderBy(desc(reviewedArtifactSets.createdAt))
        .then((rows) => rows[0] ?? null);
      return set ? getSetWithItems(db, set.id) : null;
    },

    createSet: async (input: CreateReviewedArtifactSet) => {
      const data = createReviewedArtifactSetSchema.parse(input);
      const now = new Date();
      const setId = randomUUID();

      return db.transaction(async (tx) => {
        const supersededRows = data.selectionMode === "explicit"
          ? await tx
              .update(reviewedArtifactSets)
              .set({ supersededAt: now, updatedAt: now })
              .where(and(
                ...activeContextConditions(data),
                eq(reviewedArtifactSets.selectionMode, "explicit"),
              ))
              .returning({ id: reviewedArtifactSets.id })
          : [];

        await tx.insert(reviewedArtifactSets).values({
          id: setId,
          companyId: data.companyId,
          contextType: data.context.type,
          contextIssueId: data.context.type === "issue_review" ? data.context.issueId : data.context.issueId ?? null,
          approvalId: data.context.type === "approval" ? data.context.approvalId : null,
          selectionMode: data.selectionMode,
          title: data.title ?? null,
          description: data.description ?? null,
          createdByAgentId: data.createdByAgentId ?? null,
          createdByUserId: data.createdByUserId ?? null,
          createdByRunId: data.createdByRunId ?? null,
          createdAt: now,
          updatedAt: now,
        });

        if (supersededRows.length > 0) {
          await tx
            .update(reviewedArtifactSets)
            .set({ supersededBySetId: setId, updatedAt: now })
            .where(inArray(reviewedArtifactSets.id, supersededRows.map((row) => row.id)));
        }

        if (data.items.length > 0) {
          await tx.insert(reviewedArtifactItems).values(data.items.map((item, index) => ({
            id: randomUUID(),
            companyId: data.companyId,
            setId,
            orderIndex: index,
            sourceType: item.source.type,
            ...sourceToColumns(item.source),
            title: item.title ?? null,
            description: item.description ?? null,
            displayHint: item.displayHint ?? null,
            isPrimary: item.isPrimary,
            required: item.required,
            selectedExplicitly: item.selectedExplicitly,
            metadata: item.metadata ?? null,
            createdAt: now,
            updatedAt: now,
          })));
        }

        const created = await getSetWithItems(tx, setId);
        if (!created) {
          throw new Error("Failed to create reviewed artifact set");
        }
        return created;
      });
    },
  };
}
