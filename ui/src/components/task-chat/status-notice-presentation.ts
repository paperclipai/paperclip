import { AlertCircle, AlertTriangle, ArrowRightLeft, Check, Info, Layers, Loader2, RotateCw, TerminalSquare } from "lucide-react";
import type { TaskChatProviderActivityItem } from "./task-chat-model";
import type { ToolIcon } from "./tool-taxonomy";

/**
 * Provider status notices are harness lifecycle reports (context compaction,
 * retries, model fallback, informational banners). They render as inline
 * chips between the turn's activity and never as part of the answer.
 *
 * The runner sets the category; the UI never classifies by message text.
 */
export const STATUS_NOTICE_CATEGORIES = [
  "context_compaction",
  "provider_retry",
  "model_fallback",
  "provider_informational",
  "local_command_output",
] as const;
export type StatusNoticeCategory = (typeof STATUS_NOTICE_CATEGORIES)[number];

export type StatusNoticeTone = "neutral" | "progress" | "warning" | "danger";

export interface StatusNoticePresentation {
  category: StatusNoticeCategory | "provider_error";
  icon: ToolIcon;
  tone: StatusNoticeTone;
  /** The short chip label, such as "Compacting context". */
  label: string;
  /** Provider text shown after the label, such as the retry reason. */
  detail?: string;
  /** True while the notice describes something still happening. */
  active: boolean;
  /** A fatal provider error renders as a full row, not a chip. */
  fatal: boolean;
}

function detail(item: TaskChatProviderActivityItem, label: string): string | undefined {
  return item.details.find((entry) => entry.label === label)?.value;
}

export function statusNoticeCategory(item: TaskChatProviderActivityItem): StatusNoticeCategory | null {
  if (item.family !== "provider_notice") return null;
  const category = detail(item, "Category");
  return (STATUS_NOTICE_CATEGORIES as readonly string[]).includes(category ?? "")
    ? category as StatusNoticeCategory
    : null;
}

/** A turn-scoped provider error that will not be retried. */
export function isFatalProviderError(item: TaskChatProviderActivityItem): boolean {
  return item.family === "provider_notice"
    && detail(item, "Category") === "error"
    && detail(item, "Severity") === "error"
    && !["true", "Yes"].includes(detail(item, "Recoverable") ?? "");
}

/**
 * The canonical notice payload a status chip renders: a runner-classified
 * status category, or a turn-scoped provider error that will not be retried.
 * Generic Codex warnings keep their run-log-only treatment.
 */
export function isStatusNoticePayload(payload: Record<string, unknown>): boolean {
  if ((STATUS_NOTICE_CATEGORIES as readonly string[]).includes(String(payload.category))) return true;
  return payload.category === "error" && payload.severity === "error" && payload.recoverable !== true && payload.scope === "turn";
}

export function isStatusNotice(item: TaskChatProviderActivityItem): boolean {
  return statusNoticeCategory(item) !== null || isFatalProviderError(item);
}

function summary(item: TaskChatProviderActivityItem): string | undefined {
  return item.summary?.trim() || detail(item, "Summary")?.trim() || undefined;
}

function retryLabel(item: TaskChatProviderActivityItem): string {
  switch (detail(item, "Reason")) {
    case "serverOverloaded": return "Retrying after overload";
    case "responseStreamDisconnected":
    case "responseStreamConnectionFailed":
    case "transport_lost": return "Reconnecting";
    case "httpConnectionFailed": return "Retrying connection";
    case "rate_limit": return "Retrying after rate limit";
    default: return "Retrying";
  }
}

function attemptSuffix(item: TaskChatProviderActivityItem): string {
  const attempt = detail(item, "Attempt");
  const max = detail(item, "Max attempts");
  if (!attempt) return "";
  return max ? ` (attempt ${attempt} of ${max})` : ` (attempt ${attempt})`;
}

export function statusNoticePresentation(
  item: TaskChatProviderActivityItem,
  options: { resolved?: boolean } = {},
): StatusNoticePresentation | null {
  if (isFatalProviderError(item)) {
    return {
      category: "provider_error",
      icon: AlertCircle,
      tone: "danger",
      label: "Provider error",
      detail: summary(item) ?? "The provider reported an error without a message.",
      active: false,
      fatal: true,
    };
  }
  const category = statusNoticeCategory(item);
  if (!category) return null;
  const phase = detail(item, "Phase");
  switch (category) {
    case "context_compaction":
      if (phase === "failed") {
        return { category, icon: AlertTriangle, tone: "warning", label: "Context compaction failed", detail: summary(item), active: false, fatal: false };
      }
      if (phase === "running" && item.status === "interrupted") {
        return { category, icon: Layers, tone: "neutral", label: "Compaction stopped", active: false, fatal: false };
      }
      return phase === "running"
        ? { category, icon: Loader2, tone: "progress", label: "Compacting context", active: true, fatal: false }
        : { category, icon: Layers, tone: "neutral", label: "Context compacted", active: false, fatal: false };
    case "provider_retry":
      return options.resolved
        ? { category, icon: Check, tone: "neutral", label: "Recovered after retry", detail: summary(item), active: false, fatal: false }
        : { category, icon: RotateCw, tone: "warning", label: `${retryLabel(item)}${attemptSuffix(item)}`, detail: summary(item), active: true, fatal: false };
    case "model_fallback": {
      const model = detail(item, "Fallback model");
      const reason = detail(item, "Reason");
      return {
        category,
        icon: ArrowRightLeft,
        tone: "warning",
        label: model ? `Fell back to ${model}` : "Fell back to another model",
        detail: reason ?? summary(item),
        active: false,
        fatal: false,
      };
    }
    case "provider_informational": {
      const severity = detail(item, "Severity");
      return {
        category,
        icon: severity === "info" ? Info : AlertTriangle,
        tone: severity === "error" ? "danger" : severity === "warning" ? "warning" : "neutral",
        label: severity === "error" ? "Provider error" : severity === "warning" ? "Provider warning" : "Provider update",
        detail: summary(item),
        active: false,
        fatal: false,
      };
    }
    case "local_command_output":
      return { category, icon: TerminalSquare, tone: "neutral", label: "Command output", detail: summary(item), active: false, fatal: false };
  }
}
