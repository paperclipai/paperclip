import { useEffect, useMemo, useState } from "react";
import { useParams, useNavigate, Navigate } from "@/lib/router";
import { useQuery, useMutation, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import { Trash2, Users, Plus, X, Check, Star, GitBranch } from "lucide-react";
import { useCompany } from "../context/CompanyContext";
import { teamsApi, type Team, type WorkflowStatus, type TeamMember } from "../api/teams";
import { teamDocumentsApi, type TeamDocument } from "../api/team-documents";
import { FileText } from "lucide-react";
import { issuesApi } from "../api/issues";
import { projectsApi } from "../api/projects";
import { routinesApi } from "../api/routines";
import { approvalsApi } from "../api/approvals";
import { agentsApi } from "../api/agents";
import { ApprovalCard } from "../components/ApprovalCard";
import { ShieldCheck } from "lucide-react";
import { heartbeatsApi } from "../api/heartbeats";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { PageSkeleton } from "../components/PageSkeleton";
import { IssuesList } from "../components/IssuesList";
import { EntityRow } from "../components/EntityRow";
import { StatusBadge } from "../components/StatusBadge";
import { EmptyState } from "../components/EmptyState";
import { formatDate, projectUrl } from "../lib/utils";
import { Hexagon } from "lucide-react";
import { createIssueDetailLocationState } from "../lib/issueDetailBreadcrumb";
import { useLocation } from "@/lib/router";
import { MarkdownEditor } from "../components/MarkdownEditor";

export function NewTeamPage() {
  const { selectedCompanyId } = useCompany();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [identifier, setIdentifier] = useState("");
  const [description, setDescription] = useState("");
  const [color, setColor] = useState("#3B82F6");
  const [error, setError] = useState<string | null>(null);

  const createMutation = useMutation({
    mutationFn: () =>
      teamsApi.create(selectedCompanyId!, {
        name,
        identifier: identifier.toUpperCase(),
        description: description || null,
        color,
      }),
    onSuccess: (team) => {
      qc.invalidateQueries({ queryKey: ["teams", selectedCompanyId] });
      navigate(`/teams/${team.id}`);
    },
    onError: (err: any) => {
      setError(err?.message ?? "Failed to create team");
    },
  });

  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-bold mb-6">New Team</h1>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          createMutation.mutate();
        }}
        className="space-y-4"
      >
        <div>
          <label className="block text-sm font-medium mb-1">Name</label>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Engine" required />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Identifier (2-5 uppercase chars)</label>
          <Input
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value.toUpperCase())}
            placeholder="ENG"
            pattern="[A-Z][A-Z0-9]{1,4}"
            required
          />
          <p className="text-xs text-muted-foreground mt-1">Used in issue identifiers (e.g., ENG-42)</p>
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Description</label>
          <Input value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Color</label>
          <input
            type="color"
            value={color}
            onChange={(e) => setColor(e.target.value)}
            className="h-10 w-20 rounded border border-border"
          />
        </div>
        {error && <div className="text-sm text-destructive">{error}</div>}
        <div className="flex gap-2">
          <Button type="submit" disabled={createMutation.isPending}>
            {createMutation.isPending ? "Creating..." : "Create Team"}
          </Button>
          <Button type="button" variant="outline" onClick={() => navigate(-1)}>
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
}

/**
 * Shared hook: load a team by id with keepPreviousData + initialData fallback
 * from the sidebar cache so navigation is flicker-free.
 */
function useTeam(teamId: string | undefined) {
  const { selectedCompanyId } = useCompany();
  const qc = useQueryClient();
  const sidebarTeams = qc.getQueryData<Team[]>(["teams", selectedCompanyId]);
  const teamFromList = sidebarTeams?.find((t) => t.id === teamId) ?? null;

  return useQuery({
    queryKey: ["team", selectedCompanyId, teamId],
    queryFn: () => teamsApi.get(selectedCompanyId!, teamId!),
    enabled: !!selectedCompanyId && !!teamId,
    placeholderData: keepPreviousData,
    initialData: teamFromList ?? undefined,
    initialDataUpdatedAt: 0,
  });
}

/**
 * Team → issues. Reuses the shared <IssuesList> component the main Issues
 * page uses; just adds a teamId filter to the fetch and the view-state key.
 */
export function TeamIssuesPage() {
  const { teamId } = useParams<{ teamId: string }>();
  const { selectedCompanyId } = useCompany();
  const queryClient = useQueryClient();
  const location = useLocation();
  const { data: team } = useTeam(teamId);

  const { data: issues, isLoading, error } = useQuery({
    queryKey: [...queryKeys.issues.list(selectedCompanyId!), "team", teamId],
    queryFn: () => issuesApi.list(selectedCompanyId!, { teamId }),
    enabled: !!selectedCompanyId && !!teamId,
    placeholderData: keepPreviousData,
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId!),
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: liveRuns } = useQuery({
    queryKey: queryKeys.liveRuns(selectedCompanyId!),
    queryFn: () => heartbeatsApi.liveRunsForCompany(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 5000,
  });

  const liveIssueIds = useMemo(() => {
    const ids = new Set<string>();
    for (const run of liveRuns ?? []) {
      if (run.issueId) ids.add(run.issueId);
    }
    return ids;
  }, [liveRuns]);

  const issueLinkState = useMemo(
    () =>
      createIssueDetailLocationState(
        team?.name ?? "Team",
        `${location.pathname}${location.search}${location.hash}`,
        "issues",
      ),
    [location.pathname, location.search, location.hash, team?.name],
  );

  const updateIssue = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Record<string, unknown> }) =>
      issuesApi.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(selectedCompanyId!) });
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
      teamId={teamId}
      viewStateKey={`paperclip:team-issues-view:${teamId ?? "__none__"}`}
      issueLinkState={issueLinkState}
      onUpdateIssue={(id, data) => updateIssue.mutate({ id, data })}
    />
  );
}

/**
 * Team → projects. Filters the projects list by the teamId (uses the
 * Phase 2 backend endpoint projectsApi.list?teamId=...).
 */
export function TeamProjectsPage() {
  const { teamId } = useParams<{ teamId: string }>();
  const { selectedCompanyId } = useCompany();

  const { data: allProjects, isLoading, error } = useQuery({
    queryKey: [...queryKeys.projects.list(selectedCompanyId!), "team", teamId],
    queryFn: () => projectsApi.list(selectedCompanyId!, { teamId }),
    enabled: !!selectedCompanyId && !!teamId,
    placeholderData: keepPreviousData,
  });
  const projects = useMemo(
    () => (allProjects ?? []).filter((p) => !p.archivedAt),
    [allProjects],
  );

  if (isLoading && !allProjects) return <PageSkeleton variant="list" />;

  return (
    <div className="space-y-4">
      {error && <p className="text-sm text-destructive">{error.message}</p>}
      {projects.length === 0 ? (
        <EmptyState icon={Hexagon} message="No projects linked to this team yet." />
      ) : (
        <div className="border border-border">
          {projects.map((project) => (
            <EntityRow
              key={project.id}
              title={project.name}
              subtitle={project.description ?? undefined}
              to={projectUrl(project)}
              trailing={
                <div className="flex items-center gap-3">
                  {project.targetDate && (
                    <span className="text-xs text-muted-foreground">
                      {formatDate(project.targetDate)}
                    </span>
                  )}
                  <StatusBadge status={project.status} />
                </div>
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Team routines — recurring work the leader + sub-agents run on a
 * cron schedule. Shows the team's active routines with their next run
 * time, and lets board users create a new team-scoped routine inline.
 * Phase 5.2b: "Cycles" in the user's mental model — daily standups,
 * weekly retros, monthly planning, etc.
 */
export function TeamRoutinesPage() {
  const { teamId } = useParams<{ teamId: string }>();
  const { selectedCompanyId } = useCompany();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const { data: team } = useQuery({
    queryKey: ["team", selectedCompanyId, teamId],
    queryFn: () => teamsApi.get(selectedCompanyId!, teamId!),
    enabled: !!selectedCompanyId && !!teamId,
    placeholderData: keepPreviousData,
  });

  const { data: routines, isLoading } = useQuery({
    queryKey: ["team-routines", selectedCompanyId, teamId],
    queryFn: () => routinesApi.list(selectedCompanyId!, { teamId }),
    enabled: !!selectedCompanyId && !!teamId,
    placeholderData: keepPreviousData,
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    placeholderData: keepPreviousData,
  });

  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [assigneeAgentId, setAssigneeAgentId] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Default assignee = team lead if it exists, else first claude_local
  useEffect(() => {
    if (assigneeAgentId || !agents || !team) return;
    if (team.leadAgentId) {
      setAssigneeAgentId(team.leadAgentId);
      return;
    }
    const firstLeader = agents.find((a) => a.adapterType === "claude_local");
    if (firstLeader) setAssigneeAgentId(firstLeader.id);
  }, [agents, team, assigneeAgentId]);

  const createMutation = useMutation({
    mutationFn: () =>
      routinesApi.create(selectedCompanyId!, {
        teamId,
        title: title.trim(),
        description: description.trim() || null,
        assigneeAgentId,
        priority: "medium",
        status: "active",
      }),
    onSuccess: (routine) => {
      qc.invalidateQueries({ queryKey: ["team-routines", selectedCompanyId, teamId] });
      qc.invalidateQueries({ queryKey: ["routines"] });
      setCreating(false);
      setTitle("");
      setDescription("");
      setError(null);
      // Drop user into the routine detail page so they can add a
      // schedule trigger.
      navigate(`/routines/${(routine as { id: string }).id}`);
    },
    onError: (err: any) => setError(err?.message ?? "Failed to create routine"),
  });

  if (isLoading && !routines) return <PageSkeleton variant="list" />;

  return (
    <div className="space-y-4 max-w-4xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold">Team Routines</h1>
          <p className="text-xs text-muted-foreground mt-1">
            Recurring work the team runs on a schedule — daily standups,
            weekly retros, cleanup tasks. Each run creates an issue in this
            team assigned to the routine's owner.
          </p>
        </div>
        {!creating && (
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus className="h-3 w-3 mr-1" /> New routine
          </Button>
        )}
      </div>

      {error && <div className="text-xs text-destructive">{error}</div>}

      {creating && (
        <div className="p-3 border border-border rounded bg-accent/20 space-y-2">
          <Input
            placeholder="Title (e.g. Daily engine standup)"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="h-8 text-sm"
            autoFocus
          />
          <textarea
            placeholder="Description — what should the assignee do each run?"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="w-full min-h-[60px] text-xs p-2 rounded border border-border bg-background resize-y"
          />
          <div className="flex gap-2 items-center">
            <label className="text-[11px] text-muted-foreground">Owner</label>
            <select
              value={assigneeAgentId}
              onChange={(e) => setAssigneeAgentId(e.target.value)}
              className="h-8 text-xs rounded border border-border bg-background px-2 flex-1"
            >
              {/*
                * Routine owners must be leader agents (claude_local).
                * Sub-agents (process/none adapterType) have no CLI and
                * no heartbeat — if a sub-agent were selected, the
                * routine's dispatched issues would sit forever with no
                * one to pick them up. Reviewer P1 finding K.
                */}
              {(agents ?? [])
                .filter(
                  (a) => a.status === "active" && a.adapterType === "claude_local",
                )
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} (leader)
                  </option>
                ))}
            </select>
            <Button
              size="sm"
              disabled={!title.trim() || !assigneeAgentId || createMutation.isPending}
              onClick={() => createMutation.mutate()}
            >
              Create
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setCreating(false);
                setError(null);
              }}
            >
              <X className="h-3 w-3" />
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground">
            After creating, open the routine detail page to add a cron
            schedule (e.g. <code>0 9 * * *</code> for every day at 9am).
          </p>
        </div>
      )}

      {(routines ?? []).length === 0 && !creating ? (
        <EmptyState
          icon={Hexagon}
          message="No routines yet. Create one to schedule recurring team work."
        />
      ) : (
        <div className="border border-border">
          {(routines ?? []).map((routine) => {
            const nextRun =
              routine.triggers.find((t) => t.enabled && t.nextRunAt)?.nextRunAt ?? null;
            const scheduleCount = routine.triggers.filter(
              (t) => t.kind === "schedule" && t.enabled,
            ).length;
            return (
              <EntityRow
                key={routine.id}
                title={routine.title}
                subtitle={routine.description ?? undefined}
                to={`/routines/${routine.id}`}
                trailing={
                  <div className="flex items-center gap-3 text-xs text-muted-foreground">
                    <span>
                      {scheduleCount > 0
                        ? `${scheduleCount} schedule${scheduleCount > 1 ? "s" : ""}`
                        : "no schedule"}
                    </span>
                    {nextRun && (
                      <span>next: {formatDate(String(nextRun))}</span>
                    )}
                    <StatusBadge status={routine.status} />
                  </div>
                }
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * Team approvals — sign-off queue filtered to the team. An approval
 * enters this view when it is linked (via `issue_approvals`) to ANY
 * issue belonging to this team. A single approval can span multiple
 * teams; it will show up in each team's queue.
 *
 * Reuses `ApprovalCard` + the approve/reject mutations from the global
 * Approvals page so behaviour stays consistent.
 */
export function TeamApprovalsPage() {
  const { teamId } = useParams<{ teamId: string }>();
  const { selectedCompanyId } = useCompany();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<"pending" | "all">("pending");

  const { data, isLoading, error } = useQuery({
    queryKey: ["team-approvals", selectedCompanyId, teamId],
    queryFn: () => approvalsApi.list(selectedCompanyId!, { teamId }),
    enabled: !!selectedCompanyId && !!teamId,
    placeholderData: keepPreviousData,
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const approveMutation = useMutation({
    mutationFn: (id: string) => approvalsApi.approve(id),
    onSuccess: (_approval, id) => {
      setActionError(null);
      qc.invalidateQueries({ queryKey: ["team-approvals", selectedCompanyId, teamId] });
      qc.invalidateQueries({ queryKey: queryKeys.approvals.list(selectedCompanyId!) });
      navigate(`/approvals/${id}?resolved=approved`);
    },
    onError: (err) => {
      setActionError(err instanceof Error ? err.message : "Failed to approve");
    },
  });

  const rejectMutation = useMutation({
    mutationFn: (id: string) => approvalsApi.reject(id),
    onSuccess: () => {
      setActionError(null);
      qc.invalidateQueries({ queryKey: ["team-approvals", selectedCompanyId, teamId] });
      qc.invalidateQueries({ queryKey: queryKeys.approvals.list(selectedCompanyId!) });
    },
    onError: (err) => {
      setActionError(err instanceof Error ? err.message : "Failed to reject");
    },
  });

  const filtered = (data ?? [])
    .filter(
      (a) =>
        statusFilter === "all" ||
        a.status === "pending" ||
        a.status === "revision_requested",
    )
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  const pendingCount = (data ?? []).filter(
    (a) => a.status === "pending" || a.status === "revision_requested",
  ).length;

  if (isLoading && !data) return <PageSkeleton variant="approvals" />;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold flex items-center gap-2">
            <ShieldCheck className="h-5 w-5" /> Team Approvals
          </h1>
          <p className="text-xs text-muted-foreground mt-1">
            Sign-off queue for work linked to this team's issues.
          </p>
        </div>
        <div className="flex gap-1 text-xs">
          <Button
            type="button"
            size="sm"
            variant={statusFilter === "pending" ? "secondary" : "ghost"}
            onClick={() => setStatusFilter("pending")}
          >
            Pending{pendingCount > 0 && (
              <span className="ml-1 rounded-full bg-yellow-500/20 text-yellow-500 px-1.5 py-0.5 text-[10px] font-medium">
                {pendingCount}
              </span>
            )}
          </Button>
          <Button
            type="button"
            size="sm"
            variant={statusFilter === "all" ? "secondary" : "ghost"}
            onClick={() => setStatusFilter("all")}
          >
            All
          </Button>
        </div>
      </div>

      {error && <p className="text-sm text-destructive">{error.message}</p>}
      {actionError && <p className="text-sm text-destructive">{actionError}</p>}

      {filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <ShieldCheck className="h-8 w-8 text-muted-foreground/30 mb-3" />
          <p className="text-sm text-muted-foreground">
            {statusFilter === "pending"
              ? "No pending approvals for this team."
              : "No approvals for this team yet."}
          </p>
        </div>
      ) : (
        <div className="grid gap-3">
          {filtered.map((approval) => (
            <ApprovalCard
              key={approval.id}
              approval={approval}
              requesterAgent={
                approval.requestedByAgentId
                  ? (agents ?? []).find((a) => a.id === approval.requestedByAgentId) ?? null
                  : null
              }
              onApprove={() => approveMutation.mutate(approval.id)}
              onReject={() => rejectMutation.mutate(approval.id)}
              detailLink={`/approvals/${approval.id}`}
              isPending={approveMutation.isPending || rejectMutation.isPending}
              pendingAction={
                approveMutation.isPending
                  ? "approve"
                  : rejectMutation.isPending
                  ? "reject"
                  : null
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Team docs index — lists all markdown documents attached to the team.
 * Click a doc row to open the editor.
 */
export function TeamDocsPage() {
  const { teamId } = useParams<{ teamId: string }>();
  const { selectedCompanyId } = useCompany();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const { data: docs } = useQuery({
    queryKey: ["team-documents", selectedCompanyId, teamId],
    queryFn: () => teamDocumentsApi.list(selectedCompanyId!, teamId!),
    enabled: !!selectedCompanyId && !!teamId,
    placeholderData: keepPreviousData,
  });

  const [creating, setCreating] = useState(false);
  const [newKey, setNewKey] = useState("");
  const [newTitle, setNewTitle] = useState("");
  const [error, setError] = useState<string | null>(null);

  const createMutation = useMutation({
    mutationFn: () =>
      teamDocumentsApi.upsert(selectedCompanyId!, teamId!, newKey, {
        key: newKey,
        title: newTitle || null,
        body: `# ${newTitle || newKey}\n\n`,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["team-documents", selectedCompanyId, teamId] });
      setCreating(false);
      navigate(`/teams/${teamId}/docs/${newKey}`);
      setNewKey("");
      setNewTitle("");
      setError(null);
    },
    onError: (err: any) => setError(err?.message ?? "Failed to create"),
  });

  return (
    <div className="max-w-4xl">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-bold flex items-center gap-2">
          <FileText className="h-5 w-5" /> Team Docs
        </h1>
        {!creating && (
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus className="h-3 w-3 mr-1" /> New doc
          </Button>
        )}
      </div>

      {error && <div className="text-xs text-destructive mb-2">{error}</div>}

      {creating && (
        <div className="mb-4 p-3 border border-border rounded bg-accent/20 space-y-2">
          <div className="flex gap-2">
            <Input
              placeholder="title (e.g. Team Rules)"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              className="flex-1 h-8 text-sm"
              autoFocus
            />
            <Input
              placeholder="key (e.g. rules)"
              value={newKey}
              onChange={(e) =>
                setNewKey(e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, "-"))
              }
              className="w-40 h-8 text-sm font-mono"
            />
            <Button
              size="sm"
              disabled={!newKey.trim() || createMutation.isPending}
              onClick={() => createMutation.mutate()}
            >
              Create
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setCreating(false);
                setError(null);
              }}
            >
              <X className="h-3 w-3" />
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Key is a URL-safe slug unique within the team. It's immutable after
            creation.
          </p>
        </div>
      )}

      {(docs ?? []).length === 0 && !creating ? (
        <div className="text-sm text-muted-foreground italic p-8 text-center border border-dashed border-border rounded">
          No docs yet. Click <strong>New doc</strong> to create the first one.
        </div>
      ) : (
        <div className="border border-border rounded">
          {(docs ?? []).map((doc) => (
            <NavLinkDocRow key={doc.id} teamId={teamId!} doc={doc} />
          ))}
        </div>
      )}
    </div>
  );
}

function NavLinkDocRow({ teamId, doc }: { teamId: string; doc: TeamDocument }) {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      onClick={() => navigate(`/teams/${teamId}/docs/${doc.key}`)}
      className="w-full text-left px-3 py-2 border-b border-border last:border-b-0 hover:bg-accent/40 transition-colors flex items-center gap-3"
    >
      <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium truncate">
          {doc.title || doc.key}
        </div>
        <div className="text-[11px] text-muted-foreground">
          <code className="font-mono">{doc.key}</code> · rev{" "}
          {doc.latestRevisionNumber} ·{" "}
          {new Date(doc.updatedAt).toLocaleDateString()}
        </div>
      </div>
    </button>
  );
}

/**
 * Team doc editor — plain textarea + save button. Uses
 * optimistic-concurrency with baseRevisionId so two tabs editing the same
 * doc get a 409 instead of clobbering each other.
 */
export function TeamDocDetailPage() {
  const { teamId, key } = useParams<{ teamId: string; key: string }>();
  const { selectedCompanyId } = useCompany();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const { data: doc } = useQuery({
    queryKey: ["team-document", selectedCompanyId, teamId, key],
    queryFn: () => teamDocumentsApi.get(selectedCompanyId!, teamId!, key!),
    enabled: !!selectedCompanyId && !!teamId && !!key,
    placeholderData: keepPreviousData,
  });

  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Sync local state when doc loads/changes and the local copy isn't dirty.
  useEffect(() => {
    if (doc && !dirty) {
      setTitle(doc.title ?? "");
      setBody(doc.latestBody);
    }
  }, [doc, dirty]);

  const saveMutation = useMutation({
    mutationFn: () =>
      teamDocumentsApi.upsert(selectedCompanyId!, teamId!, key!, {
        key: key!,
        title: title || null,
        body,
        baseRevisionId: doc?.latestRevisionId ?? null,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["team-document", selectedCompanyId, teamId, key] });
      qc.invalidateQueries({ queryKey: ["team-documents", selectedCompanyId, teamId] });
      setDirty(false);
      setError(null);
    },
    onError: (err: any) => setError(err?.message ?? "Save failed"),
  });

  const deleteMutation = useMutation({
    mutationFn: () => teamDocumentsApi.remove(selectedCompanyId!, teamId!, key!),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["team-documents", selectedCompanyId, teamId] });
      navigate(`/teams/${teamId}/docs`);
    },
  });

  if (!doc) return <PageSkeleton variant="detail" />;

  return (
    <div className="max-w-4xl">
      <div className="flex items-center gap-3 mb-4">
        <FileText className="h-5 w-5 text-muted-foreground" />
        <Input
          value={title}
          placeholder="Untitled doc"
          onChange={(e) => {
            setTitle(e.target.value);
            setDirty(true);
          }}
          className="flex-1 text-lg font-bold h-10 border-none bg-transparent px-0 focus-visible:ring-0"
        />
        <code className="text-xs text-muted-foreground font-mono">{key}</code>
        <span className="text-xs text-muted-foreground">
          rev {doc.latestRevisionNumber}
        </span>
        <Button
          size="sm"
          disabled={!dirty || saveMutation.isPending}
          onClick={() => saveMutation.mutate()}
        >
          {saveMutation.isPending ? "Saving..." : dirty ? "Save" : "Saved"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="text-muted-foreground hover:text-destructive"
          onClick={() => {
            if (confirm(`Delete doc "${title || key}"?`)) deleteMutation.mutate();
          }}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
      {error && <div className="text-xs text-destructive mb-2">{error}</div>}
      <MarkdownEditor
        key={`${teamId}:${key}`}
        value={body}
        onChange={(next) => {
          setBody(next);
          setDirty(true);
        }}
        placeholder="Write markdown…"
        contentClassName="min-h-[60vh] text-sm"
      />
    </div>
  );
}

/**
 * /teams/:teamId → redirect to /teams/:teamId/issues (Linear pattern:
 * clicking a team opens its issues, not its settings).
 */
export function TeamIndexRedirect() {
  const { teamId } = useParams<{ teamId: string }>();
  return <Navigate to={`/teams/${teamId}/issues`} replace />;
}

const WORKFLOW_CATEGORIES = [
  "backlog",
  "unstarted",
  "started",
  "completed",
  "canceled",
] as const;

/**
 * Inline editor for team workflow statuses.
 * Supports: add new status (name + category + color), rename/recolor
 * existing, set as default, delete (service enforces "last in category"
 * rule + 409 on slug clash, handled with a toast-style error message).
 */
function WorkflowStatusesEditor({
  teamId,
  companyId,
  statuses,
}: {
  teamId: string;
  companyId: string;
  statuses: WorkflowStatus[];
}) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [newCategory, setNewCategory] = useState<typeof WORKFLOW_CATEGORIES[number]>("unstarted");
  const [newColor, setNewColor] = useState("#64748B");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editColor, setEditColor] = useState("");

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: ["team-workflow-statuses", companyId, teamId] });

  const createMutation = useMutation({
    mutationFn: () =>
      teamsApi.createWorkflowStatus(companyId, teamId, {
        name: newName,
        category: newCategory,
        color: newColor,
      }),
    onSuccess: () => {
      invalidate();
      setAdding(false);
      setNewName("");
      setNewColor("#64748B");
      setError(null);
    },
    onError: (err: any) => setError(err?.message ?? "Failed to create"),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<WorkflowStatus> }) =>
      teamsApi.updateWorkflowStatus(companyId, teamId, id, data),
    onSuccess: () => {
      invalidate();
      setEditingId(null);
      setError(null);
    },
    onError: (err: any) => setError(err?.message ?? "Failed to update"),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => teamsApi.removeWorkflowStatus(companyId, teamId, id),
    onSuccess: () => invalidate(),
    onError: (err: any) => setError(err?.message ?? "Failed to delete"),
  });

  const setDefault = (id: string) =>
    updateMutation.mutate({ id, data: { isDefault: true } });

  const startEdit = (s: WorkflowStatus) => {
    setEditingId(s.id);
    setEditName(s.name);
    setEditColor(s.color ?? "#94A3B8");
    setError(null);
  };

  return (
    <section className="mb-8">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-bold uppercase tracking-wide text-muted-foreground">
          Workflow Statuses ({statuses.length})
        </h2>
        {!adding && (
          <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
            <Plus className="h-3 w-3 mr-1" /> Add status
          </Button>
        )}
      </div>

      {error && <div className="text-xs text-destructive mb-2">{error}</div>}

      <div className="space-y-1">
        {statuses.map((s) => {
          const isEditing = editingId === s.id;
          return (
            <div
              key={s.id}
              className="flex items-center gap-2 p-2 rounded border border-border"
            >
              {isEditing ? (
                <>
                  <input
                    type="color"
                    value={editColor}
                    onChange={(e) => setEditColor(e.target.value)}
                    className="h-5 w-8 rounded border border-border bg-transparent"
                  />
                  <Input
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    className="h-7 text-sm flex-1"
                    autoFocus
                  />
                  <Badge variant="outline" className="text-xs">
                    {s.category}
                  </Badge>
                  <code className="text-xs text-muted-foreground">{s.slug}</code>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 w-6 p-0"
                    onClick={() =>
                      updateMutation.mutate({
                        id: s.id,
                        data: { name: editName, color: editColor },
                      })
                    }
                  >
                    <Check className="h-3 w-3 text-emerald-500" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 w-6 p-0"
                    onClick={() => setEditingId(null)}
                  >
                    <X className="h-3 w-3" />
                  </Button>
                </>
              ) : (
                <>
                  <span
                    className="h-3 w-3 rounded-full shrink-0"
                    style={{ backgroundColor: s.color ?? "#94A3B8" }}
                  />
                  <span
                    className="font-medium text-sm cursor-pointer flex-1"
                    onClick={() => startEdit(s)}
                  >
                    {s.name}
                  </span>
                  <Badge variant="outline" className="text-xs">
                    {s.category}
                  </Badge>
                  <code className="text-xs text-muted-foreground">{s.slug}</code>
                  {s.isDefault ? (
                    <Badge className="flex items-center gap-1">
                      <Star className="h-3 w-3" />
                      default
                    </Badge>
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 text-[11px] px-2"
                      onClick={() => setDefault(s.id)}
                      title="Set as default for new issues"
                    >
                      Set default
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive"
                    onClick={() => {
                      if (confirm(`Delete status "${s.name}"?`)) deleteMutation.mutate(s.id);
                    }}
                    title="Delete status"
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </>
              )}
            </div>
          );
        })}

        {adding && (
          <div className="flex items-center gap-2 p-2 rounded border border-border bg-accent/20">
            <input
              type="color"
              value={newColor}
              onChange={(e) => setNewColor(e.target.value)}
              className="h-5 w-8 rounded border border-border bg-transparent"
            />
            <Input
              placeholder="Status name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              className="h-7 text-sm flex-1"
              autoFocus
            />
            <select
              value={newCategory}
              onChange={(e) => setNewCategory(e.target.value as any)}
              className="h-7 text-xs border border-border rounded px-2 bg-background"
            >
              {WORKFLOW_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <Button
              size="sm"
              className="h-7 text-xs"
              onClick={() => newName.trim() && createMutation.mutate()}
              disabled={!newName.trim() || createMutation.isPending}
            >
              Add
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 w-7 p-0"
              onClick={() => {
                setAdding(false);
                setNewName("");
                setError(null);
              }}
            >
              <X className="h-3 w-3" />
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}

/**
 * Inline editor for team members.
 * Supports: add agent from a picker (filtered to company agents not
 * already in the team), change role between lead/member, remove.
 * The service enforces company scope on agent ids.
 */
function TeamMembersEditor({
  teamId,
  companyId,
  team,
  members,
}: {
  teamId: string;
  companyId: string;
  team: Team;
  members: TeamMember[];
}) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [pickerValue, setPickerValue] = useState("");

  const { data: allAgents } = useQuery({
    queryKey: ["agents", companyId],
    queryFn: () => agentsApi.list(companyId),
    enabled: !!companyId,
  });

  const agentName = (id: string | null) => {
    if (!id) return "—";
    const a = (allAgents ?? []).find((x: any) => x.id === id);
    return a?.name ?? id.slice(0, 8);
  };

  const linkedAgentIds = new Set(
    members.map((m) => m.agentId).filter((x): x is string => !!x),
  );
  const linkable = (allAgents ?? []).filter((a: any) => !linkedAgentIds.has(a.id));

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["team-members", companyId, teamId] });
    qc.invalidateQueries({ queryKey: ["team", companyId, teamId] });
  };

  const addMutation = useMutation({
    mutationFn: (agentId: string) =>
      teamsApi.addMember(companyId, teamId, { agentId, role: "member" }),
    onSuccess: () => {
      invalidate();
      setPickerValue("");
      setError(null);
    },
    onError: (err: any) => setError(err?.message ?? "Failed to add member"),
  });

  const removeMutation = useMutation({
    mutationFn: (memberId: string) =>
      teamsApi.removeMember(companyId, teamId, memberId),
    onSuccess: () => invalidate(),
    onError: (err: any) => setError(err?.message ?? "Failed to remove"),
  });

  // Changing lead is done by updating team.leadAgentId so that
  // team_members role=lead stays in sync with the teams.lead_agent_id
  // column (the service handles the demotion/promotion transaction).
  const setLeadMutation = useMutation({
    mutationFn: (agentId: string | null) =>
      teamsApi.update(companyId, teamId, { leadAgentId: agentId }),
    onSuccess: () => invalidate(),
    onError: (err: any) => setError(err?.message ?? "Failed to set lead"),
  });

  return (
    <section className="mb-8">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-bold uppercase tracking-wide text-muted-foreground flex items-center gap-2">
          <Users className="h-4 w-4" /> Members ({members.length})
        </h2>
      </div>

      {error && <div className="text-xs text-destructive mb-2">{error}</div>}

      {members.length === 0 ? (
        <p className="text-sm text-muted-foreground italic mb-2">No members yet</p>
      ) : (
        <div className="space-y-1 mb-3">
          {members.map((m) => {
            const isLead = m.role === "lead" || m.agentId === team.leadAgentId;
            return (
              <div
                key={m.id}
                className="flex items-center gap-2 p-2 rounded border border-border"
              >
                <span className="text-sm flex-1">
                  {m.agentId ? agentName(m.agentId) : m.userId ?? "?"}
                </span>
                {isLead ? (
                  <Badge className="flex items-center gap-1">
                    <Star className="h-3 w-3" />
                    lead
                  </Badge>
                ) : (
                  <>
                    <Badge variant="outline">member</Badge>
                    {m.agentId && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 text-[11px] px-2"
                        onClick={() => setLeadMutation.mutate(m.agentId)}
                        title="Promote to lead"
                      >
                        Make lead
                      </Button>
                    )}
                  </>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive"
                  onClick={() => {
                    if (confirm("Remove from team?")) removeMutation.mutate(m.id);
                  }}
                  title="Remove member"
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              </div>
            );
          })}
        </div>
      )}

      <div className="flex items-center gap-2">
        <select
          value={pickerValue}
          onChange={(e) => setPickerValue(e.target.value)}
          className="h-8 text-sm border border-border rounded px-2 bg-background flex-1 max-w-xs"
        >
          <option value="">+ Add agent as member…</option>
          {linkable.map((a: any) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <Button
          size="sm"
          disabled={!pickerValue}
          onClick={() => pickerValue && addMutation.mutate(pickerValue)}
        >
          Add
        </Button>
      </div>
    </section>
  );
}

/**
 * Git repository setting per team — stored in teams.settings.githubRepoUrl.
 * Used by GitHub PR webhook to route PRs to the correct team.
 */
function TeamGitRepoEditor({
  teamId,
  companyId,
  team,
}: {
  teamId: string;
  companyId: string;
  team: Team;
}) {
  const qc = useQueryClient();
  const currentUrl = (team.settings as Record<string, unknown>)?.githubRepoUrl as string | undefined;
  const [url, setUrl] = useState(currentUrl ?? "");
  const [saved, setSaved] = useState(false);

  // Sync local state when team data changes (e.g. after navigation)
  useEffect(() => {
    setUrl(((team.settings as Record<string, unknown>)?.githubRepoUrl as string) ?? "");
  }, [team]);

  const updateMutation = useMutation({
    mutationFn: () =>
      teamsApi.update(companyId, teamId, {
        settings: {
          ...(team.settings as Record<string, unknown>),
          githubRepoUrl: url.trim() || undefined,
        },
      } as Partial<Team>),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["team", companyId, teamId] });
      qc.invalidateQueries({ queryKey: ["teams", companyId] });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    },
  });

  const dirty = url.trim() !== (currentUrl ?? "");

  return (
    <section className="mb-8">
      <h2 className="text-sm font-bold uppercase tracking-wide text-muted-foreground mb-3 flex items-center gap-2">
        <GitBranch className="h-4 w-4" />
        Git Repository
      </h2>
      <div className="flex items-center gap-2">
        <Input
          className="flex-1 font-mono text-xs"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://github.com/org/repo"
        />
        <Button
          size="sm"
          disabled={!dirty || updateMutation.isPending}
          onClick={() => updateMutation.mutate()}
        >
          {updateMutation.isPending ? "Saving…" : saved ? "Saved" : "Save"}
        </Button>
      </div>
      {url.trim() && !url.trim().startsWith("https://") && (
        <p className="text-xs text-destructive mt-1">URL must start with https://</p>
      )}
      <p className="text-xs text-muted-foreground mt-1">
        GitHub webhook으로 들어온 PR이 이 팀의 issue에 자동 연결됩니다.
      </p>
    </section>
  );
}

/**
 * Team settings page (the old TeamDetailPage contents moved under /settings).
 * Only accessed explicitly via the sub-menu, never from a team click.
 */
export function TeamSettingsPage() {
  const { teamId } = useParams<{ teamId: string }>();
  const { selectedCompanyId } = useCompany();
  const navigate = useNavigate();
  const qc = useQueryClient();

  // keepPreviousData is the v5 helper that keeps the *previous queryKey*'s
  // data visible while the new queryKey fetches. That's what makes team→team
  // navigation flicker-free: the old team stays on screen for the ~30ms fetch
  // window, then the content swaps in place.
  //
  // For the very first click (no prev data of any kind), seed from the cached
  // sidebar teams list so we at least get name/color/identifier without any
  // HTTP roundtrip.
  const sidebarTeams = qc.getQueryData<Team[]>(["teams", selectedCompanyId]);
  const teamFromList = sidebarTeams?.find((t) => t.id === teamId) ?? null;

  const { data: team, isLoading: isTeamLoading } = useQuery({
    queryKey: ["team", selectedCompanyId, teamId],
    queryFn: () => teamsApi.get(selectedCompanyId!, teamId!),
    enabled: !!selectedCompanyId && !!teamId,
    placeholderData: keepPreviousData,
    initialData: teamFromList ?? undefined,
    initialDataUpdatedAt: 0, // marks as stale so the real fetch still fires
  });

  const { data: members } = useQuery({
    queryKey: ["team-members", selectedCompanyId, teamId],
    queryFn: () => teamsApi.listMembers(selectedCompanyId!, teamId!),
    enabled: !!selectedCompanyId && !!teamId,
    placeholderData: keepPreviousData,
  });

  const { data: statuses } = useQuery({
    queryKey: ["team-workflow-statuses", selectedCompanyId, teamId],
    queryFn: () => teamsApi.listWorkflowStatuses(selectedCompanyId!, teamId!),
    enabled: !!selectedCompanyId && !!teamId,
    placeholderData: keepPreviousData,
  });

  const deleteMutation = useMutation({
    mutationFn: () => teamsApi.remove(selectedCompanyId!, teamId!),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["teams", selectedCompanyId] });
      navigate("/dashboard");
    },
  });

  // Only show the skeleton when we genuinely have nothing to render yet
  // (first page load, no sidebar cache, no placeholder). Use the shared
  // PageSkeleton variant="detail" to match ProjectDetail.
  if (isTeamLoading && !team) {
    return <PageSkeleton variant="detail" />;
  }
  if (!team) return null;

  return (
    <div className="max-w-4xl">
      <div className="flex items-center gap-3 mb-6">
        <span
          className="h-10 w-10 rounded-md flex items-center justify-center text-white font-bold"
          style={{ backgroundColor: team.color ?? "#6366f1" }}
        >
          {team.identifier.slice(0, 2)}
        </span>
        <div className="flex-1">
          <h1 className="text-2xl font-bold">{team.name}</h1>
          <p className="text-sm text-muted-foreground">
            {team.identifier} · {team.status}
          </p>
        </div>
        <Button
          variant="destructive"
          size="sm"
          onClick={() => {
            if (confirm(`Delete team "${team.name}"?`)) deleteMutation.mutate();
          }}
        >
          <Trash2 className="h-4 w-4 mr-1" /> Delete
        </Button>
      </div>

      {team.description && (
        <p className="text-sm text-muted-foreground mb-6">{team.description}</p>
      )}

      <WorkflowStatusesEditor
        teamId={teamId!}
        companyId={selectedCompanyId!}
        statuses={statuses ?? []}
      />

      <TeamMembersEditor
        teamId={teamId!}
        companyId={selectedCompanyId!}
        team={team}
        members={members ?? []}
      />

      <TeamGitRepoEditor
        teamId={teamId!}
        companyId={selectedCompanyId!}
        team={team}
      />

      <section>
        <h2 className="text-sm font-bold uppercase tracking-wide text-muted-foreground mb-3">
          Stats
        </h2>
        <div className="text-sm">Issue counter: {team.issueCounter}</div>
      </section>
    </div>
  );
}
