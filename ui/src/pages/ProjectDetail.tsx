import { useCallback, useEffect, useMemo, useState, useRef } from "react";
import { Link, useParams, useNavigate, useLocation, Navigate } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  PROJECT_COLORS,
  PROJECT_PERMISSION_KEYS,
  PROJECT_ROLE_PRESETS,
  isUuidLike,
  type Issue,
  type BudgetPolicySummary,
  type ExecutionWorkspace,
} from "@paperclipai/shared";
import { budgetsApi } from "../api/budgets";
import { executionWorkspacesApi } from "../api/execution-workspaces";
import { instanceSettingsApi } from "../api/instanceSettings";
import { projectsApi } from "../api/projects";
import { issuesApi } from "../api/issues";
import { agentsApi } from "../api/agents";
import { accessApi } from "../api/access";
import { heartbeatsApi } from "../api/heartbeats";
import { assetsApi } from "../api/assets";
import { usePanel } from "../context/PanelContext";
import { useCompany } from "../context/CompanyContext";
import { useToastActions } from "../context/ToastContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { ProjectProperties, type ProjectConfigFieldKey, type ProjectFieldSaveState } from "../components/ProjectProperties";
import { InlineEditor } from "../components/InlineEditor";
import { StatusBadge } from "../components/StatusBadge";
import { BudgetPolicyCard } from "../components/BudgetPolicyCard";
import { IssuesList } from "../components/IssuesList";
import { PageSkeleton } from "../components/PageSkeleton";
import { PageTabBar } from "../components/PageTabBar";
import { ProjectWorkspacesContent } from "../components/ProjectWorkspacesContent";
import { buildProjectWorkspaceSummaries } from "../lib/project-workspaces-tab";
import { collectLiveIssueIds } from "../lib/liveIssueIds";
import { cn, projectRouteRef } from "../lib/utils";
import { ToggleField } from "../components/agent-config-primitives";
import { Button } from "@/components/ui/button";
import { Tabs } from "@/components/ui/tabs";
import { PluginLauncherOutlet } from "@/plugins/launchers";
import { PluginSlotMount, PluginSlotOutlet, usePluginSlots } from "@/plugins/slots";
import { Loader2, Users, Shield, ChevronDown, ChevronRight, Trash2, Plus, Bot, ListChecks, UserCheck } from "lucide-react";

/* ── Top-level tab types ── */

type ProjectBaseTab = "overview" | "list" | "plugin-operations" | "workspaces" | "configuration" | "budget" | "members";
type ProjectPluginTab = `plugin:${string}`;
type ProjectTab = ProjectBaseTab | ProjectPluginTab;

function isProjectPluginTab(value: string | null): value is ProjectPluginTab {
  return typeof value === "string" && value.startsWith("plugin:");
}

function resolveProjectTab(pathname: string, projectId: string): ProjectTab | null {
  const segments = pathname.split("/").filter(Boolean);
  const projectsIdx = segments.indexOf("projects");
  if (projectsIdx === -1 || segments[projectsIdx + 1] !== projectId) return null;
  const tab = segments[projectsIdx + 2];
  if (tab === "overview") return "overview";
  if (tab === "configuration") return "configuration";
  if (tab === "budget") return "budget";
  if (tab === "issues") return "list";
  if (tab === "plugin-operations") return "plugin-operations";
  if (tab === "workspaces") return "workspaces";
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

/* ── Project Members Section (full management, for "Members" tab) ── */

function ProjectMembersSection({ projectId, companyId }: { projectId: string; companyId: string }) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();

  const [expandedMemberId, setExpandedMemberId] = useState<string | null>(null);
  const [editingGrants, setEditingGrants] = useState<Record<string, boolean>>({});
  const [addMemberPrincipalId, setAddMemberPrincipalId] = useState("");
  const [addMemberRole, setAddMemberRole] = useState("viewer");
  const [addAgentId, setAddAgentId] = useState("");

  const {
    data: members = [],
    isLoading: membersLoading,
  } = useQuery({
    queryKey: queryKeys.projects.members(projectId),
    queryFn: () => projectsApi.listMembers(projectId),
    enabled: !!projectId,
  });

  // Company members for the "add member" dropdown.
  // In merge-upstream, accessApi.listMembers returns { members, access }, not an array.
  const { data: companyMembersData } = useQuery({
    queryKey: queryKeys.access.companyMembers(companyId),
    queryFn: () => accessApi.listMembers(companyId).catch(() => ({ members: [], access: null } as any)),
    enabled: !!companyId,
    retry: false,
  });
  const companyMembers = useMemo(
    () =>
      (companyMembersData?.members ?? []).filter((m: any) => m.status === "active"),
    [companyMembersData],
  );

  const { data: projectAgents = [] } = useQuery({
    queryKey: queryKeys.projects.agents(projectId),
    queryFn: () => projectsApi.listAgentsAccess(projectId),
    enabled: !!projectId,
  });

  const { data: companyAgents = [] } = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
    enabled: !!companyId,
  });

  const availableCompanyMembers = useMemo(() => {
    const existingPrincipalIds = new Set(members.map((m) => m.principalId));
    return companyMembers.filter(
      (cm: any) => cm.principalType === "user" && !existingPrincipalIds.has(cm.principalId),
    );
  }, [companyMembers, members]);

  const availableAgents = useMemo(() => {
    const existingAgentIds = new Set(projectAgents.map((pa) => pa.agentId));
    return companyAgents.filter((a) => !existingAgentIds.has(a.id));
  }, [companyAgents, projectAgents]);

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
    const selected = companyMembers.find((cm: any) => cm.principalId === addMemberPrincipalId);
    if (!selected) return;
    addMemberMutation.mutate({
      principalType: selected.principalType,
      principalId: selected.principalId,
      role: addMemberRole,
    });
  }

  return (
    <div className="space-y-6">
      {/* Add Member */}
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
                {availableCompanyMembers.map((cm: any) => {
                  const label = cm.user?.name || cm.user?.email || cm.principalId;
                  return (
                    <option key={cm.principalId} value={cm.principalId}>
                      {label} ({cm.principalType})
                    </option>
                  );
                })}
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

      {/* Project Members List */}
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

      {/* Project Agents */}
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
        nullable
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

type ProjectIssueLane = "all" | "human" | "execution" | "initiative";

const PROJECT_ISSUE_LANES: Array<{
  id: ProjectIssueLane;
  label: string;
  icon: typeof ListChecks;
}> = [
  { id: "all", label: "All project work", icon: ListChecks },
  { id: "human", label: "Human-owned", icon: UserCheck },
  { id: "execution", label: "Execution issues", icon: Bot },
  { id: "initiative", label: "Initiatives", icon: Shield },
];

function isHumanOwnedProjectIssue(issue: Issue) {
  return issue.workItemType === "human_task" || issue.assigneeUserId !== null;
}

function isExecutionProjectIssue(issue: Issue) {
  return issue.workItemType === "ai_task" || issue.assigneeAgentId !== null;
}

function filterProjectIssuesByLane(issues: Issue[], lane: ProjectIssueLane) {
  if (lane === "human") return issues.filter(isHumanOwnedProjectIssue);
  if (lane === "execution") return issues.filter(isExecutionProjectIssue);
  if (lane === "initiative") return issues.filter((issue) => issue.workItemType === "initiative");
  return issues;
}

function ProjectIssuesList({ projectId, companyId }: { projectId: string; companyId: string }) {
  const queryClient = useQueryClient();
  const [activeLane, setActiveLane] = useState<ProjectIssueLane>("all");

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
  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(companyId),
    queryFn: () => projectsApi.list(companyId),
    enabled: !!companyId,
  });

  const liveIssueIds = useMemo(() => collectLiveIssueIds(liveRuns), [liveRuns]);

  const { data: issues, isLoading, error } = useQuery({
    queryKey: queryKeys.issues.listByProject(companyId, projectId),
    queryFn: () => issuesApi.list(companyId, { projectId }),
    enabled: !!companyId,
  });

  const laneCounts = useMemo(() => {
    const source = issues ?? [];
    return {
      all: source.length,
      human: source.filter(isHumanOwnedProjectIssue).length,
      execution: source.filter(isExecutionProjectIssue).length,
      initiative: source.filter((issue) => issue.workItemType === "initiative").length,
    } satisfies Record<ProjectIssueLane, number>;
  }, [issues]);

  const visibleIssues = useMemo(
    () => filterProjectIssuesByLane(issues ?? [], activeLane),
    [activeLane, issues],
  );

  const updateIssue = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Record<string, unknown> }) =>
      issuesApi.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.listByProject(companyId, projectId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(companyId) });
    },
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 border-b border-border/60 pb-3 md:flex-row md:items-center md:justify-between">
        <div className="min-w-0">
          <div className="text-sm font-medium text-foreground">Project work lanes</div>
          <div className="text-xs text-muted-foreground">
            Human tasks stay visible separately from agent execution issues.
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {PROJECT_ISSUE_LANES.map((lane) => {
            const Icon = lane.icon;
            const isActive = activeLane === lane.id;
            return (
              <button
                key={lane.id}
                type="button"
                onClick={() => setActiveLane(lane.id)}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors",
                  isActive
                    ? "bg-foreground text-background"
                    : "bg-muted/60 text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                <Icon className="h-3 w-3" />
                <span>{lane.label}</span>
                <span
                  className={cn(
                    "rounded-full px-1.5 py-0.5 text-[10px] tabular-nums",
                    isActive ? "bg-background/20 text-background" : "bg-background/70 text-muted-foreground",
                  )}
                >
                  {laneCounts[lane.id]}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <IssuesList
        issues={visibleIssues}
        isLoading={isLoading}
        error={error as Error | null}
        agents={agents}
        projects={projects}
        liveIssueIds={liveIssueIds}
        projectId={projectId}
        viewStateKey={`paperclip:project-issues-view:${activeLane}`}
        searchWithinLoadedIssues
        baseCreateIssueDefaults={activeLane === "human"
          ? { workItemType: "human_task" }
          : activeLane === "initiative"
            ? { workItemType: "initiative" }
            : activeLane === "execution"
              ? { workItemType: "ai_task" }
              : undefined}
        createIssueLabel={activeLane === "human"
          ? "Human Task"
          : activeLane === "initiative"
            ? "Initiative"
            : activeLane === "execution"
              ? "Execution Issue"
              : undefined}
        onUpdateIssue={(id, data) => updateIssue.mutate({ id, data })}
      />
    </div>
  );
}

function ProjectPluginOperationsList({
  projectId,
  companyId,
  pluginKey,
}: {
  projectId: string;
  companyId: string;
  pluginKey: string;
}) {
  const queryClient = useQueryClient();
  const originKindPrefix = `plugin:${pluginKey}`;

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
    enabled: !!companyId,
  });
  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(companyId),
    queryFn: () => projectsApi.list(companyId),
    enabled: !!companyId,
  });
  const { data: liveRuns } = useQuery({
    queryKey: queryKeys.liveRuns(companyId),
    queryFn: () => heartbeatsApi.liveRunsForCompany(companyId),
    enabled: !!companyId,
    refetchInterval: 5000,
  });
  const liveIssueIds = useMemo(() => collectLiveIssueIds(liveRuns), [liveRuns]);

  const { data: issues, isLoading, error } = useQuery({
    queryKey: queryKeys.issues.listPluginOperationsByProject(companyId, projectId, originKindPrefix),
    queryFn: () => issuesApi.list(companyId, { projectId, originKindPrefix }),
    enabled: !!companyId && !!projectId,
  });

  const updateIssue = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Record<string, unknown> }) =>
      issuesApi.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.listPluginOperationsByProject(companyId, projectId, originKindPrefix) });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.listByProject(companyId, projectId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(companyId) });
    },
  });

  return (
    <IssuesList
      issues={issues ?? []}
      isLoading={isLoading}
      error={error as Error | null}
      agents={agents}
      projects={projects}
      liveIssueIds={liveIssueIds}
      projectId={projectId}
      viewStateKey={`paperclip:project-plugin-operations-view:${pluginKey}`}
      onUpdateIssue={(id, data) => updateIssue.mutate({ id, data })}
    />
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
  const { closePanel } = usePanel();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToastActions();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const [fieldSaveStates, setFieldSaveStates] = useState<Partial<Record<ProjectConfigFieldKey, ProjectFieldSaveState>>>({});
  const fieldSaveRequestIds = useRef<Partial<Record<ProjectConfigFieldKey, number>>>({});
  const fieldSaveTimers = useRef<Partial<Record<ProjectConfigFieldKey, ReturnType<typeof setTimeout>>>>({});
  const routeProjectRef = projectId ?? "";
  const routeCompanyId = useMemo(() => {
    if (!companyPrefix) return null;
    const requestedPrefix = companyPrefix.toUpperCase();
    return companies.find((company) => company.issuePrefix.toUpperCase() === requestedPrefix)?.id ?? null;
  }, [companies, companyPrefix]);
  const lookupCompanyId = routeCompanyId ?? selectedCompanyId ?? undefined;
  const canFetchProject = routeProjectRef.length > 0 && (isUuidLike(routeProjectRef) || Boolean(lookupCompanyId));
  const activeRouteTab = routeProjectRef ? resolveProjectTab(location.pathname, routeProjectRef) : null;
  const pluginTabFromSearch = useMemo(() => {
    const tab = new URLSearchParams(location.search).get("tab");
    return isProjectPluginTab(tab) ? tab : null;
  }, [location.search]);
  const activeTab = activeRouteTab ?? pluginTabFromSearch;

  const { data: project, isLoading, error } = useQuery({
    queryKey: [...queryKeys.projects.detail(routeProjectRef), lookupCompanyId ?? null],
    queryFn: () => projectsApi.get(routeProjectRef, lookupCompanyId),
    enabled: canFetchProject,
  });
  const canonicalProjectRef = project ? projectRouteRef(project) : routeProjectRef;
  const projectLookupRef = project?.id ?? routeProjectRef;
  const resolvedCompanyId = project?.companyId ?? selectedCompanyId;
  const experimentalSettingsQuery = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
  });
  const {
    slots: pluginDetailSlots,
    isLoading: pluginDetailSlotsLoading,
  } = usePluginSlots({
    slotTypes: ["detailTab"],
    entityType: "project",
    companyId: resolvedCompanyId,
    enabled: !!resolvedCompanyId,
  });
  const pluginTabItems = useMemo(
    () => pluginDetailSlots.map((slot) => ({
      value: `plugin:${slot.pluginKey}:${slot.id}` as ProjectPluginTab,
      label: slot.displayName,
      slot,
    })),
    [pluginDetailSlots],
  );
  const activePluginTab = pluginTabItems.find((item) => item.value === activeTab) ?? null;
  const isolatedWorkspacesEnabled = experimentalSettingsQuery.data?.enableIsolatedWorkspaces === true;
  const workspaceTabProjectId = project?.id ?? null;
  const { data: workspaceTabIssues = [], isLoading: isWorkspaceTabIssuesLoading, error: workspaceTabIssuesError } = useQuery({
    queryKey: workspaceTabProjectId && resolvedCompanyId
      ? queryKeys.issues.listByProject(resolvedCompanyId, workspaceTabProjectId)
      : ["issues", "__workspace-tab__", "disabled"],
    queryFn: () => issuesApi.list(resolvedCompanyId!, { projectId: workspaceTabProjectId! }),
    enabled: Boolean(resolvedCompanyId && workspaceTabProjectId && isolatedWorkspacesEnabled),
  });
  const {
    data: workspaceTabExecutionWorkspaces = [],
    isLoading: isWorkspaceTabExecutionWorkspacesLoading,
    error: workspaceTabExecutionWorkspacesError,
  } = useQuery({
    queryKey: workspaceTabProjectId && resolvedCompanyId
      ? queryKeys.executionWorkspaces.list(resolvedCompanyId, { projectId: workspaceTabProjectId })
      : ["execution-workspaces", "__workspace-tab__", "disabled"],
    queryFn: () => executionWorkspacesApi.list(resolvedCompanyId!, { projectId: workspaceTabProjectId! }),
    enabled: Boolean(resolvedCompanyId && workspaceTabProjectId && isolatedWorkspacesEnabled),
  });
  const workspaceSummaries = useMemo(() => {
    if (!project || !isolatedWorkspacesEnabled) return [];
    return buildProjectWorkspaceSummaries({
      project,
      issues: workspaceTabIssues,
      executionWorkspaces: workspaceTabExecutionWorkspaces,
    });
  }, [project, isolatedWorkspacesEnabled, workspaceTabIssues, workspaceTabExecutionWorkspaces]);
  const showWorkspacesTab = isolatedWorkspacesEnabled && workspaceSummaries.length > 0;
  const workspaceTabDecisionLoaded =
    experimentalSettingsQuery.isFetched &&
    (!isolatedWorkspacesEnabled || (!isWorkspaceTabIssuesLoading && !isWorkspaceTabExecutionWorkspacesLoading));
  const workspaceTabError = (workspaceTabIssuesError ?? workspaceTabExecutionWorkspacesError) as Error | null;

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
  });

  const archiveProject = useMutation({
    mutationFn: (archived: boolean) =>
      projectsApi.update(
        projectLookupRef,
        { archivedAt: archived ? new Date().toISOString() : null },
        resolvedCompanyId ?? lookupCompanyId,
      ),
    onSuccess: (updatedProject, archived) => {
      invalidateProject();
      const name = updatedProject?.name ?? project?.name ?? "Project";
      if (archived) {
        pushToast({ title: `"${name}" has been archived`, tone: "success" });
        navigate("/dashboard");
      } else {
        pushToast({ title: `"${name}" has been unarchived`, tone: "success" });
      }
    },
    onError: (_, archived) => {
      pushToast({
        title: archived ? "Failed to archive project" : "Failed to unarchive project",
        tone: "error",
      });
    },
  });

  const uploadImage = useMutation({
    mutationFn: async (file: File) => {
      if (!resolvedCompanyId) throw new Error("No company selected");
      return assetsApi.uploadImage(resolvedCompanyId, file, `projects/${projectLookupRef || "draft"}`);
    },
  });

  const { data: budgetOverview } = useQuery({
    queryKey: queryKeys.budgets.overview(resolvedCompanyId ?? "__none__"),
    queryFn: () => budgetsApi.overview(resolvedCompanyId!),
    enabled: !!resolvedCompanyId,
    refetchInterval: 30_000,
    staleTime: 5_000,
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
    if (isProjectPluginTab(activeTab)) {
      navigate(`/projects/${canonicalProjectRef}?tab=${encodeURIComponent(activeTab)}`, { replace: true });
      return;
    }
    if (activeTab === "overview") {
      navigate(`/projects/${canonicalProjectRef}/overview`, { replace: true });
      return;
    }
    if (activeTab === "configuration") {
      navigate(`/projects/${canonicalProjectRef}/configuration`, { replace: true });
      return;
    }
    if (activeTab === "budget") {
      navigate(`/projects/${canonicalProjectRef}/budget`, { replace: true });
      return;
    }
    if (activeTab === "plugin-operations") {
      navigate(`/projects/${canonicalProjectRef}/plugin-operations`, { replace: true });
      return;
    }
    if (activeTab === "workspaces") {
      navigate(`/projects/${canonicalProjectRef}/workspaces`, { replace: true });
      return;
    }
    if (activeTab === "members") {
      navigate(`/projects/${canonicalProjectRef}/members`, { replace: true });
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
    navigate(`/projects/${canonicalProjectRef}`, { replace: true });
  }, [project, routeProjectRef, canonicalProjectRef, activeTab, filter, navigate]);

  useEffect(() => {
    closePanel();
    return () => closePanel();
  }, [closePanel]);

  useEffect(() => {
    return () => {
      Object.values(fieldSaveTimers.current).forEach((timer) => {
        if (timer) clearTimeout(timer);
      });
    };
  }, []);

  const setFieldState = useCallback((field: ProjectConfigFieldKey, state: ProjectFieldSaveState) => {
    setFieldSaveStates((current) => ({ ...current, [field]: state }));
  }, []);

  const scheduleFieldReset = useCallback((field: ProjectConfigFieldKey, delayMs: number) => {
    const existing = fieldSaveTimers.current[field];
    if (existing) clearTimeout(existing);
    fieldSaveTimers.current[field] = setTimeout(() => {
      setFieldSaveStates((current) => {
        const next = { ...current };
        delete next[field];
        return next;
      });
      delete fieldSaveTimers.current[field];
    }, delayMs);
  }, []);

  const updateProjectField = useCallback(async (field: ProjectConfigFieldKey, data: Record<string, unknown>) => {
    const requestId = (fieldSaveRequestIds.current[field] ?? 0) + 1;
    fieldSaveRequestIds.current[field] = requestId;
    setFieldState(field, "saving");
    try {
      await projectsApi.update(projectLookupRef, data, resolvedCompanyId ?? lookupCompanyId);
      invalidateProject();
      if (fieldSaveRequestIds.current[field] !== requestId) return;
      setFieldState(field, "saved");
      scheduleFieldReset(field, 1800);
    } catch (error) {
      if (fieldSaveRequestIds.current[field] !== requestId) return;
      setFieldState(field, "error");
      scheduleFieldReset(field, 3000);
      throw error;
    }
  }, [invalidateProject, lookupCompanyId, projectLookupRef, resolvedCompanyId, scheduleFieldReset, setFieldState]);

  const projectBudgetSummary = useMemo(() => {
    const matched = budgetOverview?.policies.find(
      (policy) => policy.scopeType === "project" && policy.scopeId === (project?.id ?? routeProjectRef),
    );
    if (matched) return matched;
    return {
      policyId: "",
      companyId: resolvedCompanyId ?? "",
      scopeType: "project",
      scopeId: project?.id ?? routeProjectRef,
      scopeName: project?.name ?? "Project",
      metric: "billed_cents",
      windowKind: "lifetime",
      amount: 0,
      observedAmount: 0,
      remainingAmount: 0,
      utilizationPercent: 0,
      warnPercent: 80,
      hardStopEnabled: true,
      notifyEnabled: true,
      isActive: false,
      status: "ok",
      paused: Boolean(project?.pausedAt),
      pauseReason: project?.pauseReason ?? null,
      windowStart: new Date(),
      windowEnd: new Date(),
    } satisfies BudgetPolicySummary;
  }, [budgetOverview?.policies, project, resolvedCompanyId, routeProjectRef]);

  const budgetMutation = useMutation({
    mutationFn: (amount: number) =>
      budgetsApi.upsertPolicy(resolvedCompanyId!, {
        scopeType: "project",
        scopeId: project?.id ?? routeProjectRef,
        amount,
        windowKind: "lifetime",
      }),
    onSuccess: () => {
      if (!resolvedCompanyId) return;
      queryClient.invalidateQueries({ queryKey: queryKeys.budgets.overview(resolvedCompanyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(routeProjectRef) });
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(projectLookupRef) });
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.list(resolvedCompanyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.dashboard(resolvedCompanyId) });
    },
  });

  if (pluginTabFromSearch && !pluginDetailSlotsLoading && !activePluginTab) {
    return <Navigate to={`/projects/${canonicalProjectRef}/issues`} replace />;
  }

  if (activeTab === "workspaces" && workspaceTabDecisionLoaded && !showWorkspacesTab) {
    return <Navigate to={`/projects/${canonicalProjectRef}/issues`} replace />;
  }

  // Redirect bare /projects/:id to cached tab or default /issues
  if (routeProjectRef && activeTab === null) {
    let cachedTab: string | null = null;
    if (project?.id) {
      try { cachedTab = localStorage.getItem(`paperclip:project-tab:${project.id}`); } catch {}
    }
    if (cachedTab === "overview") {
      return <Navigate to={`/projects/${canonicalProjectRef}/overview`} replace />;
    }
    if (cachedTab === "configuration") {
      return <Navigate to={`/projects/${canonicalProjectRef}/configuration`} replace />;
    }
    if (cachedTab === "budget") {
      return <Navigate to={`/projects/${canonicalProjectRef}/budget`} replace />;
    }
    if (cachedTab === "members") {
      return <Navigate to={`/projects/${canonicalProjectRef}/members`} replace />;
    }
    if (cachedTab === "plugin-operations" && project?.managedByPlugin) {
      return <Navigate to={`/projects/${canonicalProjectRef}/plugin-operations`} replace />;
    }
    if (cachedTab === "workspaces" && workspaceTabDecisionLoaded && showWorkspacesTab) {
      return <Navigate to={`/projects/${canonicalProjectRef}/workspaces`} replace />;
    }
    if (cachedTab === "workspaces" && !workspaceTabDecisionLoaded) {
      return <PageSkeleton variant="detail" />;
    }
    if (isProjectPluginTab(cachedTab)) {
      return <Navigate to={`/projects/${canonicalProjectRef}?tab=${encodeURIComponent(cachedTab)}`} replace />;
    }
    return <Navigate to={`/projects/${canonicalProjectRef}/issues`} replace />;
  }

  if (isLoading) return <PageSkeleton variant="detail" />;
  if (error) return <p className="text-sm text-destructive">{error.message}</p>;
  if (!project) return null;

  const handleTabChange = (tab: ProjectTab) => {
    // Cache the active tab per project
    if (project?.id) {
      try { localStorage.setItem(`paperclip:project-tab:${project.id}`, tab); } catch {}
    }
    if (isProjectPluginTab(tab)) {
      navigate(`/projects/${canonicalProjectRef}?tab=${encodeURIComponent(tab)}`);
      return;
    }
    if (tab === "overview") {
      navigate(`/projects/${canonicalProjectRef}/overview`);
    } else if (tab === "workspaces") {
      navigate(`/projects/${canonicalProjectRef}/workspaces`);
    } else if (tab === "budget") {
      navigate(`/projects/${canonicalProjectRef}/budget`);
    } else if (tab === "plugin-operations") {
      navigate(`/projects/${canonicalProjectRef}/plugin-operations`);
    } else if (tab === "configuration") {
      navigate(`/projects/${canonicalProjectRef}/configuration`);
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
        <div className="min-w-0 space-y-2">
          <InlineEditor
            value={project.name}
            onSave={(name) => updateProject.mutate({ name })}
            as="h2"
            className="text-xl font-bold"
          />
          {project.pauseReason === "budget" ? (
            <div className="inline-flex items-center gap-2 rounded-full border border-red-500/30 bg-red-500/10 px-3 py-1 text-[11px] font-medium uppercase tracking-[0.18em] text-red-200">
              <span className="h-2 w-2 rounded-full bg-red-400" />
              Paused by budget hard stop
            </div>
          ) : null}
          {project.managedByPlugin ? (
            <div className="inline-flex items-center gap-2 rounded-full border border-border bg-muted px-3 py-1 text-[11px] font-medium text-muted-foreground">
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: project.color ?? "#6366f1" }} />
              Managed by {project.managedByPlugin.pluginDisplayName}
            </div>
          ) : null}
        </div>
      </div>

      <PluginSlotOutlet
        slotTypes={["toolbarButton", "contextMenuItem"]}
        entityType="project"
        context={{
          companyId: resolvedCompanyId ?? null,
          companyPrefix: companyPrefix ?? null,
          projectId: project.id,
          projectRef: canonicalProjectRef,
          entityId: project.id,
          entityType: "project",
        }}
        className="flex flex-wrap gap-2"
        itemClassName="inline-flex"
        missingBehavior="placeholder"
      />

      <PluginLauncherOutlet
        placementZones={["toolbarButton"]}
        entityType="project"
        context={{
          companyId: resolvedCompanyId ?? null,
          companyPrefix: companyPrefix ?? null,
          projectId: project.id,
          projectRef: canonicalProjectRef,
          entityId: project.id,
          entityType: "project",
        }}
        className="flex flex-wrap gap-2"
        itemClassName="inline-flex"
      />

      <Tabs value={activeTab ?? "list"} onValueChange={(value) => handleTabChange(value as ProjectTab)}>
        <PageTabBar
          items={[
            { value: "list", label: "Issues" },
            { value: "overview", label: "Overview" },
            ...(project.managedByPlugin ? [{ value: "plugin-operations", label: "Plugin operations" }] : []),
            ...(showWorkspacesTab ? [{ value: "workspaces", label: "Workspaces" }] : []),
            { value: "members", label: "Members" },
            { value: "configuration", label: "Configuration" },
            { value: "budget", label: "Budget" },
            ...pluginTabItems.map((item) => ({
              value: item.value,
              label: item.label,
            })),
          ]}
          align="start"
          value={activeTab ?? "list"}
          onValueChange={(value) => handleTabChange(value as ProjectTab)}
        />
      </Tabs>

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

      {activeTab === "plugin-operations" && project?.id && resolvedCompanyId && project.managedByPlugin && (
        <ProjectPluginOperationsList
          projectId={project.id}
          companyId={resolvedCompanyId}
          pluginKey={project.managedByPlugin.pluginKey}
        />
      )}

      {activeTab === "workspaces" ? (
        workspaceTabDecisionLoaded ? (
          workspaceTabError ? (
            <p className="text-sm text-destructive">{workspaceTabError.message}</p>
          ) : (
            <ProjectWorkspacesContent
              companyId={resolvedCompanyId!}
              projectId={project.id}
              projectRef={canonicalProjectRef}
              summaries={workspaceSummaries}
            />
          )
        ) : (
          <p className="text-sm text-muted-foreground">Loading workspaces...</p>
        )
      ) : null}

      {activeTab === "configuration" && (
        <div className="max-w-4xl">
          <ProjectProperties
            project={project}
            onUpdate={(data) => updateProject.mutate(data)}
            onFieldUpdate={updateProjectField}
            getFieldSaveState={(field) => fieldSaveStates[field] ?? "idle"}
            onArchive={(archived) => archiveProject.mutate(archived)}
            archivePending={archiveProject.isPending}
          />
        </div>
      )}

      {activeTab === "budget" && resolvedCompanyId ? (
        <div className="max-w-3xl">
          <BudgetPolicyCard
            summary={projectBudgetSummary}
            variant="plain"
            isSaving={budgetMutation.isPending}
            onSave={(amount) => budgetMutation.mutate(amount)}
          />
        </div>
      ) : null}

      {activeTab === "members" && project?.id && resolvedCompanyId && (
        <ProjectMembersSection projectId={project.id} companyId={resolvedCompanyId} />
      )}

      {activePluginTab && (
        <PluginSlotMount
          slot={activePluginTab.slot}
          context={{
            companyId: resolvedCompanyId,
            companyPrefix: companyPrefix ?? null,
            projectId: project.id,
            projectRef: canonicalProjectRef,
            entityId: project.id,
            entityType: "project",
          }}
          missingBehavior="placeholder"
        />
      )}
    </div>
  );
}
