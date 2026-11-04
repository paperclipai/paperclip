import type { AttentionItem } from "@paperclipai/shared";
import { coordinatorTaskQuestion, coordinatorTaskQuestionAttention } from "@/fixtures/coordinatorTaskQuestion";
import { genericPendingRequestConfirmationInteraction } from "@/fixtures/issueThreadInteractionFixtures";
import type { IssueThreadInteraction } from "@/lib/issue-thread-interactions";
import { VIEWER_ID } from "./adapters";

const approval: IssueThreadInteraction = {
  ...genericPendingRequestConfirmationInteraction,
  id: "task-brand-approval",
  issueId: "task-copy",
  title: "Approve the Q4 brand-strategy plan?",
  payload: {
    version: 1,
    prompt: "Three positioning pillars, a six-week timeline, and $18k for an external photographer. Approve so the brand deck can start Monday?",
    acceptLabel: "Approve",
    rejectLabel: "Revise…",
    target: { type: "issue_document", issueId: "task-copy", documentId: "doc-brand-plan", key: "plan", revisionId: "rev-brand-plan-3", revisionNumber: 3 },
  },
};

/** The plan the approval card asks about, opened in the Focus review panel (PAP-770). */
export const COORDINATOR_PLAN_DOCUMENT = {
  id: "doc-brand-plan",
  companyId: "lab-company",
  issueId: "task-copy",
  key: "plan",
  title: "Q4 brand-strategy plan",
  format: "markdown",
  latestRevisionId: "rev-brand-plan-3",
  latestRevisionNumber: 3,
  createdByAgentId: null,
  createdByUserId: null,
  updatedByAgentId: null,
  updatedByUserId: null,
  createdAt: "2026-09-27T15:00:00.000Z",
  updatedAt: "2026-09-28T17:40:00.000Z",
  body: [
    "## Goal",
    "Reposition acmehats from \"novelty hats\" to **everyday headwear with a sense of humour**, ahead of the holiday catalog.",
    "",
    "## Positioning pillars",
    "1. **Made to be worn** — fit, fabric and care come first in every product page.",
    "2. **A wink, not a joke** — one playful detail per hat; no gag lines in headlines.",
    "3. **Gift-ready** — packaging and copy built for the holiday buyer.",
    "",
    "## Timeline (six weeks)",
    "| Week | Work | Owner |",
    "| --- | --- | --- |",
    "| 1 | Audit current catalog copy and photography | Dottabot |",
    "| 2 | Brand deck v1: voice, palette, type | Dottabot |",
    "| 3–4 | Photography shoot (external) | Photographer |",
    "| 5 | Product pages and email templates | Adbot |",
    "| 6 | Review and launch | You |",
    "",
    "## Budget",
    "- External photographer: **$18,000** (2 shoot days, 40 final images)",
    "- Agent spend: about $120 across Dottabot and Adbot",
    "",
    "## Risks",
    "- The shoot needs dates locked by Friday, or week 3 slips.",
    "- The spring catalog keeps its current copy until week 5.",
  ].join("\n"),
};

const base = coordinatorTaskQuestionAttention;

const questionAttention: AttentionItem = {
  ...base,
  audience: { kind: "user", userId: VIEWER_ID, reason: "reviewer" },
  whyNow: "you are the reviewer on this task",
};

const approvalAttention: AttentionItem = {
  ...base,
  id: `issue_thread_interaction:${approval.id}`,
  subject: { ...base.subject, id: approval.id, title: approval.title ?? null, metadata: { issueId: approval.issueId, kind: "request_confirmation", targetDocumentKey: "plan" } },
  relatedIssue: base.relatedIssue
    ? { ...base.relatedIssue, id: approval.issueId, identifier: "NEE-39", title: "Develop acmehats brand strategy and designer brief" }
    : null,
  audience: { kind: "user", userId: VIEWER_ID, reason: "requester" },
  whyNow: "you requested this",
  originAgentName: "Dottabot",
  detail: { kind: "plan_approval", issueTitle: "Develop acmehats brand strategy and designer brief", planTitle: "Q4 brand-strategy plan", summaryExcerpt: "Three positioning pillars, a six-week timeline, and $18k for an external photographer.", images: [] },
};

const stuckTaskAttention: AttentionItem = {
  ...base,
  id: "blocker_attention:task-gift-guide",
  sourceKind: "blocker_attention",
  inlineResolvable: false,
  subject: { id: "task-gift-guide", kind: "issue", companyId: base.subject.companyId, title: "Refresh the holiday gift guide", identifier: "NEE-44", status: "blocked", href: "/NEE/issues/NEE-44" },
  relatedIssue: null,
  audience: { kind: "user", userId: VIEWER_ID, reason: "instigator" },
  whyNow: "Blocks 0 tasks and needs human attention.",
  originAgentName: null,
  detail: { kind: "blocker", blockingIssue: null, blockedTaskCount: 0, images: [] },
};

export const COORDINATOR_INTERACTIONS: IssueThreadInteraction[] = [coordinatorTaskQuestion, approval];
export const COORDINATOR_INTERACTION_ATTENTION: AttentionItem[] = [approvalAttention, stuckTaskAttention, questionAttention];
