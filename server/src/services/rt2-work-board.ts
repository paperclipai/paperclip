import { createHash, createHmac } from "node:crypto";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  issueWorkProducts,
  issues,
  rt2CaptureDrafts,
  rt2CaptureDraftRevisions,
  rt2CaptureSources,
  rt2WorkBoardAttachments,
  rt2WorkBoardCards,
  rt2WorkBoardChecklistItems,
  rt2WorkBoardCustomFields,
  rt2WorkBoardCustomFieldOptions,
  rt2WorkBoardCardCustomFieldValues,
} from "@paperclipai/db";
import {
  buildOneLinerTaskDescription,
  parseOneLinerInput,
  type CreateOneLinerInboundDraft,
  type CreateRt2BoardAttachment,
  type CreateRt2BoardChecklistItem,
  type PromoteRt2CaptureDraft,
  type ReviseRt2CaptureDraft,
  type Rt2CaptureDraftSource,
  type Rt2CaptureDraftStatus,
  type Rt2CaptureQueueEvidenceFilter,
  type Rt2CaptureQueueFilters,
  type Rt2CaptureReliabilityReport,
  type Rt2CaptureSourceEvidence,
  type TransitionRt2CaptureDraft,
  type UpsertRt2CaptureSource,
  type UpdateRt2BoardCard,
  type UpdateRt2BoardChecklistItem,
  type Rt2BoardCardLabel,
  type Rt2BoardCardMember,
  type Rt2CustomFieldDefinition,
  type Rt2CustomFieldValue,
  type Rt2CustomFieldType,
} from "@paperclipai/shared";
import { conflict, notFound } from "../errors.js";
import { issueService } from "./issues.js";
import { rt2HybridSearchService } from "./rt2-hybrid-search.js";
import { rt2TaskEngineService } from "./rt2-task-engine.js";
import { workProductService } from "./work-products.js";

type ChecklistRow = typeof rt2WorkBoardChecklistItems.$inferSelect;
type AttachmentRow = typeof rt2WorkBoardAttachments.$inferSelect;
type CardRow = typeof rt2WorkBoardCards.$inferSelect;
type CaptureRow = typeof rt2CaptureDrafts.$inferSelect;
type CaptureRevisionRow = typeof rt2CaptureDraftRevisions.$inferSelect;
type CaptureSourceRow = typeof rt2CaptureSources.$inferSelect;
type CustomFieldRow = typeof rt2WorkBoardCustomFields.$inferSelect;
type CustomFieldOptionRow = typeof rt2WorkBoardCustomFieldOptions.$inferSelect;
type CustomFieldValueRow = typeof rt2WorkBoardCardCustomFieldValues.$inferSelect;
type CustomFieldRow = typeof rt2WorkBoardCustomFields.$inferSelect;
type CustomFieldOptionRow = typeof rt2WorkBoardCustomFieldOptions.$inferSelect;
type CustomFieldValueRow = typeof rt2WorkBoardCardCustomFieldValues.$inferSelect;

const CAPTURE_SOURCE_LABELS = {
  web: "Web",
  floating: "빠른 기록",
  voice: "음성",
  slack: "Slack",
  teams: "Teams",
  webhook: "Webhook",
  mobile: "Mobile",
  native: "Native",
} as const;

function normalizeHash(input: string) {
  return createHash("sha256").update(input.trim().replace(/\s+/g, " ").toLowerCase()).digest("hex");
}

function hashSecret(input: string) {
  return createHash("sha256").update(input).digest("hex");
}

function canonicalCapturePayload(input: CreateOneLinerInboundDraft) {
  return JSON.stringify({
    source: input.source ?? "webhook",
    text: input.text,
    channel: input.channel ?? null,
    externalUserId: input.externalUserId ?? null,
    eventId: input.eventId ?? null,
    eventTimestamp: input.eventTimestamp ?? null,
  });
}

function signCapturePayload(secretHash: string, input: CreateOneLinerInboundDraft) {
  return createHmac("sha256", secretHash).update(canonicalCapturePayload(input)).digest("hex");
}

function sourceBlockedReason(captureSource: CaptureSourceRow | null) {
  if (!captureSource) return null;
  if (captureSource.installationState === "not_installed") return "source_not_installed";
  if (captureSource.installationState === "blocked") return "source_blocked";
  if (captureSource.installationState === "stale") return "source_stale";
  if (captureSource.installationState === "error") return "source_error";
  return null;
}

function resolveCaptureSigning(captureSource: CaptureSourceRow | null, input: Pick<CreateOneLinerInboundDraft, "source" | "text" | "channel" | "externalUserId" | "eventId" | "eventTimestamp" | "signature">) {
  let signingStatus: "unsigned" | "signed" | "invalid" | "missing" | "stale" = captureSource?.signingSecretHash ? "missing" : "unsigned";
  let reasonCode: string | null = sourceBlockedReason(captureSource);

  if (captureSource?.signingSecretHash) {
    const expected = signCapturePayload(captureSource.signingSecretHash, {
      source: input.source,
      text: input.text,
      channel: input.channel ?? null,
      externalUserId: input.externalUserId ?? null,
      eventId: input.eventId ?? null,
      eventTimestamp: input.eventTimestamp ?? null,
      signature: input.signature ?? null,
    });
    if (!input.signature) {
      signingStatus = "missing";
      reasonCode = "signature_missing";
    } else if (input.signature !== expected) {
      signingStatus = "invalid";
      reasonCode = "signature_invalid";
    } else {
      signingStatus = "signed";
    }
  }

  return { signingStatus, reasonCode };
}

function buildSourceEvidence(
  captureSource: CaptureSourceRow | null,
  signing: ReturnType<typeof resolveCaptureSigning>,
  input: Pick<CreateOneLinerInboundDraft, "eventId" | "eventTimestamp" | "metadata">,
): Rt2CaptureSourceEvidence {
  return {
    sourceInstallationId: captureSource?.id ?? null,
    installationState: (captureSource?.installationState ?? "not_installed") as "not_installed" | "installed" | "blocked" | "stale" | "error",
    signingStatus: signing.signingStatus,
    eventId: input.eventId ?? null,
    eventTimestamp: input.eventTimestamp ?? null,
    reasonCode: signing.reasonCode,
    metadata: input.metadata && Object.keys(input.metadata).length > 0 ? input.metadata : null,
  };
}

function citationTargetFor(result: { type: string; sourceId: string; sourceKey: string }) {
  if (result.type === "task" || result.type === "deliverable" || result.type === "work_artifact") {
    return `/issues/${encodeURIComponent(result.sourceId)}`;
  }
  if (result.type === "wiki_page" || result.type === "daily_wiki_page") {
    return `/knowledge?sourceKey=${encodeURIComponent(result.sourceKey)}`;
  }
  if (result.type === "graph_node" || result.type === "graph_edge") {
    return `/knowledge?graph=${encodeURIComponent(result.sourceId)}`;
  }
  if (result.type === "document") {
    return `/documents/${encodeURIComponent(result.sourceId)}`;
  }
  return null;
}

function toCaptureSource(row: CaptureSourceRow) {
  return {
    id: row.id,
    companyId: row.companyId,
    source: row.source as Rt2CaptureDraftSource,
    label: row.label,
    installationState: row.installationState as "not_installed" | "installed" | "blocked" | "stale" | "error",
    signingStatus: row.signingStatus as "unsigned" | "signed" | "invalid" | "missing" | "stale",
    lastInboundEventAt: row.lastInboundEventAt ?? null,
    lastInboundEventId: row.lastInboundEventId ?? null,
    lastErrorCode: row.lastErrorCode ?? null,
    blockedReason: row.blockedReason ?? null,
    updatedAt: row.updatedAt ?? null,
  };
}

function defaultCaptureSource(companyId: string, source: keyof typeof CAPTURE_SOURCE_LABELS) {
  return {
    id: null,
    companyId,
    source,
    label: CAPTURE_SOURCE_LABELS[source],
    installationState: "not_installed" as const,
    signingStatus: "unsigned" as const,
    lastInboundEventAt: null,
    lastInboundEventId: null,
    lastErrorCode: null,
    blockedReason: null,
    updatedAt: null,
  };
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

function revisionSnapshotFromParsed(parsed: ReturnType<typeof parseOneLinerInput>) {
  return {
    taskTitle: parsed.taskTitle,
    todoTitle: parsed.todoTitle,
    deliverableTitle: parsed.deliverableTitle,
    deliverableType: "document",
    basePrice: parsed.basePrice ?? 0,
    taskMode: parsed.taskMode,
    capacity: parsed.capacity,
    qualityHint: null,
    goalId: null,
    okrCandidate: null,
    sourceEvidenceNote: null,
    operatorNote: parsed.dailyLog || null,
  };
}

function normalizeRevisionSnapshot(value: Record<string, unknown>, fallbackText = "") {
  const parsed = parseOneLinerInput(fallbackText || String(value.taskTitle ?? ""));
  return {
    rawInput: fallbackText || parsed.rawInput,
    taskTitle: typeof value.taskTitle === "string" && value.taskTitle.trim() ? value.taskTitle.trim() : parsed.taskTitle,
    todoTitle: typeof value.todoTitle === "string" ? value.todoTitle.trim() : parsed.todoTitle,
    deliverableTitle: typeof value.deliverableTitle === "string" && value.deliverableTitle.trim() ? value.deliverableTitle.trim() : parsed.deliverableTitle,
    basePrice: typeof value.basePrice === "number" ? value.basePrice : parsed.basePrice,
    taskMode: value.taskMode === "collab" ? "collab" as const : "solo" as const,
    capacity: typeof value.capacity === "number" && value.capacity > 0 ? Math.trunc(value.capacity) : parsed.capacity,
    dailyLog: typeof value.operatorNote === "string" ? value.operatorNote : parsed.dailyLog,
    warnings: parsed.warnings,
    deliverableType: value.deliverableType === "artifact" ? "artifact" as const : "document" as const,
    goalId: typeof value.goalId === "string" && value.goalId ? value.goalId : null,
    qualityHint: typeof value.qualityHint === "string" ? value.qualityHint : null,
    okrCandidate: typeof value.okrCandidate === "string" ? value.okrCandidate : null,
    sourceEvidenceNote: typeof value.sourceEvidenceNote === "string" ? value.sourceEvidenceNote : null,
  };
}

function toCaptureRevision(row: CaptureRevisionRow) {
  return {
    id: row.id,
    draftId: row.draftId,
    companyId: row.companyId,
    revisionNumber: row.revisionNumber,
    snapshot: row.snapshot as Record<string, unknown>,
    changeSummary: row.changeSummary ?? null,
    createdByUserId: row.createdByUserId ?? null,
    createdAt: row.createdAt,
  };
}

function toCaptureDraft(row: CaptureRow, latestRevision: CaptureRevisionRow | null = null) {
  return {
    id: row.id,
    companyId: row.companyId,
    source: row.source as Rt2CaptureDraftSource,
    channel: row.channel ?? null,
    externalUserId: row.externalUserId ?? null,
    rawText: row.rawText,
    parsedDraft: row.parsedDraft as Record<string, unknown>,
    status: row.status as Rt2CaptureDraftStatus,
    promotionTarget: row.promotionTarget as "task" | "todo" | "deliverable" | null,
    promotedIssueId: row.promotedIssueId ?? null,
    promotedWorkProductId: row.promotedWorkProductId ?? null,
    duplicateOfDraftId: row.duplicateOfDraftId ?? null,
    failureCode: row.failureCode ?? null,
    failureMessage: row.failureMessage ?? null,
    permissionStatus: row.permissionStatus as "allowed" | "missing_external_user" | "blocked",
    sourceEvidence: (row.sourceEvidence as {
      sourceInstallationId: string | null;
      installationState: "not_installed" | "installed" | "blocked" | "stale" | "error";
      signingStatus: "unsigned" | "signed" | "invalid" | "missing" | "stale";
      eventId: string | null;
      eventTimestamp: string | null;
      reasonCode: string | null;
      metadata?: Record<string, string> | null;
    } | null) ?? null,
    semanticContext: (row.semanticContext ?? []) as Array<{
      id: string;
      sourceType: string;
      sourceId: string;
      sourceKey: string;
      title: string;
      snippet: string;
      score: number;
      freshness: "fresh" | "stale" | "unknown";
      confidence: string;
      contradictionStatus: "none" | "unknown" | "unresolved" | "resolved";
      citationTarget: string | null;
    }>,
    duplicateWarning: row.duplicateWarning ?? null,
    auditTrail: row.auditTrail ?? [],
    latestRevision: latestRevision ? toCaptureRevision(latestRevision) : null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

type CaptureDraftView = ReturnType<typeof toCaptureDraft>;

const FAILED_SYNC_REASON_CODES = new Set([
  "signature_missing",
  "signature_invalid",
  "source_blocked",
  "source_stale",
  "source_not_installed",
  "source_error",
  "malformed_payload",
]);

function normalizeCaptureFilters(filters?: Partial<Rt2CaptureQueueFilters> | null): Rt2CaptureQueueFilters {
  return {
    sources: [...new Set(filters?.sources ?? [])],
    statuses: [...new Set(filters?.statuses ?? [])],
    evidence: [...new Set(filters?.evidence ?? [])],
  };
}

function hasEvidence(filters: Rt2CaptureQueueFilters, evidence: Rt2CaptureQueueEvidenceFilter) {
  return filters.evidence.includes(evidence);
}

function isDuplicateDraft(draft: CaptureDraftView) {
  return draft.status === "duplicate" || Boolean(draft.duplicateOfDraftId || draft.duplicateWarning);
}

function isFailedSyncDraft(draft: CaptureDraftView) {
  const reasonCode = draft.sourceEvidence?.reasonCode ?? null;
  return (
    draft.status === "failed"
    || draft.status === "permission_blocked"
    || draft.permissionStatus === "blocked"
    || FAILED_SYNC_REASON_CODES.has(reasonCode ?? "")
    || draft.failureCode === "parse_error"
    || draft.failureCode === "permission"
    || draft.failureCode === "source_failure"
  );
}

function isApprovalWaitingDraft(draft: CaptureDraftView) {
  return draft.status === "review_required" || draft.status === "revision_requested" || draft.status === "on_hold";
}

function isRevisedDraft(draft: CaptureDraftView) {
  return draft.status === "revised" || (draft.latestRevision?.revisionNumber ?? 0) > 1;
}

function draftMatchesFilters(draft: CaptureDraftView, filters?: Partial<Rt2CaptureQueueFilters> | null) {
  const normalized = normalizeCaptureFilters(filters);
  if (normalized.sources.length > 0 && !normalized.sources.includes(draft.source)) return false;
  if (normalized.statuses.length > 0 && !normalized.statuses.includes(draft.status)) return false;
  if (hasEvidence(normalized, "duplicate") && !isDuplicateDraft(draft)) return false;
  if (hasEvidence(normalized, "failed_sync") && !isFailedSyncDraft(draft)) return false;
  if (hasEvidence(normalized, "approval_waiting") && !isApprovalWaitingDraft(draft)) return false;
  if (hasEvidence(normalized, "revised") && !isRevisedDraft(draft)) return false;
  return true;
}

function retryCountForDraft(draft: CaptureDraftView) {
  const auditRetries = draft.auditTrail.filter((entry) => {
    const action = typeof entry.action === "string" ? entry.action : "";
    const message = typeof entry.message === "string" ? entry.message : "";
    return /retry|resent|resend/i.test(`${action} ${message}`);
  }).length;
  const metadata = draft.sourceEvidence?.metadata ?? {};
  const metadataRetries = Object.entries(metadata).reduce((total, [key, value]) => {
    if (!/retry|attempt/i.test(key)) return total;
    const numeric = Number.parseInt(value, 10);
    return Number.isFinite(numeric) && numeric > 0 ? total + numeric : total;
  }, 0);
  return auditRetries + metadataRetries;
}

function promotionLatencyMinutes(draft: CaptureDraftView) {
  if (draft.status !== "promoted") return null;
  const promotedAt = draft.auditTrail
    .map((entry) => (entry.action === "promoted" && typeof entry.at === "string" ? new Date(entry.at) : null))
    .find((date): date is Date => Boolean(date && !Number.isNaN(date.getTime())));
  const end = promotedAt ?? draft.updatedAt;
  return Math.max(0, Math.round((end.getTime() - draft.createdAt.getTime()) / 60000));
}

function buildReliabilityMetrics(drafts: CaptureDraftView[]) {
  const latencies = drafts
    .map(promotionLatencyMinutes)
    .filter((value): value is number => value !== null);
  return {
    draftCount: drafts.length,
    reviewRequiredCount: drafts.filter((draft) => draft.status === "review_required").length,
    revisedCount: drafts.filter(isRevisedDraft).length,
    duplicateCount: drafts.filter(isDuplicateDraft).length,
    failureCount: drafts.filter(isFailedSyncDraft).length,
    permissionBlockedCount: drafts.filter((draft) => draft.status === "permission_blocked").length,
    promotedCount: drafts.filter((draft) => draft.status === "promoted").length,
    retryCount: drafts.reduce((total, draft) => total + retryCountForDraft(draft), 0),
    averagePromotionLatencyMinutes: latencies.length > 0 ? Math.round(latencies.reduce((total, value) => total + value, 0) / latencies.length) : null,
    maxPromotionLatencyMinutes: latencies.length > 0 ? Math.max(...latencies) : null,
  };
}

function cardSummary(row: CardRow | undefined, checklist: ReturnType<typeof toChecklist>[], attachments: ReturnType<typeof toAttachment>[], labels: Rt2BoardCardLabel[] = [], members: Rt2BoardCardMember[] = [], customFields: Rt2CustomFieldValue[] = []) {
  const checklistDone = checklist.filter((item) => item.checked).length;
  const checklistTotal = checklist.length;
  return {
    issueId: row?.issueId ?? "",
    dueDate: row?.dueDate ? new Date(row.dueDate).toISOString().slice(0, 10) : null,
    qualityStatus: (row?.qualityStatus ?? "none") as "none" | "pending_review" | "reviewed" | "needs_work",
    priceGold: row?.priceGold ?? null,
    detailNotes: row?.detailNotes ?? null,
    checklist,
    attachments,
    checklistDone,
    checklistTotal,
    checklistProgress: checklistTotal === 0 ? 0 : Math.round((checklistDone / checklistTotal) * 100),
    labels,
    members,
    customFields,
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

  async function getLatestRevision(draftId: string) {
    return db
      .select()
      .from(rt2CaptureDraftRevisions)
      .where(eq(rt2CaptureDraftRevisions.draftId, draftId))
      .orderBy(desc(rt2CaptureDraftRevisions.revisionNumber))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function getLatestRevisionMap(draftIds: string[]) {
    const map = new Map<string, CaptureRevisionRow>();
    if (draftIds.length === 0) return map;
    const rows = await db
      .select()
      .from(rt2CaptureDraftRevisions)
      .where(inArray(rt2CaptureDraftRevisions.draftId, draftIds))
      .orderBy(desc(rt2CaptureDraftRevisions.revisionNumber));
    for (const row of rows) {
      if (!map.has(row.draftId)) map.set(row.draftId, row);
    }
    return map;
  }

  async function listCaptureSources(companyId: string) {
    const rows = await db
      .select()
      .from(rt2CaptureSources)
      .where(eq(rt2CaptureSources.companyId, companyId))
      .orderBy(rt2CaptureSources.source);
    const bySource = new Map(rows.map((row) => [row.source, toCaptureSource(row)]));
    return (Object.keys(CAPTURE_SOURCE_LABELS) as Array<keyof typeof CAPTURE_SOURCE_LABELS>).map(
      (source) => bySource.get(source) ?? defaultCaptureSource(companyId, source),
    );
  }

  async function findCaptureSource(companyId: string, source: CreateOneLinerInboundDraft["source"], sourceInstallationId?: string | null) {
    const predicates = [eq(rt2CaptureSources.companyId, companyId)];
    if (sourceInstallationId) {
      predicates.push(eq(rt2CaptureSources.id, sourceInstallationId));
    } else {
      predicates.push(eq(rt2CaptureSources.source, source ?? "webhook"));
    }
    return db
      .select()
      .from(rt2CaptureSources)
      .where(and(...predicates))
      .then((rows) => rows[0] ?? null);
  }

  async function buildSemanticContext(companyId: string, text: string) {
    try {
      const response = await rt2HybridSearchService(db).search(companyId, text, { limit: 3 });
      return response.results.slice(0, 3).map((result) => ({
        id: result.id,
        sourceType: result.sourceType,
        sourceId: result.sourceId,
        sourceKey: result.sourceKey,
        title: result.title,
        snippet: result.snippet,
        score: result.score,
        freshness: result.freshness,
        confidence: result.confidence,
        contradictionStatus: result.contradictionStatus,
        citationTarget: citationTargetFor(result),
      }));
    } catch {
      return [];
    }
  }

  return {
    listCaptureSources,

    getCaptureSource: async (companyId: string, source: CreateOneLinerInboundDraft["source"], sourceInstallationId?: string | null) => {
      return findCaptureSource(companyId, source, sourceInstallationId ?? null).then((row) => (row ? toCaptureSource(row) : null));
    },

    upsertCaptureSource: async (companyId: string, actorUserId: string, input: UpsertRt2CaptureSource) => {
      const now = new Date();
      const secretHash = input.signingSecret ? hashSecret(input.signingSecret) : undefined;
      const [row] = await db
        .insert(rt2CaptureSources)
        .values({
          companyId,
          source: input.source,
          label: input.label ?? CAPTURE_SOURCE_LABELS[input.source],
          installationState: input.installationState,
          signingStatus: input.signingStatus,
          signingSecretHash: secretHash ?? null,
          lastErrorCode: input.lastErrorCode ?? null,
          blockedReason: input.blockedReason ?? null,
          createdByUserId: actorUserId,
          updatedByUserId: actorUserId,
        })
        .onConflictDoUpdate({
          target: [rt2CaptureSources.companyId, rt2CaptureSources.source],
          set: {
            label: input.label ?? CAPTURE_SOURCE_LABELS[input.source],
            installationState: input.installationState,
            signingStatus: input.signingStatus,
            ...(secretHash ? { signingSecretHash: secretHash } : {}),
            lastErrorCode: input.lastErrorCode ?? null,
            blockedReason: input.blockedReason ?? null,
            updatedByUserId: actorUserId,
            updatedAt: now,
          },
        })
        .returning();
      return toCaptureSource(row);
    },

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
      const customFieldValuesMap = await getCardCustomFieldValues(companyId, uniqueIssueIds);

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
        const dueDateVal = card?.dueDate ?? null;
        const dueDateStr = dueDateVal ? new Date(dueDateVal).toISOString().slice(0, 10) : null;
        if (!dueDateStr) due.add("none");
        else if (dueDateStr < today) due.add("overdue");
        else if (dueDateStr === today) due.add("today");
        else due.add("upcoming");
        qualityStatuses.add((card?.qualityStatus ?? "none") as "none" | "pending_review" | "reviewed" | "needs_work");
      }

      return {
        companyId,
        cards: uniqueIssueIds.map((issueId) => ({
          ...cardSummary(
            cardsByIssue.get(issueId),
            checklistByIssue.get(issueId) ?? [],
            attachmentsByIssue.get(issueId) ?? [],
            [],
            [],
            customFieldValuesMap.get(issueId) ?? [],
          ),
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
      const dueDateValue = input.dueDate === undefined ? undefined : input.dueDate ? new Date(input.dueDate) : null;
      const [row] = await db
        .update(rt2WorkBoardCards)
        .set({
          dueDate: dueDateValue,
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
      const captureSource = await findCaptureSource(companyId, input.source, input.sourceInstallationId ?? null);
      const signing = resolveCaptureSigning(captureSource, input);

      const duplicate = await db
        .select({ id: rt2CaptureDrafts.id })
        .from(rt2CaptureDrafts)
        .where(and(
          eq(rt2CaptureDrafts.companyId, companyId),
          eq(rt2CaptureDrafts.source, input.source),
          eq(rt2CaptureDrafts.normalizedHash, hash),
        ))
        .then((rows) => rows[0] ?? null);
      const sourceBlocked = Boolean(signing.reasonCode) || signing.signingStatus === "invalid" || signing.signingStatus === "missing";
      const permissionStatus = sourceBlocked
        ? "blocked"
        : (input.source === "mobile" || input.source === "native") && !input.externalUserId
        ? "missing_external_user"
        : "allowed";
      const status = permissionStatus === "allowed" ? (duplicate ? "duplicate" : "review_required") : "permission_blocked";
      const duplicateWarning = duplicate ? `Potential duplicate of capture draft ${duplicate.id}` : null;
      const semanticContext = await buildSemanticContext(companyId, input.text);
      const sourceEvidence = buildSourceEvidence(captureSource, signing, input);
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
          sourceInstallationId: captureSource?.id ?? null,
          sourceSigningStatus: signing.signingStatus,
          sourceEvidence: sourceEvidence as unknown as Record<string, unknown>,
          semanticContext,
          duplicateWarning,
          createdByUserId: actorUserId,
          auditTrail: [{
            action: "captured",
            actorUserId,
            details: { source: input.source, duplicateOfDraftId: duplicate?.id ?? null, permissionStatus, sourceEvidence },
            at: new Date().toISOString(),
          }],
        })
        .returning();
      const [revision] = await db
        .insert(rt2CaptureDraftRevisions)
        .values({
          draftId: row.id,
          companyId,
          revisionNumber: 1,
          snapshot: revisionSnapshotFromParsed(parsed),
          changeSummary: "Initial capture parse",
          createdByUserId: actorUserId,
        })
        .returning();
      if (captureSource) {
        await db
          .update(rt2CaptureSources)
          .set({
            lastInboundEventAt: input.eventTimestamp ? new Date(input.eventTimestamp) : new Date(),
            lastInboundEventId: input.eventId ?? row.id,
            signingStatus: signing.signingStatus,
            lastErrorCode: signing.reasonCode,
            updatedAt: new Date(),
          })
          .where(eq(rt2CaptureSources.id, captureSource.id));
      }
      return toCaptureDraft(row, revision);
    },

    createMalformedInboundDraft: async (
      companyId: string,
      actorUserId: string,
      input: Omit<CreateOneLinerInboundDraft, "text"> & { text?: string | null; failureMessage: string },
    ) => {
      const source = input.source ?? "webhook";
      const fallbackText = input.text?.trim() || `malformed ${source} capture payload`;
      const parsed = parseOneLinerInput(fallbackText);
      const captureSource = await findCaptureSource(companyId, source, input.sourceInstallationId ?? null);
      if (!captureSource) {
        throw notFound("RT2 capture source not found");
      }
      const signing = resolveCaptureSigning(captureSource, { ...input, text: fallbackText });
      const sourceEvidence = buildSourceEvidence(captureSource, { ...signing, reasonCode: signing.reasonCode ?? "malformed_payload" }, input);
      const [row] = await db
        .insert(rt2CaptureDrafts)
        .values({
          companyId,
          source,
          channel: input.channel ?? null,
          externalUserId: input.externalUserId ?? null,
          rawText: fallbackText,
          normalizedHash: normalizeHash(`${source}:${input.eventId ?? fallbackText}`),
          parsedDraft: parsed as unknown as Record<string, unknown>,
          status: "failed",
          failureCode: "parse_error",
          failureMessage: input.failureMessage,
          permissionStatus: signing.reasonCode === "signature_missing" || signing.reasonCode === "signature_invalid" ? "blocked" : "allowed",
          sourceInstallationId: captureSource.id,
          sourceSigningStatus: signing.signingStatus,
          sourceEvidence: sourceEvidence as unknown as Record<string, unknown>,
          semanticContext: [],
          createdByUserId: actorUserId,
          auditTrail: [{
            action: "capture_malformed",
            actorUserId,
            details: { source, failureCode: "parse_error", sourceEvidence },
            at: new Date().toISOString(),
          }],
        })
        .returning();
      const [revision] = await db
        .insert(rt2CaptureDraftRevisions)
        .values({
          draftId: row.id,
          companyId,
          revisionNumber: 1,
          snapshot: revisionSnapshotFromParsed(parsed),
          changeSummary: "Malformed messaging payload",
          createdByUserId: actorUserId,
        })
        .returning();
      await db
        .update(rt2CaptureSources)
        .set({
          lastInboundEventAt: input.eventTimestamp ? new Date(input.eventTimestamp) : new Date(),
          lastInboundEventId: input.eventId ?? row.id,
          signingStatus: signing.signingStatus,
          lastErrorCode: sourceEvidence.reasonCode ?? "malformed_payload",
          updatedAt: new Date(),
        })
        .where(eq(rt2CaptureSources.id, captureSource.id));
      return toCaptureDraft(row, revision);
    },

    listCaptureQueue: async (companyId: string, filters?: Partial<Rt2CaptureQueueFilters> | null) => {
      const [sources, rows] = await Promise.all([
        listCaptureSources(companyId),
        db
        .select()
        .from(rt2CaptureDrafts)
        .where(eq(rt2CaptureDrafts.companyId, companyId))
        .orderBy(desc(rt2CaptureDrafts.createdAt))
          .limit(200),
      ]);
      const latestRevisions = await getLatestRevisionMap(rows.map((row) => row.id));
      const drafts = rows
        .map((row) => toCaptureDraft(row, latestRevisions.get(row.id) ?? null))
        .filter((draft) => draftMatchesFilters(draft, filters))
        .slice(0, 80);
      return {
        companyId,
        sources,
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

    getCaptureReliabilityReport: async (companyId: string): Promise<Rt2CaptureReliabilityReport> => {
      const [sources, rows] = await Promise.all([
        listCaptureSources(companyId),
        db
          .select()
          .from(rt2CaptureDrafts)
          .where(eq(rt2CaptureDrafts.companyId, companyId))
          .orderBy(desc(rt2CaptureDrafts.createdAt)),
      ]);
      const latestRevisions = await getLatestRevisionMap(rows.map((row) => row.id));
      const drafts = rows.map((row) => toCaptureDraft(row, latestRevisions.get(row.id) ?? null));
      const sourceLabels = new Map<Rt2CaptureDraftSource, string>();
      for (const source of Object.keys(CAPTURE_SOURCE_LABELS) as Rt2CaptureDraftSource[]) {
        sourceLabels.set(source, CAPTURE_SOURCE_LABELS[source]);
      }
      for (const source of sources) {
        sourceLabels.set(source.source, source.label);
      }
      for (const draft of drafts) {
        if (!sourceLabels.has(draft.source)) {
          sourceLabels.set(draft.source, CAPTURE_SOURCE_LABELS[draft.source]);
        }
      }
      return {
        companyId,
        generatedAt: new Date(),
        totals: buildReliabilityMetrics(drafts),
        rows: Array.from(sourceLabels.entries()).map(([source, label]) => ({
          source,
          label,
          ...buildReliabilityMetrics(drafts.filter((draft) => draft.source === source)),
        })),
      };
    },

    getCaptureDraftDetail: async (companyId: string, draftId: string) => {
      const row = await getCaptureRow(companyId, draftId);
      const revisions = await db
        .select()
        .from(rt2CaptureDraftRevisions)
        .where(and(eq(rt2CaptureDraftRevisions.companyId, companyId), eq(rt2CaptureDraftRevisions.draftId, draftId)))
        .orderBy(asc(rt2CaptureDraftRevisions.revisionNumber));
      const latest = revisions[revisions.length - 1] ?? null;
      return {
        ...toCaptureDraft(row, latest),
        revisions: revisions.map(toCaptureRevision),
      };
    },

    reviseCaptureDraft: async (companyId: string, draftId: string, actorUserId: string, input: ReviseRt2CaptureDraft) => {
      const row = await getCaptureRow(companyId, draftId);
      if (["promoted", "rejected", "discarded"].includes(row.status)) {
        throw conflict("RT2_CAPTURE_DRAFT_CLOSED");
      }
      const latest = await getLatestRevision(draftId);
      const nextRevisionNumber = (latest?.revisionNumber ?? 0) + 1;
      const [revision] = await db
        .insert(rt2CaptureDraftRevisions)
        .values({
          draftId,
          companyId,
          revisionNumber: nextRevisionNumber,
          snapshot: input.snapshot as unknown as Record<string, unknown>,
          changeSummary: input.changeSummary ?? "Operator revised draft",
          createdByUserId: actorUserId,
        })
        .returning();
      const [updated] = await db
        .update(rt2CaptureDrafts)
        .set({
          parsedDraft: input.snapshot as unknown as Record<string, unknown>,
          status: row.status === "review_required" || row.status === "revision_requested" || row.status === "on_hold" ? "revised" : row.status,
          updatedAt: new Date(),
          auditTrail: appendAudit(row, "revised", actorUserId, {
            revisionId: revision.id,
            revisionNumber: revision.revisionNumber,
            changeSummary: input.changeSummary ?? null,
          }),
        })
        .where(eq(rt2CaptureDrafts.id, row.id))
        .returning();
      return toCaptureDraft(updated, revision);
    },

    transitionCaptureDraft: async (companyId: string, draftId: string, actorUserId: string, input: TransitionRt2CaptureDraft) => {
      const row = await getCaptureRow(companyId, draftId);
      const latest = await getLatestRevision(draftId);
      const nextStatus =
        input.action === "hold"
          ? "on_hold"
          : input.action === "reject"
            ? "rejected"
            : input.action === "request_revision"
              ? "revision_requested"
              : "review_required";
      const [updated] = await db
        .update(rt2CaptureDrafts)
        .set({
          status: nextStatus,
          failureCode: input.action === "reject" ? "operator_rejected" : row.failureCode,
          failureMessage: input.reason ?? row.failureMessage,
          reviewedByUserId: actorUserId,
          reviewedAt: new Date(),
          updatedAt: new Date(),
          auditTrail: appendAudit(row, input.action, actorUserId, {
            reason: input.reason ?? null,
            revisionId: latest?.id ?? null,
            revisionNumber: latest?.revisionNumber ?? null,
          }),
        })
        .where(eq(rt2CaptureDrafts.id, row.id))
        .returning();
      return toCaptureDraft(updated, latest);
    },

    promoteCaptureDraft: async (companyId: string, draftId: string, actorUserId: string, input: PromoteRt2CaptureDraft) => {
      const row = await getCaptureRow(companyId, draftId);
      if (!["review_required", "revised", "revision_requested"].includes(row.status)) {
        throw conflict("RT2_CAPTURE_DRAFT_NOT_PROMOTABLE");
      }
      const latest = await getLatestRevision(draftId);
      const draft = normalizeRevisionSnapshot((latest?.snapshot as Record<string, unknown> | undefined) ?? row.parsedDraft, row.rawText);
      let promotedIssueId: string | null = null;
      let promotedWorkProductId: string | null = null;

      if (input.target === "task") {
        const issue = await tasks.createTask(companyId, actorUserId, {
          projectId: input.projectId,
          goalId: input.goalId ?? draft.goalId ?? null,
          title: draft.taskTitle,
          description: buildOneLinerTaskDescription(draft),
          priority: input.priority,
          taskMode: input.taskMode,
          capacity: input.capacity,
          deliverables: [{ title: draft.deliverableTitle, type: draft.deliverableType, basePrice: draft.basePrice ?? 0 }],
        });
        promotedIssueId = issue.id;
      } else if (input.target === "todo") {
        const todo = await tasks.createTodo(input.taskIssueId, actorUserId, {
          taskIssueId: input.taskIssueId,
          title: draft.todoTitle || draft.taskTitle,
          description: buildOneLinerTaskDescription(draft),
          assigneeUserId: input.assigneeUserId,
          deliverables: [{ title: draft.deliverableTitle, type: draft.deliverableType, basePrice: draft.basePrice ?? 0 }],
        });
        promotedIssueId = todo.id;
      } else {
        const targetIssue = await assertIssue(companyId, input.issueId);
        const workProduct = await workProducts.createForIssue(input.issueId, companyId, {
          projectId: targetIssue.projectId,
          type: draft.deliverableType,
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
            rt2Type: draft.deliverableType,
            rt2Owner: targetIssue.parentId ? "todo" : "task",
            rt2Required: true,
            rt2BasePrice: draft.basePrice ?? 0,
            captureDraftId: draftId,
            captureDraftRevisionId: latest?.id ?? null,
            captureDraftRevisionNumber: latest?.revisionNumber ?? null,
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
          auditTrail: appendAudit(row, "promoted", actorUserId, {
            target: input.target,
            promotedIssueId,
            promotedWorkProductId,
            revisionId: latest?.id ?? null,
            revisionNumber: latest?.revisionNumber ?? null,
            sourceEvidence: row.sourceEvidence ?? null,
            semanticCitationIds: ((row.semanticContext ?? []) as Array<{ id?: string }>).map((item) => item.id).filter(Boolean),
          }),
        })
        .where(eq(rt2CaptureDrafts.id, row.id))
        .returning();
      return toCaptureDraft(updated, latest);
    },

    failCaptureDraft: async (companyId: string, draftId: string, actorUserId: string, input: { failureCode: string; failureMessage: string }) => {
      const row = await getCaptureRow(companyId, draftId);
      const latest = await getLatestRevision(draftId);
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
      return toCaptureDraft(updated, latest);
    },

    getCustomFieldDefinitions: async (companyId: string): Promise<Rt2CustomFieldDefinition[]> => {
      const fieldRows = await db
        .select()
        .from(rt2WorkBoardCustomFields)
        .where(eq(rt2WorkBoardCustomFields.companyId, companyId))
        .orderBy(rt2WorkBoardCustomFields.position);
      const optionRows = await db
        .select()
        .from(rt2WorkBoardCustomFieldOptions)
        .where(eq(rt2WorkBoardCustomFieldOptions.companyId, companyId))
        .orderBy(rt2WorkBoardCustomFieldOptions.position);
      const optionsByField = new Map<string, { id: string; label: string; position: number }[]>();
      for (const row of optionRows) {
        const bucket = optionsByField.get(row.fieldId) ?? [];
        bucket.push({ id: row.id, label: row.label, position: row.position });
        optionsByField.set(row.fieldId, bucket);
      }
      return fieldRows.map((row) => ({
        id: row.id,
        name: row.name,
        fieldType: row.fieldType as Rt2CustomFieldType,
        position: row.position,
        options: optionsByField.get(row.id) ?? [],
      }));
    },

    createCustomField: async (companyId: string, actorUserId: string, input: { name: string; fieldType: Rt2CustomFieldType }) => {
      const [{ nextPosition }] = await db
        .select({ nextPosition: sql<number>`coalesce(max(${rt2WorkBoardCustomFields.position}), -1) + 1` })
        .from(rt2WorkBoardCustomFields)
        .where(eq(rt2WorkBoardCustomFields.companyId, companyId));
      const [row] = await db
        .insert(rt2WorkBoardCustomFields)
        .values({ companyId, name: input.name, fieldType: input.fieldType, position: nextPosition, createdByUserId: actorUserId })
        .returning();
      return { id: row.id, name: row.name, fieldType: row.fieldType as Rt2CustomFieldType, position: row.position, options: [] };
    },

    updateCustomField: async (companyId: string, fieldId: string, input: { name?: string; fieldType?: Rt2CustomFieldType; position?: number }) => {
      const [row] = await db
        .update(rt2WorkBoardCustomFields)
        .set({ name: input.name, fieldType: input.fieldType, position: input.position, updatedAt: new Date() })
        .where(and(eq(rt2WorkBoardCustomFields.companyId, companyId), eq(rt2WorkBoardCustomFields.id, fieldId)))
        .returning();
      if (!row) throw notFound("Custom field not found");
      const optionRows = await db
        .select()
        .from(rt2WorkBoardCustomFieldOptions)
        .where(and(eq(rt2WorkBoardCustomFieldOptions.companyId, companyId), eq(rt2WorkBoardCustomFieldOptions.fieldId, fieldId)))
        .orderBy(rt2WorkBoardCustomFieldOptions.position);
      return {
        id: row.id,
        name: row.name,
        fieldType: row.fieldType as Rt2CustomFieldType,
        position: row.position,
        options: optionRows.map((o) => ({ id: o.id, label: o.label, position: o.position })),
      };
    },

    deleteCustomField: async (companyId: string, fieldId: string) => {
      await db
        .delete(rt2WorkBoardCustomFieldOptions)
        .where(and(eq(rt2WorkBoardCustomFieldOptions.companyId, companyId), eq(rt2WorkBoardCustomFieldOptions.fieldId, fieldId)));
      await db
        .delete(rt2WorkBoardCardCustomFieldValues)
        .where(and(eq(rt2WorkBoardCardCustomFieldValues.companyId, companyId), eq(rt2WorkBoardCardCustomFieldValues.fieldId, fieldId)));
      await db
        .delete(rt2WorkBoardCustomFields)
        .where(and(eq(rt2WorkBoardCustomFields.companyId, companyId), eq(rt2WorkBoardCustomFields.id, fieldId)));
    },

    getCustomFieldOptions: async (companyId: string, fieldId: string) => {
      const rows = await db
        .select()
        .from(rt2WorkBoardCustomFieldOptions)
        .where(and(eq(rt2WorkBoardCustomFieldOptions.companyId, companyId), eq(rt2WorkBoardCustomFieldOptions.fieldId, fieldId)))
        .orderBy(rt2WorkBoardCustomFieldOptions.position);
      return rows.map((row) => ({ id: row.id, label: row.label, position: row.position }));
    },

    createCustomFieldOption: async (companyId: string, fieldId: string, input: { label: string }) => {
      const [{ nextPosition }] = await db
        .select({ nextPosition: sql<number>`coalesce(max(${rt2WorkBoardCustomFieldOptions.position}), -1) + 1` })
        .from(rt2WorkBoardCustomFieldOptions)
        .where(and(eq(rt2WorkBoardCustomFieldOptions.companyId, companyId), eq(rt2WorkBoardCustomFieldOptions.fieldId, fieldId)));
      const [row] = await db
        .insert(rt2WorkBoardCustomFieldOptions)
        .values({ companyId, fieldId, label: input.label, position: nextPosition })
        .returning();
      return { id: row.id, label: row.label, position: row.position };
    },

    deleteCustomFieldOption: async (companyId: string, optionId: string) => {
      await db
        .delete(rt2WorkBoardCustomFieldOptions)
        .where(and(eq(rt2WorkBoardCustomFieldOptions.companyId, companyId), eq(rt2WorkBoardCustomFieldOptions.id, optionId)));
    },

    getCardCustomFieldValues: async (companyId: string, issueIds: string[]): Promise<Map<string, Rt2CustomFieldValue[]>> => {
      if (issueIds.length === 0) return new Map();
      const valueRows = await db
        .select()
        .from(rt2WorkBoardCardCustomFieldValues)
        .where(and(eq(rt2WorkBoardCardCustomFieldValues.companyId, companyId), inArray(rt2WorkBoardCardCustomFieldValues.issueId, issueIds)));
      const fieldRows = await db
        .select()
        .from(rt2WorkBoardCustomFields)
        .where(eq(rt2WorkBoardCustomFields.companyId, companyId));
      const optionRows = await db
        .select()
        .from(rt2WorkBoardCustomFieldOptions)
        .where(eq(rt2WorkBoardCustomFieldOptions.companyId, companyId));
      const fieldById = new Map(fieldRows.map((f) => [f.id, f]));
      const optionsByFieldId = new Map<string, Map<string, string>>();
      for (const o of optionRows) {
        const bucket = optionsByFieldId.get(o.fieldId) ?? new Map();
        bucket.set(o.id, o.label);
        optionsByFieldId.set(o.fieldId, bucket);
      }
      const result = new Map<string, Rt2CustomFieldValue[]>();
      for (const row of valueRows) {
        const field = fieldById.get(row.fieldId);
        if (!field) continue;
        const bucket = result.get(row.issueId) ?? [];
        const optionLabels = optionsByFieldId.get(row.fieldId);
        bucket.push({
          fieldId: row.fieldId,
          fieldName: field.name,
          fieldType: field.fieldType as Rt2CustomFieldType,
          textValue: row.textValue ?? null,
          numberValue: row.numberValue ?? null,
          dateValue: row.dateValue ? new Date(row.dateValue).toISOString() : null,
          optionId: row.optionId ?? null,
          optionLabel: row.optionId ? (optionLabels?.get(row.optionId) ?? null) : null,
        });
        result.set(row.issueId, bucket);
      }
      return result;
    },

    upsertCardCustomFieldValue: async (companyId: string, issueId: string, actorUserId: string, input: { fieldId: string; textValue?: string | null; numberValue?: number | null; dateValue?: string | null; optionId?: string | null }) => {
      await ensureCard(companyId, issueId, actorUserId);
      const [row] = await db
        .insert(rt2WorkBoardCardCustomFieldValues)
        .values({ companyId, issueId, fieldId: input.fieldId, textValue: input.textValue ?? null, numberValue: input.numberValue ?? null, dateValue: input.dateValue ? new Date(input.dateValue) : null, optionId: input.optionId ?? null })
        .onConflictDoUpdate({
          target: [rt2WorkBoardCardCustomFieldValues.companyId, rt2WorkBoardCardCustomFieldValues.issueId, rt2WorkBoardCardCustomFieldValues.fieldId],
          set: { textValue: input.textValue ?? null, numberValue: input.numberValue ?? null, dateValue: input.dateValue ? new Date(input.dateValue) : null, optionId: input.optionId ?? null, updatedAt: new Date() },
        })
        .returning();
      const field = await db.select().from(rt2WorkBoardCustomFields).where(and(eq(rt2WorkBoardCustomFields.companyId, companyId), eq(rt2WorkBoardCustomFields.id, input.fieldId))).then((r) => r[0]);
      return {
        fieldId: row.fieldId,
        fieldName: field?.name ?? "",
        fieldType: (field?.fieldType ?? "text") as Rt2CustomFieldType,
        textValue: row.textValue ?? null,
        numberValue: row.numberValue ?? null,
        dateValue: row.dateValue ? new Date(row.dateValue).toISOString() : null,
        optionId: row.optionId ?? null,
        optionLabel: null,
      };
    },
  };
}
