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
  },
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
  subject: { ...base.subject, id: approval.id, title: approval.title ?? null, metadata: { issueId: approval.issueId } },
  relatedIssue: base.relatedIssue
    ? { ...base.relatedIssue, id: approval.issueId, identifier: "NEE-39", title: "Develop acmehats brand strategy and designer brief" }
    : null,
  audience: { kind: "user", userId: VIEWER_ID, reason: "requester" },
  whyNow: "you requested this",
  originAgentName: "Dottabot",
  detail: { kind: "confirmation", promptExcerpt: "Three positioning pillars, a six-week timeline, and $18k for an external photographer.", isPlanTarget: false, images: [] },
};

export const COORDINATOR_INTERACTIONS: IssueThreadInteraction[] = [coordinatorTaskQuestion, approval];
export const COORDINATOR_INTERACTION_ATTENTION: AttentionItem[] = [approvalAttention, questionAttention];
