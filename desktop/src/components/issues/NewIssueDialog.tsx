import { useState } from "react";
import { X, AlertCircle } from "lucide-react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { issuesApi } from "@/api/issues";
import type { IssuePriority } from "@/api/issues";
import { projectsApi } from "@/api/projects";
import { agentsApi } from "@/api/agents";
import { queryKeys } from "@/lib/queryKeys";

interface NewIssueDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyId: string;
}

const PRIORITY_OPTIONS: { value: IssuePriority; label: string }[] = [
  { value: "critical", label: "Critical" },
  { value: "high", label: "High" },
  { value: "medium", label: "Medium" },
  { value: "low", label: "Low" },
  { value: "none", label: "None" },
];

export function NewIssueDialog({ open, onOpenChange, companyId }: NewIssueDialogProps) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [projectId, setProjectId] = useState("");
  const [priority, setPriority] = useState<IssuePriority>("medium");
  const [assigneeAgentId, setAssigneeAgentId] = useState("");

  const queryClient = useQueryClient();

  const { data: projects = [] } = useQuery({
    queryKey: queryKeys.projects.list(companyId),
    queryFn: () => projectsApi.list(companyId),
    enabled: open,
  });

  const { data: agents = [] } = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
    enabled: open,
  });

  const createMutation = useMutation({
    mutationFn: () =>
      issuesApi.create(companyId, {
        title,
        description: description || undefined,
        project_id: projectId || undefined,
        priority,
        assignee_agent_id: assigneeAgentId || undefined,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(companyId) });
      close();
    },
  });

  if (!open) return null;

  const reset = () => {
    setTitle("");
    setDescription("");
    setProjectId("");
    setPriority("medium");
    setAssigneeAgentId("");
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
            <AlertCircle size={18} style={{ color: "var(--accent)" }} />
            <h2 className="text-sm font-semibold">New Issue</h2>
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
              placeholder="Issue title"
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
              placeholder="Describe the issue..."
              rows={3}
              className="w-full resize-none rounded-md border px-3 py-2 text-sm outline-none transition-colors"
              style={{ background: "var(--input-bg)", borderColor: "var(--input-border)", color: "var(--fg)", fontFamily: "var(--font-body)" }}
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="mb-1 block text-[13px] font-medium" style={{ color: "var(--fg-secondary)" }}>Project</label>
              <select
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
                className="w-full rounded-md border px-3 py-2 text-sm outline-none"
                style={{ background: "var(--input-bg)", borderColor: "var(--input-border)", color: "var(--fg)", fontFamily: "var(--font-body)" }}
              >
                <option value="">No project</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-[13px] font-medium" style={{ color: "var(--fg-secondary)" }}>Priority</label>
              <select
                value={priority}
                onChange={(e) => setPriority(e.target.value as IssuePriority)}
                className="w-full rounded-md border px-3 py-2 text-sm outline-none"
                style={{ background: "var(--input-bg)", borderColor: "var(--input-border)", color: "var(--fg)", fontFamily: "var(--font-body)" }}
              >
                {PRIORITY_OPTIONS.map((p) => (
                  <option key={p.value} value={p.value}>{p.label}</option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <label className="mb-1 block text-[13px] font-medium" style={{ color: "var(--fg-secondary)" }}>Assignee</label>
            <select
              value={assigneeAgentId}
              onChange={(e) => setAssigneeAgentId(e.target.value)}
              className="w-full rounded-md border px-3 py-2 text-sm outline-none"
              style={{ background: "var(--input-bg)", borderColor: "var(--input-border)", color: "var(--fg)", fontFamily: "var(--font-body)" }}
            >
              <option value="">Unassigned</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
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
            Create Issue
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
