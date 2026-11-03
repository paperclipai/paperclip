import type {
  AttentionAudience,
  AttentionItem,
  AttentionItemDetail,
  AttentionReceipt,
  AttentionSubjectKind,
  DecisionHistoryItem,
} from "@paperclipai/shared";
import { COMPANY } from "../../fixtures";
import type { LabAttentionRecord, LabHistoryRecord, LabReceipt } from "../../kit";

export function guid(seed: string): string {
  let h = 0x811c9dc5;
  let hex = "";
  for (let round = 0; hex.length < 32; round += 1) {
    for (const char of `${seed}:${round}`) h = Math.imul(h ^ char.charCodeAt(0), 0x01000193);
    hex += (h >>> 0).toString(16).padStart(8, "0");
  }
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export const agentId = (name: string) => guid(`agent:${name}`);
export const issueIdFor = (taskIdentifier: string) => guid(`issue:${taskIdentifier}`);
export const issueHref = (taskIdentifier: string) => `/${COMPANY.issuePrefix}/issues/${taskIdentifier}`;

export const VIEWER_ID = guid("user:scott");
const DOTTA_ID = guid("user:dotta");
const RILEY_ID = guid("user:riley");

export const USER_LABELS: ReadonlyMap<string, string> = new Map([
  [VIEWER_ID, "Scott"],
  [DOTTA_ID, "Dotta"],
  [RILEY_ID, "Riley"],
]);

const SUBJECT_KIND: Record<LabAttentionRecord["source"], AttentionSubjectKind> = {
  issue_thread_interaction: "interaction",
  decision: "decision",
  approval: "approval",
  join_request: "join_request",
  recovery_action: "recovery_action",
  productivity_review: "issue",
  blocker_attention: "issue",
  review: "issue",
  failed_run: "run",
  budget_alert: "budget_incident",
  agent_error_alert: "agent",
};

function detailFor(record: LabAttentionRecord): AttentionItemDetail {
  switch (record.kind) {
    case "plan":
      return { kind: "plan_approval", issueTitle: record.taskTitle, planTitle: record.target?.label ?? "Plan", summaryExcerpt: record.context, images: [] };
    case "confirmation":
      return { kind: "confirmation", promptExcerpt: record.context, isPlanTarget: false, images: [] };
    case "question":
      return { kind: "questions", questionCount: record.questions?.length ?? 1, firstQuestionText: record.questions?.[0]?.prompt ?? record.ask, images: [] };
    case "suggested_tasks":
      return { kind: "suggested_tasks", taskCount: record.suggested?.length ?? 0, firstTaskTitle: record.suggested?.[0] ?? null, images: [] };
    case "budget":
      return { kind: "budget", observedPercent: record.spend?.percent ?? 100, amountObserved: Number((record.spend?.spent ?? "$0").replace(/[^0-9.]/g, "")), amountLimit: Number((record.spend?.limit ?? "$0").replace(/[^0-9.]/g, "")), images: [] };
    case "failed_run":
      return { kind: "failed_run", agentName: record.agent, failureReasonExcerpt: record.error ?? record.context, images: [] };
    case "agent_error":
      return { kind: "agent_error", agentName: record.agent, failureReasonExcerpt: record.error ?? record.context, images: [] };
    case "approval":
      return { kind: "approval", approvalType: "spend", summaryExcerpt: record.context, images: [] };
    case "blocker":
      return { kind: "blocker", blockingIssue: record.blockingTask ? { id: issueIdFor(record.blockingTask.identifier), identifier: record.blockingTask.identifier, title: record.blockingTask.title } : null, images: [] };
    default:
      return { kind: "generic", summaryExcerpt: record.context, images: [] };
  }
}

function audienceFor(record: LabAttentionRecord): AttentionAudience {
  if (record.unowned) return { kind: "pool", userId: null, reason: "none" };
  if (record.forUser) return { kind: "user", userId: DOTTA_ID, reason: "requester" };
  return { kind: "user", userId: VIEWER_ID, reason: "requester" };
}

export function toAttentionItem(record: LabAttentionRecord): AttentionItem {
  const subjectKind = SUBJECT_KIND[record.source];
  const isInteraction = record.source === "issue_thread_interaction";
  const required = record.kind === "approval" || record.kind === "plan" || record.kind === "confirmation" || record.kind === "budget";
  const metadata = record.kind === "plan" || record.kind === "confirmation" ? { kind: "request_confirmation" } : undefined;
  return {
    id: guid(`item:${record.id}`),
    companyId: COMPANY.id,
    sourceKind: record.source,
    subject: {
      kind: subjectKind,
      id: guid(`subject:${record.id}`),
      companyId: COMPANY.id,
      title: record.ask,
      identifier: record.task,
      status: null,
      href: issueHref(record.task),
      metadata,
    },
    whyNow: record.reason,
    decisionVerbs: [record.primary, ...(record.secondary ?? [])].map((label, index) => ({ id: `verb-${index}`, label, description: null })),
    inlineResolvable: record.decideHere,
    entryRule: "lab",
    exitRule: "lab",
    dedupKey: `dedup:${record.id}`,
    dismissalKey: `dismiss:${record.id}`,
    dismissal: null,
    severity: record.severity,
    rank: 0,
    activityAt: "2026-09-28T12:00:00.000Z",
    createdAt: "2026-09-26T12:00:00.000Z",
    updatedAt: "2026-09-28T12:00:00.000Z",
    relatedIssue: {
      kind: "issue",
      id: issueIdFor(record.task),
      companyId: COMPANY.id,
      title: record.taskTitle,
      identifier: record.task,
      status: "in_review",
      href: issueHref(record.task),
    },
    audience: audienceFor(record),
    stale: record.stale ? { reason: record.stale } : null,
    required,
    changeFingerprint: `fp:${record.id}`,
    closeModes: isInteraction ? ["withdraw", "archive", "snooze"] : ["archive", "snooze"],
    obligationKey: null,
    obligationLeadId: null,
    project: null,
    workspace: null,
    expiresAt: null,
    ruleKey: null,
    originAgentName: record.agent,
    queues: [],
    shelf: false,
    retentionDays: 7,
    keep: false,
    archivedAt: null,
    retentionVersion: 1,
    decideBy: null,
    decideByAttribution: null,
    snoozedUntil: null,
    detail: detailFor(record),
    trainingExampleId: null,
    resolverAudience: isInteraction
      ? {
          requestedResolverPolicy: "anyone",
          effectiveResolverPolicy: "anyone",
          effectiveResolverPolicySource: "requested",
          resolverPolicyProvenance: "explicit",
          addresseeAgentId: null,
          addresseeUserId: record.forUser ? DOTTA_ID : null,
          addresseeName: null,
          createdByAgentId: agentId(record.agent),
          createdByAgentName: record.agent,
        }
      : null,
  } satisfies AttentionItem;
}

export function toReceipt(receipt: LabReceipt): AttentionReceipt {
  return {
    id: guid(`receipt:${receipt.id}`),
    dismissalKey: `receipt-dismiss:${receipt.id}`,
    outcome: "approved",
    sourceKind: "approval",
    sourceId: guid(`receipt-source:${receipt.id}`),
    title: receipt.title,
    reason: null,
    actorUserId: DOTTA_ID,
    transferredToUserId: null,
    issue: { id: issueIdFor(receipt.task), identifier: receipt.task, title: receipt.title, href: issueHref(receipt.task) },
    href: issueHref(receipt.task),
    createdAt: "2026-09-28T09:00:00.000Z",
    expiresAt: "2026-10-05T09:00:00.000Z",
  };
}

export function toHistoryItem(entry: LabHistoryRecord): DecisionHistoryItem {
  return {
    id: guid(`history:${entry.id}`),
    sourceKind: "approval",
    sourceId: guid(`history-source:${entry.id}`),
    issueId: issueIdFor(entry.task),
    issueIdentifier: entry.task,
    issueTitle: entry.title,
    agentId: null,
    agentName: null,
    projectId: null,
    projectName: null,
    title: entry.title,
    outcome: entry.outcome,
    label: entry.line,
    resolvedAt: "2026-09-27T09:00:00.000Z",
    resolvedByUserId: VIEWER_ID,
    resolvedByAgentId: null,
    href: issueHref(entry.task),
    target: null,
  };
}
