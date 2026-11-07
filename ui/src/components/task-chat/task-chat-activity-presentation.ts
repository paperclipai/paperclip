import { t } from "@/i18n";
import {
  AlertTriangle,
  BookOpen,
  Bot,
  CircleCheck,
  CircleDashed,
  CircleX,
  Box,
  Clock3,
  Database,
  FileCheck2,
  FilePenLine,
  FileText,
  Globe,
  Info,
  ListChecks,
  PackageCheck,
  Search,
  TerminalSquare,
  Users,
} from "lucide-react";
import type {
  TaskChatMaterializedResourceItem,
  TaskChatProtocolItem,
  TaskChatProviderActivityItem,
  TaskChatWorkspaceChangeItem,
  TaskChatWorkspaceFileItem,
} from "./task-chat-model";
import {
  humanizeToolName,
  isGenericToolName,
  mcpToolIdentity,
  toolActivityPresentation,
  type ToolIcon,
} from "./tool-taxonomy";
import { governancePresentation, type GovernanceTone } from "./governance-presentation";

export interface TaskChatActivityPresentation {
  icon: ToolIcon;
  runningLabel: string;
  completedLabel: string;
  failedLabel?: string;
  interruptedLabel?: string;
  detail?: string;
  /** Governance rows tint a stopped action and carry its reason as a note. */
  tone?: GovernanceTone;
  note?: string;
}

export function providerNoticeSeverity(item: TaskChatProviderActivityItem): "info" | "warning" | "error" {
  const severity = item.details.find((entry) => entry.label === "Severity")?.value;
  if (item.status === "failed" || severity === "error") return "error";
  return severity === "info" ? "info" : "warning";
}

function providerDetail(item: TaskChatProviderActivityItem, ...labels: string[]): string | undefined {
  return item.details.find((entry) => labels.includes(entry.label))?.value;
}

function meaningfulToolDetail(value: string | undefined): string | undefined {
  if (!value || isGenericToolName(value) || /^tool(?:\s+|_)call\b/i.test(value)) return undefined;
  return value;
}

/** Host and path without scheme or query, for one-line web activity. */
export function compactUrl(href: string): string {
  try {
    const url = new URL(href);
    const path = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "");
    return `${url.hostname.replace(/^www\./, "")}${path}`;
  } catch {
    return href;
  }
}

/** Whole-second duration such as "30s" or "2m 5s" from a millisecond detail. */
export function durationLabel(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms < 0) return undefined;
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

function modelRouteDetail(item: TaskChatProviderActivityItem): string | undefined {
  const from = providerDetail(item, "From Model") ?? providerDetail(item, "Requested Model");
  const to = providerDetail(item, "Effective Model");
  if (!to || to === "unknown") return undefined;
  const reason = providerDetail(item, "Reason");
  const route = from && from !== "unknown" && from !== to ? `${from} → ${to}` : to;
  return reason && reason !== "provider reroute" ? `${route} · ${reason}` : route;
}

export function providerActivityPresentation(item: TaskChatProviderActivityItem): TaskChatActivityPresentation {
  const detail = item.summary
    ?? providerDetail(item, "Query", "URL", "Target", "Name", "Reference", "Reason", "Summary");
  switch (item.family) {
    case "research": {
      const action = providerDetail(item, "Action")?.toLowerCase();
      const query = providerDetail(item, "Query");
      const url = providerDetail(item, "Url");
      if (action === "open_page") {
        return { icon: Globe, runningLabel: t("activity-ui:provider.researchOpen.running"), completedLabel: t("activity-ui:provider.researchOpen.completed"), failedLabel: t("activity-ui:provider.researchOpen.failed"), interruptedLabel: t("activity-ui:provider.researchOpen.interrupted"), detail: url ? compactUrl(url) : detail };
      }
      if (action === "find_in_page") {
        const pattern = providerDetail(item, "Pattern");
        return { icon: Search, runningLabel: t("activity-ui:provider.researchFind.running"), completedLabel: t("activity-ui:provider.researchFind.completed"), failedLabel: t("activity-ui:provider.researchFind.failed"), interruptedLabel: t("activity-ui:provider.researchFind.interrupted"), detail: [pattern ? `“${pattern}”` : undefined, url ? compactUrl(url) : undefined].filter(Boolean).join(" in ") || detail };
      }
      return { icon: Search, runningLabel: t("activity-ui:provider.researchSearch.running"), completedLabel: t("activity-ui:provider.researchSearch.completed"), failedLabel: t("activity-ui:provider.researchSearch.failed"), interruptedLabel: t("activity-ui:provider.researchSearch.interrupted"), detail: query ? `“${query}”` : detail };
    }
    case "tool_execution": {
      const name = providerDetail(item, "Name");
      const target = providerDetail(item, "Target");
      const progress = providerDetail(item, "Progress");
      const tool = toolActivityPresentation({
        name,
        transport: providerDetail(item, "Transport"),
        namespace: providerDetail(item, "Namespace"),
        operation: providerDetail(item, "Operation"),
        target,
        progress,
      });
      const boundedActivity = meaningfulToolDetail(item.summary)
        ?? meaningfulToolDetail(progress)
        ?? meaningfulToolDetail(target);
      const activityIsIdentity = Boolean(
        boundedActivity && name && humanizeToolName(boundedActivity) === humanizeToolName(name),
      );
      const technicalName = name ? mcpToolIdentity(name)?.name ?? name : tool.displayName;
      // Source deduplication uses stable classification, not the translated verb.
      const source = tool.sourceLabel
        ? `${tool.sourceLabel} · ${technicalName}`
        : name && !isGenericToolName(name) && tool.confidence !== "fallback"
          ? name
          : undefined;
      return {
        icon: tool.icon,
        runningLabel: tool.runningLabel,
        completedLabel: tool.completedLabel,
        failedLabel: tool.failedLabel,
        interruptedLabel: tool.interruptedLabel,
        detail: [activityIsIdentity ? undefined : boundedActivity, source].filter(Boolean).join(" · ") || undefined,
      };
    }
    case "plan_proposal":
      return { icon: FileText, runningLabel: "Writing a plan", completedLabel: "Proposed a plan", failedLabel: "Plan proposal failed", interruptedLabel: "Plan proposal stopped", detail };
    case "plan":
      return { icon: ListChecks, runningLabel: t("activity-ui:provider.plan.running"), completedLabel: t("activity-ui:provider.plan.completed"), failedLabel: t("activity-ui:provider.plan.failed"), interruptedLabel: t("activity-ui:provider.plan.interrupted"), detail };
    case "delegation": {
      const action = providerDetail(item, "Action")?.toLowerCase();
      if (action === "message") return { icon: Users, runningLabel: t("activity-ui:provider.delegationMessage.running"), completedLabel: t("activity-ui:provider.delegationMessage.completed"), failedLabel: t("activity-ui:provider.delegationMessage.failed"), interruptedLabel: t("activity-ui:provider.delegationMessage.interrupted"), detail };
      if (action === "resume") return { icon: Users, runningLabel: t("activity-ui:provider.delegationResume.running"), completedLabel: t("activity-ui:provider.delegationResume.completed"), failedLabel: t("activity-ui:provider.delegationResume.failed"), interruptedLabel: t("activity-ui:provider.delegationResume.interrupted"), detail };
      if (action === "close") return { icon: Users, runningLabel: t("activity-ui:provider.delegationClose.running"), completedLabel: t("activity-ui:provider.delegationClose.completed"), failedLabel: t("activity-ui:provider.delegationClose.failed"), interruptedLabel: t("activity-ui:provider.delegationClose.interrupted"), detail };
      if (action === "wait") return { icon: Users, runningLabel: t("activity-ui:provider.delegationWait.running"), completedLabel: t("activity-ui:provider.delegationWait.completed"), failedLabel: t("activity-ui:provider.delegationWait.failed"), interruptedLabel: t("activity-ui:provider.delegationWait.interrupted"), detail };
      return { icon: Users, runningLabel: t("activity-ui:provider.delegationStart.running"), completedLabel: t("activity-ui:provider.delegationStart.completed"), failedLabel: t("activity-ui:provider.delegationStart.failed"), interruptedLabel: t("activity-ui:provider.delegationStart.interrupted"), detail };
    }
    case "model_identity":
      return item.eventType === "model.route.changed"
        ? { icon: Bot, runningLabel: t("activity-ui:provider.modelSwitch.running"), completedLabel: t("activity-ui:provider.modelSwitch.completed"), failedLabel: t("activity-ui:provider.modelSwitch.failed"), interruptedLabel: t("activity-ui:provider.modelSwitch.interrupted"), detail: modelRouteDetail(item) ?? detail }
        : { icon: Bot, runningLabel: t("activity-ui:provider.modelVerify.running"), completedLabel: t("activity-ui:provider.modelVerify.completed"), failedLabel: t("activity-ui:provider.modelVerify.failed"), interruptedLabel: t("activity-ui:provider.modelVerify.interrupted"), detail };
    case "context":
      return { icon: Database, runningLabel: t("activity-ui:provider.context.running"), completedLabel: t("activity-ui:provider.context.completed"), failedLabel: t("activity-ui:provider.context.failed"), interruptedLabel: t("activity-ui:provider.context.interrupted"), detail };
    case "artifact": {
      const viewed = item.eventType === "artifact.viewed";
      return viewed
        ? { icon: Box, runningLabel: t("activity-ui:provider.artifactView.running"), completedLabel: t("activity-ui:provider.artifactView.completed"), failedLabel: t("activity-ui:provider.artifactView.failed"), interruptedLabel: t("activity-ui:provider.artifactView.interrupted"), detail }
        : { icon: Box, runningLabel: t("activity-ui:provider.artifactGenerate.running"), completedLabel: t("activity-ui:provider.artifactGenerate.completed"), failedLabel: t("activity-ui:provider.artifactGenerate.failed"), interruptedLabel: t("activity-ui:provider.artifactGenerate.interrupted"), detail };
    }
    case "review": {
      const state = providerDetail(item, "State")?.toLowerCase();
      return state === "exited"
        ? { icon: FileCheck2, runningLabel: t("activity-ui:provider.reviewLeave.running"), completedLabel: t("activity-ui:provider.reviewLeave.completed"), failedLabel: t("activity-ui:provider.reviewLeave.failed"), interruptedLabel: t("activity-ui:provider.reviewLeave.interrupted"), detail }
        : { icon: FileCheck2, runningLabel: t("activity-ui:provider.reviewEnter.running"), completedLabel: t("activity-ui:provider.reviewEnter.completed"), failedLabel: t("activity-ui:provider.reviewEnter.failed"), interruptedLabel: t("activity-ui:provider.reviewEnter.interrupted"), detail };
    }
    case "hook":
    case "safety": {
      const governance = governancePresentation(item)!;
      return {
        icon: governance.icon,
        runningLabel: governance.label,
        completedLabel: governance.label,
        failedLabel: governance.label,
        interruptedLabel: governance.label,
        detail: governance.detail,
        tone: governance.tone,
        note: governance.note,
      };
    }
    case "memory":
      return { icon: BookOpen, runningLabel: t("activity-ui:provider.memory.running"), completedLabel: t("activity-ui:provider.memory.completed"), failedLabel: t("activity-ui:provider.memory.failed"), interruptedLabel: t("activity-ui:provider.memory.interrupted"), detail };
    case "terminal":
      return { icon: TerminalSquare, runningLabel: t("activity-ui:provider.terminal.running"), completedLabel: t("activity-ui:provider.terminal.completed"), failedLabel: t("activity-ui:provider.terminal.failed"), interruptedLabel: t("activity-ui:provider.terminal.interrupted"), detail };
    case "wait": {
      const planned = durationLabel(providerDetail(item, "Planned Duration Ms"));
      const elapsed = durationLabel(providerDetail(item, "Elapsed Duration Ms"));
      return {
        icon: Clock3,
        runningLabel: planned ? `Waiting ${planned}` : t("activity-ui:provider.wait.running"),
        completedLabel: elapsed ?? planned ? `Waited ${elapsed ?? planned}` : t("activity-ui:provider.wait.completed"),
        failedLabel: t("activity-ui:provider.wait.failed"),
        interruptedLabel: elapsed ? `Stopped waiting after ${elapsed}` : t("activity-ui:provider.wait.interrupted"),
      };
    }
    case "verification": {
      const status = providerDetail(item, "Status");
      return {
        icon: status === "passed" ? CircleCheck : status === "failed" ? CircleX : CircleDashed,
        runningLabel: "Running a check",
        completedLabel: status === "not_run" ? "Check not run" : "Check passed",
        failedLabel: "Check failed",
        interruptedLabel: "Check not run",
        detail: item.summary,
      };
    }
    case "provider_notice":
      return { icon: providerNoticeSeverity(item) === "info" ? Info : AlertTriangle, runningLabel: t("activity-ui:provider.notice.running"), completedLabel: t("activity-ui:provider.notice.completed"), failedLabel: t("activity-ui:provider.notice.failed"), interruptedLabel: t("activity-ui:provider.notice.interrupted"), detail };
  }
}

function workspaceChangePresentation(item: TaskChatWorkspaceChangeItem): TaskChatActivityPresentation {
  const count = item.totals.files || item.files.length;
  const detail = count > 0 ? t("activity-ui:provider.fileCount", { count }) : undefined;
  return { icon: FilePenLine, runningLabel: t("activity-ui:provider.editingFiles"), completedLabel: t("activity-ui:provider.editedFiles"), detail };
}

function workspaceFilePresentation(item: TaskChatWorkspaceFileItem): TaskChatActivityPresentation {
  return {
    icon: FileText,
    runningLabel: t("activity-ui:provider.referencingFile"),
    completedLabel: t("activity-ui:provider.referencedFile"),
    detail: item.line == null ? item.path : `${item.path}:${item.line}`,
  };
}

function resourcePresentation(item: TaskChatMaterializedResourceItem): TaskChatActivityPresentation {
  return {
    icon: item.resourceKind === "document" ? FileText : PackageCheck,
    runningLabel: t("activity-ui:provider.savingResource"),
    completedLabel: item.resourceKind === "document" ? t("activity-ui:provider.addedDocument") : t("activity-ui:provider.addedDeliverable"),
    detail: item.title,
  };
}

export function protocolActivityPresentation(item: TaskChatProtocolItem): TaskChatActivityPresentation | null {
  switch (item.surface) {
    case "provider_activity": return providerActivityPresentation(item);
    case "workspace_change": return workspaceChangePresentation(item);
    case "workspace_file": return workspaceFilePresentation(item);
    case "resource": return resourcePresentation(item);
    case "runtime_request":
    case "run_result":
    case "run_terminal":
      return null;
  }
}

export function protocolActivityIsRunning(item: TaskChatProtocolItem): boolean {
  if (item.surface === "provider_activity") return item.status === "running";
  if (item.surface === "workspace_change") return !item.complete;
  return false;
}

export function protocolActivityLabel(item: TaskChatProtocolItem, presentation: TaskChatActivityPresentation): string {
  if (item.surface !== "provider_activity") {
    return protocolActivityIsRunning(item) ? presentation.runningLabel : presentation.completedLabel;
  }
  if (item.status === "failed") return presentation.failedLabel ?? t("activity-ui:provider.failedFallback", { activity: presentation.completedLabel });
  if (item.status === "interrupted") return presentation.interruptedLabel ?? t("activity-ui:provider.interruptedFallback", { activity: presentation.completedLabel });
  return item.status === "running" ? presentation.runningLabel : presentation.completedLabel;
}
