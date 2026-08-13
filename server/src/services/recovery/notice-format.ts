import type { IssueCommentMetadata, IssueCommentPresentation } from "@paperclipai/shared";

export type NoticeMetadataRow = IssueCommentMetadata["sections"][number]["rows"][number];
export type NoticeMetadataSection = IssueCommentMetadata["sections"][number];

export function metadataText(value: unknown, fallback = "unknown") {
  const text = typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
  const resolved = text.length > 0 ? text : fallback;
  return resolved.length > 2000 ? `${resolved.slice(0, 1997)}...` : resolved;
}

export function keyValueRow(label: string, value: unknown): NoticeMetadataRow {
  return { type: "key_value", label, value: metadataText(value) };
}

export function issueLinkRow(
  label: string,
  issue: { id: string; identifier: string | null; title: string } | null | undefined,
): NoticeMetadataRow {
  if (!issue) return keyValueRow(label, "unknown");
  return {
    type: "issue_link",
    label,
    issueId: issue.id,
    identifier: issue.identifier,
    title: issue.title,
  };
}

export function runLinkRow(
  label: string,
  run: { id: string; status: string; agentId?: string | null } | null | undefined,
): NoticeMetadataRow {
  if (!run) return keyValueRow(label, "unknown");
  return {
    type: "run_link",
    label,
    runId: run.id,
    ...(run.agentId ? { agentId: run.agentId } : {}),
    title: run.status,
  };
}

export function agentLinkRow(
  label: string,
  agent: { id: string; name: string | null } | null | undefined,
): NoticeMetadataRow {
  if (!agent) return keyValueRow(label, "unknown");
  return {
    type: "agent_link",
    label,
    agentId: agent.id,
    // Issue-comment metadata constrains link names to 160 characters.
    name: agent.name?.slice(0, 160) ?? null,
  };
}

export function systemNoticePresentation(input: {
  tone: IssueCommentPresentation["tone"];
  title: string;
}): IssueCommentPresentation {
  return {
    kind: "system_notice",
    tone: input.tone,
    title: input.title,
    detailsDefaultOpen: false,
  };
}
