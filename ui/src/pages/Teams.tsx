import { useState } from "react";
import { useParams, useNavigate } from "@/lib/router";
import { useQuery, useMutation, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import { Plus, Trash2, Users } from "lucide-react";
import { useCompany } from "../context/CompanyContext";
import { teamsApi, type Team, type WorkflowStatus, type TeamMember } from "../api/teams";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { PageSkeleton } from "../components/PageSkeleton";

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
    <div className="max-w-2xl mx-auto p-8">
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

export function TeamDetailPage() {
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
    return (
      <div className="max-w-4xl mx-auto p-8">
        <PageSkeleton variant="detail" />
      </div>
    );
  }
  if (!team) return null;

  return (
    <div className="max-w-4xl mx-auto p-8">
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

      <section className="mb-8">
        <h2 className="text-sm font-bold uppercase tracking-wide text-muted-foreground mb-3">
          Workflow Statuses ({statuses?.length ?? 0})
        </h2>
        <div className="space-y-1">
          {(statuses ?? []).map((s: WorkflowStatus) => (
            <div
              key={s.id}
              className="flex items-center gap-3 p-2 rounded border border-border"
            >
              <span
                className="h-3 w-3 rounded-full"
                style={{ backgroundColor: s.color ?? "#94A3B8" }}
              />
              <span className="font-medium">{s.name}</span>
              <Badge variant="outline" className="text-xs">
                {s.category}
              </Badge>
              <code className="text-xs text-muted-foreground ml-auto">{s.slug}</code>
              {s.isDefault && <Badge>default</Badge>}
            </div>
          ))}
        </div>
      </section>

      <section className="mb-8">
        <h2 className="text-sm font-bold uppercase tracking-wide text-muted-foreground mb-3 flex items-center gap-2">
          <Users className="h-4 w-4" /> Members ({members?.length ?? 0})
        </h2>
        {(members ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground italic">No members yet</p>
        ) : (
          <div className="space-y-1">
            {(members ?? []).map((m: TeamMember) => (
              <div
                key={m.id}
                className="flex items-center gap-3 p-2 rounded border border-border"
              >
                <span className="text-sm">{m.agentId ?? m.userId}</span>
                <Badge variant="outline">{m.role}</Badge>
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="text-sm font-bold uppercase tracking-wide text-muted-foreground mb-3">
          Stats
        </h2>
        <div className="text-sm">Issue counter: {team.issueCounter}</div>
      </section>
    </div>
  );
}
