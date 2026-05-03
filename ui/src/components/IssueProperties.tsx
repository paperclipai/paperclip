import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { pickTextColorForPillBg } from "@/lib/color-contrast";
import { Link } from "@/lib/router";
import type { Issue, IssueCollaborator } from "@paperclipai/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { accessApi } from "../api/access";
import { agentsApi } from "../api/agents";
import { authApi } from "../api/auth";
import { issuesApi } from "../api/issues";
import { projectsApi } from "../api/projects";
import { useCompany } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";
import { buildCompanyUserInlineOptions, buildCompanyUserLabelMap } from "../lib/company-members";
import { useProjectOrder } from "../hooks/useProjectOrder";
import { getRecentAssigneeIds, sortAgentsByRecency, trackRecentAssignee } from "../lib/recent-assignees";
import { formatAssigneeUserLabel } from "../lib/assignees";
import { buildExecutionPolicy, stageParticipantValues } from "../lib/issue-execution-policy";
import { StatusIcon } from "./StatusIcon";
import { PriorityIcon } from "./PriorityIcon";
import { Identity } from "./Identity";
import { formatDate, cn, projectUrl } from "../lib/utils";
import { timeAgo } from "../lib/timeAgo";
import { Separator } from "@/components/ui/separator";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { User, Hexagon, ArrowUpRight, Tag, Plus, GitBranch, FolderOpen, Check, ExternalLink, Lock, Globe, X as XIcon, Calendar, Play } from "lucide-react";
import { AgentIcon } from "./AgentIconPicker";

function TruncatedCopyable({ value, icon: Icon }: { value: string; icon: React.ComponentType<{ className?: string }> }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timerRef.current), []);
  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 1500);
    } catch { /* noop */ }
  }, [value]);

  return (
    <div className="flex items-start gap-1.5 min-w-0 flex-1">
      <Icon className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-0.5" />
      <button
        type="button"
        className="text-sm font-mono min-w-0 break-all text-left cursor-pointer hover:text-foreground transition-colors"
        onClick={handleCopy}
        title={copied ? "Copied!" : "Click to copy"}
      >
        {value}
      </button>
      {copied && <Check className="h-3 w-3 text-green-500 shrink-0 mt-0.5" />}
    </div>
  );
}

function defaultProjectWorkspaceIdForProject(project: {
  workspaces?: Array<{ id: string; isPrimary: boolean }>;
  executionWorkspacePolicy?: { defaultProjectWorkspaceId?: string | null } | null;
} | null | undefined) {
  if (!project) return null;
  return project.executionWorkspacePolicy?.defaultProjectWorkspaceId
    ?? project.workspaces?.find((workspace) => workspace.isPrimary)?.id
    ?? project.workspaces?.[0]?.id
    ?? null;
}

function defaultExecutionWorkspaceModeForProject(project: { executionWorkspacePolicy?: { enabled?: boolean; defaultMode?: string | null } | null } | null | undefined) {
  const defaultMode = project?.executionWorkspacePolicy?.enabled ? project.executionWorkspacePolicy.defaultMode : null;
  if (defaultMode === "isolated_workspace" || defaultMode === "operator_branch") return defaultMode;
  if (defaultMode === "adapter_default") return "agent_default";
  return "shared_workspace";
}

interface IssuePropertiesProps {
  issue: Issue;
  childIssues?: Issue[];
  onAddSubIssue?: () => void;
  onUpdate: (data: Record<string, unknown>) => void;
  inline?: boolean;
}

function PropertyRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 py-1.5">
      <span className="text-xs text-muted-foreground shrink-0 w-20 mt-0.5">{label}</span>
      <div className="flex items-center gap-1.5 min-w-0 flex-1 flex-wrap">{children}</div>
    </div>
  );
}

function formatDueDateRelative(date: Date | string): string {
  const now = new Date();
  const due = new Date(date);
  const diffDays = Math.round((due.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
  if (diffDays < -1) return `Overdue by ${Math.abs(diffDays)} days`;
  if (diffDays === -1) return "Overdue by 1 day";
  if (diffDays === 0) return "Due today";
  if (diffDays === 1) return "Due tomorrow";
  if (diffDays <= 7) return `Due in ${diffDays} days`;
  return formatDate(due);
}

function dueDateInputValue(date: Date | string): string {
  return new Date(date).toISOString().split("T")[0]!;
}

const LEAD_DAYS_PRESETS = [0, 1, 3, 7, 14] as const;

function computeStartDate(dueDate: Date | string, leadDays: number): Date {
  const due = new Date(dueDate);
  const dueDayStart = Date.UTC(due.getUTCFullYear(), due.getUTCMonth(), due.getUTCDate());
  return new Date(dueDayStart - Math.max(0, Math.floor(leadDays)) * 86_400_000);
}

function formatStartRelative(dueDate: Date | string, leadDays: number): string {
  const start = computeStartDate(dueDate, leadDays);
  const now = new Date();
  const diffDays = Math.round((start.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
  const leadLabel = leadDays === 0 ? "on due date" : leadDays === 1 ? "1d before" : `${leadDays}d before`;
  if (diffDays < 0) return `Started ${Math.abs(diffDays)}d ago (${leadLabel})`;
  if (diffDays === 0) return `Starts today (${leadLabel})`;
  if (diffDays === 1) return `Starts tomorrow (${leadLabel})`;
  if (diffDays <= 30) return `Starts in ${diffDays}d (${leadLabel})`;
  return `Starts ${start.toLocaleDateString()}`;
}

/** Renders a Popover on desktop, or an inline collapsible section on mobile (inline mode). */
function PropertyPicker({
  inline,
  label,
  open,
  onOpenChange,
  triggerContent,
  triggerClassName,
  popoverClassName,
  popoverAlign = "end",
  extra,
  children,
}: {
  inline?: boolean;
  label: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  triggerContent: React.ReactNode;
  triggerClassName?: string;
  popoverClassName?: string;
  popoverAlign?: "start" | "center" | "end";
  extra?: React.ReactNode;
  children: React.ReactNode;
}) {
  const btnCn = cn(
    "inline-flex items-start gap-1.5 cursor-pointer hover:bg-accent/50 rounded px-1 -mx-1 py-0.5 transition-colors min-w-0 max-w-full text-left",
    triggerClassName,
  );

  if (inline) {
    return (
      <div>
        <PropertyRow label={label}>
          <button className={btnCn} onClick={() => onOpenChange(!open)}>
            {triggerContent}
          </button>
          {extra}
        </PropertyRow>
        {open && (
          <div className={cn("rounded-md border border-border bg-popover p-1 mb-2", popoverClassName)}>
            {children}
          </div>
        )}
      </div>
    );
  }

  return (
    <PropertyRow label={label}>
      <Popover open={open} onOpenChange={onOpenChange}>
        <PopoverTrigger asChild>
          <button className={btnCn}>{triggerContent}</button>
        </PopoverTrigger>
        <PopoverContent className={cn("p-1", popoverClassName)} align={popoverAlign} collisionPadding={16}>
          {children}
        </PopoverContent>
      </Popover>
      {extra}
    </PropertyRow>
  );
}

function CollaboratorPill({
  collaborator,
  agentName,
  userLabel,
  onRemove,
}: {
  collaborator: IssueCollaborator;
  agentName: (id: string | null) => string | null;
  userLabel: (id: string | null | undefined) => string | null;
  onRemove: () => void;
}) {
  const label = collaborator.principalType === "agent"
    ? (agentName(collaborator.principalId) ?? collaborator.displayName ?? collaborator.principalId.slice(0, 8))
    : (userLabel(collaborator.principalId) ?? collaborator.displayName ?? collaborator.email ?? "User");
  const reasonLabel = collaborator.reason === "creator"
    ? "creator"
    : collaborator.reason === "assignment"
      ? "assignee"
      : collaborator.reason === "mention"
        ? "mentioned"
        : null;
  return (
    <div className="flex items-center gap-1.5 min-w-0">
      {collaborator.principalType === "agent" ? (
        <Hexagon className="h-3 w-3 text-muted-foreground shrink-0" />
      ) : (
        <User className="h-3 w-3 text-muted-foreground shrink-0" />
      )}
      <span className="text-sm min-w-0 truncate">{label}</span>
      {reasonLabel && (
        <span className="text-[10px] text-muted-foreground shrink-0">({reasonLabel})</span>
      )}
      <button
        type="button"
        onClick={onRemove}
        className="ml-auto opacity-0 group-hover:opacity-100 focus:opacity-100 hover:bg-accent/50 rounded p-0.5 transition-opacity shrink-0"
        title="Remove collaborator"
      >
        <XIcon className="h-3 w-3 text-muted-foreground" />
      </button>
    </div>
  );
}

interface UserDirectoryLike {
  principalId: string;
  user: { id: string; email: string | null; name: string | null; image: string | null } | null;
}

function CollaboratorCandidates({
  search,
  agents,
  users,
  existing,
  onSelect,
}: {
  search: string;
  agents: Array<{ id: string; name: string; icon?: string | null; status?: string }>;
  users: UserDirectoryLike[];
  existing: IssueCollaborator[];
  onSelect: (type: "user" | "agent", id: string) => void;
}) {
  const existingKeys = useMemo(
    () => new Set(existing.map((c) => `${c.principalType}:${c.principalId}`)),
    [existing],
  );
  const q = search.trim().toLowerCase();

  const agentMatches = agents
    .filter((a) => a.status !== "terminated")
    .filter((a) => !existingKeys.has(`agent:${a.id}`))
    .filter((a) => !q || a.name.toLowerCase().includes(q))
    .slice(0, 8);

  const userMatches = users
    .map((u) => ({
      userId: u.user?.id ?? u.principalId,
      name: u.user?.name ?? null,
      email: u.user?.email ?? null,
    }))
    .filter((u) => !existingKeys.has(`user:${u.userId}`))
    .filter((u) => {
      if (!q) return true;
      const n = (u.name ?? "").toLowerCase();
      const e = (u.email ?? "").toLowerCase();
      return n.includes(q) || e.includes(q);
    })
    .slice(0, 8);

  if (agentMatches.length === 0 && userMatches.length === 0) {
    const activeAgents = agents.filter((a) => a.status !== "terminated");
    const totalCandidates = users.length + activeAgents.length;
    const emptyMessage = q
      ? `No matches for "${q}"`
      : totalCandidates === 0
        ? "No users or agents in this company yet"
        : "Everyone is already a collaborator";
    return <div className="px-2 py-2 text-xs text-muted-foreground">{emptyMessage}</div>;
  }

  return (
    <div className="max-h-72 overflow-auto">
      {userMatches.length > 0 && (
        <div className="py-1">
          <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">Users</div>
          {userMatches.map((u) => (
            <button
              key={`user:${u.userId}`}
              className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs rounded hover:bg-accent/50"
              onClick={() => onSelect("user", u.userId)}
            >
              <User className="h-3 w-3 text-muted-foreground shrink-0" />
              <span className="truncate">{u.name ?? u.email ?? u.userId.slice(0, 8)}</span>
            </button>
          ))}
        </div>
      )}
      {agentMatches.length > 0 && (
        <div className="py-1">
          <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">Agents</div>
          {agentMatches.map((a) => (
            <button
              key={`agent:${a.id}`}
              className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs rounded hover:bg-accent/50"
              onClick={() => onSelect("agent", a.id)}
            >
              <Hexagon className="h-3 w-3 text-muted-foreground shrink-0" />
              <span className="truncate">{a.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function IssueProperties({
  issue,
  childIssues = [],
  onAddSubIssue,
  onUpdate,
  inline,
}: IssuePropertiesProps) {
  const { selectedCompanyId } = useCompany();
  const queryClient = useQueryClient();
  const companyId = issue.companyId ?? selectedCompanyId;
  const [assigneeOpen, setAssigneeOpen] = useState(false);
  const [assigneeSearch, setAssigneeSearch] = useState("");
  const [projectOpen, setProjectOpen] = useState(false);
  const [projectSearch, setProjectSearch] = useState("");
  const [blockedByOpen, setBlockedByOpen] = useState(false);
  const [blockedBySearch, setBlockedBySearch] = useState("");
  const [parentOpen, setParentOpen] = useState(false);
  const [parentSearch, setParentSearch] = useState("");
  const [reviewersOpen, setReviewersOpen] = useState(false);
  const [reviewerSearch, setReviewerSearch] = useState("");
  const [approversOpen, setApproversOpen] = useState(false);
  const [approverSearch, setApproverSearch] = useState("");
  const [labelsOpen, setLabelsOpen] = useState(false);
  const [labelSearch, setLabelSearch] = useState("");
  const [newLabelName, setNewLabelName] = useState("");
  const [newLabelColor, setNewLabelColor] = useState("#6366f1");
  const [addCollaboratorOpen, setAddCollaboratorOpen] = useState(false);
  const [collaboratorSearch, setCollaboratorSearch] = useState("");
  const [confirmMakeCompanyOpen, setConfirmMakeCompanyOpen] = useState(false);
  const [startOpen, setStartOpen] = useState(false);

  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });
  const currentUserId = session?.user?.id ?? session?.session?.userId;

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(companyId!),
    queryFn: () => agentsApi.list(companyId!),
    enabled: !!companyId,
  });
  const { data: companyMembers } = useQuery({
    queryKey: queryKeys.access.companyUserDirectory(companyId!),
    queryFn: () => accessApi.listUserDirectory(companyId!),
    enabled: !!companyId,
  });

  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(companyId!),
    queryFn: () => projectsApi.list(companyId!),
    enabled: !!companyId,
  });
  const activeProjects = useMemo(
    () => (projects ?? []).filter((p) => !p.archivedAt || p.id === issue.projectId),
    [projects, issue.projectId],
  );
  const { orderedProjects } = useProjectOrder({
    projects: activeProjects,
    companyId,
    userId: currentUserId,
  });

  const { data: labels } = useQuery({
    queryKey: queryKeys.issues.labels(companyId!),
    queryFn: () => issuesApi.listLabels(companyId!),
    enabled: !!companyId,
  });

  const { data: allIssues } = useQuery({
    queryKey: queryKeys.issues.list(companyId!),
    queryFn: () => issuesApi.list(companyId!),
    enabled: !!companyId && (blockedByOpen || parentOpen),
  });

  const { data: collaborators } = useQuery({
    queryKey: queryKeys.issues.collaborators(issue.id),
    queryFn: () => issuesApi.listCollaborators(issue.id),
    enabled: !!issue.id,
  });

  const invalidateCollaborators = useCallback(
    () => queryClient.invalidateQueries({ queryKey: queryKeys.issues.collaborators(issue.id) }),
    [queryClient, issue.id],
  );

  const addCollaborator = useMutation({
    mutationFn: (data: { principalType: "user" | "agent"; principalId: string }) =>
      issuesApi.addCollaborator(issue.id, data.principalType, data.principalId),
    onSuccess: () => invalidateCollaborators(),
  });

  const removeCollaborator = useMutation({
    mutationFn: (data: { principalType: "user" | "agent"; principalId: string }) =>
      issuesApi.removeCollaborator(issue.id, data.principalType, data.principalId),
    onSuccess: () => invalidateCollaborators(),
  });

  const updateVisibility = useMutation({
    mutationFn: (data: { visibility: "private" | "company"; confirmed?: boolean }) =>
      issuesApi.updateVisibility(issue.id, data.visibility, data.confirmed),
    onSuccess: () => {
      if (companyId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(companyId) });
      }
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(issue.id) });
    },
  });

  const createLabel = useMutation({
    mutationFn: (data: { name: string; color: string }) => issuesApi.createLabel(companyId!, data),
    onSuccess: async (created) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.issues.labels(companyId!) });
      onUpdate({ labelIds: [...(issue.labelIds ?? []), created.id] });
      setNewLabelName("");
    },
  });

  const toggleLabel = (labelId: string) => {
    const ids = issue.labelIds ?? [];
    const next = ids.includes(labelId)
      ? ids.filter((id) => id !== labelId)
      : [...ids, labelId];
    onUpdate({ labelIds: next });
  };

  const agentName = (id: string | null) => {
    if (!id || !agents) return null;
    const agent = agents.find((a) => a.id === id);
    return agent?.name ?? id.slice(0, 8);
  };

  const projectName = (id: string | null) => {
    if (!id) return id?.slice(0, 8) ?? "None";
    const project = orderedProjects.find((p) => p.id === id);
    return project?.name ?? id.slice(0, 8);
  };
  const currentProject = issue.projectId
    ? orderedProjects.find((project) => project.id === issue.projectId) ?? null
    : null;
  const projectLink = (id: string | null) => {
    if (!id) return null;
    const project = projects?.find((p) => p.id === id) ?? null;
    return project ? projectUrl(project) : `/projects/${id}`;
  };

  const recentAssigneeIds = useMemo(() => getRecentAssigneeIds(), [assigneeOpen]);
  const sortedAgents = useMemo(
    () => sortAgentsByRecency((agents ?? []).filter((a) => a.status !== "terminated"), recentAssigneeIds),
    [agents, recentAssigneeIds],
  );
  const userLabelMap = useMemo(
    () => buildCompanyUserLabelMap(companyMembers?.users),
    [companyMembers?.users],
  );
  const otherUserOptions = useMemo(
    () => buildCompanyUserInlineOptions(companyMembers?.users, { excludeUserIds: [currentUserId, issue.createdByUserId] }),
    [companyMembers?.users, currentUserId, issue.createdByUserId],
  );

  const assignee = issue.assigneeAgentId
    ? agents?.find((a) => a.id === issue.assigneeAgentId)
    : null;
  const reviewerValues = stageParticipantValues(issue.executionPolicy, "review");
  const approverValues = stageParticipantValues(issue.executionPolicy, "approval");
  const userLabel = (userId: string | null | undefined) => formatAssigneeUserLabel(userId, currentUserId, userLabelMap);
  const assigneeUserLabel = userLabel(issue.assigneeUserId);
  const creatorUserLabel = userLabel(issue.createdByUserId);
  const updateExecutionPolicy = (nextReviewers: string[], nextApprovers: string[]) => {
    onUpdate({
      executionPolicy: buildExecutionPolicy({
        existingPolicy: issue.executionPolicy ?? null,
        reviewerValues: nextReviewers,
        approverValues: nextApprovers,
      }),
    });
  };
  const toggleExecutionParticipant = (stageType: "review" | "approval", value: string) => {
    const currentValues = stageType === "review" ? reviewerValues : approverValues;
    const nextValues = currentValues.includes(value)
      ? currentValues.filter((candidate) => candidate !== value)
      : [...currentValues, value];
    updateExecutionPolicy(
      stageType === "review" ? nextValues : reviewerValues,
      stageType === "approval" ? nextValues : approverValues,
    );
  };
  const executionParticipantLabel = (value: string) => {
    if (value.startsWith("agent:")) {
      return agentName(value.slice("agent:".length)) ?? value.slice("agent:".length, "agent:".length + 8);
    }
    if (value.startsWith("user:")) {
      return userLabel(value.slice("user:".length)) ?? "User";
    }
    return value;
  };
  const reviewerTrigger = reviewerValues.length > 0
    ? <span className="text-sm break-words min-w-0">{reviewerValues.map((value) => executionParticipantLabel(value)).join(", ")}</span>
    : <span className="text-sm text-muted-foreground">None</span>;
  const approverTrigger = approverValues.length > 0
    ? <span className="text-sm break-words min-w-0">{approverValues.map((value) => executionParticipantLabel(value)).join(", ")}</span>
    : <span className="text-sm text-muted-foreground">None</span>;
  const nextRunnableExecutionStage = (() => {
    if (issue.executionState?.status === "changes_requested" && issue.executionState.currentStageType) {
      return issue.executionState.currentStageType;
    }
    if (issue.executionState) return null;
    if (reviewerValues.length > 0) return "review";
    if (approverValues.length > 0) return "approval";
    return null;
  })();
  const runExecutionButton = (stageType: "review" | "approval") => (
    <PropertyRow label="">
      <button
        type="button"
        className="inline-flex items-center rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
        onClick={() => onUpdate({ status: "in_review" })}
      >
        {stageType === "review" ? "Run review now" : "Run approval now"}
      </button>
    </PropertyRow>
  );
  const currentExecutionLabel = (() => {
    if (!issue.executionState?.currentStageType) return null;
    const stageLabel = issue.executionState.currentStageType === "review" ? "Review" : "Approval";
    const participant = issue.executionState.currentParticipant;
    const participantLabel = participant
      ? (participant.type === "agent"
        ? agentName(participant.agentId ?? null)
        : userLabel(participant.userId ?? null))
      : null;
    if (issue.executionState.status === "changes_requested") {
      return `${stageLabel} requested changes${participantLabel ? ` by ${participantLabel}` : ""}`;
    }
    return `${stageLabel} pending${participantLabel ? ` with ${participantLabel}` : ""}`;
  })();

  const labelsTrigger = (issue.labels ?? []).length > 0 ? (
    <div className="flex items-center gap-1 flex-wrap">
      {(issue.labels ?? []).slice(0, 3).map((label) => (
        <span
          key={label.id}
          className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium border"
          style={{
            borderColor: label.color,
            backgroundColor: `${label.color}22`,
            color: pickTextColorForPillBg(label.color, 0.13),
          }}
        >
          {label.name}
        </span>
      ))}
      {(issue.labels ?? []).length > 3 && (
        <span className="text-xs text-muted-foreground">+{(issue.labels ?? []).length - 3}</span>
      )}
    </div>
  ) : (
    <>
      <Tag className="h-3.5 w-3.5 text-muted-foreground" />
      <span className="text-sm text-muted-foreground">No labels</span>
    </>
  );
  const labelsExtra = (issue.labelIds ?? []).length > 0 ? (
    <button
      type="button"
      className="inline-flex items-center justify-center h-5 w-5 rounded hover:bg-accent/50 transition-colors text-muted-foreground hover:text-foreground"
      onClick={() => setLabelsOpen(true)}
      aria-label="Add label"
      title="Add label"
    >
      <Plus className="h-3 w-3" />
    </button>
  ) : undefined;

  const labelsContent = (
    <>
      <input
        className="w-full px-2 py-1.5 text-xs bg-transparent outline-none border-b border-border mb-1 placeholder:text-muted-foreground/50"
        placeholder="Search labels..."
        value={labelSearch}
        onChange={(e) => setLabelSearch(e.target.value)}
        autoFocus={!inline}
      />
      <div className="max-h-44 overflow-y-auto overscroll-contain space-y-0.5">
        {(labels ?? [])
          .filter((label) => {
            if (!labelSearch.trim()) return true;
            return label.name.toLowerCase().includes(labelSearch.toLowerCase());
          })
          .map((label) => {
            const selected = (issue.labelIds ?? []).includes(label.id);
            return (
              <button
                key={label.id}
                className={cn(
                  "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50 text-left",
                  selected && "bg-accent"
                )}
                onClick={() => toggleLabel(label.id)}
              >
                <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ backgroundColor: label.color }} />
                <span className="truncate">{label.name}</span>
              </button>
            );
          })}
      </div>
      <div className="mt-2 border-t border-border pt-2 space-y-1">
        <div className="flex items-center gap-1">
          <input
            className="h-7 w-7 p-0 rounded bg-transparent"
            type="color"
            value={newLabelColor}
            onChange={(e) => setNewLabelColor(e.target.value)}
          />
          <input
            className="flex-1 px-2 py-1.5 text-xs bg-transparent outline-none rounded placeholder:text-muted-foreground/50"
            placeholder="New label"
            value={newLabelName}
            onChange={(e) => setNewLabelName(e.target.value)}
          />
        </div>
        <button
          className="flex items-center justify-center gap-1.5 w-full px-2 py-1.5 text-xs rounded border border-border hover:bg-accent/50 disabled:opacity-50"
          disabled={!newLabelName.trim() || createLabel.isPending}
          onClick={() =>
            createLabel.mutate({
              name: newLabelName.trim(),
              color: newLabelColor,
            })
          }
        >
          <Plus className="h-3 w-3" />
          {createLabel.isPending ? "Creating…" : "Create label"}
        </button>
      </div>
    </>
  );

  const assigneeTrigger = assignee ? (
    <Identity name={assignee.name} size="sm" />
  ) : assigneeUserLabel ? (
    <>
      <User className="h-3.5 w-3.5 text-muted-foreground" />
      <span className="text-sm">{assigneeUserLabel}</span>
    </>
  ) : (
    <>
      <User className="h-3.5 w-3.5 text-muted-foreground" />
      <span className="text-sm text-muted-foreground">Unassigned</span>
    </>
  );

  const assigneeContent = (
    <>
      <input
        className="w-full px-2 py-1.5 text-xs bg-transparent outline-none border-b border-border mb-1 placeholder:text-muted-foreground/50"
        placeholder="Search assignees..."
        value={assigneeSearch}
        onChange={(e) => setAssigneeSearch(e.target.value)}
        autoFocus={!inline}
      />
      <div className="max-h-48 overflow-y-auto overscroll-contain">
        <button
          className={cn(
            "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50",
            !issue.assigneeAgentId && !issue.assigneeUserId && "bg-accent"
          )}
          onClick={() => { onUpdate({ assigneeAgentId: null, assigneeUserId: null }); setAssigneeOpen(false); }}
        >
          No assignee
        </button>
        {currentUserId && (
          <button
            className={cn(
              "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50",
              issue.assigneeUserId === currentUserId && "bg-accent",
            )}
            onClick={() => {
              onUpdate({ assigneeAgentId: null, assigneeUserId: currentUserId });
              setAssigneeOpen(false);
            }}
          >
            <User className="h-3 w-3 shrink-0 text-muted-foreground" />
            Assign to me
          </button>
        )}
        {issue.createdByUserId && issue.createdByUserId !== currentUserId && (
          <button
            className={cn(
              "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50",
              issue.assigneeUserId === issue.createdByUserId && "bg-accent",
            )}
            onClick={() => {
              onUpdate({ assigneeAgentId: null, assigneeUserId: issue.createdByUserId });
              setAssigneeOpen(false);
            }}
          >
            <User className="h-3 w-3 shrink-0 text-muted-foreground" />
            {creatorUserLabel ? `Assign to ${creatorUserLabel}` : "Assign to requester"}
          </button>
        )}
        {otherUserOptions
          .filter((option) => {
            if (!assigneeSearch.trim()) return true;
            const q = assigneeSearch.toLowerCase();
            return `${option.label} ${option.searchText ?? ""}`.toLowerCase().includes(q);
          })
          .map((option) => {
            const userId = option.id.slice("user:".length);
            return (
              <button
                key={option.id}
                className={cn(
                  "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50",
                  issue.assigneeUserId === userId && "bg-accent",
                )}
                onClick={() => {
                  onUpdate({ assigneeAgentId: null, assigneeUserId: userId });
                  setAssigneeOpen(false);
                }}
              >
                <User className="h-3 w-3 shrink-0 text-muted-foreground" />
                {option.label}
              </button>
            );
          })}
        {sortedAgents
          .filter((a) => {
            if (!assigneeSearch.trim()) return true;
            const q = assigneeSearch.toLowerCase();
            return a.name.toLowerCase().includes(q);
          })
          .map((a) => (
          <button
            key={a.id}
            className={cn(
              "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50",
              a.id === issue.assigneeAgentId && "bg-accent"
            )}
            onClick={() => { trackRecentAssignee(a.id); onUpdate({ assigneeAgentId: a.id, assigneeUserId: null }); setAssigneeOpen(false); }}
          >
            <AgentIcon icon={a.icon} className="shrink-0 h-3 w-3 text-muted-foreground" />
            {a.name}
          </button>
        ))}
      </div>
    </>
  );

  const executionParticipantsContent = (
    stageType: "review" | "approval",
    values: string[],
    search: string,
    setSearch: (value: string) => void,
    onClear: () => void,
  ) => (
    <>
      <input
        className="w-full px-2 py-1.5 text-xs bg-transparent outline-none border-b border-border mb-1 placeholder:text-muted-foreground/50"
        placeholder={`Search ${stageType === "review" ? "reviewers" : "approvers"}...`}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        autoFocus={!inline}
      />
      <div className="max-h-48 overflow-y-auto overscroll-contain">
        <button
          className={cn(
            "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50",
            values.length === 0 && "bg-accent",
          )}
          onClick={onClear}
        >
          No {stageType === "review" ? "reviewers" : "approvers"}
        </button>
        {currentUserId && (
          <button
            className={cn(
              "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50",
              values.includes(`user:${currentUserId}`) && "bg-accent",
            )}
            onClick={() => toggleExecutionParticipant(stageType, `user:${currentUserId}`)}
          >
            <User className="h-3 w-3 shrink-0 text-muted-foreground" />
            Assign to me
          </button>
        )}
        {issue.createdByUserId && issue.createdByUserId !== currentUserId && (
          <button
            className={cn(
              "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50",
              values.includes(`user:${issue.createdByUserId}`) && "bg-accent",
            )}
            onClick={() => toggleExecutionParticipant(stageType, `user:${issue.createdByUserId}`)}
          >
            <User className="h-3 w-3 shrink-0 text-muted-foreground" />
            {creatorUserLabel ? creatorUserLabel : "Requester"}
          </button>
        )}
        {otherUserOptions
          .filter((option) => {
            if (!search.trim()) return true;
            return `${option.label} ${option.searchText ?? ""}`.toLowerCase().includes(search.toLowerCase());
          })
          .map((option) => (
            <button
              key={`${stageType}:${option.id}`}
              className={cn(
                "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50",
                values.includes(option.id) && "bg-accent",
              )}
              onClick={() => toggleExecutionParticipant(stageType, option.id)}
            >
              <User className="h-3 w-3 shrink-0 text-muted-foreground" />
              {option.label}
            </button>
          ))}
        {sortedAgents
          .filter((agent) => {
            if (!search.trim()) return true;
            return agent.name.toLowerCase().includes(search.toLowerCase());
          })
          .map((agent) => {
            const encoded = `agent:${agent.id}`;
            return (
              <button
                key={`${stageType}:${agent.id}`}
                className={cn(
                  "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50",
                  values.includes(encoded) && "bg-accent",
                )}
                onClick={() => toggleExecutionParticipant(stageType, encoded)}
              >
                <AgentIcon icon={agent.icon} className="shrink-0 h-3 w-3 text-muted-foreground" />
                {agent.name}
              </button>
            );
          })}
      </div>
    </>
  );

  const projectTrigger = issue.projectId ? (
    <>
      <span
        className="shrink-0 h-3 w-3 rounded-sm"
        style={{ backgroundColor: orderedProjects.find((p) => p.id === issue.projectId)?.color ?? "#6366f1" }}
      />
      <span className="text-sm break-words min-w-0">{projectName(issue.projectId)}</span>
    </>
  ) : (
    <>
      <Hexagon className="h-3.5 w-3.5 text-muted-foreground" />
      <span className="text-sm text-muted-foreground">No project</span>
    </>
  );

  const projectContent = (
    <>
      <input
        className="w-full px-2 py-1.5 text-xs bg-transparent outline-none border-b border-border mb-1 placeholder:text-muted-foreground/50"
        placeholder="Search projects..."
        value={projectSearch}
        onChange={(e) => setProjectSearch(e.target.value)}
        autoFocus={!inline}
      />
      <div className="max-h-48 overflow-y-auto overscroll-contain">
        <button
          className={cn(
            "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50 whitespace-nowrap",
            !issue.projectId && "bg-accent"
          )}
          onClick={() => {
            onUpdate({
              projectId: null,
              projectWorkspaceId: null,
              executionWorkspaceId: null,
              executionWorkspacePreference: null,
              executionWorkspaceSettings: null,
            });
            setProjectOpen(false);
          }}
        >
          No project
        </button>
        {orderedProjects
          .filter((p) => {
            if (!projectSearch.trim()) return true;
            const q = projectSearch.toLowerCase();
            return p.name.toLowerCase().includes(q);
          })
          .map((p) => (
          <button
            key={p.id}
            className={cn(
              "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50 whitespace-nowrap",
              p.id === issue.projectId && "bg-accent"
            )}
            onClick={() => {
              const defaultMode = defaultExecutionWorkspaceModeForProject(p);
              onUpdate({
                projectId: p.id,
                projectWorkspaceId: defaultProjectWorkspaceIdForProject(p),
                executionWorkspaceId: null,
                executionWorkspacePreference: defaultMode,
                executionWorkspaceSettings: p.executionWorkspacePolicy?.enabled
                  ? { mode: defaultMode }
                  : null,
              });
              setProjectOpen(false);
            }}
          >
            <span
              className="shrink-0 h-3 w-3 rounded-sm"
              style={{ backgroundColor: p.color ?? "#6366f1" }}
            />
            {p.name}
          </button>
        ))}
      </div>
    </>
  );

  const blockedByIds = issue.blockedBy?.map((relation) => relation.id) ?? [];
  const descendantIssueIds = useMemo(() => {
    if (!allIssues?.length) return new Set<string>();
    const childrenByParentId = new Map<string, string[]>();
    for (const candidate of allIssues) {
      if (!candidate.parentId) continue;
      const children = childrenByParentId.get(candidate.parentId) ?? [];
      children.push(candidate.id);
      childrenByParentId.set(candidate.parentId, children);
    }

    const descendants = new Set<string>();
    const stack = [...(childrenByParentId.get(issue.id) ?? [])];
    while (stack.length > 0) {
      const candidateId = stack.pop();
      if (!candidateId || descendants.has(candidateId)) continue;
      descendants.add(candidateId);
      stack.push(...(childrenByParentId.get(candidateId) ?? []));
    }
    return descendants;
  }, [allIssues, issue.id]);
  const currentParentIssue = useMemo(() => {
    if (!issue.parentId) return null;
    return allIssues?.find((candidate) => candidate.id === issue.parentId) ?? null;
  }, [allIssues, issue.parentId]);
  const parentIdentifier = issue.ancestors?.[0]?.identifier ?? currentParentIssue?.identifier;
  const parentTitle = issue.ancestors?.[0]?.title ?? currentParentIssue?.title ?? issue.parentId?.slice(0, 8);
  const parentTrigger = issue.parentId ? (
    <span className="text-sm break-words min-w-0 inline">
      {parentIdentifier ? `${parentIdentifier} ` : ""}
      {parentTitle}
    </span>
  ) : (
    <span className="text-sm text-muted-foreground">No parent</span>
  );
  const parentLink = issue.parentId ? (
    <Link
      to={`/issues/${parentIdentifier ?? issue.parentId}`}
      className="inline-flex items-center justify-center h-5 w-5 rounded hover:bg-accent/50 transition-colors text-muted-foreground hover:text-foreground"
      onClick={(e) => e.stopPropagation()}
    >
      <ArrowUpRight className="h-3 w-3" />
    </Link>
  ) : undefined;
  const parentOptions = (allIssues ?? [])
    .filter((candidate) => candidate.id !== issue.id)
    .filter((candidate) => !descendantIssueIds.has(candidate.id))
    .filter((candidate) => {
      if (!parentSearch.trim()) return true;
      const query = parentSearch.toLowerCase();
      return (
        (candidate.identifier ?? "").toLowerCase().includes(query) ||
        candidate.title.toLowerCase().includes(query)
      );
    })
    .sort((a, b) => {
      const aLabel = `${a.identifier ?? ""} ${a.title}`.trim();
      const bLabel = `${b.identifier ?? ""} ${b.title}`.trim();
      return aLabel.localeCompare(bLabel);
    });
  const parentContent = (
    <>
      <input
        className="w-full px-2 py-1.5 text-xs bg-transparent outline-none border-b border-border mb-1 placeholder:text-muted-foreground/50"
        placeholder="Search issues..."
        value={parentSearch}
        onChange={(e) => setParentSearch(e.target.value)}
        autoFocus={!inline}
      />
      <div className="max-h-48 overflow-y-auto overscroll-contain">
        <button
          className={cn(
            "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50",
            !issue.parentId && "bg-accent",
          )}
          onClick={() => {
            onUpdate({ parentId: null });
            setParentOpen(false);
          }}
        >
          No parent
        </button>
        {parentOptions.map((candidate) => (
          <button
            key={candidate.id}
            className={cn(
              "flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs rounded hover:bg-accent/50",
              candidate.id === issue.parentId && "bg-accent",
            )}
            onClick={() => {
              onUpdate({ parentId: candidate.id });
              setParentOpen(false);
            }}
          >
            <StatusIcon status={candidate.status} />
            <span className="truncate">
              {candidate.identifier ? `${candidate.identifier} ` : ""}
              {candidate.title}
            </span>
          </button>
        ))}
      </div>
    </>
  );
  const blockedByTrigger = blockedByIds.length > 0 ? (
    <div className="flex items-center gap-1 flex-wrap min-w-0">
      {(issue.blockedBy ?? []).slice(0, 2).map((relation) => (
        <span key={relation.id} className="inline-flex max-w-full items-center rounded-full border border-border px-2 py-0.5 text-xs">
          <span className="truncate">{relation.identifier ?? relation.title}</span>
        </span>
      ))}
      {(issue.blockedBy ?? []).length > 2 && (
        <span className="text-xs text-muted-foreground">+{(issue.blockedBy ?? []).length - 2}</span>
      )}
    </div>
  ) : (
    <span className="text-sm text-muted-foreground">No blockers</span>
  );

  const blockingIssues = issue.blocks ?? [];
  const blockerOptions = (allIssues ?? [])
    .filter((candidate) => candidate.id !== issue.id)
    .filter((candidate) => {
      if (!blockedBySearch.trim()) return true;
      const query = blockedBySearch.toLowerCase();
      return (
        (candidate.identifier ?? "").toLowerCase().includes(query) ||
        candidate.title.toLowerCase().includes(query)
      );
    })
    .sort((a, b) => {
      const aLabel = `${a.identifier ?? ""} ${a.title}`.trim();
      const bLabel = `${b.identifier ?? ""} ${b.title}`.trim();
      return aLabel.localeCompare(bLabel);
    });

  const toggleBlockedBy = (blockedByIssueId: string) => {
    const nextBlockedByIds = blockedByIds.includes(blockedByIssueId)
      ? blockedByIds.filter((candidate) => candidate !== blockedByIssueId)
      : [...blockedByIds, blockedByIssueId];
    onUpdate({ blockedByIssueIds: nextBlockedByIds });
  };

  const blockedByContent = (
    <>
      <input
        className="w-full px-2 py-1.5 text-xs bg-transparent outline-none border-b border-border mb-1 placeholder:text-muted-foreground/50"
        placeholder="Search issues..."
        value={blockedBySearch}
        onChange={(e) => setBlockedBySearch(e.target.value)}
        autoFocus={!inline}
      />
      <div className="max-h-48 overflow-y-auto overscroll-contain">
        <button
          className={cn(
            "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50",
            blockedByIds.length === 0 && "bg-accent",
          )}
          onClick={() => onUpdate({ blockedByIssueIds: [] })}
        >
          No blockers
        </button>
        {blockerOptions.map((candidate) => {
          const selected = blockedByIds.includes(candidate.id);
          return (
            <button
              key={candidate.id}
              className={cn(
                "flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs rounded hover:bg-accent/50",
                selected && "bg-accent",
              )}
              onClick={() => toggleBlockedBy(candidate.id)}
            >
              <StatusIcon status={candidate.status} />
              <span className="truncate">
                {candidate.identifier ? `${candidate.identifier} ` : ""}
                {candidate.title}
              </span>
            </button>
          );
        })}
      </div>
    </>
  );

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <PropertyRow label="Status">
          <StatusIcon
            status={issue.status}
            onChange={(status) => onUpdate({ status })}
            showLabel
          />
        </PropertyRow>

        <PropertyRow label="Priority">
          <PriorityIcon
            priority={issue.priority}
            onChange={(priority) => onUpdate({ priority })}
            showLabel
          />
        </PropertyRow>

        <PropertyPicker
          inline={inline}
          label="Labels"
          open={labelsOpen}
          onOpenChange={(open) => { setLabelsOpen(open); if (!open) setLabelSearch(""); }}
          triggerContent={labelsTrigger}
          triggerClassName="min-w-0 max-w-full"
          popoverClassName="w-64"
          extra={labelsExtra}
        >
          {labelsContent}
        </PropertyPicker>

        <PropertyPicker
          inline={inline}
          label="Assignee"
          open={assigneeOpen}
          onOpenChange={(open) => { setAssigneeOpen(open); if (!open) setAssigneeSearch(""); }}
          triggerContent={assigneeTrigger}
          popoverClassName="w-52"
          extra={issue.assigneeAgentId ? (
            <Link
              to={`/agents/${issue.assigneeAgentId}`}
              className="inline-flex items-center justify-center h-5 w-5 rounded hover:bg-accent/50 transition-colors text-muted-foreground hover:text-foreground"
              onClick={(e) => e.stopPropagation()}
            >
              <ArrowUpRight className="h-3 w-3" />
            </Link>
          ) : undefined}
        >
          {assigneeContent}
        </PropertyPicker>

        <PropertyPicker
          inline={inline}
          label="Project"
          open={projectOpen}
          onOpenChange={(open) => { setProjectOpen(open); if (!open) setProjectSearch(""); }}
          triggerContent={projectTrigger}
          triggerClassName="min-w-0 max-w-full"
          popoverClassName="w-fit min-w-[11rem]"
          extra={issue.projectId ? (
            <Link
              to={projectLink(issue.projectId)!}
              className="inline-flex items-center justify-center h-5 w-5 rounded hover:bg-accent/50 transition-colors text-muted-foreground hover:text-foreground"
              onClick={(e) => e.stopPropagation()}
            >
              <ArrowUpRight className="h-3 w-3" />
            </Link>
          ) : undefined}
        >
          {projectContent}
        </PropertyPicker>

        <PropertyRow label="Due date">
          {issue.dueDate ? (
            <>
              {(() => {
                const isClosed = issue.status === "done" || issue.status === "cancelled";
                const isOverdue = !isClosed && new Date(issue.dueDate) < new Date();
                return (
                  <span
                    className={cn(
                      "relative inline-flex items-center gap-1.5 cursor-pointer hover:bg-accent/50 rounded px-1 -mx-1 py-0.5 transition-colors",
                      isOverdue && "text-red-500 font-medium",
                    )}
                    title="Change due date"
                  >
                    <Calendar
                      className={cn(
                        "h-3.5 w-3.5 shrink-0",
                        isOverdue ? "text-red-500" : "text-muted-foreground",
                      )}
                    />
                    <span className="text-sm">{formatDueDateRelative(issue.dueDate)}</span>
                    <input
                      type="date"
                      className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                      value={dueDateInputValue(issue.dueDate)}
                      onChange={(e) => {
                        if (e.target.value) {
                          onUpdate({
                            dueDate: new Date(e.target.value + "T23:59:59.999Z").toISOString(),
                          });
                        }
                      }}
                    />
                  </span>
                );
              })()}
              <button
                type="button"
                onClick={() => onUpdate({ dueDate: null })}
                className="inline-flex items-center justify-center h-5 w-5 rounded hover:bg-accent/50 transition-colors text-muted-foreground hover:text-foreground"
                title="Remove due date"
              >
                <XIcon className="h-3 w-3" />
              </button>
            </>
          ) : (
            <span className="relative inline-flex items-center gap-1.5 cursor-pointer hover:bg-accent/50 rounded px-1 -mx-1 py-0.5 transition-colors">
              <Calendar className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-sm text-muted-foreground">No due date</span>
              <input
                type="date"
                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                onChange={(e) => {
                  if (e.target.value) {
                    onUpdate({
                      dueDate: new Date(e.target.value + "T23:59:59.999Z").toISOString(),
                    });
                  }
                }}
              />
            </span>
          )}
        </PropertyRow>

        {issue.dueDate ? (
          <PropertyRow label="Start">
            <Play className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <Popover open={startOpen} onOpenChange={setStartOpen}>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className="inline-flex items-center gap-1.5 cursor-pointer hover:bg-accent/50 rounded px-1 -mx-1 py-0.5 transition-colors text-left"
                  title="Change lead time"
                >
                  <span className="text-sm">
                    {issue.workLeadDays != null
                      ? formatStartRelative(issue.dueDate, issue.workLeadDays)
                      : "Start when ready"}
                  </span>
                </button>
              </PopoverTrigger>
              <PopoverContent className="p-1 w-56" align="end" collisionPadding={16}>
                <div className="flex flex-col">
                  {LEAD_DAYS_PRESETS.map((days) => {
                    const selected = issue.workLeadDays === days;
                    return (
                      <button
                        key={days}
                        type="button"
                        className={cn(
                          "flex items-center justify-between gap-2 px-2 py-1.5 text-sm rounded hover:bg-accent/50 text-left",
                          selected && "bg-accent/50",
                        )}
                        onClick={() => {
                          onUpdate({ workLeadDays: days });
                          setStartOpen(false);
                        }}
                      >
                        <span>{days === 0 ? "On due date" : days === 1 ? "1 day before" : `${days} days before`}</span>
                        {selected ? <Check className="h-3.5 w-3.5" /> : null}
                      </button>
                    );
                  })}
                </div>
              </PopoverContent>
            </Popover>
            {issue.workLeadDays != null ? (
              <button
                type="button"
                onClick={() => onUpdate({ workLeadDays: null })}
                className="inline-flex items-center justify-center h-5 w-5 rounded hover:bg-accent/50 transition-colors text-muted-foreground hover:text-foreground"
                title="Clear lead time"
              >
                <XIcon className="h-3 w-3" />
              </button>
            ) : null}
          </PropertyRow>
        ) : null}

        <PropertyPicker
          inline={inline}
          label="Parent"
          open={parentOpen}
          onOpenChange={(open) => {
            setParentOpen(open);
            if (!open) setParentSearch("");
          }}
          triggerContent={parentTrigger}
          triggerClassName="min-w-0 max-w-full"
          popoverClassName="w-72"
          extra={parentLink}
        >
          {parentContent}
        </PropertyPicker>

        <PropertyPicker
          inline={inline}
          label="Blocked by"
          open={blockedByOpen}
          onOpenChange={(open) => {
            setBlockedByOpen(open);
            if (!open) setBlockedBySearch("");
          }}
          triggerContent={blockedByTrigger}
          triggerClassName="min-w-0 max-w-full"
          popoverClassName="w-72"
        >
          {blockedByContent}
        </PropertyPicker>

        <PropertyRow label="Blocking">
          {blockingIssues.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {blockingIssues.map((relation) => (
                <Link
                  key={relation.id}
                  to={`/issues/${relation.identifier ?? relation.id}`}
                  className="inline-flex items-center rounded-full border border-border px-2 py-0.5 text-xs hover:bg-accent/50"
                >
                  {relation.identifier ?? relation.title}
                </Link>
              ))}
            </div>
          ) : null}
        </PropertyRow>

        <PropertyRow label="Sub-issues">
          <div className="flex flex-wrap items-center gap-1.5">
            {childIssues.length > 0
              ? childIssues.map((child) => (
                <Link
                  key={child.id}
                  to={`/issues/${child.identifier ?? child.id}`}
                  className="inline-flex items-center rounded-full border border-border px-2 py-0.5 text-xs hover:bg-accent/50"
                >
                  {child.identifier ?? child.title}
                </Link>
              ))
              : null}
            {onAddSubIssue ? (
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
                onClick={onAddSubIssue}
              >
                <Plus className="h-3 w-3" />
                Add sub-issue
              </button>
            ) : null}
          </div>
        </PropertyRow>

        <PropertyPicker
          inline={inline}
          label="Reviewers"
          open={reviewersOpen}
          onOpenChange={(open) => { setReviewersOpen(open); if (!open) setReviewerSearch(""); }}
          triggerContent={reviewerTrigger}
          triggerClassName="min-w-0 max-w-full"
          popoverClassName="w-56"
        >
          {executionParticipantsContent(
            "review",
            reviewerValues,
            reviewerSearch,
            setReviewerSearch,
            () => updateExecutionPolicy([], approverValues),
          )}
        </PropertyPicker>
        {nextRunnableExecutionStage === "review" && reviewerValues.length > 0 ? runExecutionButton("review") : null}

        <PropertyPicker
          inline={inline}
          label="Approvers"
          open={approversOpen}
          onOpenChange={(open) => { setApproversOpen(open); if (!open) setApproverSearch(""); }}
          triggerContent={approverTrigger}
          triggerClassName="min-w-0 max-w-full"
          popoverClassName="w-56"
        >
          {executionParticipantsContent(
            "approval",
            approverValues,
            approverSearch,
            setApproverSearch,
            () => updateExecutionPolicy(reviewerValues, []),
          )}
        </PropertyPicker>
        {nextRunnableExecutionStage === "approval" && approverValues.length > 0 ? runExecutionButton("approval") : null}

        {currentExecutionLabel && (
          <PropertyRow label="Execution">
            <span className="text-sm">{currentExecutionLabel}</span>
          </PropertyRow>
        )}

        {issue.requestDepth > 0 && (
          <PropertyRow label="Depth">
            <span className="text-sm font-mono">{issue.requestDepth}</span>
          </PropertyRow>
        )}
      </div>

      <Separator />

      <div className="space-y-1">
        <PropertyRow label="Visibility">
          {issue.visibility === "private" ? (
            <button
              type="button"
              onClick={() => setConfirmMakeCompanyOpen(true)}
              className="inline-flex items-center gap-1.5 rounded px-1 -mx-1 py-0.5 text-sm hover:bg-accent/50 transition-colors cursor-pointer"
              title="Make visible to the whole company"
            >
              <Lock className="h-3.5 w-3.5 text-muted-foreground" />
              <span>Private</span>
            </button>
          ) : (
            <button
              type="button"
              onClick={() =>
                updateVisibility.mutate({ visibility: "private" })
              }
              className="inline-flex items-center gap-1.5 rounded px-1 -mx-1 py-0.5 text-sm hover:bg-accent/50 transition-colors cursor-pointer"
              title="Make private"
            >
              <Globe className="h-3.5 w-3.5 text-muted-foreground" />
              <span>Company</span>
            </button>
          )}
        </PropertyRow>

        <PropertyRow label="Collaborators">
          <div className="flex flex-col gap-1 min-w-0 flex-1">
            {(collaborators ?? []).length === 0 ? (
              <span className="text-sm text-muted-foreground">No collaborators</span>
            ) : (
              (collaborators ?? []).map((c) => (
                <CollaboratorPill
                  key={c.id}
                  collaborator={c}
                  agentName={agentName}
                  userLabel={userLabel}
                  onRemove={() =>
                    removeCollaborator.mutate({
                      principalType: c.principalType,
                      principalId: c.principalId,
                    })
                  }
                />
              ))
            )}
            <Popover
              open={addCollaboratorOpen}
              onOpenChange={(open) => {
                setAddCollaboratorOpen(open);
                if (!open) setCollaboratorSearch("");
              }}
            >
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className="inline-flex items-center gap-1 self-start rounded px-1 -mx-1 py-0.5 text-xs text-muted-foreground hover:bg-accent/50 transition-colors"
                >
                  <Plus className="h-3 w-3" />
                  Add
                </button>
              </PopoverTrigger>
              <PopoverContent className="w-64 p-1" align="end" collisionPadding={16}>
                <div className="px-2 py-1.5">
                  <input
                    type="text"
                    value={collaboratorSearch}
                    onChange={(e) => setCollaboratorSearch(e.target.value)}
                    placeholder="Search users or agents..."
                    className="w-full rounded border border-border bg-transparent px-2 py-1 text-xs focus:outline-none focus:border-primary"
                  />
                </div>
                <CollaboratorCandidates
                  search={collaboratorSearch}
                  agents={agents ?? []}
                  users={companyMembers?.users ?? []}
                  existing={collaborators ?? []}
                  onSelect={(principalType, principalId) => {
                    addCollaborator.mutate({ principalType, principalId });
                    setAddCollaboratorOpen(false);
                    setCollaboratorSearch("");
                  }}
                />
              </PopoverContent>
            </Popover>
          </div>
        </PropertyRow>
      </div>

      <Dialog open={confirmMakeCompanyOpen} onOpenChange={setConfirmMakeCompanyOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Make this issue visible to the whole company?</DialogTitle>
            <DialogDescription>
              Anyone in the company will be able to see this issue, its comments, documents, and attachments.
              You can switch it back to private later.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmMakeCompanyOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                updateVisibility.mutate(
                  { visibility: "company", confirmed: true },
                  { onSuccess: () => setConfirmMakeCompanyOpen(false) },
                );
              }}
            >
              Make company-visible
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {issue.currentExecutionWorkspace?.branchName || issue.currentExecutionWorkspace?.cwd || issue.executionWorkspaceId ? (
        <>
          <Separator />
          <div className="space-y-1">
            {issue.executionWorkspaceId && (
              <PropertyRow label="Workspace">
                <Link
                  to={`/execution-workspaces/${issue.executionWorkspaceId}`}
                  className="text-sm text-primary hover:underline inline-flex items-center gap-1"
                >
                  View workspace
                  <ExternalLink className="h-3 w-3" />
                </Link>
              </PropertyRow>
            )}
            {issue.currentExecutionWorkspace?.branchName && (
              <PropertyRow label="Branch">
                <TruncatedCopyable
                  value={issue.currentExecutionWorkspace.branchName}
                  icon={GitBranch}
                />
              </PropertyRow>
            )}
            {issue.currentExecutionWorkspace?.cwd && (
              <PropertyRow label="Folder">
                <TruncatedCopyable
                  value={issue.currentExecutionWorkspace.cwd}
                  icon={FolderOpen}
                />
              </PropertyRow>
            )}
          </div>
        </>
      ) : null}

      <Separator />

      <div className="space-y-1">
        {(issue.createdByAgentId || issue.createdByUserId) && (
          <PropertyRow label="Created by">
            {issue.createdByAgentId ? (
              <Link
                to={`/agents/${issue.createdByAgentId}`}
                className="hover:underline"
              >
                <Identity name={agentName(issue.createdByAgentId) ?? issue.createdByAgentId.slice(0, 8)} size="sm" />
              </Link>
            ) : (
              <>
                <User className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-sm">{creatorUserLabel ?? "User"}</span>
              </>
            )}
          </PropertyRow>
        )}
        {issue.startedAt && (
          <PropertyRow label="Started">
            <span className="text-sm">{formatDate(issue.startedAt)}</span>
          </PropertyRow>
        )}
        {issue.completedAt && (
          <PropertyRow label="Completed">
            <span className="text-sm">{formatDate(issue.completedAt)}</span>
          </PropertyRow>
        )}
        <PropertyRow label="Created">
          <span className="text-sm">{formatDate(issue.createdAt)}</span>
        </PropertyRow>
        <PropertyRow label="Updated">
          <span className="text-sm">{timeAgo(issue.updatedAt)}</span>
        </PropertyRow>
      </div>
    </div>
  );
}
