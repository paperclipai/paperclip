import { useState, useCallback } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { agentsApi } from "../api/agents";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { cn } from "../lib/utils";
import { Plus, Pencil, Trash2, ChevronDown, ChevronRight, Zap } from "lucide-react";
import type { Agent } from "@paperclipai/shared";

export interface AgentSkill {
  name: string;
  description?: string;
  content: string;
  enabled?: boolean;
}

function parseSkills(agent: Agent): AgentSkill[] {
  const config = agent.adapterConfig as Record<string, unknown> | null;
  const raw = config?.skills;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (s): s is AgentSkill =>
      s && typeof s === "object" && typeof (s as AgentSkill).name === "string" && typeof (s as AgentSkill).content === "string",
  );
}

function SkillForm({
  initial,
  onSave,
  onCancel,
}: {
  initial?: AgentSkill;
  onSave: (skill: AgentSkill) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [content, setContent] = useState(initial?.content ?? "");

  function handleSave() {
    if (!name.trim() || !content.trim()) return;
    onSave({ name: name.trim(), description: description.trim() || undefined, content, enabled: true });
  }

  return (
    <div className="border border-border p-3 space-y-3">
      <div className="space-y-2">
        <div>
          <label className="text-xs font-medium text-muted-foreground block mb-1">Skill Name</label>
          <input
            className="w-full px-2 py-1.5 text-sm border border-border bg-background rounded focus:outline-none focus:ring-1 focus:ring-ring"
            placeholder="e.g. code-reviewer"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground block mb-1">Description (optional)</label>
          <input
            className="w-full px-2 py-1.5 text-sm border border-border bg-background rounded focus:outline-none focus:ring-1 focus:ring-ring"
            placeholder="Brief description of what this skill does"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground block mb-1">Skill Content (Markdown)</label>
          <textarea
            className="w-full px-2 py-1.5 text-sm border border-border bg-background rounded focus:outline-none focus:ring-1 focus:ring-ring font-mono min-h-[120px] resize-y"
            placeholder={"Skill instructions in markdown...\n\nThis will be available as a Claude Code skill the agent can invoke."}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={8}
          />
        </div>
      </div>
      <div className="flex items-center gap-2 justify-end">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" onClick={handleSave} disabled={!name.trim() || !content.trim()}>
          {initial ? "Update" : "Add"} Skill
        </Button>
      </div>
    </div>
  );
}

export function AgentSkillsEditor({
  agent,
  companyId,
}: {
  agent: Agent;
  companyId?: string;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [skills, setSkills] = useState<AgentSkill[]>(() => parseSkills(agent));
  const [editIndex, setEditIndex] = useState<number | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [expanded, setExpanded] = useState(true);

  const saveSkills = useMutation({
    mutationFn: (updatedSkills: AgentSkill[]) => {
      const existingConfig = (agent.adapterConfig as Record<string, unknown>) ?? {};
      return agentsApi.update(agent.id, {
        adapterConfig: { ...existingConfig, skills: updatedSkills },
      }, companyId);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.urlKey) });
      pushToast({ title: "Skills updated", tone: "success" });
    },
    onError: (err) => {
      pushToast({ title: "Failed to save skills", body: err instanceof Error ? err.message : "Unknown error", tone: "error" });
    },
  });

  const handleAdd = useCallback((skill: AgentSkill) => {
    const updated = [...skills, skill];
    setSkills(updated);
    setShowAddForm(false);
    saveSkills.mutate(updated);
  }, [skills, saveSkills]);

  const handleUpdate = useCallback((index: number, skill: AgentSkill) => {
    const updated = [...skills];
    updated[index] = skill;
    setSkills(updated);
    setEditIndex(null);
    saveSkills.mutate(updated);
  }, [skills, saveSkills]);

  const handleDelete = useCallback((index: number) => {
    const updated = skills.filter((_, i) => i !== index);
    setSkills(updated);
    saveSkills.mutate(updated);
  }, [skills, saveSkills]);

  const handleToggle = useCallback((index: number) => {
    const updated = [...skills];
    updated[index] = { ...updated[index]!, enabled: !(updated[index]!.enabled ?? true) };
    setSkills(updated);
    saveSkills.mutate(updated);
  }, [skills, saveSkills]);

  return (
    <div>
      <button
        className="flex items-center gap-2 text-sm font-medium hover:text-foreground transition-colors mb-3"
        onClick={() => setExpanded((v) => !v)}
      >
        {expanded
          ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
          : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
        }
        <Zap className="h-3.5 w-3.5" />
        Skills
        <span className="text-xs font-normal text-muted-foreground">{skills.length}</span>
      </button>

      {expanded && (
        <div className="space-y-2">
          {skills.length === 0 && !showAddForm && (
            <p className="text-sm text-muted-foreground">
              No custom skills installed. Skills are injected as Claude Code skills at runtime.
            </p>
          )}

          {skills.map((skill, i) => (
            <div key={`${skill.name}-${i}`}>
              {editIndex === i ? (
                <SkillForm
                  initial={skill}
                  onSave={(s) => handleUpdate(i, s)}
                  onCancel={() => setEditIndex(null)}
                />
              ) : (
                <div className={cn(
                  "flex items-center gap-3 px-3 py-2 border border-border group",
                  !(skill.enabled ?? true) && "opacity-50",
                )}>
                  <button
                    className={cn(
                      "flex items-center justify-center h-3.5 w-3.5 border border-border rounded-sm shrink-0",
                      (skill.enabled ?? true) && "bg-foreground",
                    )}
                    onClick={() => handleToggle(i)}
                    title={skill.enabled ?? true ? "Disable skill" : "Enable skill"}
                  >
                    {(skill.enabled ?? true) && (
                      <span className="text-background text-[10px] leading-none">&#10003;</span>
                    )}
                  </button>
                  <div className="flex-1 min-w-0">
                    <span className="text-sm font-medium">{skill.name}</span>
                    {skill.description && (
                      <span className="text-xs text-muted-foreground ml-2">{skill.description}</span>
                    )}
                  </div>
                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      className="p-1 hover:bg-accent/50 rounded"
                      onClick={() => setEditIndex(i)}
                      title="Edit skill"
                    >
                      <Pencil className="h-3 w-3 text-muted-foreground" />
                    </button>
                    <button
                      className="p-1 hover:bg-destructive/10 rounded"
                      onClick={() => handleDelete(i)}
                      title="Remove skill"
                    >
                      <Trash2 className="h-3 w-3 text-destructive/70" />
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}

          {showAddForm && (
            <SkillForm onSave={handleAdd} onCancel={() => setShowAddForm(false)} />
          )}

          {!showAddForm && editIndex === null && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowAddForm(true)}
              disabled={saveSkills.isPending}
            >
              <Plus className="h-3.5 w-3.5 mr-1.5" />
              Add Skill
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
