import type {
  IssueCommentMetadata,
  IssueCommentMetadataRow,
  IssueCommentPresentation,
} from "@paperclipai/shared";
import type {
  SystemNoticeMetadataRow,
  SystemNoticeMetadataSection,
  SystemNoticeProps,
  SystemNoticeTone,
} from "../components/SystemNotice";

export type ChildReviewEscalationIssueLink = {
  id?: string;
  identifier: string;
  title?: string;
  href: string;
};

export type ChildReviewEscalationNotice = {
  parent?: ChildReviewEscalationIssueLink;
  child: ChildReviewEscalationIssueLink;
  sourceCommentId?: string;
  sourceCommentExcerpt?: string;
  childAssigneeAgentId?: string;
  reviewActorAgentId?: string;
};

const TONE_LABEL: Record<SystemNoticeTone, string> = {
  neutral: "System notice",
  info: "System notice",
  success: "System notice",
  warning: "System warning",
  danger: "System alert",
};

function metadataRowText(row: { label?: string | null }, fallback: string) {
  const label = row.label?.trim();
  return label && label.length > 0 ? label : fallback;
}

function mapMetadataRow(
  row: IssueCommentMetadataRow,
  ctx: { runAgentId?: string | null },
): SystemNoticeMetadataRow | null {
  switch (row.type) {
    case "text":
      return { kind: "text", label: metadataRowText(row, "Detail"), value: row.text };
    case "code":
      return { kind: "code", label: metadataRowText(row, "Code"), value: row.code };
    case "key_value":
      return { kind: "text", label: row.label, value: row.value };
    case "issue_link": {
      const identifier = row.identifier ?? null;
      if (!identifier) {
        return { kind: "text", label: metadataRowText(row, "Issue"), value: row.title ?? "unknown" };
      }
      return {
        kind: "issue",
        label: metadataRowText(row, "Issue"),
        identifier,
        href: `/issues/${identifier}`,
        title: row.title ?? undefined,
      };
    }
    case "agent_link": {
      const name = row.name?.trim() || row.agentId.slice(0, 8);
      return {
        kind: "agent",
        label: metadataRowText(row, "Agent"),
        name,
        href: `/agents/${row.agentId}`,
      };
    }
    case "run_link": {
      const runAgentId = ctx.runAgentId ?? null;
      const href = runAgentId ? `/agents/${runAgentId}/runs/${row.runId}` : undefined;
      return {
        kind: "run",
        label: metadataRowText(row, "Run"),
        runId: row.runId,
        href,
        status: row.title ?? undefined,
      };
    }
    default:
      return null;
  }
}

export function mapCommentMetadataToSystemNoticeSections(
  metadata: IssueCommentMetadata | null | undefined,
  ctx: { runAgentId?: string | null } = {},
): SystemNoticeMetadataSection[] {
  if (!metadata || !Array.isArray(metadata.sections)) return [];
  return metadata.sections
    .map((section) => {
      const rows = section.rows
        .map((row) => mapMetadataRow(row, ctx))
        .filter((r): r is SystemNoticeMetadataRow => r !== null);
      if (rows.length === 0) return null;
      const out: SystemNoticeMetadataSection = { rows };
      if (section.title) out.title = section.title;
      return out;
    })
    .filter((s): s is SystemNoticeMetadataSection => s !== null);
}

function commentMetadataKeyValue(
  metadata: IssueCommentMetadata | null | undefined,
  label: string,
) {
  if (!metadata?.sections) return null;
  for (const section of metadata.sections) {
    for (const row of section.rows) {
      if (row.type === "key_value" && row.label === label) return row.value;
    }
  }
  return null;
}

function nonEmptyMetadataValue(value: string | null | undefined) {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === "none" || trimmed === "unknown" || trimmed === "unassigned") {
    return null;
  }
  return trimmed;
}

function commentMetadataIssueLink(
  metadata: IssueCommentMetadata | null | undefined,
  labels: readonly string[],
) {
  const labelSet = new Set(labels);
  for (const section of metadata?.sections ?? []) {
    for (const row of section.rows) {
      if (row.type === "issue_link" && row.label && labelSet.has(row.label)) {
        return row;
      }
    }
  }
  return null;
}

function issueHref(identifier: string) {
  return `/issues/${encodeURIComponent(identifier)}`;
}

function issueLinkFromMetadata(input: {
  metadata: IssueCommentMetadata | null | undefined;
  labels: readonly string[];
  identifierKey: string;
  idKey: string;
  titleKey: string;
  fallbackIdentifier?: string | null;
}): ChildReviewEscalationIssueLink | null {
  const issueRow = commentMetadataIssueLink(input.metadata, input.labels);
  const identifier =
    nonEmptyMetadataValue(issueRow?.identifier ?? undefined)
    ?? nonEmptyMetadataValue(commentMetadataKeyValue(input.metadata, input.identifierKey))
    ?? nonEmptyMetadataValue(input.fallbackIdentifier)
    ?? nonEmptyMetadataValue(issueRow?.issueId ?? undefined)
    ?? nonEmptyMetadataValue(commentMetadataKeyValue(input.metadata, input.idKey));
  if (!identifier) return null;

  const title =
    nonEmptyMetadataValue(issueRow?.title ?? undefined)
    ?? nonEmptyMetadataValue(commentMetadataKeyValue(input.metadata, input.titleKey))
    ?? undefined;
  const id =
    nonEmptyMetadataValue(issueRow?.issueId ?? undefined)
    ?? nonEmptyMetadataValue(commentMetadataKeyValue(input.metadata, input.idKey))
    ?? undefined;

  return {
    id,
    identifier,
    title,
    href: issueHref(identifier),
  };
}

const ISSUE_IDENTIFIER_RE = /\b[A-Z][A-Z0-9]+-\d+\b/;

function issueIdentifierFromBodySection(
  bodyText: string,
  label: string,
  stopLabels: readonly string[],
) {
  const start = bodyText.indexOf(`${label}:`);
  if (start < 0) return null;
  let end = bodyText.length;
  for (const stopLabel of stopLabels) {
    const stop = bodyText.indexOf(`${stopLabel}:`, start + label.length + 1);
    if (stop >= 0 && stop < end) end = stop;
  }
  const section = bodyText.slice(start, end);
  return section.match(ISSUE_IDENTIFIER_RE)?.[0] ?? null;
}

export function getChildReviewEscalationNotice(input: {
  metadata: IssueCommentMetadata | null | undefined;
  bodyText: string;
}): ChildReviewEscalationNotice | null {
  const kind = commentMetadataKeyValue(input.metadata, "kind");
  const bodyLooksLikeChildReviewEscalation =
    input.bodyText.includes("child review lane without a reviewer handoff");
  if (kind !== "child_in_review_without_reviewer_handoff" && !bodyLooksLikeChildReviewEscalation) {
    return null;
  }

  const parentIdentifierFromBody = issueIdentifierFromBodySection(input.bodyText, "Parent issue", [
    "Child issue",
    "Child assignee",
    "Review actor",
    "Reason",
  ]);
  const childIdentifierFromBody = issueIdentifierFromBodySection(input.bodyText, "Child issue", [
    "Child assignee",
    "Review actor",
    "Reason",
    "Source child comment",
  ]);

  const child = issueLinkFromMetadata({
    metadata: input.metadata,
    labels: ["Child issue", "Child"],
    identifierKey: "childIdentifier",
    idKey: "childIssueId",
    titleKey: "childTitle",
    fallbackIdentifier: childIdentifierFromBody,
  });
  if (!child) return null;

  const parent = issueLinkFromMetadata({
    metadata: input.metadata,
    labels: ["Parent issue", "Parent"],
    identifierKey: "parentIdentifier",
    idKey: "parentIssueId",
    titleKey: "parentTitle",
    fallbackIdentifier: parentIdentifierFromBody,
  });

  return {
    child,
    parent: parent ?? undefined,
    sourceCommentId: nonEmptyMetadataValue(commentMetadataKeyValue(input.metadata, "sourceCommentId")) ?? undefined,
    sourceCommentExcerpt: nonEmptyMetadataValue(commentMetadataKeyValue(input.metadata, "sourceCommentExcerpt")) ?? undefined,
    childAssigneeAgentId: nonEmptyMetadataValue(commentMetadataKeyValue(input.metadata, "childAssigneeAgentId")) ?? undefined,
    reviewActorAgentId: nonEmptyMetadataValue(commentMetadataKeyValue(input.metadata, "actorAgentId")) ?? undefined,
  };
}

export function compactSystemNoticeBodyText(input: {
  metadata: IssueCommentMetadata | null | undefined;
  bodyText: string;
}) {
  const childReviewEscalation = getChildReviewEscalationNotice(input);
  if (!childReviewEscalation) return input.bodyText;

  return [
    "Paperclip found a child review lane without a reviewer handoff.",
    "",
    `Action needed: take ownership of ${childReviewEscalation.child.identifier} now. Reassign it to a reviewer/worker, answer the pending decision, create a real blocker, escalate to board/user, or record an intentional manual resolution.`,
  ].join("\n");
}

export function systemNoticeLabelForTone(
  tone: SystemNoticeTone,
  presentationTitle?: string | null,
): string {
  const trimmed = presentationTitle?.trim();
  if (trimmed && trimmed.length > 0) return trimmed;
  return TONE_LABEL[tone];
}

export function buildSystemNoticeProps(input: {
  presentation: IssueCommentPresentation | null;
  metadata: IssueCommentMetadata | null;
  body: import("react").ReactNode;
  timestamp?: string;
  source?: SystemNoticeProps["source"];
  runAgentId?: string | null;
}): SystemNoticeProps {
  const tone: SystemNoticeTone = input.presentation?.tone ?? "neutral";
  const label = systemNoticeLabelForTone(tone, input.presentation?.title);
  const detailsDefaultOpen = Boolean(input.presentation?.detailsDefaultOpen);
  const sections = mapCommentMetadataToSystemNoticeSections(input.metadata, {
    runAgentId: input.runAgentId ?? null,
  });
  return {
    tone,
    label,
    body: input.body,
    metadata: sections.length > 0 ? sections : undefined,
    detailsDefaultOpen,
    timestamp: input.timestamp,
    source: input.source,
  };
}
