import { t, i18n } from "@/i18n";
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



// Display projection only. Recognition, deduplication keys, and stored metadata
// retain the original strings produced by the server.
const NOTICE_DISPLAY_KEYS: Record<string, string> = {
  "System notice": "localizationTaskRuntime.ui_System_notice_1j94h34",
  "System warning": "localizationTaskRuntime.ui_System_warning_8kjbgo",
  "System alert": "localizationTaskRuntime.ui_System_alert_nsduvm",
  "System update": "localizationTaskRuntime.ui_System_update_a520s5",
  "Task paused — Claude needs re-authentication": "localizationTaskRuntime.ui_Task_paused_Claude_needs_re_authentication_12kau6h",
  "Task paused — a secret/config binding is missing": "localizationTaskRuntime.ui_Task_paused_a_secret_config_binding_is_missing_1i7npgt",
  "Task paused — workspace problem": "localizationTaskRuntime.ui_Task_paused_workspace_problem_jyzuac",
  "Task paused — waiting on a recovery owner": "localizationTaskRuntime.ui_Task_paused_waiting_on_a_recovery_owner_vb5ter",
  "No live execution path": "localizationTaskRuntime.ui_No_live_execution_path_ocr24d",
  "Workspace validation failed": "localizationTaskRuntime.ui_Workspace_validation_failed_1ak9xwe",
  "Configuration incomplete": "localizationTaskRuntime.ui_Configuration_incomplete_an1vbj",
  "Review recovery stalled": "localizationTaskRuntime.ui_Review_recovery_stalled_3ewqnf",
  "Automatic recovery blocked": "localizationTaskRuntime.ui_Automatic_recovery_blocked_1eunv7z",
  "Error: usage limit reached": "localizationTaskRuntime.ui_Error_usage_limit_reached_mzg8db",
  "Error: not logged in to Claude": "localizationTaskRuntime.ui_Error_not_logged_in_to_Claude_f0d3ug",
  "Error: agent login required": "localizationTaskRuntime.ui_Error_agent_login_required_1klt4bm",
  "Continuation failed": "localizationTaskRuntime.ui_Continuation_failed_3mtcyf",
  "Recovery: recovery attempt failed — remains blocked": "localizationTaskRuntime.ui_Recovery_recovery_attempt_failed_remains_blocked_wepuy6",
  "Recovery: waiting on dependencies — moved to blocked": "localizationTaskRuntime.ui_Recovery_waiting_on_dependencies_moved_to_blocked_124m2yj",
  "Recovery": "localizationTaskRuntime.ui_Recovery_bx9hye",
  "Run evidence": "localizationTaskRuntime.ui_Run_evidence_1rsf2vj",
  "Detail": "localizationTaskRuntime.ui_Detail_ei31dg",
  "Code": "localizationTaskRuntime.ui_Code_xoaiok",
  "Task": "localizationTaskRuntime.ui_Task_x0051o",
  "Agent": "localizationTaskRuntime.ui_Agent_1w5o8jq",
  "Run": "localizationTaskRuntime.ui_Run_137u7vu",
  "Recovery action": "localizationTaskRuntime.ui_Recovery_action_14o4sg",
  "Recovery owner": "localizationTaskRuntime.ui_Recovery_owner_yll8q5",
  "Next action": "localizationTaskRuntime.ui_Next_action_107tu5e",
  "Source run": "localizationTaskRuntime.ui_Source_run_lzyuvx",
  "Failure code": "localizationTaskRuntime.ui_Failure_code_1tobl5m",
  "Failure summary": "localizationTaskRuntime.ui_Failure_summary_1suev25",
  "Cause": "localizationTaskRuntime.ui_Cause_vbnqgw",
  "Previous status": "localizationTaskRuntime.ui_Previous_status_leypve",
  "Latest run": "localizationTaskRuntime.ui_Latest_run_243xn7",
  "Blocking issues": "localizationTaskRuntime.ui_Blocking_issues_tt6fce",
  "Board decision required": "localizationTaskRuntime.ui_Board_decision_required_1kwnj60",
  "The recovery owner should either restore a live execution path or record the manual resolution on the source issue": "localizationTaskRuntime.ui_The_recovery_owner_should_either_restore_a_live_execution_path_or_dr2smj",
};

export function systemNoticeMetadataLabelDisplay(value: string): string {
  const key = NOTICE_DISPLAY_KEYS[value];
  return key ? t(key) : value;
}

export const systemNoticeTitleDisplay = systemNoticeMetadataLabelDisplay;

export function systemNoticeRunStatusDisplay(value: string): string {
  return i18n.resolvedLanguage?.startsWith("en") ? value : t(`status.${value}`, { defaultValue: value });
}

export function systemNoticeMetadataValueDisplay(row: SystemNoticeMetadataRow): string {
  if (row.kind !== "text") return "";
  if (row.label === "Previous status") return systemNoticeRunStatusDisplay(row.value);
  if (row.label === "Recovery owner" && row.value === "board") return t("localizationTaskRuntime.ui_Board_1hpelzf");
  const values: Record<string, string> = {
    "Board decision required": "localizationTaskRuntime.ui_Board_decision_required_1kwnj60",
    "The recovery owner should either restore a live execution path or record the manual resolution on the source issue": "localizationTaskRuntime.ui_The_recovery_owner_should_either_restore_a_live_execution_path_or_dr2smj",
    "Inspect the evidence, then retry the original owner, explicitly reassign, repair the execution path, or record an intentional resolution": "localizationTaskRuntime.ui_Inspect_the_evidence_then_retry_the_original_owner_explicitly_rea_2xqsex",
  };
  // Translate only the known system-authored instructions, never arbitrary
  // failure text, issue titles, names, IDs, or user-provided metadata values.
  return (row.label === "Next action" || row.label === "Recovery owner") && values[row.value]
    ? t(values[row.value]) : row.value;
}

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
        return { kind: "text", label: metadataRowText(row, "Task"), value: row.title ?? "unknown" };
      }
      return {
        kind: "issue",
        label: metadataRowText(row, "Task"),
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
      const runAgentId = row.agentId ?? ctx.runAgentId ?? null;
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
