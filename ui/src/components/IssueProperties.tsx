import { useMemo, useState } from "react";
import { pickTextColorForPillBg } from "@/lib/color-contrast";
import { Link } from "@/lib/router";
import type { Issue } from "@paperclipai/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { agentsApi } from "../api/agents";
import { authApi } from "../api/auth";
import { issuesApi } from "../api/issues";
import { projectsApi } from "../api/projects";
import { useCompany } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";
import { useProjectOrder } from "../hooks/useProjectOrder";
import { getRecentAssigneeIds, sortAgentsByRecency, trackRecentAssignee } from "../lib/recent-assignees";
import { formatAssigneeUserLabel } from "../lib/assignees";
import { StatusIcon } from "./StatusIcon";
import { PriorityIcon } from "./PriorityIcon";
import { Identity } from "./Identity";
import { formatDate, cn, projectUrl } from "../lib/utils";
import { timeAgo } from "../lib/timeAgo";
import { Separator } from "@/components/ui/separator";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { User, Hexagon, ArrowUpRight, Tag, Plus, Trash2 } from "lucide-react";
import { AgentIcon } from "./AgentIconPicker";

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
  onUpdate: (data: Record<string, unknown>) => void;
  inline?: boolean;
}

function PropertyRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 py-1.5">
      <span className="text-xs text-muted-foreground shrink-0 w-20">{label}</span>
      <div className="flex items-center gap-1.5 min-w-0 flex-1">{children}</div>
    </div>
  );
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
    "inline-flex items-center gap-1.5 cursor-pointer hover:bg-accent/50 rounded px-1 -mx-1 py-0.5 transition-colors",
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

export function IssueProperties({ issue, onUpdate, inline }: IssuePropertiesProps) {
  const { selectedCompanyId } = useCompany();
  const queryClient = useQueryClient();
  const companyId = issue.companyId ?? selectedCompanyId;
  const [assigneeOpen, setAssigneeOpen] = useState(false);
  const [assigneeSearch, setAssigneeSearch] = useState("");
  const [projectOpen, setProjectOpen] = useState(false);
  const [projectSearch, setProjectSearch] = useState("");
  const [blockedByOpen, setBlockedByOpen] = useState(false);
  const [blockedBySearch, setBlockedBySearch] = useState("");
  const [labelsOpen, setLabelsOpen] = useState(false);
  const [labelSearch, setLabelSearch] = useState("");
  const [newLabelName, setNewLabelName] = useState("");
  const [newLabelColor, setNewLabelColor] = useState("#6366f1");

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
    enabled: !!companyId && blockedByOpen,
  });

  const createLabel = useMutation({
    mutationFn: (data: { name: string; color: string }) => issuesApi.createLabel(companyId!, data),
    onSuccess: async (created) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.issues.labels(companyId!) });
      onUpdate({ labelIds: [...(issue.labelIds ?? []), created.id] });
      setNewLabelName("");
    },
  });

  const deleteLabel = useMutation({
    mutationFn: (labelId: string) => issuesApi.deleteLabel(labelId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.labels(companyId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(companyId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(issue.id) });
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

  const assignee = issue.assigneeAgentId
    ? agents?.find((a) => a.id === issue.assigneeAgentId)
    : null;
  const userLabel = (userId: string | null | undefined) => formatAssigneeUserLabel(userId, currentUserId);
  const assigneeUserLabel = userLabel(issue.assigneeUserId);
  const creatorUserLabel = userLabel(issue.createdByUserId);

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
              <div key={label.id} className="flex items-center gap-1">
                <button
                  className={cn(
                    "flex items-center gap-2 flex-1 px-2 py-1.5 text-xs rounded hover:bg-accent/50 text-left",
                    selected && "bg-accent"
                  )}
                  onClick={() => toggleLabel(label.id)}
                >
                  <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ backgroundColor: label.color }} />
                  <span className="truncate">{label.name}</span>
                </button>
                <button
                  type="button"
                  className="p-1 text-muted-foreground hover:text-destructive rounded"
                  onClick={() => deleteLabel.mutate(label.id)}
                  title={`Delete ${label.name}`}
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
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

  const projectTrigger = issue.projectId ? (
    <>
      <span
        className="shrink-0 h-3 w-3 rounded-sm"
        style={{ backgroundColor: orderedProjects.find((p) => p.id === issue.projectId)?.color ?? "#6366f1" }}
      />
      <span className="text-sm truncate">{projectName(issue.projectId)}</span>
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
          ) : (
            <span className="text-sm text-muted-foreground">None</span>
          )}
        </PropertyRow>

        {issue.parentId && (
          <PropertyRow label="Parent">
            <Link
              to={`/issues/${issue.ancestors?.[0]?.identifier ?? issue.parentId}`}
              className="text-sm hover:underline"
            >
              {issue.ancestors?.[0]?.title ?? issue.parentId.slice(0, 8)}
            </Link>
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
