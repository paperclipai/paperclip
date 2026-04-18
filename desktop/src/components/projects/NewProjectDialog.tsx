import { useState } from "react";
import { X, FolderPlus } from "lucide-react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { projectsApi } from "@/api/projects";
import { agentsApi } from "@/api/agents";
import { queryKeys } from "@/lib/queryKeys";

interface NewProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyId: string;
}

export function NewProjectDialog({ open, onOpenChange, companyId }: NewProjectDialogProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [color, setColor] = useState("#5A78BE");
  const [leadAgentId, setLeadAgentId] = useState("");

  const queryClient = useQueryClient();

  const { data: agents = [] } = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
    enabled: open,
  });

  const createMutation = useMutation({
    mutationFn: () =>
      projectsApi.create(companyId, {
        name,
        description: description || undefined,
        color,
        lead_agent_id: leadAgentId || undefined,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.list(companyId) });
      close();
    },
  });

  if (!open) return null;

  const reset = () => {
    setName("");
    setDescription("");
    setColor("#5A78BE");
    setLeadAgentId("");
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
            <FolderPlus size={18} style={{ color: "var(--accent)" }} />
            <h2 className="text-sm font-semibold">New Project</h2>
          </div>
          <button onClick={close} className="flex h-7 w-7 items-center justify-center rounded-md transition-colors" style={{ color: "var(--fg-muted)" }}>
            <X size={16} />
          </button>
        </div>

        {/* Content */}
        <div className="flex flex-col gap-4 px-6 py-5">
          <div>
            <label className="mb-1 block text-[13px] font-medium" style={{ color: "var(--fg-secondary)" }}>Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Project name"
              className="w-full rounded-md border px-3 py-2 text-sm outline-none transition-colors"
              style={{ background: "var(--input-bg)", borderColor: "var(--input-border)", color: "var(--fg)", fontFamily: "var(--font-body)" }}
              autoFocus
            />
          </div>
          <div>
            <label className="mb-1 block text-[13px] font-medium" style={{ color: "var(--fg-secondary)" }}>Description</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What is this project about?"
              rows={3}
              className="w-full resize-none rounded-md border px-3 py-2 text-sm outline-none transition-colors"
              style={{ background: "var(--input-bg)", borderColor: "var(--input-border)", color: "var(--fg)", fontFamily: "var(--font-body)" }}
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="mb-1 block text-[13px] font-medium" style={{ color: "var(--fg-secondary)" }}>Color</label>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={color}
                  onChange={(e) => setColor(e.target.value)}
                  className="h-8 w-8 shrink-0 cursor-pointer rounded border-none"
                />
                <input
                  type="text"
                  value={color}
                  onChange={(e) => setColor(e.target.value)}
                  className="flex-1 rounded-md border px-3 py-2 text-sm outline-none"
                  style={{ background: "var(--input-bg)", borderColor: "var(--input-border)", color: "var(--fg)", fontFamily: "var(--font-mono)" }}
                />
              </div>
            </div>
            <div>
              <label className="mb-1 block text-[13px] font-medium" style={{ color: "var(--fg-secondary)" }}>Lead Agent</label>
              <select
                value={leadAgentId}
                onChange={(e) => setLeadAgentId(e.target.value)}
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
            disabled={!name.trim() || createMutation.isPending}
            className="rounded-md px-4 py-2 text-[13px] font-medium transition-colors disabled:opacity-40"
            style={{ background: "var(--accent)", color: "var(--accent-fg)" }}
          >
            Create Project
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
