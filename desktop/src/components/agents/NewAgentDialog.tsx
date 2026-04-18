import { useState } from "react";
import { Bot, X } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { agentsApi } from "@/api/agents";
import { queryKeys } from "@/lib/queryKeys";

interface NewAgentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyId: string;
}

const ADAPTER_OPTIONS = [
  { type: "ollama_local", label: "Ollama (Free)", description: "Run models locally — no account needed" },
  { type: "claude_local", label: "Claude", description: "Anthropic Claude Code CLI" },
  { type: "codex_local", label: "Codex", description: "OpenAI Codex CLI" },
  { type: "cursor_local", label: "Cursor", description: "Cursor Agent CLI" },
  { type: "gemini_local", label: "Gemini", description: "Google Gemini CLI" },
  { type: "opencode_local", label: "OpenCode", description: "OpenCode CLI" },
  { type: "process", label: "Custom Process", description: "Generic subprocess" },
];

const ROLE_OPTIONS = [
  { value: "ceo", label: "CEO" },
  { value: "manager", label: "Manager" },
  { value: "general", label: "General" },
  { value: "specialist", label: "Specialist" },
  { value: "contractor", label: "Contractor" },
];

export function NewAgentDialog({ open, onOpenChange, companyId }: NewAgentDialogProps) {
  const [step, setStep] = useState(1);
  const [adapterType, setAdapterType] = useState("claude_local");
  const [name, setName] = useState("");
  const [role, setRole] = useState("general");

  const queryClient = useQueryClient();
  const createMutation = useMutation({
    mutationFn: () => agentsApi.create(companyId, { name, role, adapter_type: adapterType }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(companyId) });
      close();
    },
  });

  if (!open) return null;

  const reset = () => {
    setStep(1);
    setAdapterType("claude_local");
    setName("");
    setRole("general");
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
            <Bot size={18} style={{ color: "var(--accent)" }} />
            <h2 className="text-sm font-semibold">New Agent</h2>
          </div>
          <button
            onClick={close}
            className="flex h-7 w-7 items-center justify-center rounded-md transition-colors"
            style={{ color: "var(--fg-muted)" }}
          >
            <X size={16} />
          </button>
        </div>

        {/* Content */}
        <div className="px-6 py-5">
          {step === 1 && (
            <div>
              <p className="mb-4 text-[13px] font-medium" style={{ color: "var(--fg-secondary)" }}>
                Choose an adapter
              </p>
              <div className="grid grid-cols-2 gap-2">
                {ADAPTER_OPTIONS.map((opt) => (
                  <button
                    key={opt.type}
                    onClick={() => setAdapterType(opt.type)}
                    className="rounded-lg border p-3 text-left transition-all"
                    style={{
                      borderColor: adapterType === opt.type ? "var(--accent)" : "var(--card-border)",
                      background: adapterType === opt.type ? "var(--accent-subtle)" : "transparent",
                    }}
                  >
                    <div className="text-[13px] font-medium">{opt.label}</div>
                    <div className="text-[11px]" style={{ color: "var(--fg-muted)" }}>{opt.description}</div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="flex flex-col gap-4">
              <div>
                <label className="mb-1 block text-[13px] font-medium" style={{ color: "var(--fg-secondary)" }}>
                  Name
                </label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g., Atlas"
                  className="w-full rounded-md border px-3 py-2 text-sm outline-none transition-colors"
                  style={{
                    background: "var(--input-bg)",
                    borderColor: "var(--input-border)",
                    color: "var(--fg)",
                    fontFamily: "var(--font-body)",
                  }}
                  autoFocus
                />
              </div>
              <div>
                <label className="mb-1 block text-[13px] font-medium" style={{ color: "var(--fg-secondary)" }}>
                  Role
                </label>
                <div className="flex gap-2 flex-wrap">
                  {ROLE_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      onClick={() => setRole(opt.value)}
                      className="rounded-md border px-3 py-1.5 text-xs font-medium transition-colors"
                      style={{
                        borderColor: role === opt.value ? "var(--accent)" : "var(--border)",
                        background: role === opt.value ? "var(--accent)" : "transparent",
                        color: role === opt.value ? "var(--accent-fg)" : "var(--fg-secondary)",
                      }}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t px-6 py-4" style={{ borderColor: "var(--border-subtle)" }}>
          <div className="text-[12px]" style={{ color: "var(--fg-muted)" }}>
            Step {step} of 2
          </div>
          <div className="flex gap-2">
            {step > 1 && (
              <button
                onClick={() => setStep(step - 1)}
                className="rounded-md border px-4 py-2 text-[13px] font-medium transition-colors"
                style={{ borderColor: "var(--border)", color: "var(--fg-secondary)" }}
              >
                Back
              </button>
            )}
            {step < 2 ? (
              <button
                onClick={() => setStep(2)}
                className="rounded-md px-4 py-2 text-[13px] font-medium transition-colors"
                style={{ background: "var(--accent)", color: "var(--accent-fg)" }}
              >
                Next
              </button>
            ) : (
              <button
                onClick={() => createMutation.mutate()}
                disabled={!name.trim() || createMutation.isPending}
                className="rounded-md px-4 py-2 text-[13px] font-medium transition-colors disabled:opacity-40"
                style={{ background: "var(--accent)", color: "var(--accent-fg)" }}
              >
                Create Agent
              </button>
            )}
          </div>
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
