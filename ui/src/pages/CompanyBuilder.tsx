import { useEffect, useMemo, useState } from "react";
import { Link } from "@/lib/router";
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
import { listUIAdapters, getUIAdapter } from "../adapters";
import type {
  BuilderMessage,
  BuilderProviderSettings,
  BuilderSession,
  BuilderSessionDetail,
} from "@paperclipai/shared";
import type { CreateConfigValues } from "@paperclipai/adapter-utils";

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

// Get available adapters dynamically from the UI adapter registry
function getAvailableBuilderAdapters(supportedAdapterTypes: string[]) {
  const supported = new Set(supportedAdapterTypes);
  const allAdapters = listUIAdapters();
  return allAdapters.filter((adapter) => supported.has(adapter.type));
}

// Get models for a specific adapter type
async function getAdapterModels(adapterType: string): Promise<Array<{ id: string; label: string }>> {
  const adapter = getUIAdapter(adapterType);
  if (!adapter) return [];
  // Access models from the adapter module if available
  try {
    const module = await import(/* @vite-ignore */ `@paperclipai/adapter-${adapterType.replace(/_/g, '-')}`);
    return module.models || [];
  } catch {
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

function getApprovalBackedToolResult(toolResult: BuilderMessage["content"]["toolResult"] | undefined): {
  approvalId: string | null;
  requiresApproval: boolean;
} {
  const result = toolResult?.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return { approvalId: null, requiresApproval: false };
  }
  const record = result as Record<string, unknown>;
  return {
    approvalId: typeof record.approvalId === "string" ? record.approvalId : null,
    requiresApproval: record.requiresApproval === true,
  };
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
  const { approvalId, requiresApproval } = getApprovalBackedToolResult(toolResult);
  const approvalBackedProposal = Boolean(proposalId && approvalId && requiresApproval);

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[80%] rounded-lg px-3 py-2 text-sm ${
          isUser ? "bg-primary text-primary-foreground" : "bg-muted"
        }`}
      >
        <div className="whitespace-pre-wrap">{text}</div>
        {toolCalls.length > 0 && (
          <div className="mt-1 space-y-1">
            {toolCalls.map((call) => (
              <div
                key={call.id}
                className="rounded bg-black/5 px-2 py-1 text-xs dark:bg-white/10"
              >
                <span className="font-semibold">{call.name}</span>
                <pre className="mt-0.5 overflow-x-auto text-[10px] opacity-80">
                  {JSON.stringify(call.arguments, null, 2)}
                </pre>
              </div>
            ))}
          </div>
        )}
        {toolResult && (
          <div
            className={`mt-1 rounded px-2 py-1 text-xs ${
              toolResult.ok
                ? "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-200"
                : "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-200"
            }`}
          >
            {toolResult.ok ? "✓" : "✗"} {toolResult.name}
            {typeof toolResult.result === "object" && toolResult.result !== null ? (
              <pre className="mt-0.5 overflow-x-auto text-[10px] opacity-80">
                {JSON.stringify(toolResult.result, null, 2)}
              </pre>
            ) : (
              <span className="ml-1 opacity-80">{String(toolResult.result ?? "")}</span>
            )}
            {proposalId && (
              <div className="mt-1.5 flex items-center gap-2">
                <span className="text-[10px] opacity-70">Proposal #{proposalId.slice(0, 8)}</span>
                {onApplyProposal && onRejectProposal && (
                  <>
                    <button
                      type="button"
                      onClick={() => onApplyProposal(proposalId)}
                      disabled={proposalActionPending === proposalId}
                      className="rounded bg-primary px-2 py-0.5 text-[10px] text-primary-foreground hover:opacity-90 disabled:opacity-50"
                    >
                      {proposalActionPending === proposalId ? "Applying…" : "Apply"}
                    </button>
                    <button
                      type="button"
                      onClick={() => onRejectProposal(proposalId)}
                      disabled={proposalActionPending === proposalId}
                      className="rounded border border-border px-2 py-0.5 text-[10px] hover:bg-muted disabled:opacity-50"
                    >
                      Reject
                    </button>
                  </>
                )}
                {approvalBackedProposal && (
                  <span className="text-[10px] opacity-70">→ Approvals queue</span>
                )}
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
  // Form values for the adapter's ConfigFields component
  formValues: CreateConfigValues;
}

function deriveFormFromSettings(settings: BuilderProviderSettings | null): SettingsFormState {
  const adapterConfig = settings?.adapterConfig ?? {};
  return {
    adapterType: settings?.adapterType ?? "claude_local",
    formValues: adapterConfigToFormValues(adapterConfig),
  };
}

/** Convert stored adapterConfig to form values for CreateConfigValues shape */
function adapterConfigToFormValues(config: Record<string, unknown>): CreateConfigValues {
  return {
    // Common fields
    adapterType: "",
    model: (config.model as string) ?? "",
    instructionsFilePath: (config.instructionsFilePath as string) ?? "",
    cwd: (config.cwd as string) ?? "",
    // Claude-specific
    thinkingEffort: (config.effort as string) ?? "",
    chrome: (config.chrome as boolean) ?? false,
    dangerouslySkipPermissions: (config.dangerouslySkipPermissions as boolean) ?? false,
    // Timeouts
    timeoutSec: (config.timeoutSec as number) ?? 0,
    // Prompt template
    promptTemplate: (config.promptTemplate as string) ?? "",
    bootstrapPrompt: (config.bootstrapPromptTemplate as string) ?? "",
    // Args
    command: (config.command as string) ?? "",
    extraArgs: Array.isArray(config.extraArgs) ? config.extraArgs.join(", ") : "",
    args: Array.isArray(config.args) ? config.args.join(", ") : "",
    // Env bindings (for EnvVarEditor)
    envBindings: (config.env as Record<string, unknown>) ?? {},
    envVars: "",
    // Codex/OpenCode specific
    search: (config.search as boolean) ?? false,
    fastMode: (config.fastMode as boolean) ?? false,
    dangerouslyBypassSandbox: (config.dangerouslyBypassSandbox as boolean) ?? false,
    // OpenClaw
    url: (config.url as string) ?? "",
    accessToken: (config.accessToken as string) ?? undefined,
    apiKey: (config.apiKey as string) ?? undefined,
    // Workspace settings
    workspaceStrategyType: (config.workspaceStrategyType as string) ?? undefined,
    workspaceBaseRef: (config.workspaceBaseRef as string) ?? undefined,
    workspaceBranchTemplate: (config.workspaceBranchTemplate as string) ?? undefined,
    worktreeParentDir: (config.worktreeParentDir as string) ?? undefined,
    payloadTemplateJson: (config.payloadTemplateJson as string) ?? undefined,
    runtimeServicesJson: (config.runtimeServicesJson as string) ?? undefined,
    artifactOutputsJson: (config.artifactOutputsJson as string) ?? undefined,
    maxTurnsPerRun: (config.maxTurnsPerRun as number) ?? 10,
    // Heartbeat (runtime config)
    heartbeatEnabled: false,
    intervalSec: 300,
  };
}

function SettingsPanel({ companyId }: { companyId: string }) {
  const queryClient = useQueryClient();
  const toast = useToastActions();
  const toolsQuery = useQuery({
    queryKey: [...QUERY_KEY, "tools", companyId] as const,
    queryFn: () => builderApi.getTools(companyId),
  });
  const settingsQuery = useQuery({
    queryKey: [...QUERY_KEY, "settings", companyId] as const,
    queryFn: () => builderApi.getSettings(companyId),
  });
  const [form, setForm] = useState<SettingsFormState | null>(null);
  const [availableModels, setAvailableModels] = useState<Array<{ id: string; label: string }>>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  // Track dirty config fields (edited but not saved)
  const [dirtyConfig, setDirtyConfig] = useState<Record<string, unknown>>({});

  // Get available Builder-compatible adapters dynamically
  const availableAdapters = useMemo(
    () => getAvailableBuilderAdapters(toolsQuery.data?.supportedAdapterTypes ?? []),
    [toolsQuery.data?.supportedAdapterTypes],
  );

  // Get current adapter module
  const uiAdapter = useMemo(() => {
    if (!form?.adapterType) return null;
    return getUIAdapter(form.adapterType);
  }, [form?.adapterType]);

  useEffect(() => {
    if (settingsQuery.data) {
      const derived = deriveFormFromSettings(settingsQuery.data.settings);
      setForm(derived);
      setDirtyConfig({}); // Clear dirty state when loading saved settings
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
          if (!form.formValues.model && models.length > 0) {
            setForm((prev) =>
              prev
                ? {
                    ...prev,
                    formValues: { ...prev.formValues, model: models[0].id },
                  }
                : null,
            );
          }
        })
        .catch((err) => {
          console.error("Failed to load models:", err);
          setAvailableModels([]);
        })
        .finally(() => {
          setLoadingModels(false);
        });
    }
  }, [form?.adapterType]);

  const mutation = useMutation({
    mutationFn: async () => {
      if (!form || !uiAdapter) return null;

      // Build final adapter config using the adapter's own buildAdapterConfig
      const baseConfig = uiAdapter.buildAdapterConfig(form.formValues);
      const mergedConfig = { ...baseConfig, ...dirtyConfig };

      return builderApi.updateSettings(companyId, {
        adapterType: form.adapterType,
        adapterConfig: mergedConfig,
      });
    },
    onSuccess: async () => {
      toast.pushToast({ title: "Builder settings saved", tone: "success" });
      setDirtyConfig({}); // Clear dirty state after save
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

  if (!form || !toolsQuery.data) {
    return <div className="text-xs text-muted-foreground">Loading settings…</div>;
  }

  const selectedAdapter = availableAdapters.find((a) => a.type === form.adapterType);

  // Build props for the adapter's ConfigFields component
  // We treat this like "create mode" for simplicity - we manage formValues ourselves
  const adapterFieldProps = {
    mode: "create" as const,
    isCreate: true,
    adapterType: form.adapterType,
    values: form.formValues,
    set: (patch: Partial<CreateConfigValues>) => {
      setForm((prev) =>
        prev ? { ...prev, formValues: { ...prev.formValues, ...patch } } : null,
      );
    },
    config: settingsQuery.data?.settings?.adapterConfig ?? {},
    eff: ((_group: "adapterConfig", _field: string, original: string) => original) as any,
    mark: (_group: "adapterConfig", _field: string, _value: unknown) => {
      // Builder saves in one go, so we don't need granular dirty tracking per field
    },
    models: availableModels,
    hideInstructionsFile: true, // Builder doesn't need instructions file
  };

  return (
    <div className="space-y-4 text-sm">
      <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground">
        <SettingsIcon className="h-3.5 w-3.5" /> Configuration
      </div>

      <label className="block text-xs">
        Adapter Type
        <select
          className="mt-1 w-full rounded border border-border bg-background px-2 py-1 text-sm"
          value={form.adapterType}
          onChange={(e) => {
            const newAdapterType = e.target.value;
            setForm({
              adapterType: newAdapterType,
              formValues: adapterConfigToFormValues({}),
            });
            setDirtyConfig({});
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

      {/* Render the adapter's own ConfigFields component */}
      {uiAdapter && <uiAdapter.ConfigFields {...adapterFieldProps} />}

      <Button
        onClick={() => mutation.mutate()}
        disabled={mutation.isPending || !form.formValues.model?.trim()}
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
    mutationFn: async (text: string) => builderApi.sendMessage(companyId, session.id, { text }),
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
        toast.pushToast({
          title: "Proposal applied",
          body: "The proposal has been applied to your company.",
          tone: "success",
        });
      } else {
        await builderApi.rejectProposal(companyId, proposalId);
        toast.pushToast({
          title: "Proposal rejected",
          body: "The proposal has been rejected.",
          tone: "info",
        });
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
