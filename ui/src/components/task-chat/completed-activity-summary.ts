import { Brain, CirclePause, Gauge, Layers3 } from "lucide-react";
import type { TaskChatActivityPhaseItem } from "./task-chat-model";
import {
  toolActivityPresentation,
  type ToolFamily,
  type ToolIcon,
} from "./tool-taxonomy";
import { protocolActivityPresentation } from "./task-chat-activity-presentation";

type Activity = TaskChatActivityPhaseItem["items"][number];
const labels: Record<ToolFamily, string> = {
  terminal: "Ran commands",
  grep: "Searched files",
  search: "Searched files",
  read: "Read files",
  edit: "Edited files",
  web: "Searched the web",
  plan: "Worked on a plan",
  question: "Requested input",
  agent: "Worked with agents",
  safety: "Reviewed safety",
  image: "Worked with images",
  wait: "Waited",
  mcp: "Used connected tools",
  other: "Used tools",
};

/** Describe observed activities, never infer success from a finished group. */
export function completedActivitySummary(items: Activity[]) {
  const categories = new Map<
    string,
    { label: string; icon: ToolIcon; order: number }
  >();
  const add = (label: string, icon: ToolIcon, order = 0) => {
    const existing = categories.get(label);
    if (!existing || order < existing.order)
      categories.set(label, { label, icon, order });
  };
  const tools: Array<{
    family: ToolFamily;
    icon: ToolIcon;
    completed: boolean;
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
        const family =
          item.surface === "provider_activity" ? item.family : item.surface;
        const label =
          (
            {
              research: "Searched the web",
              plan: "Worked on a plan",
              delegation: "Worked with agents",
              artifact: "Worked with artifacts",
              context: "Managed context",
              memory: "Checked memory",
              model_identity: "Checked model settings",
              review: "Worked in review mode",
              hook: "Ran hooks",
              safety: "Reviewed safety",
              terminal: "Ran commands",
              wait: "Waited",
              provider_notice: "Received a provider update",
              workspace_change: "Worked on files",
              workspace_file: "Referenced files",
              resource: "Added resources",
            } as Record<string, string>
          )[family] ?? "Used tools";
        add(label, p.icon, order);
      }
    }
  }
  const completedFamilies = new Set(
    tools.filter((tool) => tool.completed).map((tool) => tool.family),
  );
  // Merge repeated families and retries. Terminal is an action, not an exit-status claim.
  for (const tool of tools) {
    const succeeded = completedFamilies.has(tool.family);
    const label =
      tool.family === "read" && !succeeded
        ? "Checked files"
        : tool.family === "edit" && !succeeded
          ? "Worked on files"
          : labels[tool.family];
    add(label, tool.icon, tool.order);
  }
  if (!categories.size) {
    if (items.some((item) => item.kind === "thinking"))
      add("Thought through the task", Brain);
    else if (items.some((item) => item.kind === "marker"))
      add("Activity stopped", CirclePause);
    else add("Recorded usage", Gauge);
  }
  const values = [...categories.values()].sort((a, b) => a.order - b.order);
  const join = (parts: string[]) =>
    parts
      .map((p, i) => (i ? p.charAt(0).toLowerCase() + p.slice(1) : p))
      .join(", ");
  const fullLabel = join(values.map((v) => v.label));
  return {
    label:
      values.length > 3
        ? `${join(values.slice(0, 2).map((v) => v.label))}, and more`
        : fullLabel,
    fullLabel,
    icon: values.length === 1 ? values[0].icon : Layers3,
  };
}
