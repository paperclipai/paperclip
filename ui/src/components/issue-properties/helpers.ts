import type { AdapterModel } from "../../api/agents";
import type { Issue, Project } from "@paperclipai/shared";
import { extractProviderIdWithFallback } from "../../lib/model-utils";
import type { IssueModelLane } from "../../lib/issue-assignee-overrides";

export function defaultProjectWorktreeIdForProject(project: {
  workspaces?: Array<{ id: string; isPrimary: boolean }>;
  executionWorkspacePolicy?: { defaultProjectWorkspaceId?: string | null } | null;
} | null | undefined) {
  if (!project) return null;
  return project.executionWorkspacePolicy?.defaultProjectWorkspaceId
    ?? project.workspaces?.find((worktree) => worktree.isPrimary)?.id
    ?? project.workspaces?.[0]?.id
    ?? null;
}

export function defaultExecutionWorktreeModeForProject(project: { executionWorkspacePolicy?: { enabled?: boolean; defaultMode?: string | null } | null } | null | undefined) {
  const defaultMode = project?.executionWorkspacePolicy?.enabled ? project.executionWorkspacePolicy.defaultMode : null;
  if (defaultMode === "isolated_workspace" || defaultMode === "operator_branch") return defaultMode;
  if (defaultMode === "adapter_default") return "agent_default";
  return "shared_workspace";
}

function primaryWorktreeIdForProject(project: Pick<Project, "primaryWorkspace" | "workspaces"> | null | undefined) {
  return project?.primaryWorkspace?.id
    ?? project?.workspaces.find((worktree) => worktree.isPrimary)?.id
    ?? project?.workspaces[0]?.id
    ?? null;
}

export function isMainIssueWorktree(input: {
  issue: Pick<Issue, "projectWorkspaceId" | "currentExecutionWorkspace">;
  project: Pick<Project, "primaryWorkspace" | "workspaces"> | null | undefined;
}) {
  const worktree = input.issue.currentExecutionWorkspace ?? null;
  const primaryWorktreeId = primaryWorktreeIdForProject(input.project);
  const linkedProjectWorktreeId = worktree?.projectWorkspaceId ?? input.issue.projectWorkspaceId ?? null;
  if (worktree) {
    if (worktree.mode !== "shared_workspace") return false;
    if (!linkedProjectWorktreeId || !primaryWorktreeId) return true;
    return worktree.mode === "shared_workspace" && linkedProjectWorktreeId === primaryWorktreeId;
  }
  if (!linkedProjectWorktreeId || !primaryWorktreeId) return true;
  return linkedProjectWorktreeId === primaryWorktreeId;
}

export function toDateTimeLocalValue(value: string | null | undefined) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const offsetMs = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}

export const ISSUE_THINKING_EFFORT_OPTIONS = {
  claude_local: [
    { value: "", label: "Default" },
    { value: "low", label: "Low" },
    { value: "medium", label: "Medium" },
    { value: "high", label: "High" },
  ],
  codex_local: [
    { value: "", label: "Default" },
    { value: "minimal", label: "Minimal" },
    { value: "low", label: "Low" },
    { value: "medium", label: "Medium" },
    { value: "high", label: "High" },
    { value: "xhigh", label: "X-High" },
  ],
  opencode_local: [
    { value: "", label: "Default" },
    { value: "minimal", label: "Minimal" },
    { value: "low", label: "Low" },
    { value: "medium", label: "Medium" },
    { value: "high", label: "High" },
    { value: "xhigh", label: "X-High" },
    { value: "max", label: "Max" },
  ],
} as const;

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function compactRecord(record: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== undefined),
  );
}

export function thinkingEffortOptionsFor(adapterType: string | null | undefined) {
  if (adapterType === "codex_local") return ISSUE_THINKING_EFFORT_OPTIONS.codex_local;
  if (adapterType === "opencode_local") return ISSUE_THINKING_EFFORT_OPTIONS.opencode_local;
  return ISSUE_THINKING_EFFORT_OPTIONS.claude_local;
}

export function thinkingEffortKeyFor(adapterType: string | null | undefined) {
  if (adapterType === "codex_local") return "modelReasoningEffort";
  if (adapterType === "opencode_local") return "variant";
  return "effort";
}

export function thinkingEffortValueFor(adapterType: string | null | undefined, adapterConfig: Record<string, unknown>) {
  if (adapterType === "codex_local") {
    return String(adapterConfig.modelReasoningEffort ?? adapterConfig.reasoningEffort ?? adapterConfig.effort ?? "");
  }
  if (adapterType === "opencode_local") {
    return String(adapterConfig.variant ?? "");
  }
  return String(adapterConfig.effort ?? "");
}

export function overrideLane(overrides: Issue["assigneeAdapterOverrides"]): IssueModelLane {
  if (overrides?.modelProfile === "cheap") return "cheap";
  if (overrides?.adapterConfig) return "custom";
  return "primary";
}

export function sortAdapterModels(models: AdapterModel[]) {
  return [...models].sort((a, b) => {
    const providerA = extractProviderIdWithFallback(a.id);
    const providerB = extractProviderIdWithFallback(b.id);
    const byProvider = providerA.localeCompare(providerB);
    if (byProvider !== 0) return byProvider;
    return a.id.localeCompare(b.id);
  });
}
