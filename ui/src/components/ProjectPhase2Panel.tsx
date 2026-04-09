import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { api } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { Checkbox } from "@/components/ui/checkbox";

interface Props {
  projectId: string;
  companyId: string;
}

interface TeamLink {
  projectId: string;
  teamId: string;
  addedAt: string;
  team: { id: string; name: string; identifier: string; color: string | null; status: string };
}

interface ProjectMember {
  id: string;
  projectId: string;
  agentId: string | null;
  userId: string | null;
  role: string;
}

interface Milestone {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  targetDate: string | null;
  status: string;
  sortOrder: number;
}

interface ProjectUpdate {
  id: string;
  projectId: string;
  health: string;
  body: string;
  createdAt: string;
}

interface Team {
  id: string;
  name: string;
  identifier: string;
  color: string | null;
  status: string;
}

interface Agent {
  id: string;
  name: string;
}

const HEALTH_COLORS: Record<string, string> = {
  on_track: "#10B981",
  at_risk: "#F59E0B",
  off_track: "#EF4444",
};

export function ProjectPhase2Panel({ projectId, companyId }: Props) {
  const qc = useQueryClient();

  // Queries
  const teams = useQuery({
    queryKey: ["project-teams", projectId],
    queryFn: () => api.get<TeamLink[]>(`/companies/${companyId}/projects/${projectId}/teams`),
    enabled: !!projectId,
  });

  const members = useQuery({
    queryKey: ["project-members", projectId],
    queryFn: () => api.get<ProjectMember[]>(`/companies/${companyId}/projects/${projectId}/members`),
    enabled: !!projectId,
  });

  const milestones = useQuery({
    queryKey: ["project-milestones", projectId],
    queryFn: () => api.get<Milestone[]>(`/companies/${companyId}/projects/${projectId}/milestones`),
    enabled: !!projectId,
  });

  const updates = useQuery({
    queryKey: ["project-updates", projectId],
    queryFn: () => api.get<ProjectUpdate[]>(`/companies/${companyId}/projects/${projectId}/updates`),
    enabled: !!projectId,
  });

  const allTeams = useQuery({
    queryKey: ["teams", companyId, "for-project-link"],
    queryFn: () => api.get<Team[]>(`/companies/${companyId}/teams`),
    enabled: !!companyId,
  });

  const allAgents = useQuery({
    queryKey: ["agents-for-project-member", companyId],
    queryFn: () => api.get<Agent[]>(`/companies/${companyId}/agents`),
    enabled: !!companyId,
  });

  // Mutations
  const addTeamMutation = useMutation({
    mutationFn: (teamId: string) =>
      api.post(`/companies/${companyId}/projects/${projectId}/teams`, { teamId }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["project-teams", projectId] }),
  });

  const removeTeamMutation = useMutation({
    mutationFn: (teamId: string) =>
      api.delete(`/companies/${companyId}/projects/${projectId}/teams/${teamId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["project-teams", projectId] }),
  });

  const addMemberMutation = useMutation({
    mutationFn: (agentId: string) =>
      api.post(`/companies/${companyId}/projects/${projectId}/members`, { agentId, role: "member" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["project-members", projectId] }),
  });

  const removeMemberMutation = useMutation({
    mutationFn: (memberId: string) =>
      api.delete(`/companies/${companyId}/projects/${projectId}/members/${memberId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["project-members", projectId] }),
  });

  const [msName, setMsName] = useState("");
  const createMilestoneMutation = useMutation({
    mutationFn: (name: string) =>
      api.post(`/companies/${companyId}/projects/${projectId}/milestones`, { name }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["project-milestones", projectId] });
      setMsName("");
    },
  });

  const removeMilestoneMutation = useMutation({
    mutationFn: (id: string) =>
      api.delete(`/companies/${companyId}/projects/${projectId}/milestones/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["project-milestones", projectId] }),
  });

  const toggleMilestoneMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      api.patch(`/companies/${companyId}/projects/${projectId}/milestones/${id}`, { status }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["project-milestones", projectId] }),
  });

  const [updateBody, setUpdateBody] = useState("");
  const [updateHealth, setUpdateHealth] = useState<"on_track" | "at_risk" | "off_track">("on_track");
  const createUpdateMutation = useMutation({
    mutationFn: () =>
      api.post(`/companies/${companyId}/projects/${projectId}/updates`, {
        health: updateHealth,
        body: updateBody,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["project-updates", projectId] });
      qc.invalidateQueries({ queryKey: queryKeyForProject(companyId) });
      setUpdateBody("");
    },
  });

  const linkedTeamIds = new Set((teams.data ?? []).map((t) => t.teamId));
  const linkableTeams = (allTeams.data ?? []).filter((t) => !linkedTeamIds.has(t.id));

  const linkedAgentIds = new Set(
    (members.data ?? []).map((m) => m.agentId).filter((x): x is string => !!x),
  );
  const linkableAgents = (allAgents.data ?? []).filter((a) => !linkedAgentIds.has(a.id));

  const agentName = (id: string | null) =>
    id ? (allAgents.data ?? []).find((a) => a.id === id)?.name ?? id.slice(0, 8) : "—";

  return (
    <div data-testid="phase2-panel" className="mt-8 space-y-6">
      {/* === Teams === */}
      <section data-testid="phase2-teams">
        <h3 className="text-xs font-bold uppercase tracking-wide text-muted-foreground mb-2">
          Linked Teams ({teams.data?.length ?? 0})
        </h3>
        <div className="rounded-lg bg-card overflow-hidden mb-2">
          {(teams.data ?? []).map((link) => (
            <div key={link.teamId} className="flex items-center gap-2 px-3 h-7 text-[13px] hover:bg-accent/30 transition-colors group">
              <span className="inline-block h-2.5 w-2.5 rounded-sm shrink-0" style={{ backgroundColor: link.team.color ?? "#94A3B8" }} />
              <span className="flex-1 truncate text-foreground/80">{link.team.identifier} {link.team.name}</span>
              <button onClick={() => removeTeamMutation.mutate(link.teamId)} className="text-muted-foreground/40 hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity" aria-label={`unlink team ${link.team.identifier}`}>
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
        {linkableTeams.length > 0 && (
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="sm" className="text-xs text-muted-foreground h-7">
                <Plus className="h-3 w-3 mr-1.5" /> Link team
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-48 p-1" align="start">
              {linkableTeams.map((t) => (
                <button key={t.id} className="flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded-md hover:bg-accent/50 text-left" onClick={() => addTeamMutation.mutate(t.id)}>
                  <span className="h-2 w-2 rounded-sm" style={{ backgroundColor: t.color ?? "#94A3B8" }} />
                  {t.identifier} — {t.name}
                </button>
              ))}
            </PopoverContent>
          </Popover>
        )}
      </section>

      {/* === Members === */}
      <section data-testid="phase2-members">
        <h3 className="text-xs font-bold uppercase tracking-wide text-muted-foreground mb-2">
          Members ({members.data?.length ?? 0})
        </h3>
        <div className="rounded-lg bg-card overflow-hidden mb-2">
          {(members.data ?? []).map((m) => (
            <div key={m.id} className="flex items-center gap-2 px-3 h-7 text-[13px] hover:bg-accent/30 transition-colors group">
              <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-5 rounded-full">{m.role}</Badge>
              <span className="flex-1 truncate text-foreground/80">{agentName(m.agentId)}</span>
              <button onClick={() => removeMemberMutation.mutate(m.id)} className="text-muted-foreground/40 hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity" aria-label={`remove member ${m.id}`}>
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
        {linkableAgents.length > 0 && (
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="sm" className="text-xs text-muted-foreground h-7">
                <Plus className="h-3 w-3 mr-1.5" /> Add member
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-48 p-1 max-h-72 overflow-y-auto" align="start">
              {linkableAgents.map((a) => (
                <button key={a.id} className="flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded-md hover:bg-accent/50 text-left" onClick={() => addMemberMutation.mutate(a.id)}>
                  {a.name}
                </button>
              ))}
            </PopoverContent>
          </Popover>
        )}
      </section>

      {/* === Milestones === */}
      <section data-testid="phase2-milestones">
        <h3 className="text-xs font-bold uppercase tracking-wide text-muted-foreground mb-2">
          Milestones ({milestones.data?.length ?? 0})
        </h3>
        <div className="rounded-lg bg-card overflow-hidden">
          {(milestones.data ?? []).map((m) => (
            <div key={m.id} className="flex items-center gap-2 px-3 h-7 text-[13px] hover:bg-accent/30 transition-colors group">
              <Checkbox
                checked={m.status === "completed"}
                onCheckedChange={() => toggleMilestoneMutation.mutate({ id: m.id, status: m.status === "completed" ? "planned" : "completed" })}
                className="h-4 w-4"
              />
              <span className={`flex-1 truncate ${m.status === "completed" ? "line-through text-muted-foreground" : "text-foreground/80"}`}>
                {m.name}
              </span>
              {m.targetDate && <span className="text-[11px] text-muted-foreground">{m.targetDate}</span>}
              <button onClick={() => removeMilestoneMutation.mutate(m.id)} className="text-muted-foreground/40 hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity" aria-label={`delete milestone ${m.name}`}>
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
          ))}
          <form className="flex items-center gap-2 px-3 h-8" onSubmit={(e) => { e.preventDefault(); if (msName.trim()) createMilestoneMutation.mutate(msName.trim()); }}>
            <Plus className="h-3.5 w-3.5 shrink-0 text-muted-foreground/40" />
            <input
              data-testid="phase2-milestone-name"
              value={msName}
              onChange={(e) => setMsName(e.target.value)}
              placeholder="Add milestone..."
              className="flex-1 text-[13px] bg-transparent outline-none placeholder:text-muted-foreground/40"
            />
            {msName.trim() && (
              <Button type="submit" variant="ghost" size="sm" className="h-5 text-xs px-2 text-primary">
                Add
              </Button>
            )}
          </form>
        </div>
      </section>

      {/* === Health updates === */}
      <section data-testid="phase2-health">
        <h3 className="text-xs font-bold uppercase tracking-wide text-muted-foreground mb-2">
          Health Updates ({updates.data?.length ?? 0})
        </h3>
        <div className="rounded-lg bg-card overflow-hidden">
          {(updates.data ?? []).slice(0, 5).map((u) => (
            <div key={u.id} className="flex items-center gap-2 px-3 h-7 text-[13px] hover:bg-accent/30 transition-colors">
              <span className="inline-block h-2.5 w-2.5 rounded-full shrink-0" style={{ backgroundColor: HEALTH_COLORS[u.health] ?? "#94A3B8" }} />
              <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-5 rounded-full">{u.health}</Badge>
              <span className="flex-1 truncate text-foreground/80">{u.body}</span>
            </div>
          ))}
          <form className="px-3 py-2 space-y-2" onSubmit={(e) => { e.preventDefault(); if (updateBody.trim()) createUpdateMutation.mutate(); }}>
            <div className="flex items-center gap-2">
              <Popover>
                <PopoverTrigger asChild>
                  <button type="button" className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors">
                    <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: HEALTH_COLORS[updateHealth] }} />
                    {updateHealth.replace(/_/g, " ")}
                  </button>
                </PopoverTrigger>
                <PopoverContent className="w-36 p-1" align="start">
                  {(["on_track", "at_risk", "off_track"] as const).map((h) => (
                    <button key={h} type="button" className="flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded-md hover:bg-accent/50" onClick={() => setUpdateHealth(h)}>
                      <span className="h-2 w-2 rounded-full" style={{ backgroundColor: HEALTH_COLORS[h] }} />
                      {h.replace(/_/g, " ")}
                    </button>
                  ))}
                </PopoverContent>
              </Popover>
              {updateBody.trim() && (
                <Button type="submit" variant="ghost" size="sm" className="ml-auto h-5 text-xs px-2 text-primary">
                  Post
                </Button>
              )}
            </div>
            <textarea
              data-testid="phase2-update-body"
              value={updateBody}
              onChange={(e) => setUpdateBody(e.target.value)}
              placeholder="What's the latest status?"
              rows={2}
              className="w-full text-[13px] bg-transparent outline-none resize-none placeholder:text-muted-foreground/40"
            />
          </form>
        </div>
      </section>
    </div>
  );
}

function queryKeyForProject(companyId: string) {
  return ["projects", companyId];
}
