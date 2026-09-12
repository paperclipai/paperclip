import { Trans } from "react-i18next";
import { t, useTranslation } from "@/i18n";
import { useMemo, useState } from "react";
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
import { InlineBanner } from "@/components/InlineBanner";
import { listAdapterOptions } from "@/adapters/metadata";
import { agentsApi } from "@/api/agents";
import { queryKeys } from "@/lib/queryKeys";
import { ApiError } from "@/api/client";
import {
  builtInAgentsApi,
  type BuiltInAgentState,
} from "@/api/builtInAgents";

// Guard stock metadata by registry ID and exact source so custom/future copy is not masked.
function builtInPurpose(definition: BuiltInAgentState["definition"]): string {
  if (definition.key === "briefs" && definition.shortPurpose === "Prepares concise operational briefs for the board and agent company.") {
    return t("localizationAgentChrome.builtinPurpose_briefs");
  }
  if (definition.key === "learning" && definition.shortPurpose === "Maintains reusable company learning from completed work and recurring patterns.") {
    return t("localizationAgentChrome.builtinPurpose_learning");
  }
  if (definition.key === "reflection-coach" && definition.shortPurpose === "Runs evidence-backed reflection loops on recent agent work, proposes small instruction and skill improvements, and requests approval before changes are applied.") {
    return t("localizationAgentChrome.builtinPurpose_reflection_coach");
  }
  if (definition.key === "summarizer" && definition.shortPurpose === "Writes short, human-readable Markdown status summaries into project, workspaces-overview, project-workspace, and execution-workspace summary slots on demand.") {
    return t("localizationAgentChrome.builtinPurpose_summarizer");
  }
  return definition.shortPurpose;
}

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
  const { t } = useTranslation();
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
  const [error, setError] = useState<string | true | null>(null);

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

  const { data: fetchedModels } = useQuery({
    queryKey: queryKeys.agents.adapterModels(companyId, adapterType, null),
    queryFn: () => agentsApi.adapterModels(companyId, adapterType, {}),
    enabled: open && Boolean(companyId) && setupSupportedInModal,
  });
  const models = fetchedModels ?? [];

  const modelRequired = setupSupportedInModal;
  const normalizedModel = model.trim();
  const modelKnown =
    !normalizedModel ||
    models.length === 0 ||
    models.some((candidate) => candidate.id === normalizedModel);
  const modelError = modelKnown
    ? null
    : t("localizationAgentChrome.modelUnavailable", { model: normalizedModel, adapter: adapterType });
  const budgetMonthlyCents = parseBudgetMonthlyCents(budgetDollars);
  const budgetValid = !budgetDollars.trim() || budgetMonthlyCents !== undefined;
  const canSubmit =
    budgetValid &&
    modelKnown &&
    (setupSupportedInModal ? !modelRequired || normalizedModel.length > 0 : true);
  const submitLabel = setupSupportedInModal
    ? t("localizationAgentChrome.configureEnable", { name: definition.displayName })
    : t("localizationAgentChrome.provisionAgent", { name: definition.displayName });

  const provision = useMutation({
    mutationFn: async () => {
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
      setError(err instanceof ApiError ? err.message : true);
    },
  });

  return (
    <Dialog open={open} onOpenChange={(next) => (provision.isPending ? undefined : onOpenChange(next))}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("localizationAgentChrome.setUpAgentTitle", { name: definition.displayName })}</DialogTitle>
          <DialogDescription>{builtInPurpose(definition)}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <InlineBanner tone="info" compact>
            <Trans i18nKey="localizationAgentChrome.createsBuiltIn" values={{ name: definition.displayName }} components={{ name: <strong />, badge: <strong /> }} />
          </InlineBanner>

          <Field label={t("pages.inviteLanding.agentForm.adapterType")}>
            <AdapterTypeDropdown
              value={adapterType}
              onChange={(next) => {
                setAdapterType(next);
                setModel("");
              }}
              disabledTypes={disabledTypes}
            />
          </Field>

          {modelRequired && (
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

          {!setupSupportedInModal && (
            <InlineBanner tone="warning" compact>{t("localizationAgentChrome.ui56_This_adapter_needs_command_or_endpoint_fields_before")}</InlineBanner>
          )}

          <Field label={t("localizationAgentChrome.ui57_Monthly_budget_optional")} hint={t("localizationAgentChrome.ui58_Leave_blank_for_no_cap")}>
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
              <span className="text-sm text-muted-foreground">{t("localizationAgentChrome.ui59_month")}</span>
            </div>
          </Field>

          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error === true ? t("localizationAgentChrome.ui50_Failed_to_configure_the_built_in_agent") : error}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={provision.isPending}
          >{t("localizationIssueDetail.ui_Not_now")}</Button>
          <Button
            onClick={() => {
              setError(null);
              provision.mutate();
            }}
            disabled={!canSubmit || provision.isPending}
          >
            {provision.isPending ? t("localizationAgentChrome.ui60_Configuring") : submitLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
