import { Shield, ShieldAlert, ShieldCheck, ShieldX, Webhook } from "lucide-react";
import type { TaskChatProviderActivityItem } from "./task-chat-model";
import type { ToolIcon } from "./tool-taxonomy";

/**
 * Governance rows: automatic approval reviews and harness hooks. They render
 * as small grey activity rows so automatic decisions stay auditable. A row
 * that stopped the agent (denied, blocked, timed out) is tinted and carries
 * its reason on a second line, because that reason explains what the agent
 * did next.
 */
export type GovernanceTone = "neutral" | "blocked" | "failed";

export interface GovernancePresentation {
  icon: ToolIcon;
  label: string;
  detail?: string;
  tone: GovernanceTone;
  /** The provider's reason, shown under the row when the action was stopped. */
  note?: string;
}

function detail(item: TaskChatProviderActivityItem, label: string): string | undefined {
  const value = item.details.find((entry) => entry.label === label)?.value?.trim();
  return value ? value : undefined;
}

function joined(...parts: Array<string | undefined | null | false>): string | undefined {
  const value = parts.filter((part): part is string => Boolean(part)).join(" · ");
  return value || undefined;
}

/** "preToolUse" (Codex) and "PreToolUse" (Claude) both read as "PreToolUse". */
export function hookEventLabel(value: string | undefined): string | undefined {
  if (!value || value === "unknown") return undefined;
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function durationLabel(value: string | undefined): string | undefined {
  const ms = value ? Number(value) : Number.NaN;
  if (!Number.isFinite(ms) || ms < 0) return undefined;
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function riskLabel(value: string | undefined): string | undefined {
  return value ? `${value} risk` : undefined;
}

function blockedSubject(eventName: string | undefined): string {
  const event = eventName?.toLowerCase();
  if (event === "pretooluse" || event === "permissionrequest") return "a tool call";
  if (event === "userpromptsubmit") return "the prompt";
  return "the action";
}

function hookPresentation(item: TaskChatProviderActivityItem): GovernancePresentation {
  const eventName = hookEventLabel(detail(item, "Event"));
  const subject = eventName ? `${eventName} hook` : "Hook";
  const tool = detail(item, "Tool Name");
  const outcome = detail(item, "Outcome") ?? detail(item, "Status");
  const message = item.summary?.trim() || detail(item, "Message");
  const source = detail(item, "Source");
  const duration = durationLabel(detail(item, "Duration Ms"));
  if (item.status === "running" || outcome === "running") {
    return { icon: Webhook, label: eventName ? `Running ${eventName} hook` : "Running a hook", detail: joined(tool, source), tone: "neutral" };
  }
  if (outcome === "blocked") {
    return {
      icon: ShieldX,
      label: `${subject} blocked ${tool ?? blockedSubject(eventName)}`,
      detail: joined(source, duration),
      tone: "blocked",
      note: message,
    };
  }
  if (outcome === "stopped") {
    return { icon: ShieldX, label: `${subject} stopped the turn`, detail: joined(source, duration), tone: "blocked", note: message };
  }
  if (outcome === "failed" || item.status === "failed") {
    return { icon: ShieldAlert, label: `${subject} failed`, detail: joined(source, duration), tone: "failed", note: message };
  }
  if (outcome === "feedback") {
    return { icon: Webhook, label: `${subject} sent feedback`, detail: joined(message, source), tone: "neutral" };
  }
  if (outcome === "context") {
    return { icon: Webhook, label: `${subject} added context`, detail: joined(message, source), tone: "neutral" };
  }
  return { icon: Webhook, label: `${subject} ran`, detail: joined(tool, source, duration), tone: "neutral" };
}

function safetyPresentation(item: TaskChatProviderActivityItem): GovernancePresentation {
  const decision = detail(item, "Decision");
  const action = detail(item, "Action");
  const risk = riskLabel(detail(item, "Risk Level"));
  const rationale = item.summary?.trim() || detail(item, "Rationale");
  if (item.status === "running" || decision === "pending") {
    return { icon: Shield, label: "Auto-reviewing", detail: action, tone: "neutral" };
  }
  if (decision === "allowed") {
    return { icon: ShieldCheck, label: "Auto-review approved", detail: joined(action, risk), tone: "neutral" };
  }
  if (decision === "denied") {
    return { icon: ShieldX, label: "Auto-review denied", detail: joined(action, risk), tone: "blocked", note: rationale };
  }
  if (decision === "timed_out") {
    return { icon: ShieldAlert, label: "Auto-review timed out", detail: action, tone: "blocked", note: rationale ?? "The action did not run." };
  }
  if (decision === "aborted") {
    return { icon: ShieldAlert, label: "Auto-review stopped", detail: action, tone: "neutral" };
  }
  if (decision === "user_required") {
    return { icon: ShieldAlert, label: "Auto-review asked for approval", detail: joined(action, risk), tone: "neutral", note: rationale };
  }
  return { icon: ShieldCheck, label: "Auto-review finished", detail: action, tone: "neutral" };
}

export function governancePresentation(item: TaskChatProviderActivityItem): GovernancePresentation | null {
  if (item.family === "hook") return hookPresentation(item);
  if (item.family === "safety") return safetyPresentation(item);
  return null;
}
