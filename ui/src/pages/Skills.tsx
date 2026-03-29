import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { Skill, SkillTier } from "@paperclipai/shared";
import { skillsApi } from "../api/skills";
import { agentsApi } from "../api/agents";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EntityRow } from "../components/EntityRow";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Blocks, Lock, Plus, Terminal, FolderOpen, Trash2 } from "lucide-react";

type InstallMode = "path" | "command";

const TIER_ORDER: SkillTier[] = ["built_in", "company", "agent"];
const TIER_LABELS: Record<SkillTier, string> = {
  built_in: "Built-in",
  company: "Company",
  agent: "Agent",
};
const SOURCE_LABELS: Record<string, string> = {
  bundled: "Bundled",
  git: "Git",
  local: "Local",
};

function tierBadgeClass(tier: SkillTier): string {
  switch (tier) {
    case "built_in":
      return "bg-muted text-muted-foreground";
    case "company":
      return "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300";
    case "agent":
      return "bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300";
    default:
      return "bg-muted text-muted-foreground";
  }
}

function groupSkillsByTier(skills: Skill[]): Map<SkillTier, Skill[]> {
  const map = new Map<SkillTier, Skill[]>();
  for (const tier of TIER_ORDER) {
    map.set(tier, []);
  }
  for (const skill of skills) {
    const list = map.get(skill.tier) ?? [];
    list.push(skill);
    map.set(skill.tier, list);
  }
  return map;
}

export function Skills() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [showInstallForm, setShowInstallForm] = useState(false);
  const [installMode, setInstallMode] = useState<InstallMode>("command");
  const [installName, setInstallName] = useState("");
  const [installDescription, setInstallDescription] = useState("");
  const [installPath, setInstallPath] = useState("");
  const [installCommand, setInstallCommand] = useState("");
  const [installOutput, setInstallOutput] = useState<{ stdout: string; stderr: string } | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Skills" }]);
  }, [setBreadcrumbs]);

  const { data: skills, isLoading, error } = useQuery({
    queryKey: queryKeys.skills.list(selectedCompanyId!),
    queryFn: () => skillsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId && (skills ?? []).some((s) => s.tier === "agent" && s.agentId),
  });

  const createMutation = useMutation({
    mutationFn: (data: { name: string; description: string; installedPath: string }) =>
      skillsApi.create(selectedCompanyId!, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.skills.list(selectedCompanyId!) });
      setShowInstallForm(false);
      setInstallName("");
      setInstallDescription("");
      setInstallPath("");
    },
  });

  const commandInstallMutation = useMutation({
    mutationFn: (data: { command: string }) =>
      skillsApi.install(selectedCompanyId!, data),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.skills.list(selectedCompanyId!) });
      setInstallOutput({ stdout: result.stdout, stderr: result.stderr });
      if (result.installed.length > 0) {
        setInstallCommand("");
      }
    },
  });

  const removeMutation = useMutation({
    mutationFn: (id: string) => skillsApi.remove(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.skills.list(selectedCompanyId!) });
    },
  });

  const agentMap = new Map((agents ?? []).map((a) => [a.id, a.name]));

  if (!selectedCompanyId) {
    return <EmptyState icon={Blocks} message="Select a company to view skills." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  const grouped = groupSkillsByTier(skills ?? []);
  const hasAnySkills = (skills ?? []).length > 0;

  const handleInstallPath = () => {
    if (!installName.trim() || !installPath.trim()) return;
    createMutation.mutate({
      name: installName.trim(),
      description: installDescription.trim() || "",
      installedPath: installPath.trim(),
    });
  };

  const handleInstallCommand = () => {
    if (!installCommand.trim()) return;
    setInstallOutput(null);
    commandInstallMutation.mutate({ command: installCommand.trim() });
  };

  const handleRemove = (skill: Skill) => {
    if (!window.confirm(`Remove skill "${skill.name}"?`)) return;
    removeMutation.mutate(skill.id);
  };

  return (
    <div className="space-y-4 animate-page-enter">
      <div className="flex items-center justify-end">
        <Button
          size="sm"
          variant="outline"
          onClick={() => setShowInstallForm(!showInstallForm)}
          disabled={!selectedCompanyId}
        >
          <Plus className="h-4 w-4 mr-1" />
          Install Skill
        </Button>
      </div>

      {showInstallForm && (
        <div className="border border-border rounded-md p-4 space-y-3 bg-muted/30">
          <div className="flex gap-1 mb-2">
            <button
              type="button"
              onClick={() => setInstallMode("command")}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                installMode === "command"
                  ? "bg-background text-foreground border border-border shadow-xs"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <Terminal className="h-3.5 w-3.5" />
              Command
            </button>
            <button
              type="button"
              onClick={() => setInstallMode("path")}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                installMode === "path"
                  ? "bg-background text-foreground border border-border shadow-xs"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <FolderOpen className="h-3.5 w-3.5" />
              Path
            </button>
          </div>

          {installMode === "command" && (
            <>
              <div className="space-y-2">
                <Label htmlFor="skill-command">Install command</Label>
                <Input
                  id="skill-command"
                  value={installCommand}
                  onChange={(e) => setInstallCommand(e.target.value)}
                  placeholder="npx skills add vercel-labs/agent-skills"
                  className="font-mono text-xs"
                  onKeyDown={(e) => { if (e.key === "Enter") handleInstallCommand(); }}
                />
                <p className="text-[11px] text-muted-foreground">
                  Runs the command on the server and registers any discovered skills.
                </p>
              </div>
              {installOutput && (
                <pre className="bg-neutral-950 rounded-md p-2 text-xs overflow-x-auto whitespace-pre-wrap font-mono text-green-400 max-h-40 overflow-y-auto">
                  {installOutput.stdout || installOutput.stderr || "(no output)"}
                </pre>
              )}
              {commandInstallMutation.isError && (
                <p className="text-xs text-destructive">
                  {(commandInstallMutation.error as Error)?.message ?? "Install failed"}
                </p>
              )}
              <div className="flex gap-2">
                <Button size="sm" onClick={handleInstallCommand} disabled={!installCommand.trim() || commandInstallMutation.isPending}>
                  {commandInstallMutation.isPending ? "Running..." : "Run"}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => { setShowInstallForm(false); setInstallOutput(null); }}>
                  Cancel
                </Button>
              </div>
            </>
          )}

          {installMode === "path" && (
            <>
              <div className="space-y-2">
                <Label htmlFor="skill-name">Name</Label>
                <Input
                  id="skill-name"
                  value={installName}
                  onChange={(e) => setInstallName(e.target.value)}
                  placeholder="Skill name"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="skill-description">Description</Label>
                <Textarea
                  id="skill-description"
                  value={installDescription}
                  onChange={(e) => setInstallDescription(e.target.value)}
                  placeholder="Optional description"
                  rows={2}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="skill-path">Installed path</Label>
                <Input
                  id="skill-path"
                  value={installPath}
                  onChange={(e) => setInstallPath(e.target.value)}
                  placeholder="/path/to/skill"
                />
              </div>
              <div className="flex gap-2">
                <Button size="sm" onClick={handleInstallPath} disabled={!installName.trim() || !installPath.trim() || createMutation.isPending}>
                  Add
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setShowInstallForm(false)}>
                  Cancel
                </Button>
              </div>
            </>
          )}
        </div>
      )}

      {error && <p className="text-sm text-destructive">{error.message}</p>}

      {!hasAnySkills && !showInstallForm && (
        <EmptyState
          icon={Blocks}
          message="No skills yet."
          description="Skills give agents specialized capabilities — from code review to deployment workflows. Install skills to extend what your agents can do."
          action="Install Skill"
          onAction={() => setShowInstallForm(true)}
        />
      )}

      {hasAnySkills && (
        <div className="space-y-6">
          {TIER_ORDER.map((tier) => {
            const tierSkills = grouped.get(tier) ?? [];
            if (tierSkills.length === 0) return null;

            return (
              <div key={tier}>
                <h3 className="text-sm font-medium text-muted-foreground mb-2">{TIER_LABELS[tier]}</h3>
                <div className="border border-border">
                  {tierSkills.map((skill) => (
                    <EntityRow
                      key={skill.id}
                      leading={
                        skill.tier === "built_in" ? (
                          <Lock className="h-4 w-4 text-muted-foreground shrink-0" />
                        ) : undefined
                      }
                      title={skill.name}
                      subtitle={
                        [
                          skill.description,
                          skill.tier === "agent" && skill.agentId
                            ? `Agent: ${agentMap.get(skill.agentId) ?? skill.agentId}`
                            : null,
                        ]
                          .filter(Boolean)
                          .join(" · ") || undefined
                      }
                      trailing={
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-muted-foreground">
                            {SOURCE_LABELS[skill.sourceType] ?? skill.sourceType}
                          </span>
                          <span
                            className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium ${tierBadgeClass(skill.tier)}`}
                          >
                            {TIER_LABELS[skill.tier]}
                          </span>
                          {skill.tier === "company" && (
                            <Button
                              size="icon-sm"
                              variant="ghost"
                              className="text-destructive hover:text-destructive"
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                handleRemove(skill);
                              }}
                              disabled={removeMutation.isPending}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          )}
                        </div>
                      }
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
