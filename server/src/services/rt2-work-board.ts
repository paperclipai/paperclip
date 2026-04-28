import { createHash } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  issueWorkProducts,
  issues,
  rt2CaptureDrafts,
  rt2WorkBoardAttachments,
  rt2WorkBoardCards,
  rt2WorkBoardChecklistItems,
} from "@paperclipai/db";
import {
  buildOneLinerTaskDescription,
  parseOneLinerInput,
  type CreateOneLinerInboundDraft,
  type CreateRt2BoardAttachment,
  type CreateRt2BoardChecklistItem,
  type PromoteRt2CaptureDraft,
  type UpdateRt2BoardCard,
  type UpdateRt2BoardChecklistItem,
} from "@paperclipai/shared";
import { conflict, notFound } from "../errors.js";
import { issueService } from "./issues.js";
import { rt2TaskEngineService } from "./rt2-task-engine.js";
import { workProductService } from "./work-products.js";

type ChecklistRow = typeof rt2WorkBoardChecklistItems.$inferSelect;
type AttachmentRow = typeof rt2WorkBoardAttachments.$inferSelect;
type CardRow = typeof rt2WorkBoardCards.$inferSelect;
type CaptureRow = typeof rt2CaptureDrafts.$inferSelect;

function normalizeHash(input: string) {
  return createHash("sha256").update(input.trim().replace(/\s+/g, " ").toLowerCase()).digest("hex");
}

function toChecklist(row: ChecklistRow) {
  return {
    id: row.id,
    issueId: row.issueId,
    title: row.title,
    checked: row.checked === 1,
    position: row.position,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toAttachment(row: AttachmentRow) {
  return {
    id: row.id,
    issueId: row.issueId,
    label: row.label,
    url: row.url,
    contentType: row.contentType ?? null,
    previewKind: row.previewKind as "link" | "image" | "document",
    position: row.position,
  };
}

function toCaptureDraft(row: CaptureRow) {
  return {
    id: row.id,
    companyId: row.companyId,
    source: row.source as "slack" | "teams" | "webhook" | "mobile" | "native",
    channel: row.channel ?? null,
    externalUserId: row.externalUserId ?? null,
    rawText: row.rawText,
    parsedDraft: row.parsedDraft as Record<string, unknown>,
    status: row.status as "review_required" | "duplicate" | "permission_blocked" | "failed" | "promoted" | "discarded",
    promotionTarget: row.promotionTarget as "task" | "todo" | "deliverable" | null,
    promotedIssueId: row.promotedIssueId ?? null,
    promotedWorkProductId: row.promotedWorkProductId ?? null,
    duplicateOfDraftId: row.duplicateOfDraftId ?? null,
    failureCode: row.failureCode ?? null,
    failureMessage: row.failureMessage ?? null,
    permissionStatus: row.permissionStatus as "allowed" | "missing_external_user" | "blocked",
    auditTrail: row.auditTrail ?? [],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function cardSummary(row: CardRow | undefined, checklist: ReturnType<typeof toChecklist>[], attachments: ReturnType<typeof toAttachment>[]) {
  const checklistDone = checklist.filter((item) => item.checked).length;
  const checklistTotal = checklist.length;
  return {
    issueId: row?.issueId ?? "",
    dueDate: row?.dueDate ?? null,
    qualityStatus: (row?.qualityStatus ?? "none") as "none" | "pending_review" | "reviewed" | "needs_work",
    priceGold: row?.priceGold ?? null,
    detailNotes: row?.detailNotes ?? null,
    checklist,
    attachments,
    checklistDone,
    checklistTotal,
    checklistProgress: checklistTotal === 0 ? 0 : Math.round((checklistDone / checklistTotal) * 100),
  };
}

function appendAudit(row: CaptureRow, action: string, actorUserId: string, details: Record<string, unknown> = {}) {
  return [
    ...(row.auditTrail ?? []),
    {
      action,
      actorUserId,
      details,
      at: new Date().toISOString(),
    },
  ];
}

export function rt2WorkBoardService(db: Db) {
  const tasks = rt2TaskEngineService(db);
  const workProducts = workProductService(db);
  const issuesSvc = issueService(db);

  async function assertIssue(companyId: string, issueId: string) {
    const issue = await issuesSvc.getById(issueId);
    if (!issue || issue.companyId !== companyId) {
      throw notFound("RT2 board card not found");
    }
    return issue;
  }

  async function ensureCard(companyId: string, issueId: string, actorUserId?: string) {
    await db
      .insert(rt2WorkBoardCards)
      .values({ companyId, issueId, updatedByUserId: actorUserId ?? null })
      .onConflictDoNothing();
  }

  async function getCaptureRow(companyId: string, draftId: string) {
    const row = await db
      .select()
      .from(rt2CaptureDrafts)
      .where(and(eq(rt2CaptureDrafts.companyId, companyId), eq(rt2CaptureDrafts.id, draftId)))
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("RT2 capture draft not found");
    return row;
  }

  return {
    getBoardOverview: async (companyId: string, issueIds: string[]) => {
      const uniqueIssueIds = [...new Set(issueIds)].filter(Boolean);
      if (uniqueIssueIds.length === 0) {
        return {
          companyId,
          cards: [],
          filters: { lanes: [], assigneeIds: [], okrIds: [], qualityStatuses: [], due: [] },
        };
      }

      const [cardRows, checklistRows, attachmentRows, issueRows] = await Promise.all([
        db.select().from(rt2WorkBoardCards).where(and(eq(rt2WorkBoardCards.companyId, companyId), inArray(rt2WorkBoardCards.issueId, uniqueIssueIds))),
        db.select().from(rt2WorkBoardChecklistItems).where(and(eq(rt2WorkBoardChecklistItems.companyId, companyId), inArray(rt2WorkBoardChecklistItems.issueId, uniqueIssueIds))).orderBy(rt2WorkBoardChecklistItems.position),
        db.select().from(rt2WorkBoardAttachments).where(and(eq(rt2WorkBoardAttachments.companyId, companyId), inArray(rt2WorkBoardAttachments.issueId, uniqueIssueIds))).orderBy(rt2WorkBoardAttachments.position),
        db.select({
          id: issues.id,
          status: issues.status,
          assigneeAgentId: issues.assigneeAgentId,
          assigneeUserId: issues.assigneeUserId,
          goalId: issues.goalId,
        }).from(issues).where(and(eq(issues.companyId, companyId), inArray(issues.id, uniqueIssueIds))),
      ]);

      const cardsByIssue = new Map(cardRows.map((row) => [row.issueId, row]));
      const checklistByIssue = new Map<string, ReturnType<typeof toChecklist>[]>();
      for (const row of checklistRows) {
        const bucket = checklistByIssue.get(row.issueId) ?? [];
        bucket.push(toChecklist(row));
        checklistByIssue.set(row.issueId, bucket);
      }
      const attachmentsByIssue = new Map<string, ReturnType<typeof toAttachment>[]>();
      for (const row of attachmentRows) {
        const bucket = attachmentsByIssue.get(row.issueId) ?? [];
        bucket.push(toAttachment(row));
        attachmentsByIssue.set(row.issueId, bucket);
      }

      const today = new Date().toISOString().slice(0, 10);
      const due = new Set<"overdue" | "today" | "upcoming" | "none">();
      const qualityStatuses = new Set<"none" | "pending_review" | "reviewed" | "needs_work">();
      const laneSet = new Set<string>();
      const assigneeSet = new Set<string>();
      const okrSet = new Set<string>();

      for (const issue of issueRows) {
        laneSet.add(issue.status);
        if (issue.assigneeAgentId) assigneeSet.add(issue.assigneeAgentId);
        if (issue.assigneeUserId) assigneeSet.add(`user:${issue.assigneeUserId}`);
        if (issue.goalId) okrSet.add(issue.goalId);
        const card = cardsByIssue.get(issue.id);
        const dueDate = card?.dueDate ?? null;
        if (!dueDate) due.add("none");
        else if (dueDate < today) due.add("overdue");
        else if (dueDate === today) due.add("today");
        else due.add("upcoming");
        qualityStatuses.add((card?.qualityStatus ?? "none") as "none" | "pending_review" | "reviewed" | "needs_work");
      }

      return {
        companyId,
        cards: uniqueIssueIds.map((issueId) => ({
          ...cardSummary(cardsByIssue.get(issueId), checklistByIssue.get(issueId) ?? [], attachmentsByIssue.get(issueId) ?? []),
          issueId,
        })),
        filters: {
          lanes: [...laneSet],
          assigneeIds: [...assigneeSet],
          okrIds: [...okrSet],
          qualityStatuses: [...qualityStatuses],
          due: [...due],
        },
      };
    },

    updateCard: async (companyId: string, issueId: string, actorUserId: string, input: UpdateRt2BoardCard) => {
      await assertIssue(companyId, issueId);
      await ensureCard(companyId, issueId, actorUserId);
      const [row] = await db
        .update(rt2WorkBoardCards)
        .set({
          dueDate: input.dueDate === undefined ? undefined : input.dueDate,
          qualityStatus: input.qualityStatus,
          priceGold: input.priceGold === undefined ? undefined : input.priceGold,
          detailNotes: input.detailNotes === undefined ? undefined : input.detailNotes,
          updatedByUserId: actorUserId,
          updatedAt: new Date(),
        })
        .where(and(eq(rt2WorkBoardCards.companyId, companyId), eq(rt2WorkBoardCards.issueId, issueId)))
        .returning();
      return row;
    },

    addChecklistItem: async (companyId: string, issueId: string, actorUserId: string, input: CreateRt2BoardChecklistItem) => {
      await assertIssue(companyId, issueId);
      await ensureCard(companyId, issueId, actorUserId);
      const [{ nextPosition }] = await db
        .select({ nextPosition: sql<number>`coalesce(max(${rt2WorkBoardChecklistItems.position}), -1) + 1` })
        .from(rt2WorkBoardChecklistItems)
        .where(and(eq(rt2WorkBoardChecklistItems.companyId, companyId), eq(rt2WorkBoardChecklistItems.issueId, issueId)));
      const [row] = await db
        .insert(rt2WorkBoardChecklistItems)
        .values({ companyId, issueId, title: input.title, position: nextPosition, createdByUserId: actorUserId })
        .returning();
      return toChecklist(row);
    },

    updateChecklistItem: async (companyId: string, issueId: string, itemId: string, input: UpdateRt2BoardChecklistItem) => {
      await assertIssue(companyId, issueId);
      const [row] = await db
        .update(rt2WorkBoardChecklistItems)
        .set({
          title: input.title,
          checked: input.checked === undefined ? undefined : input.checked ? 1 : 0,
          updatedAt: new Date(),
        })
        .where(and(eq(rt2WorkBoardChecklistItems.companyId, companyId), eq(rt2WorkBoardChecklistItems.issueId, issueId), eq(rt2WorkBoardChecklistItems.id, itemId)))
        .returning();
      if (!row) throw notFound("RT2 checklist item not found");
      return toChecklist(row);
    },

    reorderChecklist: async (companyId: string, issueId: string, orderedItemIds: string[]) => {
      await assertIssue(companyId, issueId);
      await db.transaction(async (tx) => {
        for (const [position, itemId] of orderedItemIds.entries()) {
          await tx
            .update(rt2WorkBoardChecklistItems)
            .set({ position, updatedAt: new Date() })
            .where(and(eq(rt2WorkBoardChecklistItems.companyId, companyId), eq(rt2WorkBoardChecklistItems.issueId, issueId), eq(rt2WorkBoardChecklistItems.id, itemId)));
        }
      });
      const rows = await db
        .select()
        .from(rt2WorkBoardChecklistItems)
        .where(and(eq(rt2WorkBoardChecklistItems.companyId, companyId), eq(rt2WorkBoardChecklistItems.issueId, issueId)))
        .orderBy(rt2WorkBoardChecklistItems.position);
      return rows.map(toChecklist);
    },

    addAttachment: async (companyId: string, issueId: string, actorUserId: string, input: CreateRt2BoardAttachment) => {
      await assertIssue(companyId, issueId);
      await ensureCard(companyId, issueId, actorUserId);
      const previewKind = input.contentType?.startsWith("image/") ? "image" : input.contentType?.includes("pdf") ? "document" : "link";
      const [{ nextPosition }] = await db
        .select({ nextPosition: sql<number>`coalesce(max(${rt2WorkBoardAttachments.position}), -1) + 1` })
        .from(rt2WorkBoardAttachments)
        .where(and(eq(rt2WorkBoardAttachments.companyId, companyId), eq(rt2WorkBoardAttachments.issueId, issueId)));
      const [row] = await db
        .insert(rt2WorkBoardAttachments)
        .values({ companyId, issueId, label: input.label, url: input.url, contentType: input.contentType ?? null, previewKind, position: nextPosition, createdByUserId: actorUserId })
        .returning();
      return toAttachment(row);
    },

    createInboundDraft: async (companyId: string, actorUserId: string, input: CreateOneLinerInboundDraft) => {
      const parsed = parseOneLinerInput(input.text);
      const hash = normalizeHash(input.text);
      const duplicate = await db
        .select({ id: rt2CaptureDrafts.id })
        .from(rt2CaptureDrafts)
        .where(and(
          eq(rt2CaptureDrafts.companyId, companyId),
          eq(rt2CaptureDrafts.source, input.source),
          eq(rt2CaptureDrafts.normalizedHash, hash),
        ))
        .then((rows) => rows[0] ?? null);
      const permissionStatus = (input.source === "mobile" || input.source === "native") && !input.externalUserId
        ? "missing_external_user"
        : "allowed";
      const status = duplicate ? "duplicate" : permissionStatus === "allowed" ? "review_required" : "permission_blocked";
      const [row] = await db
        .insert(rt2CaptureDrafts)
        .values({
          companyId,
          source: input.source,
          channel: input.channel ?? null,
          externalUserId: input.externalUserId ?? null,
          rawText: input.text,
          normalizedHash: hash,
          parsedDraft: parsed as unknown as Record<string, unknown>,
          status,
          duplicateOfDraftId: duplicate?.id ?? null,
          permissionStatus,
          createdByUserId: actorUserId,
          auditTrail: [{
            action: "captured",
            actorUserId,
            details: { source: input.source, duplicateOfDraftId: duplicate?.id ?? null, permissionStatus },
            at: new Date().toISOString(),
          }],
        })
        .returning();
      return toCaptureDraft(row);
    },

    listCaptureQueue: async (companyId: string) => {
      const rows = await db
        .select()
        .from(rt2CaptureDrafts)
        .where(eq(rt2CaptureDrafts.companyId, companyId))
        .orderBy(desc(rt2CaptureDrafts.createdAt))
        .limit(80);
      const drafts = rows.map(toCaptureDraft);
      return {
        companyId,
        summary: {
          reviewRequired: drafts.filter((draft) => draft.status === "review_required").length,
          duplicate: drafts.filter((draft) => draft.status === "duplicate").length,
          permissionBlocked: drafts.filter((draft) => draft.status === "permission_blocked").length,
          failed: drafts.filter((draft) => draft.status === "failed").length,
          promoted: drafts.filter((draft) => draft.status === "promoted").length,
        },
        drafts,
      };
    },

    promoteCaptureDraft: async (companyId: string, draftId: string, actorUserId: string, input: PromoteRt2CaptureDraft) => {
      const row = await getCaptureRow(companyId, draftId);
      if (row.status !== "review_required") {
        throw conflict("RT2_CAPTURE_DRAFT_NOT_PROMOTABLE");
      }
      const draft = parseOneLinerInput(row.rawText);
      let promotedIssueId: string | null = null;
      let promotedWorkProductId: string | null = null;

      if (input.target === "task") {
        const issue = await tasks.createTask(companyId, actorUserId, {
          projectId: input.projectId,
          goalId: input.goalId ?? null,
          title: draft.taskTitle,
          description: buildOneLinerTaskDescription(draft),
          priority: input.priority,
          taskMode: input.taskMode,
          capacity: input.capacity,
          deliverables: [{ title: draft.deliverableTitle, type: "document", basePrice: draft.basePrice ?? 0 }],
        });
        promotedIssueId = issue.id;
      } else if (input.target === "todo") {
        const todo = await tasks.createTodo(input.taskIssueId, actorUserId, {
          taskIssueId: input.taskIssueId,
          title: draft.todoTitle || draft.taskTitle,
          description: buildOneLinerTaskDescription(draft),
          assigneeUserId: input.assigneeUserId,
          deliverables: [{ title: draft.deliverableTitle, type: "document", basePrice: draft.basePrice ?? 0 }],
        });
        promotedIssueId = todo.id;
      } else {
        const targetIssue = await assertIssue(companyId, input.issueId);
        const workProduct = await workProducts.createForIssue(input.issueId, companyId, {
          projectId: targetIssue.projectId,
          type: "document",
          provider: "custom",
          title: draft.deliverableTitle,
          status: "draft",
          reviewState: "none",
          isPrimary: false,
          healthStatus: "unknown",
          summary: draft.dailyLog || null,
          metadata: {
            rt2Deliverable: true,
            rt2State: "defined",
            rt2Type: "document",
            rt2Owner: targetIssue.parentId ? "todo" : "task",
            rt2Required: true,
            rt2BasePrice: draft.basePrice ?? 0,
            captureDraftId: draftId,
          },
        });
        promotedIssueId = input.issueId;
        promotedWorkProductId = workProduct?.id ?? null;
      }

      const [updated] = await db
        .update(rt2CaptureDrafts)
        .set({
          status: "promoted",
          promotionTarget: input.target,
          promotedIssueId,
          promotedWorkProductId,
          reviewedByUserId: actorUserId,
          reviewedAt: new Date(),
          updatedAt: new Date(),
          auditTrail: appendAudit(row, "promoted", actorUserId, { target: input.target, promotedIssueId, promotedWorkProductId }),
        })
        .where(eq(rt2CaptureDrafts.id, row.id))
        .returning();
      return toCaptureDraft(updated);
    },

    failCaptureDraft: async (companyId: string, draftId: string, actorUserId: string, input: { failureCode: string; failureMessage: string }) => {
      const row = await getCaptureRow(companyId, draftId);
      const [updated] = await db
        .update(rt2CaptureDrafts)
        .set({
          status: input.failureCode === "duplicate" ? "duplicate" : input.failureCode === "permission" ? "permission_blocked" : "failed",
          failureCode: input.failureCode,
          failureMessage: input.failureMessage,
          reviewedByUserId: actorUserId,
          reviewedAt: new Date(),
          updatedAt: new Date(),
          auditTrail: appendAudit(row, "marked_failed", actorUserId, input),
        })
        .where(eq(rt2CaptureDrafts.id, row.id))
        .returning();
      return toCaptureDraft(updated);
    },
  };
}
