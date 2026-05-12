export type ApprovalIssueCommentEventKind =
  | "created"
  | "approved"
  | "rejected"
  | "revision_requested"
  | "resubmitted";

export interface ApprovalIssueCommentInput {
  event: ApprovalIssueCommentEventKind;
  approval: {
    id: string;
    type: string;
    status: string;
    payload: Record<string, unknown>;
    decisionNote?: string | null;
  };
  issuePrefix: string;
  requesterAgentName?: string | null;
}

function readPayloadTitle(payload: Record<string, unknown>): string {
  const raw = typeof payload.title === "string" ? payload.title.trim() : "";
  return raw.length > 0 ? raw : "Board approval";
}

function approvalLink(input: ApprovalIssueCommentInput): string {
  const title = readPayloadTitle(input.approval.payload);
  return `[${title}](/${input.issuePrefix}/approvals/${input.approval.id})`;
}

function trimmedNote(note: string | null | undefined): string | null {
  if (typeof note !== "string") return null;
  const trimmed = note.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function buildApprovalSystemCommentBody(input: ApprovalIssueCommentInput): string {
  const link = approvalLink(input);
  const note = trimmedNote(input.approval.decisionNote);
  const requesterClause = input.requesterAgentName ? ` Requested by ${input.requesterAgentName}.` : "";
  const noteSuffix = note ? `\n\n**Decision note:** ${note}` : "";

  switch (input.event) {
    case "created":
      return [
        "## Pending board approval",
        "",
        `This issue is gated on a board decision: ${link} (\`${input.approval.type}\`, status \`pending\`).${requesterClause}`,
      ].join("\n");
    case "approved":
      return [
        "## Board approval granted",
        "",
        `${link} approved.${noteSuffix}`,
      ].join("\n");
    case "rejected":
      return [
        "## Board approval rejected",
        "",
        `${link} rejected.${noteSuffix}`,
      ].join("\n");
    case "revision_requested":
      return [
        "## Board requested revision",
        "",
        `${link} sent back for revision.${noteSuffix}`,
      ].join("\n");
    case "resubmitted":
      return [
        "## Approval resubmitted",
        "",
        `${link} resubmitted to the board (status \`pending\`).${requesterClause}`,
      ].join("\n");
  }
}
