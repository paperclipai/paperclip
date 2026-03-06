import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@/lib/router";
import { useDialog } from "../context/DialogContext";
import { useCompany } from "../context/CompanyContext";
import { agentsApi } from "../api/agents";
import { queryKeys } from "../lib/queryKeys";
import { AGENT_ROLES } from "@paperclipai/shared";
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
import { roleLabels } from "./agent-config-primitives";
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

  // Popover states
  const [roleOpen, setRoleOpen] = useState(false);
  const [reportsToOpen, setReportsToOpen] = useState(false);

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
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
      agentsApi.hire(selectedCompanyId!, data),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(selectedCompanyId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.approvals.list(selectedCompanyId!) });
      reset();
      closeNewAgent();
      navigate(agentUrl(result.agent));
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

          {/* Shared config form (adapter + heartbeat) */}
          <AgentConfigForm
            mode="create"
            values={configValues}
            onChange={(patch) => setConfigValues((prev) => ({ ...prev, ...patch }))}
            adapterModels={adapterModels}
          />
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
