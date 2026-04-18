import { useState } from "react";
import { X, Target } from "lucide-react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { goalsApi } from "@/api/goals";
import type { GoalNode } from "@/api/goals";
import { agentsApi } from "@/api/agents";
import { queryKeys } from "@/lib/queryKeys";

interface NewGoalDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyId: string;
}

const LEVEL_OPTIONS = [
  { value: "mission", label: "Mission" },
  { value: "objective", label: "Objective" },
  { value: "key_result", label: "Key Result" },
  { value: "task", label: "Task" },
];

function flattenGoals(nodes: GoalNode[], depth = 0): Array<{ id: string; title: string; depth: number }> {
  const result: Array<{ id: string; title: string; depth: number }> = [];
  for (const node of nodes) {
    result.push({ id: node.id, title: node.title, depth });
    result.push(...flattenGoals(node.children, depth + 1));
  }
  return result;
}

export function NewGoalDialog({ open, onOpenChange, companyId }: NewGoalDialogProps) {
  const [title, setTitle] = useState("");
  const [level, setLevel] = useState("objective");
  const [parentId, setParentId] = useState("");
  const [ownerAgentId, setOwnerAgentId] = useState("");

  const queryClient = useQueryClient();

  const { data: goals = [] } = useQuery({
    queryKey: queryKeys.goals.list(companyId),
    queryFn: () => goalsApi.list(companyId),
    enabled: open,
  });

  const { data: agents = [] } = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
    enabled: open,
  });

  const flatGoals = flattenGoals(goals);

  const createMutation = useMutation({
    mutationFn: () =>
      goalsApi.create(companyId, {
        title,
        level,
        parent_id: parentId || undefined,
        owner_agent_id: ownerAgentId || undefined,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.goals.list(companyId) });
      close();
    },
  });

  if (!open) return null;

  const reset = () => {
    setTitle("");
    setLevel("objective");
    setParentId("");
    setOwnerAgentId("");
  };

  const close = () => {
    onOpenChange(false);
    reset();
  };

  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center"
      style={{ background: "oklch(0 0 0 / 0.4)" }}
      onClick={(e) => { if (e.target === e.currentTarget) close(); }}
    >
      <div
        className="w-[520px] overflow-hidden rounded-lg border"
        style={{
          background: "var(--card-bg)",
          borderColor: "var(--border)",
          boxShadow: "var(--shadow-3)",
          animation: "dialog-in 0.15s var(--ease-spring)",
        }}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b px-6 py-4" style={{ borderColor: "var(--border-subtle)" }}>
          <div className="flex items-center gap-3">
            <Target size={18} style={{ color: "var(--accent)" }} />
            <h2 className="text-sm font-semibold">New Goal</h2>
          </div>
          <button onClick={close} className="flex h-7 w-7 items-center justify-center rounded-md transition-colors" style={{ color: "var(--fg-muted)" }}>
            <X size={16} />
          </button>
        </div>

        {/* Content */}
        <div className="flex flex-col gap-4 px-6 py-5">
          <div>
            <label className="mb-1 block text-[13px] font-medium" style={{ color: "var(--fg-secondary)" }}>Title</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Goal title"
              className="w-full rounded-md border px-3 py-2 text-sm outline-none transition-colors"
              style={{ background: "var(--input-bg)", borderColor: "var(--input-border)", color: "var(--fg)", fontFamily: "var(--font-body)" }}
              autoFocus
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="mb-1 block text-[13px] font-medium" style={{ color: "var(--fg-secondary)" }}>Level</label>
              <select
                value={level}
                onChange={(e) => setLevel(e.target.value)}
                className="w-full rounded-md border px-3 py-2 text-sm outline-none"
                style={{ background: "var(--input-bg)", borderColor: "var(--input-border)", color: "var(--fg)", fontFamily: "var(--font-body)" }}
              >
                {LEVEL_OPTIONS.map((l) => (
                  <option key={l.value} value={l.value}>{l.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-[13px] font-medium" style={{ color: "var(--fg-secondary)" }}>Owner Agent</label>
              <select
                value={ownerAgentId}
                onChange={(e) => setOwnerAgentId(e.target.value)}
                className="w-full rounded-md border px-3 py-2 text-sm outline-none"
                style={{ background: "var(--input-bg)", borderColor: "var(--input-border)", color: "var(--fg)", fontFamily: "var(--font-body)" }}
              >
                <option value="">None</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <label className="mb-1 block text-[13px] font-medium" style={{ color: "var(--fg-secondary)" }}>Parent Goal</label>
            <select
              value={parentId}
              onChange={(e) => setParentId(e.target.value)}
              className="w-full rounded-md border px-3 py-2 text-sm outline-none"
              style={{ background: "var(--input-bg)", borderColor: "var(--input-border)", color: "var(--fg)", fontFamily: "var(--font-body)" }}
            >
              <option value="">No parent (top-level)</option>
              {flatGoals.map((g) => (
                <option key={g.id} value={g.id}>{"  ".repeat(g.depth)}{g.title}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 border-t px-6 py-4" style={{ borderColor: "var(--border-subtle)" }}>
          <button
            onClick={close}
            className="rounded-md border px-4 py-2 text-[13px] font-medium transition-colors"
            style={{ borderColor: "var(--border)", color: "var(--fg-secondary)" }}
          >
            Cancel
          </button>
          <button
            onClick={() => createMutation.mutate()}
            disabled={!title.trim() || createMutation.isPending}
            className="rounded-md px-4 py-2 text-[13px] font-medium transition-colors disabled:opacity-40"
            style={{ background: "var(--accent)", color: "var(--accent-fg)" }}
          >
            Create Goal
          </button>
        </div>
      </div>

      <style>{`
        @keyframes dialog-in {
          from { opacity: 0; transform: scale(0.97) translateY(-8px); }
          to { opacity: 1; transform: scale(1) translateY(0); }
        }
      `}</style>
    </div>
  );
}
