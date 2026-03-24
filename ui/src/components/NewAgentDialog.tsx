import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@/lib/router";
import { useDialog } from "../context/DialogContext";
import { useCompany } from "../context/CompanyContext";
import { agentsApi } from "../api/agents";
import { queryKeys } from "../lib/queryKeys";
import { AGENT_ROLES, AGENT_PRESETS, PROVIDER_LABELS, STRATEGIC_ROLES, type AgentPreset } from "@paperclipai/shared";
import { credentialsApi } from "../api/credentials";
import {
  Dialog,
  DialogContent,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Minimize2,
  Maximize2,
  Shield,
  User,
} from "lucide-react";
import { cn, agentUrl } from "../lib/utils";
import { roleLabels, adapterLabels } from "./agent-config-primitives";
import { AgentConfigForm, type CreateConfigValues } from "./AgentConfigForm";
import { defaultCreateValues } from "./agent-config-defaults";
import { getUIAdapter } from "../adapters";
import { AgentIcon } from "./AgentIconPicker";

export function NewAgentDialog() {
  const { newAgentOpen, closeNewAgent } = useDialog();
  const { selectedCompanyId, selectedCompany } = useCompany();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState(true);

  // Identity
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [role, setRole] = useState("general");
  const [reportsTo, setReportsTo] = useState("");

  // Config values (managed by AgentConfigForm)
  const [configValues, setConfigValues] = useState<CreateConfigValues>(defaultCreateValues);

  // Preset state
  const [selectedPreset, setSelectedPreset] = useState<AgentPreset | null>(null);
  const [showFullForm, setShowFullForm] = useState(false);

  // Track per-preset provider overrides
  const [providerOverrides, setProviderOverrides] = useState<Record<string, "claude" | "qwen">>({});

  // Popover states
  const [roleOpen, setRoleOpen] = useState(false);
  const [reportsToOpen, setReportsToOpen] = useState(false);

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId && newAgentOpen,
  });

  const { data: credentials = [] } = useQuery({
    queryKey: queryKeys.credentials.list(selectedCompanyId!),
    queryFn: () => credentialsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId && newAgentOpen,
  });

  const {
    data: adapterModels,
    error: adapterModelsError,
    isLoading: adapterModelsLoading,
    isFetching: adapterModelsFetching,
  } = useQuery({
    queryKey:
      selectedCompanyId
        ? queryKeys.agents.adapterModels(selectedCompanyId, configValues.adapterType)
        : ["agents", "none", "adapter-models", configValues.adapterType],
    queryFn: () => agentsApi.adapterModels(selectedCompanyId!, configValues.adapterType),
    enabled: Boolean(selectedCompanyId) && newAgentOpen,
  });

  const isFirstAgent = !agents || agents.length === 0;
  const effectiveRole = isFirstAgent ? "ceo" : role;
  const [formError, setFormError] = useState<string | null>(null);

  // Auto-fill for CEO
  useEffect(() => {
    if (newAgentOpen && isFirstAgent) {
      if (!name) setName("CEO");
      if (!title) setTitle("CEO");
    }
  }, [newAgentOpen, isFirstAgent]); // eslint-disable-line react-hooks/exhaustive-deps

  const createAgent = useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      agentsApi.create(selectedCompanyId!, data),
    onSuccess: (agent) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(selectedCompanyId!) });
      reset();
      closeNewAgent();
      navigate(agentUrl(agent));
    },
    onError: (error) => {
      setFormError(error instanceof Error ? error.message : "Failed to create agent");
    },
  });

  function reset() {
    setName("");
    setTitle("");
    setRole("general");
    setReportsTo("");
    setConfigValues(defaultCreateValues);
    setExpanded(true);
    setFormError(null);
    setSelectedPreset(null);
    setShowFullForm(false);
    setProviderOverrides({});
  }

  function handlePresetWithProvider(preset: AgentPreset, provider: "claude" | "qwen") {
    // Find the right credential
    const credentialType = provider === "qwen" ? "qwen_api_key" : "claude_oauth";
    const credential = credentials.find((c) => c.type === credentialType && c.isDefault)
      ?? credentials.find((c) => c.type === credentialType);

    // Set identity
    setName(preset.name);
    setTitle(preset.title);
    setRole(preset.role);

    // Set config with auto-credential
    setConfigValues((prev) => ({
      ...prev,
      adapterType: preset.adapterType,
      credentialId: credential?.id ?? null,
      heartbeatEnabled: true,
      intervalSec: 300,
    }));

    setSelectedPreset(preset);
    setShowFullForm(false);
  }

  function handlePresetSelect(preset: AgentPreset) {
    handlePresetWithProvider(preset, providerOverrides[preset.id] ?? preset.defaultProvider);
  }

  function buildAdapterConfig() {
    const adapter = getUIAdapter(configValues.adapterType);
    return adapter.buildAdapterConfig(configValues);
  }

  function handleSubmit() {
    if (!selectedCompanyId || !name.trim()) return;
    setFormError(null);
    if (configValues.adapterType === "opencode_local") {
      const selectedModel = configValues.model.trim();
      if (!selectedModel) {
        setFormError("OpenCode requires an explicit model in provider/model format.");
        return;
      }
      if (adapterModelsError) {
        setFormError(
          adapterModelsError instanceof Error
            ? adapterModelsError.message
            : "Failed to load OpenCode models.",
        );
        return;
      }
      if (adapterModelsLoading || adapterModelsFetching) {
        setFormError("OpenCode models are still loading. Please wait and try again.");
        return;
      }
      const discovered = adapterModels ?? [];
      if (!discovered.some((entry) => entry.id === selectedModel)) {
        setFormError(
          discovered.length === 0
            ? "No OpenCode models discovered. Run `opencode models` and authenticate providers."
            : `Configured OpenCode model is unavailable: ${selectedModel}`,
        );
        return;
      }
    }
    createAgent.mutate({
      name: name.trim(),
      role: effectiveRole,
      ...(title.trim() ? { title: title.trim() } : {}),
      ...(reportsTo ? { reportsTo } : {}),
      credentialId: configValues.credentialId || null,
      adapterType: configValues.adapterType,
      adapterConfig: buildAdapterConfig(),
      runtimeConfig: {
        heartbeat: {
          enabled: configValues.heartbeatEnabled,
          intervalSec: configValues.intervalSec,
          wakeOnDemand: true,
          cooldownSec: 10,
          maxConcurrentRuns: 1,
        },
      },
      budgetMonthlyCents: 0,
    });
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSubmit();
    }
  }

  const currentReportsTo = (agents ?? []).find((a) => a.id === reportsTo);

  return (
    <Dialog
      open={newAgentOpen}
      onOpenChange={(open) => {
        if (!open) { reset(); closeNewAgent(); }
      }}
    >
      <DialogContent
        showCloseButton={false}
        className={cn("p-0 gap-0 overflow-hidden", expanded ? "sm:max-w-2xl" : "sm:max-w-lg")}
        onKeyDown={handleKeyDown}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-border">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            {selectedCompany && (
              <span className="bg-muted px-1.5 py-0.5 rounded text-xs font-medium">
                {selectedCompany.name.slice(0, 3).toUpperCase()}
              </span>
            )}
            <span className="text-muted-foreground/60">&rsaquo;</span>
            <span>New agent</span>
          </div>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon-xs" className="text-muted-foreground" onClick={() => setExpanded(!expanded)}>
              {expanded ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
            </Button>
            <Button variant="ghost" size="icon-xs" className="text-muted-foreground" onClick={() => { reset(); closeNewAgent(); }}>
              <span className="text-lg leading-none">&times;</span>
            </Button>
          </div>
        </div>

        <div className="overflow-y-auto max-h-[70vh]">
          {/* Name */}
          <div className="px-4 pt-4 pb-2 shrink-0">
            <input
              className="w-full text-lg font-semibold bg-transparent outline-none placeholder:text-muted-foreground/50"
              placeholder="Agent name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </div>

          {/* Title */}
          <div className="px-4 pb-2">
            <input
              className="w-full bg-transparent outline-none text-sm text-muted-foreground placeholder:text-muted-foreground/40"
              placeholder="Title (e.g. VP of Engineering)"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>

          {/* Property chips: Role + Reports To */}
          <div className="flex items-center gap-1.5 px-4 py-2 border-t border-border flex-wrap">
            {/* Role */}
            <Popover open={roleOpen} onOpenChange={setRoleOpen}>
              <PopoverTrigger asChild>
                <button
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent/50 transition-colors",
                    isFirstAgent && "opacity-60 cursor-not-allowed"
                  )}
                  disabled={isFirstAgent}
                >
                  <Shield className="h-3 w-3 text-muted-foreground" />
                  {roleLabels[effectiveRole] ?? effectiveRole}
                </button>
              </PopoverTrigger>
              <PopoverContent className="w-36 p-1" align="start">
                {AGENT_ROLES.map((r) => (
                  <button
                    key={r}
                    className={cn(
                      "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50",
                      r === role && "bg-accent"
                    )}
                    onClick={() => { setRole(r); setRoleOpen(false); }}
                  >
                    {roleLabels[r] ?? r}
                  </button>
                ))}
              </PopoverContent>
            </Popover>

            {/* Reports To */}
            <Popover open={reportsToOpen} onOpenChange={setReportsToOpen}>
              <PopoverTrigger asChild>
                <button
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent/50 transition-colors",
                    isFirstAgent && "opacity-60 cursor-not-allowed"
                  )}
                  disabled={isFirstAgent}
                >
                  {currentReportsTo ? (
                    <>
                      <AgentIcon icon={currentReportsTo.icon} className="h-3 w-3 text-muted-foreground" />
                      {`Reports to ${currentReportsTo.name}`}
                    </>
                  ) : (
                    <>
                      <User className="h-3 w-3 text-muted-foreground" />
                      {isFirstAgent ? "Reports to: N/A (CEO)" : "Reports to..."}
                    </>
                  )}
                </button>
              </PopoverTrigger>
              <PopoverContent className="w-48 p-1" align="start">
                <button
                  className={cn(
                    "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50",
                    !reportsTo && "bg-accent"
                  )}
                  onClick={() => { setReportsTo(""); setReportsToOpen(false); }}
                >
                  No manager
                </button>
                {(agents ?? []).map((a) => (
                  <button
                    key={a.id}
                    className={cn(
                      "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50 truncate",
                      a.id === reportsTo && "bg-accent"
                    )}
                    onClick={() => { setReportsTo(a.id); setReportsToOpen(false); }}
                  >
                    <AgentIcon icon={a.icon} className="shrink-0 h-3 w-3 text-muted-foreground" />
                    {a.name}
                    <span className="text-muted-foreground ml-auto">{roleLabels[a.role] ?? a.role}</span>
                  </button>
                ))}
              </PopoverContent>
            </Popover>
          </div>

          {/* Preset grid — shown when no preset selected and not in full-form mode */}
          {!selectedPreset && !showFullForm && !isFirstAgent && (
            <div className="px-4 py-3 border-t border-border">
              <div className="text-xs font-medium text-muted-foreground mb-2">Quick start from template</div>
              <div className="grid grid-cols-2 gap-2">
                {AGENT_PRESETS.map((preset) => {
                  const provider = providerOverrides[preset.id] ?? preset.defaultProvider;
                  return (
                    <div
                      key={preset.id}
                      className="flex flex-col rounded-lg border border-border transition-all hover:border-foreground/20 overflow-hidden"
                    >
                      {/* Clickable card body */}
                      <button
                        onClick={() => handlePresetWithProvider(preset, provider)}
                        className="flex flex-col items-start gap-1 px-3 py-2 text-left hover:bg-accent/50 transition-colors flex-1"
                      >
                        <div className="flex items-center gap-2">
                          <AgentIcon icon={preset.icon} className="h-3.5 w-3.5 text-muted-foreground" />
                          <span className="text-xs font-medium">{preset.name}</span>
                        </div>
                        <span className="text-[10px] text-muted-foreground line-clamp-1">{preset.description}</span>
                      </button>
                      {/* Provider toggle at bottom */}
                      <div className="flex items-center gap-1 px-3 py-1.5 border-t border-border bg-muted/30">
                        <select
                          className="w-full rounded border-none bg-transparent text-[10px] font-medium text-muted-foreground outline-none cursor-pointer"
                          value={provider}
                          onChange={(e) => {
                            e.stopPropagation();
                            setProviderOverrides((prev) => ({ ...prev, [preset.id]: e.target.value as "claude" | "qwen" }));
                          }}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <option value="claude">&#9729; Claude</option>
                          <option value="qwen">&#128060; Qwen</option>
                        </select>
                      </div>
                    </div>
                  );
                })}
              </div>
              <button
                className="mt-2 w-full text-xs text-muted-foreground hover:text-foreground transition-colors py-1"
                onClick={() => setShowFullForm(true)}
              >
                or create custom agent...
              </button>
            </div>
          )}

          {/* Selected preset summary — shown when preset is selected but full form is hidden */}
          {selectedPreset && !showFullForm && (
            <div className="px-4 py-3 border-t border-border">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <AgentIcon icon={selectedPreset.icon} className="h-4 w-4 text-muted-foreground" />
                  <span className="text-xs font-medium">{selectedPreset.description}</span>
                  <span className="text-[10px] bg-muted px-1.5 py-0.5 rounded text-muted-foreground">
                    {configValues.credentialId
                      ? (credentials.find((c) => c.id === configValues.credentialId)?.type === "qwen_api_key" ? "\ud83d\udc3c Qwen" : "\u2601 Claude")
                      : adapterLabels[selectedPreset.adapterType] ?? selectedPreset.adapterType
                    }
                  </span>
                </div>
                <button
                  className="text-xs text-muted-foreground hover:text-foreground"
                  onClick={() => { setSelectedPreset(null); setShowFullForm(false); }}
                >
                  Change
                </button>
              </div>
              <button
                className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                onClick={() => setShowFullForm(true)}
              >
                Customize settings...
              </button>
            </div>
          )}

          {/* Shared config form (adapter + heartbeat) — shown when full form is active or first agent */}
          {(showFullForm || isFirstAgent) && (
            <AgentConfigForm
              mode="create"
              values={configValues}
              onChange={(patch) => setConfigValues((prev) => ({ ...prev, ...patch }))}
              adapterModels={adapterModels}
            />
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-2.5 border-t border-border">
          <span className="text-xs text-muted-foreground">
            {isFirstAgent ? "This will be the CEO" : ""}
          </span>
        </div>
        {formError && (
          <div className="px-4 pb-2 text-xs text-destructive">{formError}</div>
        )}
        <div className="flex items-center justify-end px-4 pb-3">
          <Button
            size="sm"
            disabled={!name.trim() || createAgent.isPending}
            onClick={handleSubmit}
          >
            {createAgent.isPending ? "Creating…" : "Create agent"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
