import { useEffect, useMemo, useState } from "react";
import { useParams, useNavigate, Navigate } from "@/lib/router";
import { useQuery, useMutation, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import { Trash2, Users, Plus, X, Check, Star } from "lucide-react";
import { useCompany } from "../context/CompanyContext";
import { teamsApi, type Team, type WorkflowStatus, type TeamMember } from "../api/teams";
import { teamDocumentsApi, type TeamDocument } from "../api/team-documents";
import { FileText } from "lucide-react";
import { issuesApi } from "../api/issues";
import { projectsApi } from "../api/projects";
import { agentsApi } from "../api/agents";
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

      <section>
        <h2 className="text-sm font-bold uppercase tracking-wide text-muted-foreground mb-3">
          Stats
        </h2>
        <div className="text-sm">Issue counter: {team.issueCounter}</div>
      </section>
    </div>
  );
}
