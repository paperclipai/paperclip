import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/agent-config-primitives";
import { AdapterTypeDropdown, ModelDropdown } from "@/components/AgentConfigForm";
import { DevinModelPicker } from "@/adapters/devin-local/model-picker";
import {
  devinModelActionError,
  devinModelView,
  type DevinModelDraftStatus,
} from "@/adapters/devin-local/model-selection";
import { InlineBanner } from "@/components/InlineBanner";
import { listAdapterOptions } from "@/adapters/metadata";
import { agentsApi } from "@/api/agents";
import { queryKeys } from "@/lib/queryKeys";
import {
  builtInAgentsApi,
  type BuiltInAgentState,
} from "@/api/builtInAgents";

/** Adapters whose config completeness is keyed on a non-empty `model`. */
function isModelBasedAdapter(adapterType: string): boolean {
  return !["process", "command", "http", "openclaw_gateway", "hermes_gateway"].includes(adapterType);
}

function defaultAdapterType(state: BuiltInAgentState): string {
  return state.definition.defaultAdapterType ?? state.definition.allowedAdapterTypes?.[0] ?? "codex_local";
}

function parseBudgetMonthlyCents(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const cents = Math.round(Number(trimmed) * 100);
  return Number.isFinite(cents) && cents >= 0 ? cents : undefined;
}

export interface ConfigureBuiltInAgentModalProps {
  companyId: string;
  state: BuiltInAgentState;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after a successful provision (e.g. to navigate to the agent). */
  onConfigured?: (result: BuiltInAgentState) => void;
}

/**
 * Configure-on-first-use modal for a built-in agent. Reuses the shared
 * `AdapterTypeDropdown` + `ModelDropdown` (ux-spec D6 — no second model picker),
 * plus an optional monthly budget, and submits to the provision endpoint.
 */
export function ConfigureBuiltInAgentModal({
  companyId,
  state,
  open,
  onOpenChange,
  onConfigured,
}: ConfigureBuiltInAgentModalProps) {
  const queryClient = useQueryClient();
  const { definition } = state;

  const [adapterType, setAdapterType] = useState<string>(
    () => state.agent?.adapterType ?? defaultAdapterType(state),
  );
  const [model, setModel] = useState<string>(() => {
    const config = state.agent?.adapterConfig;
    const configuredModel = typeof config === "object" && config !== null
      ? (config as Record<string, unknown>).model
      : null;
    if (typeof configuredModel === "string") return configuredModel;
    const defaultModel = state.definition.defaultAdapterConfig?.model;
    return typeof defaultModel === "string" ? defaultModel : "";
  });
  const [modelOpen, setModelOpen] = useState(false);
  const [budgetDollars, setBudgetDollars] = useState<string>(() => {
    const cents = definition.defaultBudgetMonthlyCents ?? 0;
    return cents > 0 ? String(cents / 100) : "";
  });
  const [error, setError] = useState<string | null>(null);
  const [openRevision, setOpenRevision] = useState(0);
  const [resetRevision, setResetRevision] = useState(0);
  const [modelDraftEntry, setModelDraftEntry] = useState<{
    scopeKey: string;
    status: DevinModelDraftStatus;
  } | null>(null);
  const initialModel = () => {
    const config = state.agent?.adapterConfig;
    const configuredModel =
      typeof config === "object" && config !== null
        ? (config as Record<string, unknown>).model
        : null;
    if (typeof configuredModel === "string") return configuredModel;
    const defaultModel = state.definition.defaultAdapterConfig?.model;
    return typeof defaultModel === "string" ? defaultModel : "";
  };

  useEffect(() => {
    if (!open) return;
    setOpenRevision((revision) => revision + 1);
    setAdapterType(state.agent?.adapterType ?? defaultAdapterType(state));
    setModel(initialModel());
    setBudgetDollars(() => {
      const cents = state.definition.defaultBudgetMonthlyCents ?? 0;
      return cents > 0 ? String(cents / 100) : "";
    });
    setModelDraftEntry(null);
    setError(null);
  }, [open, companyId, definition.key]);

  // Restrict adapter choices to the registry's allow-list. Non-model adapters
  // are still selectable: provisioning creates the row, then full agent config
  // collects command/endpoint fields while the built-in remains `needs_setup`.
  const disabledTypes = useMemo(() => {
    const allowed = new Set(definition.allowedAdapterTypes ?? []);
    return new Set(
      listAdapterOptions()
        .map((option) => option.value)
        .filter((value) => allowed.size > 0 && !allowed.has(value)),
    );
  }, [definition.allowedAdapterTypes]);

  const setupSupportedInModal = isModelBasedAdapter(adapterType);

  const modelsQuery = useQuery({
    queryKey: queryKeys.agents.adapterModels(companyId, adapterType, null),
    queryFn: () => agentsApi.adapterModels(companyId, adapterType, {}),
    enabled: open && Boolean(companyId) && setupSupportedInModal,
  });
  const models = modelsQuery.data ?? [];

  const modelScopeKey = JSON.stringify([
    companyId,
    "builtin",
    definition.key,
    openRevision,
    adapterType,
    resetRevision,
  ]);
  const modelDraftStatus: DevinModelDraftStatus =
    modelDraftEntry && modelDraftEntry.scopeKey === modelScopeKey
      ? modelDraftEntry.status
      : { view: devinModelView(model, models), dirty: false, pending: false, message: null };
  const modelActionError =
    adapterType === "devin_local"
      ? devinModelActionError(model, modelDraftStatus)
      : null;
  const modelActionErrorRef = useRef(modelActionError);
  modelActionErrorRef.current = modelActionError;

  const modelRequired = setupSupportedInModal;
  const normalizedModel = model.trim();
  const modelKnown =
    !normalizedModel ||
    models.length === 0 ||
    models.some((candidate) => candidate.id === normalizedModel);
  const modelError = modelKnown
    ? null
    : `Model “${normalizedModel}” is not available for ${adapterType}. Choose a known model.`;
  const budgetMonthlyCents = parseBudgetMonthlyCents(budgetDollars);
  const budgetValid = !budgetDollars.trim() || budgetMonthlyCents !== undefined;
  const canSubmit =
    budgetValid &&
    modelKnown &&
    !modelActionError &&
    (setupSupportedInModal ? !modelRequired || normalizedModel.length > 0 : true);
  const submitLabel = setupSupportedInModal
    ? `Configure & enable ${definition.displayName}`
    : `Provision ${definition.displayName}`;

  const provision = useMutation({
    mutationFn: async () => {
      const actionError = modelActionErrorRef.current;
      if (actionError) throw new Error(actionError);
      if (!budgetValid) throw new Error("Enter a valid monthly budget.");
      if (!modelKnown) throw new Error(modelError ?? "Choose a known model.");
      if (modelRequired && normalizedModel.length === 0) {
        throw new Error("Choose a model before continuing.");
      }
      const adapterConfig: Record<string, unknown> = {};
      if (model.trim()) adapterConfig.model = model.trim();
      const result = await builtInAgentsApi.provision(companyId, definition.key, {
        adapterType,
        adapterConfig,
        ...(budgetMonthlyCents !== undefined ? { budgetMonthlyCents } : {}),
      });
      return result;
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.builtInAgents.list(companyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(companyId) });
      if (result.agentId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(result.agentId) });
      }
      onConfigured?.(result);
      onOpenChange(false);
    },
    onError: (err) => {
      setError(
        err instanceof Error
          ? err.message
          : "Failed to configure the built-in agent.",
      );
    },
  });

  return (
    <Dialog open={open} onOpenChange={(next) => (provision.isPending ? undefined : onOpenChange(next))}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Set up the {definition.displayName}</DialogTitle>
          <DialogDescription>{definition.shortPurpose}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <InlineBanner tone="info" compact>
            Creates <strong>{definition.displayName}</strong> in your roster, badged{" "}
            <strong>Built-in</strong>. Organizations that require hire approval will queue this for the
            board.
          </InlineBanner>

          <Field label="Adapter type">
            <AdapterTypeDropdown
              value={adapterType}
              onChange={(next) => {
                setAdapterType(next);
                setModel("");
                setModelDraftEntry(null);
                setResetRevision((revision) => revision + 1);
              }}
              disabledTypes={disabledTypes}
            />
          </Field>

          {modelRequired && adapterType === "devin_local" && (
            <DevinModelPicker
              models={models}
              value={model}
              onChange={setModel}
              open={modelOpen}
              onOpenChange={setModelOpen}
              allowDefault={false}
              required
              groupByProvider={false}
              creatable
              scopeKey={modelScopeKey}
              catalogState={
                modelsQuery.isPending
                  ? "loading"
                  : modelsQuery.error
                    ? "error"
                    : "ready"
              }
              catalogError={
                modelsQuery.error instanceof Error
                  ? modelsQuery.error.message
                  : null
              }
              onRefreshModels={async () => {
                const refreshed = await agentsApi.adapterModels(companyId, adapterType, { refresh: true });
                queryClient.setQueryData(
                  queryKeys.agents.adapterModels(companyId, adapterType, null),
                  refreshed,
                );
              }}
              refreshingModels={modelsQuery.isFetching}
              onDraftStatusChange={(status) => {
                setModelDraftEntry({ scopeKey: modelScopeKey, status });
              }}
            />
          )}

          {modelRequired && adapterType !== "devin_local" && (
            // ModelDropdown supplies its own "Model" Field label + hint.
            <ModelDropdown
              models={models}
              value={model}
              onChange={setModel}
              open={modelOpen}
              onOpenChange={setModelOpen}
              allowDefault={adapterType !== "opencode_local"}
              required
              groupByProvider={false}
              creatable
            />
          )}

          {modelError && (
            <p className="text-sm text-destructive" role="alert">
              {modelError}
            </p>
          )}

          {modelActionError && (
            <p className="text-sm text-destructive" role="alert">
              {modelActionError}
            </p>
          )}

          {!setupSupportedInModal && (
            <InlineBanner tone="warning" compact>
              This adapter needs command or endpoint fields before it can run. Provision the
              built-in row now, then finish those fields from the full agent configuration.
            </InlineBanner>
          )}

          <Field label="Monthly budget (optional)" hint="Leave blank for no cap.">
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">$</span>
              <Input
                type="number"
                min="0"
                step="1"
                inputMode="decimal"
                placeholder="0"
                value={budgetDollars}
                onChange={(event) => setBudgetDollars(event.target.value)}
                className="w-32"
              />
              <span className="text-sm text-muted-foreground">/ month</span>
            </div>
          </Field>

          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={provision.isPending}
          >
            Not now
          </Button>
          <Button
            onClick={() => {
              setError(null);
              provision.mutate();
            }}
            disabled={!canSubmit || provision.isPending}
          >
            {provision.isPending ? "Configuring…" : submitLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
