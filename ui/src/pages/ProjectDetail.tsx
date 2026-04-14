import { useEffect, useMemo, useState, useRef } from "react";
import { useParams, useNavigate, useLocation, Navigate } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { PROJECT_COLORS, PROJECT_PERMISSION_KEYS, PROJECT_ROLE_PRESETS, isUuidLike } from "@paperclipai/shared";
import { projectsApi } from "../api/projects";
import { issuesApi } from "../api/issues";
import { agentsApi } from "../api/agents";
import { accessApi } from "../api/access";
import { heartbeatsApi } from "../api/heartbeats";
import { assetsApi } from "../api/assets";
import { usePanel } from "../context/PanelContext";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { ProjectProperties } from "../components/ProjectProperties";
import { InlineEditor } from "../components/InlineEditor";
import { StatusBadge } from "../components/StatusBadge";
import { IssuesList } from "../components/IssuesList";
import { PageSkeleton } from "../components/PageSkeleton";
import { ToggleField } from "../components/agent-config-primitives";
import { projectRouteRef, cn } from "../lib/utils";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SlidersHorizontal, Users, Shield, ChevronDown, ChevronRight, Trash2, Plus, Bot } from "lucide-react";

/* ── Top-level tab types ── */

type ProjectTab = "overview" | "list" | "members";

function resolveProjectTab(pathname: string, projectId: string): ProjectTab | null {
  const segments = pathname.split("/").filter(Boolean);
  const projectsIdx = segments.indexOf("projects");
  if (projectsIdx === -1 || segments[projectsIdx + 1] !== projectId) return null;
  const tab = segments[projectsIdx + 2];
  if (tab === "overview") return "overview";
  if (tab === "issues") return "list";
  if (tab === "members") return "members";
  return null;
}

/* ── Project permission labels ── */

const PROJECT_PERMISSION_LABELS: Record<string, string> = {
  "project:view": "View project",
  "project:issues:create": "Create issues",
  "project:issues:edit": "Edit issues",
  "project:issues:delete": "Delete issues",
  "project:issues:assign": "Assign issues",
  "project:agents:use": "Use agents",
  "project:settings": "Project settings",
  "project:members:manage": "Manage members",
};

const PROJECT_PERMISSION_DESCRIPTIONS: Record<string, string> = {
  "project:view": "View the project and its issues.",
  "project:issues:create": "Create new issues in this project.",
  "project:issues:edit": "Edit existing issues in this project.",
  "project:issues:delete": "Delete issues from this project.",
  "project:issues:assign": "Assign issues to members or agents.",
  "project:agents:use": "Use agents within this project.",
  "project:settings": "Modify project settings and configuration.",
  "project:members:manage": "Add, remove, and manage project members.",
};

/* ── Overview tab content ── */

function OverviewContent({
  project,
  onUpdate,
  imageUploadHandler,
}: {
  project: { description: string | null; status: string; targetDate: string | null };
  onUpdate: (data: Record<string, unknown>) => void;
  imageUploadHandler?: (file: File) => Promise<string>;
}) {
  return (
    <div className="space-y-6">
      <InlineEditor
        value={project.description ?? ""}
        onSave={(description) => onUpdate({ description })}
        as="p"
        className="text-sm text-muted-foreground"
        placeholder="Add a description..."
        multiline
        imageUploadHandler={imageUploadHandler}
      />

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
        <div>
          <span className="text-muted-foreground">Status</span>
          <div className="mt-1">
            <StatusBadge status={project.status} />
          </div>
        </div>
        {project.targetDate && (
          <div>
            <span className="text-muted-foreground">Target Date</span>
            <p>{project.targetDate}</p>
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Members panel (lightweight, for overview area) ── */

function MembersPanel({
  projectId,
  onGoToMembers,
}: {
  projectId: string;
  onGoToMembers: () => void;
}) {
  const { data: members = [], isLoading } = useQuery({
    queryKey: queryKeys.projects.members(projectId),
    queryFn: () => projectsApi.listMembers(projectId),
    enabled: !!projectId,
  });

  if (isLoading) {
    return (
      <div className="space-y-2">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Members</div>
        <p className="text-xs text-muted-foreground">Loading members...</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <Users className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Members</span>
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
            {members.length}
          </span>
        </div>
        <button
          onClick={onGoToMembers}
          className="text-[11px] text-muted-foreground hover:text-foreground transition-colors"
        >
          Manage members
        </button>
      </div>
      {members.length === 0 ? (
        <p className="text-xs text-muted-foreground">No members assigned yet.</p>
      ) : (
        <div className="space-y-1">
          {members.slice(0, 5).map((member) => (
            <div
              key={member.id}
              className="flex items-center gap-2 text-xs"
            >
              <span className="font-medium truncate">{member.displayName || member.email || member.principalId}</span>
              <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                {member.role}
              </span>
            </div>
          ))}
          {members.length > 5 && (
            <p className="text-[11px] text-muted-foreground">
              +{members.length - 5} more
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/* ── Color picker popover ── */

function ColorPicker({
  currentColor,
  onSelect,
}: {
  currentColor: string;
  onSelect: (color: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className="shrink-0 h-5 w-5 rounded-md cursor-pointer hover:ring-2 hover:ring-foreground/20 transition-[box-shadow]"
        style={{ backgroundColor: currentColor }}
        aria-label="Change project color"
      />
      {open && (
        <div className="absolute top-full left-0 mt-2 p-2 bg-popover border border-border rounded-lg shadow-lg z-50 w-max">
          <div className="grid grid-cols-5 gap-1.5">
            {PROJECT_COLORS.map((color) => (
              <button
                key={color}
                onClick={() => {
                  onSelect(color);
                  setOpen(false);
                }}
                className={`h-6 w-6 rounded-md cursor-pointer transition-[transform,box-shadow] duration-150 hover:scale-110 ${
                  color === currentColor
                    ? "ring-2 ring-foreground ring-offset-1 ring-offset-background"
                    : "hover:ring-2 hover:ring-foreground/30"
                }`}
                style={{ backgroundColor: color }}
                aria-label={`Select color ${color}`}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ── List (issues) tab content ── */

function ProjectIssuesList({ projectId, companyId }: { projectId: string; companyId: string }) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
    enabled: !!companyId,
  });

  const { data: liveRuns } = useQuery({
    queryKey: queryKeys.liveRuns(companyId),
    queryFn: () => heartbeatsApi.liveRunsForCompany(companyId),
    enabled: !!companyId,
    refetchInterval: 5000,
  });

  const liveIssueIds = useMemo(() => {
    const ids = new Set<string>();
    for (const run of liveRuns ?? []) {
      if (run.issueId) ids.add(run.issueId);
    }
    return ids;
  }, [liveRuns]);

  const { data: issues, isLoading, error } = useQuery({
    queryKey: queryKeys.issues.listByProject(companyId, projectId),
    queryFn: () => issuesApi.list(companyId, { projectId }),
    enabled: !!companyId,
  });

  const updateIssue = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Record<string, unknown> }) =>
      issuesApi.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.listByProject(companyId, projectId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(companyId) });
    },
    onError: (err) => {
      pushToast({
        title: "Failed to update issue",
        body: err instanceof Error ? err.message : "Unknown error",
        tone: "error",
      });
    },
  });

  return (
    <IssuesList
      issues={issues ?? []}
      isLoading={isLoading}
      error={error as Error | null}
      agents={agents}
      liveIssueIds={liveIssueIds}
      projectId={projectId}
      viewStateKey={`paperclip:project-view:${projectId}`}
      onUpdateIssue={(id, data) => updateIssue.mutate({ id, data })}
    />
  );
}

/* ── Project Members Section (full management, for "Members" tab) ── */

function ProjectMembersSection({ projectId, companyId }: { projectId: string; companyId: string }) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();

  // State
  const [expandedMemberId, setExpandedMemberId] = useState<string | null>(null);
  const [editingGrants, setEditingGrants] = useState<Record<string, boolean>>({});
  const [addMemberPrincipalId, setAddMemberPrincipalId] = useState("");
  const [addMemberRole, setAddMemberRole] = useState("viewer");
  const [addAgentId, setAddAgentId] = useState("");

  // Fetch project members
  const {
    data: members = [],
    isLoading: membersLoading,
  } = useQuery({
    queryKey: queryKeys.projects.members(projectId),
    queryFn: () => projectsApi.listMembers(projectId),
    enabled: !!projectId,
  });

  // Fetch company members (for "add member" dropdown)
  // This may fail if user lacks users:manage_permissions — handle gracefully
  const { data: companyMembers = [] } = useQuery({
    queryKey: queryKeys.access.members(companyId),
    queryFn: () => accessApi.listMembers(companyId).catch(() => [] as any[]),
    enabled: !!companyId,
    retry: false,
  });

  // Fetch project agents
  const { data: projectAgents = [] } = useQuery({
    queryKey: queryKeys.projects.agents(projectId),
    queryFn: () => projectsApi.listAgentsAccess(projectId),
    enabled: !!projectId,
  });

  // Fetch company agents (for "add agent" dropdown)
  const { data: companyAgents = [] } = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
    enabled: !!companyId,
  });

  // Human members not yet in project (agents go through "Add Agent" section)
  const availableCompanyMembers = useMemo(() => {
    const existingPrincipalIds = new Set(members.map((m) => m.principalId));
    return companyMembers.filter((cm) => cm.principalType === "user" && !existingPrincipalIds.has(cm.principalId));
  }, [companyMembers, members]);

  // Agents not yet assigned to project
  const availableAgents = useMemo(() => {
    const existingAgentIds = new Set(projectAgents.map((pa) => pa.agentId));
    return companyAgents.filter((a) => !existingAgentIds.has(a.id));
  }, [companyAgents, projectAgents]);

  // Add member mutation
  const addMemberMutation = useMutation({
    mutationFn: (data: { principalType: string; principalId: string; role: string }) =>
      projectsApi.addMember(projectId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.members(projectId) });
      setAddMemberPrincipalId("");
      setAddMemberRole("viewer");
    },
    onError: (err) => {
      pushToast({
        title: "Failed to add member",
        body: err instanceof Error ? err.message : "Unknown error",
        tone: "error",
      });
    },
  });

  // Update permissions mutation
  const permissionsMutation = useMutation({
    mutationFn: ({ memberId, grants }: { memberId: string; grants: Array<{ permissionKey: string }> }) =>
      projectsApi.updateMemberPermissions(projectId, memberId, grants),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.members(projectId) });
      setExpandedMemberId(null);
    },
    onError: (err) => {
      pushToast({
        title: "Failed to update permissions",
        body: err instanceof Error ? err.message : "Unknown error",
        tone: "error",
      });
    },
  });

  // Apply role preset mutation
  const applyPresetMutation = useMutation({
    mutationFn: ({ memberId, presetId }: { memberId: string; presetId: string }) =>
      projectsApi.applyMemberRolePreset(projectId, memberId, presetId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.members(projectId) });
      setExpandedMemberId(null);
    },
    onError: (err) => {
      pushToast({
        title: "Failed to apply role preset",
        body: err instanceof Error ? err.message : "Unknown error",
        tone: "error",
      });
    },
  });

  // Remove member mutation
  const removeMemberMutation = useMutation({
    mutationFn: (memberId: string) => projectsApi.removeMember(projectId, memberId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.members(projectId) });
      setExpandedMemberId(null);
    },
    onError: (err) => {
      pushToast({
        title: "Failed to remove member",
        body: err instanceof Error ? err.message : "Unknown error",
        tone: "error",
      });
    },
  });

  // Add agent access mutation
  const addAgentMutation = useMutation({
    mutationFn: (agentId: string) => projectsApi.addAgentAccess(projectId, agentId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.agents(projectId) });
      setAddAgentId("");
    },
    onError: (err) => {
      pushToast({
        title: "Failed to add agent to project",
        body: err instanceof Error ? err.message : "Unknown error",
        tone: "error",
      });
    },
  });

  // Remove agent access mutation
  const removeAgentMutation = useMutation({
    mutationFn: (agentId: string) => projectsApi.removeAgentAccess(projectId, agentId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.agents(projectId) });
    },
    onError: (err) => {
      pushToast({
        title: "Failed to remove agent from project",
        body: err instanceof Error ? err.message : "Unknown error",
        tone: "error",
      });
    },
  });

  function startEditPermissions(member: { id: string; grants: Array<{ permissionKey: string }> }) {
    if (expandedMemberId === member.id) {
      setExpandedMemberId(null);
      return;
    }
    const initial: Record<string, boolean> = {};
    for (const key of PROJECT_PERMISSION_KEYS) {
      initial[key] = (member.grants ?? []).some((g) => g.permissionKey === key);
    }
    setEditingGrants(initial);
    setExpandedMemberId(member.id);
  }

  function handleSavePermissions(memberId: string) {
    const grants: Array<{ permissionKey: string }> = [];
    for (const key of PROJECT_PERMISSION_KEYS) {
      if (editingGrants[key]) {
        grants.push({ permissionKey: key });
      }
    }
    permissionsMutation.mutate({ memberId, grants });
  }

  function handleAddMember() {
    if (!addMemberPrincipalId) return;
    const selected = companyMembers.find((cm) => cm.principalId === addMemberPrincipalId);
    if (!selected) return;
    addMemberMutation.mutate({
      principalType: selected.principalType,
      principalId: selected.principalId,
      role: addMemberRole,
    });
  }

  return (
    <div className="space-y-6">
      {/* ── Add Member ── */}
      <div className="space-y-3">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Add Member
        </div>
        <div className="rounded-md border border-border px-4 py-4 space-y-3">
          <div className="flex items-center gap-1.5">
            <Users className="h-4 w-4 text-muted-foreground" />
            <span className="text-xs text-muted-foreground">
              Add a company member to this project.
            </span>
          </div>
          <div className="flex items-end gap-2 flex-wrap">
            <div className="flex-1 min-w-[200px]">
              <label className="text-xs text-muted-foreground mb-1 block">Member</label>
              <select
                className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm outline-none"
                value={addMemberPrincipalId}
                onChange={(e) => setAddMemberPrincipalId(e.target.value)}
              >
                <option value="">Select a member...</option>
                {availableCompanyMembers.map((cm) => (
                  <option key={cm.principalId} value={cm.principalId}>
                    {cm.displayName || cm.email || cm.principalId} ({cm.principalType})
                  </option>
                ))}
              </select>
            </div>
            <div className="w-[140px]">
              <label className="text-xs text-muted-foreground mb-1 block">Role</label>
              <select
                className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm outline-none"
                value={addMemberRole}
                onChange={(e) => setAddMemberRole(e.target.value)}
              >
                {PROJECT_ROLE_PRESETS.map((preset) => (
                  <option key={preset.id} value={preset.id}>
                    {preset.label}
                  </option>
                ))}
              </select>
            </div>
            <Button
              size="sm"
              onClick={handleAddMember}
              disabled={!addMemberPrincipalId || addMemberMutation.isPending}
            >
              <Plus className="h-3.5 w-3.5 mr-1" />
              {addMemberMutation.isPending ? "Adding..." : "Add"}
            </Button>
          </div>
          {addMemberMutation.isError && (
            <p className="text-xs text-destructive">
              {addMemberMutation.error instanceof Error
                ? addMemberMutation.error.message
                : "Failed to add member"}
            </p>
          )}
        </div>
      </div>

      {/* ── Project Members List ── */}
      <div className="space-y-3">
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            Project Members
          </span>
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
            {members.length}
          </span>
        </div>
        <div className="rounded-md border border-border px-4 py-4">
          {membersLoading ? (
            <p className="text-xs text-muted-foreground">Loading members...</p>
          ) : members.length === 0 ? (
            <p className="text-xs text-muted-foreground">No members in this project yet.</p>
          ) : (
            <div className="space-y-1">
              {members.map((member) => (
                <div key={member.id}>
                  {/* Member row */}
                  <div
                    className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2 cursor-pointer hover:bg-accent/50 transition-colors"
                    onClick={() => startEditPermissions(member)}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-sm font-medium truncate">
                        {member.displayName || member.email || member.principalId}
                      </span>
                      {member.email && member.displayName && (
                        <span className="shrink-0 text-xs text-muted-foreground truncate max-w-[200px]">
                          {member.email}
                        </span>
                      )}
                      <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                        {member.principalType}
                      </span>
                      <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                        {member.role}
                      </span>
                      {(member.grants?.length ?? 0) > 0 && (
                        <span className="shrink-0 rounded bg-indigo-500/10 px-1.5 py-0.5 text-[10px] font-medium text-indigo-600">
                          {member.grants.length} permissions
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <Shield className="h-3.5 w-3.5 text-muted-foreground" />
                      {expandedMemberId === member.id ? (
                        <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                      ) : (
                        <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                      )}
                    </div>
                  </div>

                  {/* Permission editor (expanded) */}
                  {expandedMemberId === member.id && (
                    <div className="mt-1 space-y-2 rounded-md border border-border bg-muted/30 px-3 py-3">
                      <div className="flex items-center justify-between">
                        <div className="text-xs font-medium text-muted-foreground">
                          Permissions
                        </div>
                        <div className="flex items-center gap-1">
                          {PROJECT_ROLE_PRESETS.map((preset) => (
                            <button
                              key={preset.id}
                              onClick={() => {
                                applyPresetMutation.mutate({ memberId: member.id, presetId: preset.id });
                              }}
                              className="rounded px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
                              title={preset.description}
                            >
                              {preset.label}
                            </button>
                          ))}
                        </div>
                      </div>
                      <div className="space-y-1">
                        {PROJECT_PERMISSION_KEYS.map((key) => (
                          <ToggleField
                            key={key}
                            label={PROJECT_PERMISSION_LABELS[key] ?? key}
                            hint={PROJECT_PERMISSION_DESCRIPTIONS[key]}
                            checked={!!editingGrants[key]}
                            onChange={(v) =>
                              setEditingGrants((prev) => ({
                                ...prev,
                                [key]: v,
                              }))
                            }
                          />
                        ))}
                      </div>
                      <div className="flex items-center gap-2 pt-1">
                        <Button
                          size="sm"
                          onClick={() => handleSavePermissions(member.id)}
                          disabled={permissionsMutation.isPending}
                        >
                          {permissionsMutation.isPending ? "Saving..." : "Save permissions"}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setExpandedMemberId(null)}
                        >
                          Cancel
                        </Button>
                        <div className="ml-auto">
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-destructive hover:text-destructive hover:bg-destructive/10"
                            onClick={() => {
                              if (window.confirm(`Remove ${member.displayName || member.email || "this member"} from the project?`)) {
                                removeMemberMutation.mutate(member.id);
                              }
                            }}
                            disabled={removeMemberMutation.isPending}
                          >
                            <Trash2 className="h-3.5 w-3.5 mr-1" />
                            {removeMemberMutation.isPending ? "Removing..." : "Remove"}
                          </Button>
                        </div>
                      </div>
                      {permissionsMutation.isError && (
                        <span className="text-xs text-destructive">
                          {permissionsMutation.error instanceof Error
                            ? permissionsMutation.error.message
                            : "Failed to save permissions"}
                        </span>
                      )}
                      {applyPresetMutation.isError && (
                        <span className="text-xs text-destructive">
                          {applyPresetMutation.error instanceof Error
                            ? applyPresetMutation.error.message
                            : "Failed to apply role preset"}
                        </span>
                      )}
                      {removeMemberMutation.isError && (
                        <span className="text-xs text-destructive">
                          {removeMemberMutation.error instanceof Error
                            ? removeMemberMutation.error.message
                            : "Failed to remove member"}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ── Project Agents ── */}
      <div className="space-y-3">
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            Project Agents
          </span>
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
            {projectAgents.length}
          </span>
        </div>
        <div className="rounded-md border border-border px-4 py-4 space-y-3">
          <div className="flex items-center gap-1.5">
            <Bot className="h-4 w-4 text-muted-foreground" />
            <span className="text-xs text-muted-foreground">
              Agents assigned to this project can be used to work on issues.
            </span>
          </div>

          {/* Agent list */}
          {projectAgents.length > 0 && (
            <div className="space-y-1">
              {projectAgents.map((pa) => (
                <div
                  key={pa.id}
                  className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <Bot className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    <span className="text-sm font-medium truncate">
                      {pa.agent.name}
                    </span>
                    <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                      {pa.agent.role}
                    </span>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="shrink-0 text-destructive hover:text-destructive hover:bg-destructive/10 h-7 text-xs px-2"
                    onClick={() => {
                      if (window.confirm(`Remove agent "${pa.agent.name}" from the project?`)) {
                        removeAgentMutation.mutate(pa.agentId);
                      }
                    }}
                    disabled={removeAgentMutation.isPending}
                  >
                    <Trash2 className="h-3 w-3 mr-1" />
                    Remove
                  </Button>
                </div>
              ))}
            </div>
          )}

          {/* Add agent */}
          <div className="flex items-end gap-2 flex-wrap border-t border-border pt-3">
            <div className="flex-1 min-w-[200px]">
              <label className="text-xs text-muted-foreground mb-1 block">Add agent</label>
              <select
                className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm outline-none"
                value={addAgentId}
                onChange={(e) => setAddAgentId(e.target.value)}
              >
                <option value="">Select an agent...</option>
                {availableAgents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name} ({agent.role})
                  </option>
                ))}
              </select>
            </div>
            <Button
              size="sm"
              onClick={() => {
                if (addAgentId) addAgentMutation.mutate(addAgentId);
              }}
              disabled={!addAgentId || addAgentMutation.isPending}
            >
              <Plus className="h-3.5 w-3.5 mr-1" />
              {addAgentMutation.isPending ? "Adding..." : "Add agent"}
            </Button>
          </div>
          {addAgentMutation.isError && (
            <p className="text-xs text-destructive">
              {addAgentMutation.error instanceof Error
                ? addAgentMutation.error.message
                : "Failed to add agent"}
            </p>
          )}
          {removeAgentMutation.isError && (
            <p className="text-xs text-destructive">
              {removeAgentMutation.error instanceof Error
                ? removeAgentMutation.error.message
                : "Failed to remove agent"}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Main project page ── */

export function ProjectDetail() {
  const { companyPrefix, projectId, filter } = useParams<{
    companyPrefix?: string;
    projectId: string;
    filter?: string;
  }>();
  const { companies, selectedCompanyId, setSelectedCompanyId } = useCompany();
  const { openPanel, closePanel, panelVisible, setPanelVisible } = usePanel();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const [mobilePropsOpen, setMobilePropsOpen] = useState(false);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const routeProjectRef = projectId ?? "";
  const routeCompanyId = useMemo(() => {
    if (!companyPrefix) return null;
    const requestedPrefix = companyPrefix.toUpperCase();
    return companies.find((company) => company.issuePrefix.toUpperCase() === requestedPrefix)?.id ?? null;
  }, [companies, companyPrefix]);
  const lookupCompanyId = routeCompanyId ?? selectedCompanyId ?? undefined;
  const canFetchProject = routeProjectRef.length > 0 && (isUuidLike(routeProjectRef) || Boolean(lookupCompanyId));

  const activeTab = routeProjectRef ? resolveProjectTab(location.pathname, routeProjectRef) : null;

  const { data: project, isLoading, error } = useQuery({
    queryKey: [...queryKeys.projects.detail(routeProjectRef), lookupCompanyId ?? null],
    queryFn: () => projectsApi.get(routeProjectRef, lookupCompanyId),
    enabled: canFetchProject,
  });
  const canonicalProjectRef = project ? projectRouteRef(project) : routeProjectRef;
  const projectLookupRef = project?.id ?? routeProjectRef;
  const resolvedCompanyId = project?.companyId ?? selectedCompanyId;

  useEffect(() => {
    if (!project?.companyId || project.companyId === selectedCompanyId) return;
    setSelectedCompanyId(project.companyId, { source: "route_sync" });
  }, [project?.companyId, selectedCompanyId, setSelectedCompanyId]);

  const invalidateProject = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(routeProjectRef) });
    queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(projectLookupRef) });
    if (resolvedCompanyId) {
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.list(resolvedCompanyId) });
    }
  };

  const updateProject = useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      projectsApi.update(projectLookupRef, data, resolvedCompanyId ?? lookupCompanyId),
    onSuccess: invalidateProject,
    onError: (err) => {
      pushToast({
        title: "Failed to update project",
        body: err instanceof Error ? err.message : "Unknown error",
        tone: "error",
      });
    },
  });

  const uploadImage = useMutation({
    mutationFn: async (file: File) => {
      if (!resolvedCompanyId) throw new Error("No company selected");
      return assetsApi.uploadImage(resolvedCompanyId, file, `projects/${projectLookupRef || "draft"}`);
    },
    onError: (err) => {
      pushToast({
        title: "Failed to upload image",
        body: err instanceof Error ? err.message : "Unknown error",
        tone: "error",
      });
    },
  });

  useEffect(() => {
    setBreadcrumbs([
      { label: "Projects", href: "/projects" },
      { label: project?.name ?? routeProjectRef ?? "Project" },
    ]);
  }, [setBreadcrumbs, project, routeProjectRef]);

  useEffect(() => {
    if (!project) return;
    if (routeProjectRef === canonicalProjectRef) return;
    if (activeTab === "overview") {
      navigate(`/projects/${canonicalProjectRef}/overview`, { replace: true });
      return;
    }
    if (activeTab === "list") {
      if (filter) {
        navigate(`/projects/${canonicalProjectRef}/issues/${filter}`, { replace: true });
        return;
      }
      navigate(`/projects/${canonicalProjectRef}/issues`, { replace: true });
      return;
    }
    if (activeTab === "members") {
      navigate(`/projects/${canonicalProjectRef}/members`, { replace: true });
      return;
    }
    navigate(`/projects/${canonicalProjectRef}`, { replace: true });
  }, [project, routeProjectRef, canonicalProjectRef, activeTab, filter, navigate]);

  useEffect(() => {
    if (project) {
      openPanel(<ProjectProperties project={project} onUpdate={(data) => updateProject.mutate(data)} />);
    }
    return () => closePanel();
  }, [project]); // eslint-disable-line react-hooks/exhaustive-deps

  // Redirect bare /projects/:id to /projects/:id/issues
  if (routeProjectRef && activeTab === null) {
    return <Navigate to={`/projects/${canonicalProjectRef}/issues`} replace />;
  }

  if (isLoading) return <PageSkeleton variant="detail" />;
  if (error) return <p className="text-sm text-destructive">{error.message}</p>;
  if (!project) return null;

  const handleTabChange = (tab: ProjectTab) => {
    if (tab === "overview") {
      navigate(`/projects/${canonicalProjectRef}/overview`);
    } else if (tab === "members") {
      navigate(`/projects/${canonicalProjectRef}/members`);
    } else {
      navigate(`/projects/${canonicalProjectRef}/issues`);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start gap-3">
        <div className="h-7 flex items-center">
          <ColorPicker
            currentColor={project.color ?? "#6366f1"}
            onSelect={(color) => updateProject.mutate({ color })}
          />
        </div>
        <InlineEditor
          value={project.name}
          onSave={(name) => updateProject.mutate({ name })}
          as="h2"
          className="text-xl font-bold"
        />
        <Button
          variant="ghost"
          size="icon-xs"
          className="ml-auto md:hidden shrink-0"
          onClick={() => setMobilePropsOpen(true)}
          title="Properties"
        >
          <SlidersHorizontal className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          className={cn(
            "shrink-0 ml-auto transition-opacity duration-200 hidden md:flex",
            panelVisible ? "opacity-0 pointer-events-none w-0 overflow-hidden" : "opacity-100",
          )}
          onClick={() => setPanelVisible(true)}
          title="Show properties"
        >
          <SlidersHorizontal className="h-4 w-4" />
        </Button>
      </div>

      {/* Top-level project tabs */}
      <div className="flex items-center gap-1 border-b border-border">
        <button
          className={`px-3 py-2 text-sm font-medium transition-colors border-b-2 ${
            activeTab === "overview"
              ? "border-foreground text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
          onClick={() => handleTabChange("overview")}
        >
          Overview
        </button>
        <button
          className={`px-3 py-2 text-sm font-medium transition-colors border-b-2 ${
            activeTab === "list"
              ? "border-foreground text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
          onClick={() => handleTabChange("list")}
        >
          List
        </button>
        <button
          className={`px-3 py-2 text-sm font-medium transition-colors border-b-2 ${
            activeTab === "members"
              ? "border-foreground text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
          onClick={() => handleTabChange("members")}
        >
          Members
        </button>
      </div>

      {/* Tab content */}
      {activeTab === "overview" && (
        <>
          <OverviewContent
            project={project}
            onUpdate={(data) => updateProject.mutate(data)}
            imageUploadHandler={async (file) => {
              const asset = await uploadImage.mutateAsync(file);
              return asset.contentPath;
            }}
          />
          {project.id && (
            <MembersPanel
              projectId={project.id}
              onGoToMembers={() => handleTabChange("members")}
            />
          )}
        </>
      )}

      {activeTab === "list" && project?.id && resolvedCompanyId && (
        <ProjectIssuesList projectId={project.id} companyId={resolvedCompanyId} />
      )}

      {activeTab === "members" && project?.id && resolvedCompanyId && (
        <ProjectMembersSection projectId={project.id} companyId={resolvedCompanyId} />
      )}

      {/* Mobile properties drawer */}
      <Sheet open={mobilePropsOpen} onOpenChange={setMobilePropsOpen}>
        <SheetContent side="bottom" className="max-h-[85dvh] pb-[env(safe-area-inset-bottom)]">
          <SheetHeader>
            <SheetTitle className="text-sm">Properties</SheetTitle>
          </SheetHeader>
          <ScrollArea className="flex-1 overflow-y-auto">
            <div className="px-4 pb-4">
              <ProjectProperties project={project} onUpdate={(data) => updateProject.mutate(data)} />
            </div>
          </ScrollArea>
        </SheetContent>
      </Sheet>
    </div>
  );
}
