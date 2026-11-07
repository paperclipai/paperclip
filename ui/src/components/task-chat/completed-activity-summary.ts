import { i18n, t } from "@/i18n";
import { Brain, CirclePause, Gauge, Layers3 } from "lucide-react";
import type { TaskChatActivityPhaseItem } from "./task-chat-model";
import {
  toolActivityPresentation,
  type ToolFamily,
  type ToolIcon,
} from "./tool-taxonomy";
import { protocolActivityPresentation, providerNoticeSeverity } from "./task-chat-activity-presentation";

type Activity = TaskChatActivityPhaseItem["items"][number];

const categoryIdentity: Record<string, string> = {
  "checkFailed": "Check failed",
  "skippedChecks": "Skipped checks",
  "switchedModels": "Switched models",
  "autoReviewedActions": "Auto-reviewed actions",
  "ranChecks": "Ran checks",
  "ranCommands": "Ran commands",
  "searchedFiles": "Searched files",
  "readFiles": "Read files",
  "editedFiles": "Edited files",
  "searchedWeb": "Searched the web",
  "workedPlan": "Worked on a plan",
  "requestedInput": "Requested input",
  "workedAgents": "Worked with agents",
  "reviewedSafety": "Reviewed safety",
  "workedImages": "Worked with images",
  "waited": "Waited",
  "connectedTools": "Used connected tools",
  "usedTools": "Used tools",
  "workedArtifacts": "Worked with artifacts",
  "managedContext": "Managed context",
  "checkedMemory": "Checked memory",
  "checkedModels": "Checked model settings",
  "workedReview": "Worked in review mode",
  "ranHooks": "Ran hooks",
  "workedFiles": "Worked on files",
  "referencedFiles": "Referenced files",
  "addedResources": "Added resources",
  "receivedUpdate": "Received a provider update",
  "providerError": "Provider error reported",
  "providerWarning": "Provider warning reported",
  "receivedUpdates": "Received provider updates",
  "checkedFiles": "Checked files",
  "thought": "Thought through the task",
  "stopped": "Activity stopped",
  "usage": "Recorded usage"
};

const labels: Record<ToolFamily, string> = {
  terminal: "ranCommands",
  grep: "searchedFiles",
  search: "searchedFiles",
  read: "readFiles",
  edit: "editedFiles",
  web: "searchedWeb",
  plan: "workedPlan",
  question: "requestedInput",
  agent: "workedAgents",
  safety: "reviewedSafety",
  image: "workedImages",
  wait: "waited",
  mcp: "connectedTools",
  other: "usedTools",
};

/** Describe observed activities, never infer success from a finished group. */
export function completedActivitySummary(items: Activity[]) {
  const categories = new Map<
    string,
    { label: string; icon: ToolIcon; order: number }
  >();
  const add = (key: string, icon: ToolIcon, order = 0, raw = false) => {
    const identity = raw ? key : categoryIdentity[key];
    const label = raw ? key : t(`activity-ui:summary.${key}`);
    const existing = categories.get(identity);
    if (!existing || order < existing.order)
      categories.set(identity, { label, icon, order });
  };
  const tools: Array<{
    family: ToolFamily;
    icon: ToolIcon;
    completed: boolean;
    order: number;
  }> = [];
  const quietGovernance: Array<{ label: string; single: string; icon: ToolIcon; order: number }> = [];
  const notices: Array<{
    summary: string | undefined;
    severity: "info" | "warning" | "error";
    icon: ToolIcon;
    order: number;
  }> = [];
  for (const [order, item] of items.entries()) {
    if (item.kind === "tool") {
      const p = toolActivityPresentation({
        name: item.rawName ?? item.name,
        target: item.target,
      });
      tools.push({ ...p, order, completed: item.status === "completed" });
    } else if (item.kind === "protocol") {
      if (
        item.surface === "provider_activity" &&
        item.family === "tool_execution"
      ) {
        const value = (label: string) =>
          item.details.find((d) => d.label === label)?.value;
        const p = toolActivityPresentation({
          name: value("Name"),
          operation: value("Operation"),
          transport: value("Transport"),
          namespace: value("Namespace"),
          target: value("Target"),
        });
        tools.push({ ...p, order, completed: item.status === "completed" });
      } else {
        const p = protocolActivityPresentation(item);
        if (!p) continue;
        if (item.surface === "provider_activity" && item.family === "provider_notice") {
          // Reuse only the normalized notice text already available in the row.
          const summary = item.summary?.trim()
            || item.details.find((entry) => entry.label === "Summary")?.value.trim();
          notices.push({ summary, severity: providerNoticeSeverity(item), icon: p.icon, order });
          continue;
        }
        if (item.surface === "provider_activity" && (item.family === "hook" || item.family === "safety")) {
          // A hook or reviewer that stopped an action is the headline of the
          // group; routine passes only describe a group with nothing else.
          if (p.tone === "blocked" || p.tone === "failed") add(p.completedLabel, p.icon, -1, true);
          else quietGovernance.push({ label: item.family === "hook" ? "ranHooks" : "autoReviewedActions", single: p.completedLabel, icon: p.icon, order });
          continue;
        }
        if (item.surface === "provider_activity" && item.family === "verification") {
          // A failed check stays visible even when the compact label truncates.
          if (item.status === "failed") add("checkFailed", p.icon, -1);
          else if (item.details.find((entry) => entry.label === "Status")?.value === "not_run") add("skippedChecks", p.icon, order);
          else add("ranChecks", p.icon, order);
          continue;
        }
        if (item.surface === "provider_activity" && item.eventType === "model.route.changed") {
          add("switchedModels", p.icon, order);
          continue;
        }
        const family =
          item.surface === "provider_activity" ? item.family : item.surface;
        const label =
          (
            {
              research: "searchedWeb",
              plan: "workedPlan",
              delegation: "workedAgents",
              artifact: "workedArtifacts",
              context: "managedContext",
              memory: "checkedMemory",
              model_identity: "checkedModels",
              review: "workedReview",
              hook: "ranHooks",
              safety: "reviewedSafety",
              terminal: "ranCommands",
              wait: "waited",
              workspace_change: "workedFiles",
              workspace_file: "referencedFiles",
              resource: "addedResources",
              verification: "ranChecks",
            } as Record<string, string>
          )[family] ?? "usedTools";
        add(label, p.icon, order);
      }
    }
  }
  if (notices.length) {
    const strongest = notices.find((notice) => notice.severity === "error")
      ?? notices.find((notice) => notice.severity === "warning")
      ?? notices[0]!;
    const label = notices.length === 1
      ? strongest.summary || "receivedUpdate"
      : strongest.severity === "error"
        ? "providerError"
        : strongest.severity === "warning"
          ? "providerWarning"
          : "receivedUpdates";
    // One notice category leaves room for actual work. Keep warnings and errors
    // visible when the compact label truncates other activity categories.
    add(label, strongest.icon, strongest.severity === "info" ? notices[0]!.order : -1, notices.length === 1 && Boolean(strongest.summary));
  }
  const completedFamilies = new Set(
    tools.filter((tool) => tool.completed).map((tool) => tool.family),
  );
  // Merge repeated families and retries. Terminal is an action, not an exit-status claim.
  for (const tool of tools) {
    const succeeded = completedFamilies.has(tool.family);
    const label =
      tool.family === "read" && !succeeded
        ? "checkedFiles"
        : tool.family === "edit" && !succeeded
          ? "workedFiles"
          : labels[tool.family];
    add(label, tool.icon, tool.order);
  }
  if (!categories.size) {
    // One quiet hook or review names itself; several share a category label.
    if (quietGovernance.length === 1) add(quietGovernance[0]!.single, quietGovernance[0]!.icon, quietGovernance[0]!.order, true);
    else for (const quiet of quietGovernance) add(quiet.label, quiet.icon, quiet.order);
  }
  if (!categories.size) {
    if (items.some((item) => item.kind === "thinking"))
      add("thought", Brain);
    else if (items.some((item) => item.kind === "marker"))
      add("stopped", CirclePause);
    else add("usage", Gauge);
  }
  const values = [...categories.values()].sort((a, b) => a.order - b.order);
  const join = (parts: string[]) => parts
    .map((part, index) => index && i18n.resolvedLanguage !== "zh-CN"
      ? part.charAt(0).toLowerCase() + part.slice(1) : part)
    .reduce((first, next) => t("activity-ui:summary.join", { first, next }));
  const fullLabel = join(values.map((v) => v.label));
  return {
    label:
      values.length > 3
        ? t("activity-ui:summary.more", { summary: join(values.slice(0, 2).map((v) => v.label)) })
        : fullLabel,
    fullLabel,
    icon: values.length === 1 ? values[0].icon : Layers3,
  };
}
