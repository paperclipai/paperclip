import { t } from "@/i18n";
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

const TONE_LABEL: Record<SystemNoticeTone, string> = {
  get "neutral"() { return t("display:copy_399320a290b7"); },
  get "info"() { return t("display:copy_399320a290b7"); },
  get "success"() { return t("display:copy_399320a290b7"); },
  get "warning"() { return t("display:copy_2cb0b2be0241"); },
  get "danger"() { return t("display:copy_835afd6493fe"); },
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
      return { kind: "text", label: metadataRowText(row, t("display:copy_6d045cadcec9")), value: row.text };
    case "code":
      return { kind: "code", label: metadataRowText(row, t("display:copy_9026b76a390f")), value: row.code };
    case "key_value":
      return { kind: "text", label: row.label, value: row.value };
    case "issue_link": {
      const identifier = row.identifier ?? null;
      if (!identifier) {
        return { kind: "text", label: metadataRowText(row, t("display:copy_4a37fef800cd")), value: row.title ?? t("display:copy_4042057e3f06") };
      }
      return {
        kind: "issue",
        label: metadataRowText(row, t("display:copy_4a37fef800cd")),
        identifier,
        href: `/issues/${identifier}`,
        title: row.title ?? undefined,
      };
    }
    case "agent_link": {
      const name = row.name?.trim() || row.agentId.slice(0, 8);
      return {
        kind: "agent",
        label: metadataRowText(row, t("display:copy_e8ff02c389eb")),
        name,
        href: `/agents/${row.agentId}`,
      };
    }
    case "run_link": {
      const runAgentId = row.agentId ?? ctx.runAgentId ?? null;
      const href = runAgentId ? `/agents/${runAgentId}/runs/${row.runId}` : undefined;
      return {
        kind: "run",
        label: metadataRowText(row, t("display:copy_cbea70186698")),
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
