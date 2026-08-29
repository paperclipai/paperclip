import type {
  IssueCommentMetadata,
  IssueCommentPresentation,
} from "@paperclipai/shared";

export type NoticeMetadataRow =
  IssueCommentMetadata["sections"][number]["rows"][number];
export type NoticeMetadataSection = IssueCommentMetadata["sections"][number];

export function metadataText(value: unknown, fallback = "unknown") {
  const text =
    typeof value === "string"
      ? value.trim()
      : value == null
        ? ""
        : String(value).trim();
  const resolved = text.length > 0 ? text : fallback;
  return resolved.length > 2000 ? `${resolved.slice(0, 1997)}...` : resolved;
}

export function keyValueRow(label: string, value: unknown): NoticeMetadataRow {
  return { type: "key_value", label, value: metadataText(value) };
}

function boundedMetadataText(value: unknown, maxLength: number) {
  const text = metadataText(value);
  if (text.length <= maxLength) return text;

  const limit = maxLength - 3;
  let truncated = "";
  for (const { segment } of new Intl.Segmenter().segment(text)) {
    if (truncated.length + segment.length > limit) break;
    truncated += segment;
  }
  return `${truncated}...`;
}

export function issueLinkRow(
  label: string,
  issue:
    { id: string; identifier: string | null; title: string } | null | undefined,
): NoticeMetadataRow {
  if (!issue) return keyValueRow(label, "unknown");
  return {
    type: "issue_link",
    label,
    issueId: issue.id,
    identifier: issue.identifier == null ? null : boundedMetadataText(issue.identifier, 80),
    title: boundedMetadataText(issue.title, 240),
  };
}

export function runLinkRow(
  label: string,
  run:
    { id: string; status: string; agentId?: string | null } | null | undefined,
): NoticeMetadataRow {
  if (!run) return keyValueRow(label, "unknown");
  return {
    type: "run_link",
    label,
    runId: run.id,
    ...(run.agentId ? { agentId: run.agentId } : {}),
    title: boundedMetadataText(run.status, 160),
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
    name: agent.name == null ? null : boundedMetadataText(agent.name, 160),
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
