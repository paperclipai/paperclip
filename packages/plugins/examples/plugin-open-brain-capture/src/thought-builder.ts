const MAX_THOUGHT_LENGTH = 500;

interface IssueData {
  identifier: string | null;
  title: string;
}

interface CommentData {
  body: string;
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + "...";
}

function extractFirstSentence(body: string): string {
  const cleaned = body
    .replace(/^#+\s+.*$/gm, "") // strip markdown headings
    .replace(/^[-*]\s+/gm, "") // strip list markers
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // strip markdown links, keep text
    .replace(/\*\*([^*]+)\*\*/g, "$1") // strip bold
    .trim();

  const firstLine = cleaned.split("\n").find((l) => l.trim().length > 0) ?? "";
  return truncate(firstLine.trim(), 200);
}

export function buildDoneThought(
  issue: IssueData,
  latestComment: CommentData | null,
  agentName?: string,
): string {
  const prefix = issue.identifier ? `[${issue.identifier}]` : "";
  const agent = agentName ? ` (${agentName})` : "";
  const context = latestComment
    ? ` ${extractFirstSentence(latestComment.body)}`
    : "";
  return truncate(
    `${prefix} ${issue.title} — COMPLETED${agent}.${context}`,
    MAX_THOUGHT_LENGTH,
  );
}

export function buildBlockedThought(
  issue: IssueData,
  latestComment: CommentData | null,
  agentName?: string,
): string {
  const prefix = issue.identifier ? `[${issue.identifier}]` : "";
  const agent = agentName ? ` (${agentName})` : "";
  const context = latestComment
    ? ` ${extractFirstSentence(latestComment.body)}`
    : "";
  return truncate(
    `${prefix} ${issue.title} — BLOCKED${agent}.${context}`,
    MAX_THOUGHT_LENGTH,
  );
}

export function buildDelegationThought(
  issue: IssueData,
  parentIssue: IssueData | null,
  assigneeName: string,
): string {
  const prefix = issue.identifier ? `[${issue.identifier}]` : "";
  const parentRef = parentIssue
    ? ` Subtask of ${parentIssue.identifier ?? parentIssue.title}.`
    : "";
  return truncate(
    `${prefix} ${issue.title} — DELEGATED to ${assigneeName}.${parentRef}`,
    MAX_THOUGHT_LENGTH,
  );
}
