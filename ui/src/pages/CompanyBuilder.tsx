import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Sparkles, Send, RefreshCw, Settings as SettingsIcon, Wrench } from "lucide-react";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToastActions } from "../context/ToastContext";
import { builderApi } from "../api/builder";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "../components/EmptyState";
import { listUIAdapters } from "../adapters/registry";
import type {
  BuilderMessage,
  BuilderProviderSettings,
  BuilderSession,
  BuilderSessionDetail,
} from "@paperclipai/shared";

/**
 * Company AI Builder page.
 *
 * Three-pane layout:
 *
 *   [ session list ] [ chat transcript + inline proposal actions ] [ settings panel ]
 *
 * Mutation tools (create_routine, hire_agent, …) produce a `builder_proposal`
 * which surfaces inline next to the originating tool result with Apply /
 * Reject buttons. Governed primitives also create a row in the Approvals
 * queue (handled by the existing Approvals UI).
 */

const QUERY_KEY = ["builder"] as const;

// Supported local CLI adapters for Builder
// These are the adapters that spawn processes and work with the adapter executor
const SUPPORTED_BUILDER_ADAPTER_TYPES = [
  "claude_local",
  "codex_local",
  "opencode_local",
  "cursor_local",
  "gemini_local",
  "pi_local",
] as const;

// Get available adapters dynamically from the UI adapter registry
function getAvailableBuilderAdapters() {
  const allAdapters = listUIAdapters();
  return allAdapters.filter((adapter) =>
    SUPPORTED_BUILDER_ADAPTER_TYPES.includes(adapter.type as any)
  );
}

// Get models for a specific adapter type
async function getAdapterModels(adapterType: string): Promise<Array<{ id: string; label: string }>> {
  try {
    // Dynamically import the adapter module to get its models
    switch (adapterType) {
      case "claude_local":
        const claude = await import("@paperclipai/adapter-claude-local");
        return claude.models || [];
      case "codex_local":
        const codex = await import("@paperclipai/adapter-codex-local");
        return codex.models || [];
      case "opencode_local":
        const opencode = await import("@paperclipai/adapter-opencode-local");
        return opencode.models || [];
      case "cursor_local":
        const cursor = await import("@paperclipai/adapter-cursor-local");
        return cursor.models || [];
      case "gemini_local":
        const gemini = await import("@paperclipai/adapter-gemini-local");
        return gemini.models || [];
      case "pi_local":
        const pi = await import("@paperclipai/adapter-pi-local");
        return pi.models || [];
      default:
        return [];
    }
  } catch (err) {
    console.warn(`Failed to load models for ${adapterType}:`, err);
    return [];
  }
}

// Get adapter compatibility status badge
function getAdapterStatusBadge(adapterType: string): string {
  // Phase 4 will add actual testing - for now mark all as experimental
  switch (adapterType) {
    case "claude_local":
    case "opencode_local":
      return "🧪 Experimental - Core functionality implemented";
    case "codex_local":
    case "cursor_local":
    case "gemini_local":
    case "pi_local":
      return "⚠️ Untested - May require additional configuration";
    default:
      return "❓ Unknown compatibility status";
  }
}

function formatRoleLabel(role: BuilderMessage["role"]): string {
  switch (role) {
    case "assistant":
      return "AI";
    case "user":
      return "You";
    case "tool":
      return "Tool";
    default:
      return role;
  }
}

function MessageBubble({
  message,
  onApplyProposal,
  onRejectProposal,
  proposalActionPending,
}: {
  message: BuilderMessage;
  onApplyProposal?: (proposalId: string) => void;
  onRejectProposal?: (proposalId: string) => void;
  proposalActionPending?: string | null;
}) {
  const text = message.content.text ?? "";
  const toolCalls = message.content.toolCalls ?? [];
  const toolResult = message.content.toolResult;
  const isUser = message.role === "user";
  const proposalId = toolResult?.proposalId;

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[80%] rounded-lg px-3 py-2 text-sm ${
          isUser ? "bg-primary text-primary-foreground" : "bg-muted"
        }`}
      >
        <div className="text-[11px] uppercase tracking-wide opacity-60 mb-1">
          {formatRoleLabel(message.role)}
        </div>
        {text && <div className="whitespace-pre-wrap">{text}</div>}
        {toolCalls.length > 0 && (
          <div className="mt-2 space-y-1">
            {toolCalls.map((call) => (
              <div
                key={call.id}
                className="rounded border border-border/50 bg-background/40 px-2 py-1 text-xs font-mono"
              >
                → {call.name}({JSON.stringify(call.arguments)})
              </div>
            ))}
          </div>
        )}
        {toolResult && (
          <div className="mt-1 rounded border border-border/50 bg-background/40 px-2 py-1 text-xs">
            <div className="font-mono opacity-70 mb-1">
              {toolResult.name} → {toolResult.ok ? "ok" : "error"}
            </div>
            <pre className="whitespace-pre-wrap text-[11px] leading-snug">
              {JSON.stringify(toolResult.result, null, 2).slice(0, 800)}
            </pre>
            {proposalId && toolResult.proposalStatus === "pending" && onApplyProposal && onRejectProposal && (
              <div className="mt-2 flex items-center gap-2 border-t border-border/40 pt-2">
                <span className="text-[11px] uppercase opacity-60">Proposal</span>
                <button
                  type="button"
                  className="rounded bg-primary px-2 py-0.5 text-[11px] text-primary-foreground disabled:opacity-50"
                  disabled={proposalActionPending === proposalId}
                  onClick={() => onApplyProposal(proposalId)}
                >
                  Apply
                </button>
                <button
                  type="button"
                  className="rounded border border-border px-2 py-0.5 text-[11px] disabled:opacity-50"
                  disabled={proposalActionPending === proposalId}
                  onClick={() => onRejectProposal(proposalId)}
                >
                  Reject
                </button>
              </div>
            )}
            {proposalId && toolResult.proposalStatus && toolResult.proposalStatus !== "pending" && (
              <div className="mt-2 border-t border-border/40 pt-2">
                <span className="text-[11px] uppercase opacity-60">
                  Proposal {toolResult.proposalStatus}
                </span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

interface SettingsFormState {
  adapterType: string;
  model: string;
}

function deriveFormFromSettings(settings: BuilderProviderSettings | null): SettingsFormState {
  return {
    adapterType: settings?.adapterType ?? "claude_local",
    model: (settings?.adapterConfig?.model as string) ?? "",
  };
}

function SettingsPanel({ companyId }: { companyId: string }) {
  const queryClient = useQueryClient();
  const toast = useToastActions();
  const settingsQuery = useQuery({
    queryKey: [...QUERY_KEY, "settings", companyId] as const,
    queryFn: () => builderApi.getSettings(companyId),
  });
  const [form, setForm] = useState<SettingsFormState | null>(null);
  const [availableModels, setAvailableModels] = useState<Array<{ id: string; label: string }>>([]);
  const [loadingModels, setLoadingModels] = useState(false);

  // Get available Builder-compatible adapters dynamically
  const availableAdapters = useMemo(() => getAvailableBuilderAdapters(), []);

  useEffect(() => {
    if (settingsQuery.data) {
      setForm(deriveFormFromSettings(settingsQuery.data.settings));
    }
  }, [settingsQuery.data]);

  // Load models when adapter type changes
  useEffect(() => {
    if (form?.adapterType) {
      setLoadingModels(true);
      getAdapterModels(form.adapterType)
        .then((models) => {
          setAvailableModels(models);
          // If no model is set and models are available, select the first one
          if (!form.model && models.length > 0) {
            setForm((prev) => prev ? { ...prev, model: models[0].id } : null);
          }
        })
        .catch((err) => {
          console.error('Failed to load models:', err);
          setAvailableModels([]);
        })
        .finally(() => {
          setLoadingModels(false);
        });
    }
  }, [form?.adapterType]);

  const mutation = useMutation({
    mutationFn: async () => {
      if (!form) return null;
      
      return builderApi.updateSettings(companyId, {
        adapterType: form.adapterType,
        adapterConfig: {
          model: form.model.trim(),
        },
      });
    },
    onSuccess: async () => {
      toast.pushToast({ title: "Builder settings saved", tone: "success" });
      await queryClient.invalidateQueries({ queryKey: [...QUERY_KEY, "settings", companyId] });
    },
    onError: (err) => {
      toast.pushToast({
        title: "Failed to save settings",
        body: err instanceof Error ? err.message : String(err),
        tone: "error",
      });
    },
  });

  if (!form) return <div className="text-xs text-muted-foreground">Loading settings…</div>;

  const selectedAdapter = availableAdapters.find((a) => a.type === form.adapterType);

  return (
    <div className="space-y-3 text-sm">
      <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground">
        <SettingsIcon className="h-3.5 w-3.5" /> Configuration
      </div>
      
      <label className="block text-xs">
        Adapter Type
        <select
          className="mt-1 w-full rounded border border-border bg-background px-2 py-1 text-sm"
          value={form.adapterType}
          onChange={(e) => {
            setForm({ ...form, adapterType: e.target.value, model: "" });
          }}
        >
          {availableAdapters.map((adapter) => (
            <option key={adapter.type} value={adapter.type}>
              {adapter.label}
            </option>
          ))}
        </select>
        {selectedAdapter && (
          <div className="mt-1 text-[10px] text-muted-foreground">
            {getAdapterStatusBadge(form.adapterType)}
          </div>
        )}
      </label>
      
      <label className="block text-xs">
        Model
        {loadingModels ? (
          <div className="mt-1 w-full rounded border border-border bg-background px-2 py-1 text-sm text-muted-foreground">
            Loading models...
          </div>
        ) : (
          <select
            className="mt-1 w-full rounded border border-border bg-background px-2 py-1 text-sm font-mono"
            value={form.model}
            onChange={(e) => setForm({ ...form, model: e.target.value })}
          >
            {!form.model && <option value="">-- Select a model --</option>}
            {availableModels.map((model) => (
              <option key={model.id} value={model.id}>
                {model.label}
              </option>
            ))}
          </select>
        )}
      </label>
      
      <Button
        onClick={() => mutation.mutate()}
        disabled={mutation.isPending || !form.model.trim()}
        size="sm"
        className="w-full"
      >
        {mutation.isPending ? "Saving…" : "Save settings"}
      </Button>
    </div>
  );
}

function ToolList({ companyId }: { companyId: string }) {
  const toolsQuery = useQuery({
    queryKey: [...QUERY_KEY, "tools", companyId] as const,
    queryFn: () => builderApi.getTools(companyId),
  });
  if (!toolsQuery.data) {
    return <div className="text-xs text-muted-foreground">Loading tools…</div>;
  }
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground">
        <Wrench className="h-3.5 w-3.5" /> Available tools
      </div>
      {toolsQuery.data.tools.map((tool) => (
        <div key={tool.name} className="rounded border border-border px-2 py-1.5 text-xs">
          <div className="font-mono">{tool.name}</div>
          <div className="text-muted-foreground">{tool.description}</div>
          <div className="mt-1 text-[10px] uppercase tracking-wide opacity-60">
            {tool.capability} · {tool.requiresApproval ? "approval-gated" : "direct"}
          </div>
        </div>
      ))}
    </div>
  );
}

function ChatPanel({
  companyId,
  session,
  refresh,
}: {
  companyId: string;
  session: BuilderSessionDetail;
  refresh: () => void;
}) {
  const [input, setInput] = useState("");
  const [proposalActionPending, setProposalActionPending] = useState<string | null>(null);
  const toast = useToastActions();
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: async (text: string) =>
      builderApi.sendMessage(companyId, session.id, { text }),
    onSuccess: async () => {
      setInput("");
      await queryClient.invalidateQueries({
        queryKey: [...QUERY_KEY, "session", companyId, session.id],
      });
      refresh();
    },
    onError: (err) => {
      toast.pushToast({
        title: "Failed to send message",
        body: err instanceof Error ? err.message : String(err),
        tone: "error",
      });
    },
  });

  const decideProposal = async (
    proposalId: string,
    action: "apply" | "reject",
  ) => {
    setProposalActionPending(proposalId);
    try {
      if (action === "apply") {
        await builderApi.applyProposal(companyId, proposalId);
        toast.pushToast({ title: "Proposal applied", tone: "success" });
      } else {
        await builderApi.rejectProposal(companyId, proposalId);
        toast.pushToast({ title: "Proposal rejected", tone: "info" });
      }
      await queryClient.invalidateQueries({
        queryKey: [...QUERY_KEY, "session", companyId, session.id],
      });
      refresh();
    } catch (err) {
      toast.pushToast({
        title: action === "apply" ? "Failed to apply proposal" : "Failed to reject proposal",
        body: err instanceof Error ? err.message : String(err),
        tone: "error",
      });
    } finally {
      setProposalActionPending(null);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 space-y-3 overflow-y-auto pr-2">
        {session.messages.length === 0 ? (
          <EmptyState
            icon={Sparkles}
            message="Ask anything about this company. Try: 'list my agents and which routines are paused'"
          />
        ) : (
          session.messages.map((msg) => (
            <MessageBubble
              key={msg.id}
              message={msg}
              onApplyProposal={(id) => decideProposal(id, "apply")}
              onRejectProposal={(id) => decideProposal(id, "reject")}
              proposalActionPending={proposalActionPending}
            />
          ))
        )}
      </div>
      <form
        className="mt-3 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const text = input.trim();
          if (!text || mutation.isPending) return;
          mutation.mutate(text);
        }}
      >
        <input
          className="flex-1 rounded border border-border bg-background px-3 py-2 text-sm"
          placeholder="Ask the AI Builder…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={mutation.isPending || session.state !== "active"}
        />
        <Button
          type="submit"
          size="sm"
          disabled={!input.trim() || mutation.isPending || session.state !== "active"}
        >
          {mutation.isPending ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
        </Button>
      </form>
    </div>
  );
}

export function CompanyBuilder() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const toast = useToastActions();
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "AI Builder" }]);
  }, [setBreadcrumbs]);

  const sessionsQuery = useQuery({
    queryKey: [...QUERY_KEY, "sessions", selectedCompanyId] as const,
    queryFn: () =>
      selectedCompanyId ? builderApi.listSessions(selectedCompanyId) : Promise.resolve({ sessions: [] }),
    enabled: !!selectedCompanyId,
  });

  const sessionDetailQuery = useQuery({
    queryKey: [...QUERY_KEY, "session", selectedCompanyId, activeSessionId] as const,
    queryFn: () =>
      selectedCompanyId && activeSessionId
        ? builderApi.getSession(selectedCompanyId, activeSessionId)
        : Promise.resolve({ session: null as BuilderSessionDetail | null }),
    enabled: !!selectedCompanyId && !!activeSessionId,
  });

  const createMutation = useMutation({
    mutationFn: async () => {
      if (!selectedCompanyId) return null;
      return builderApi.createSession(selectedCompanyId, { title: "New session" });
    },
    onSuccess: async (created) => {
      if (!created) return;
      setActiveSessionId(created.session.id);
      await queryClient.invalidateQueries({
        queryKey: [...QUERY_KEY, "sessions", selectedCompanyId],
      });
    },
    onError: (err) => {
      toast.pushToast({
        title: "Failed to create session",
        body: err instanceof Error ? err.message : String(err),
        tone: "error",
      });
    },
  });

  const sessions: BuilderSession[] = sessionsQuery.data?.sessions ?? [];

  // Auto-select the first session on load.
  useEffect(() => {
    if (!activeSessionId && sessions[0]) setActiveSessionId(sessions[0].id);
  }, [activeSessionId, sessions]);

  const detail = useMemo(
    () => sessionDetailQuery.data?.session ?? null,
    [sessionDetailQuery.data],
  );

  if (!selectedCompanyId) {
    return <div className="text-sm text-muted-foreground">Select a company to use the AI Builder.</div>;
  }

  return (
    <div className="grid h-full gap-4 lg:grid-cols-[220px_1fr_280px]">
      <Card className="overflow-hidden">
        <CardContent className="space-y-2 p-3">
          <div className="flex items-center justify-between">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">Sessions</div>
            <Button size="sm" variant="ghost" onClick={() => createMutation.mutate()}>
              + New
            </Button>
          </div>
          {sessions.length === 0 ? (
            <div className="text-xs text-muted-foreground">No sessions yet.</div>
          ) : (
            sessions.map((session) => (
              <button
                key={session.id}
                type="button"
                onClick={() => setActiveSessionId(session.id)}
                className={`block w-full rounded px-2 py-1.5 text-left text-sm hover:bg-muted ${
                  session.id === activeSessionId ? "bg-muted font-medium" : ""
                }`}
              >
                <div className="truncate">{session.title || "Untitled session"}</div>
                <div className="text-[10px] text-muted-foreground">
                  {session.model} · {session.state}
                </div>
              </button>
            ))
          )}
        </CardContent>
      </Card>

      <Card className="overflow-hidden">
        <CardContent className="flex h-[70vh] flex-col p-3">
          {detail ? (
            <ChatPanel
              companyId={selectedCompanyId}
              session={detail}
              refresh={() => sessionDetailQuery.refetch()}
            />
          ) : (
            <EmptyState
              icon={Sparkles}
              message="No session selected. Create one to start chatting with your company's AI Builder."
            />
          )}
        </CardContent>
      </Card>

      <Card className="overflow-hidden">
        <CardContent className="space-y-4 p-3">
          <SettingsPanel companyId={selectedCompanyId} />
          <ToolList companyId={selectedCompanyId} />
        </CardContent>
      </Card>
    </div>
  );
}
