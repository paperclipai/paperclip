import type {
  Issue,
  IssueComment,
  IssueThreadInteraction,
  IssueWorkProduct,
} from "@paperclipai/shared";

export type OperatorDigestState =
  | "needs_you"
  | "ready_review"
  | "running"
  | "blocked"
  | "quiet";

export interface OperatorDigestEvidence {
  label: string;
  href?: string | null;
}

export interface OperatorDigest {
  state: OperatorDigestState;
  label: string;
  oneLiner: string;
  humanAction: string;
  latestChange: string;
  evidence: OperatorDigestEvidence[];
  nextStep: string;
  risk: string;
  voiceSummary: string;
}

export interface BuildOperatorDigestInput {
  issue: Issue;
  childIssues?: readonly Issue[];
  comments?: readonly IssueComment[];
  interactions?: readonly IssueThreadInteraction[];
  hasLiveRuns?: boolean;
}

const TERMINAL_STATUSES = new Set<Issue["status"]>(["done", "cancelled"]);

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function stripMarkdown(value: string): string {
  return compactWhitespace(
    value
      .replace(/```[\s\S]*?```/g, " code block ")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/!\[[^\]]*\]\([^)]+\)/g, " image ")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/^#{1,6}\s+/gm, "")
      .replace(/^[-*+]\s+/gm, "")
      .replace(/[*_~>#]/g, ""),
  );
}

function truncate(value: string, max = 180): string {
  const trimmed = compactWhitespace(value);
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function summarizeText(value: string | null | undefined, fallback: string): string {
  const cleaned = value ? stripMarkdown(value) : "";
  return cleaned ? truncate(cleaned) : fallback;
}

function toTime(value: Date | string | null | undefined): number {
  if (!value) return 0;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
}

function latestComment(comments: readonly IssueComment[]): IssueComment | null {
  return comments
    .filter((comment) => comment.authorType !== "system" && compactWhitespace(comment.body).length > 0)
    .sort((a, b) => toTime(b.createdAt) - toTime(a.createdAt))[0] ?? null;
}

function latestWorkProduct(workProducts: readonly IssueWorkProduct[]): IssueWorkProduct | null {
  return [...workProducts].sort((a, b) => toTime(b.updatedAt) - toTime(a.updatedAt))[0] ?? null;
}

function pendingInteraction(interactions: readonly IssueThreadInteraction[]): IssueThreadInteraction | null {
  return [...interactions]
    .filter((interaction) => interaction.status === "pending")
    .sort((a, b) => toTime(b.updatedAt) - toTime(a.updatedAt))[0] ?? null;
}

function interactionAction(interaction: IssueThreadInteraction): string {
  if (interaction.kind === "request_confirmation") {
    return interaction.payload.acceptLabel
      ? `Confirm or reject: ${interaction.payload.prompt}`
      : `Confirm the requested decision: ${interaction.payload.prompt}`;
  }
  if (interaction.kind === "ask_user_questions") {
    return interaction.payload.title
      ? `Answer the pending questions: ${interaction.payload.title}`
      : "Answer the pending questions.";
  }
  const count = interaction.payload.tasks.length;
  return count === 1 ? "Accept or reject the suggested task." : `Accept or reject ${count} suggested tasks.`;
}

function deriveState(input: BuildOperatorDigestInput): OperatorDigestState {
  const { issue, childIssues = [], interactions = [], hasLiveRuns = false } = input;
  if (pendingInteraction(interactions)) return "needs_you";
  if (issue.status === "blocked" || (issue.blockedBy?.length ?? 0) > 0) return "blocked";
  if (hasLiveRuns || issue.status === "in_progress") return "running";
  if (issue.status === "in_review") return "ready_review";

  const activeChild = childIssues.some((child) => !TERMINAL_STATUSES.has(child.status));
  if (activeChild && !TERMINAL_STATUSES.has(issue.status)) return "running";

  return "quiet";
}

function stateLabel(state: OperatorDigestState): string {
  switch (state) {
    case "needs_you":
      return "Needs You";
    case "ready_review":
      return "Ready Review";
    case "running":
      return "Running";
    case "blocked":
      return "Blocked";
    case "quiet":
      return "Quiet";
  }
}

function evidenceForIssue(issue: Issue): OperatorDigestEvidence[] {
  const workProducts = issue.workProducts ?? [];
  const documents = issue.documentSummaries ?? [];
  const evidence: OperatorDigestEvidence[] = [];

  for (const product of workProducts.slice(0, 3)) {
    evidence.push({
      label: product.title || product.summary || "Work product",
      href: product.url,
    });
  }

  for (const doc of documents.filter((document) => document.key !== "plan").slice(0, Math.max(0, 3 - evidence.length))) {
    evidence.push({
      label: doc.title || doc.key,
      href: null,
    });
  }

  return evidence;
}

function blockersSummary(issue: Issue): string | null {
  const blockers = issue.blockedBy ?? [];
  if (blockers.length === 0) return null;
  const first = blockers[0]!;
  const label = first.identifier ?? first.title ?? first.id.slice(0, 8);
  return blockers.length === 1 ? label : `${label} and ${blockers.length - 1} more`;
}

export function buildOperatorDigest(input: BuildOperatorDigestInput): OperatorDigest {
  const { issue, comments = [], interactions = [], hasLiveRuns = false } = input;
  const state = deriveState(input);
  const interaction = pendingInteraction(interactions);
  const latest = latestComment(comments);
  const product = latestWorkProduct(issue.workProducts ?? []);
  const evidence = evidenceForIssue(issue);
  const blockerSummary = blockersSummary(issue);
  const issueLabel = issue.identifier ?? issue.id.slice(0, 8);

  const productSummary = product
    ? summarizeText(product.summary, `${product.title} is available.`)
    : null;
  const commentSummary = latest
    ? summarizeText(latest.body, "Latest comment is available.")
    : null;
  const descriptionSummary = summarizeText(issue.description, issue.title);

  let oneLiner = productSummary ?? commentSummary ?? descriptionSummary;
  let humanAction = "No human action needed right now.";
  let nextStep = "Keep the issue parked unless new information arrives.";
  let risk = "No active execution risk is visible from the current issue state.";

  if (state === "needs_you" && interaction) {
    oneLiner = interaction.summary || interaction.title || oneLiner;
    humanAction = interactionAction(interaction);
    nextStep = "Respond in the pending interaction so the assignee can continue.";
    risk = "The issue will not advance until the pending human decision is resolved.";
  } else if (state === "blocked") {
    oneLiner = blockerSummary ? `Blocked by ${blockerSummary}.` : oneLiner;
    humanAction = blockerSummary ? `Resolve or replace blocker ${blockerSummary}.` : "Name the external owner and unblock action.";
    nextStep = "Clear the blocker, reassign it, or mark the wait as intentionally external.";
    risk = "The work may stay silent because blocked issues do not have a healthy execution path.";
  } else if (state === "running") {
    oneLiner = hasLiveRuns ? "A run is active for this issue." : oneLiner;
    humanAction = "No action needed unless the run stalls or asks for input.";
    nextStep = "Wait for the active run or child work to produce a disposition.";
    risk = "The visible state can change when the active run finishes.";
  } else if (state === "ready_review") {
    humanAction = evidence.length > 0
      ? "Review the evidence and approve, request changes, or create the next task."
      : "Review the latest comment and decide whether more work is needed.";
    nextStep = "After review, move the issue to done or send it back to in progress.";
    risk = "Delivered artifacts may still be unverified until a human review happens.";
  }

  const latestChange = product
    ? `Latest artifact: ${product.title}`
    : commentSummary
      ? `Latest comment: ${commentSummary}`
      : `Updated ${new Date(issue.updatedAt).toLocaleString()}`;

  return {
    state,
    label: stateLabel(state),
    oneLiner,
    humanAction,
    latestChange,
    evidence,
    nextStep,
    risk,
    voiceSummary: `${issueLabel} ${stateLabel(state)}. ${oneLiner} ${humanAction}`,
  };
}
