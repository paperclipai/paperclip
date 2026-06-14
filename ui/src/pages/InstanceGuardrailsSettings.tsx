import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ShieldCheck } from "lucide-react";
import type { InstanceGuardsConfig } from "@paperclipai/shared";
import {
  DEFAULT_GUARD_AGENT_MONTHLY_TOKENS,
  DEFAULT_GUARD_COMPANY_MONTHLY_TOKENS,
  DEFAULT_GUARD_MAX_CONSECUTIVE_SAME_ISSUE_RUNS,
  DEFAULT_GUARD_MAX_RUNS_PER_AGENT_PER_HOUR,
  DEFAULT_GUARD_MAX_TOKENS_PER_RUN,
  DEFAULT_GUARD_MAX_TURNS_PER_RUN,
  DEFAULT_GUARD_WARN_PERCENT,
} from "@paperclipai/shared";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

function millions(n: number) {
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function Section({ title, description, children }: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-sm font-semibold">{title}</h2>
        <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
      </div>
      {children}
    </div>
  );
}

function NumberField({
  label,
  description,
  value,
  onChange,
  min,
  disabled,
  hint,
}: {
  label: string;
  description: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  disabled?: boolean;
  hint?: string;
}) {
  return (
    <div className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 items-start">
      <div>
        <Label className="text-sm">{label}</Label>
        <p className="text-xs text-muted-foreground">{description}</p>
        {hint && <p className="text-xs text-muted-foreground/70 mt-0.5">{hint}</p>}
      </div>
      <Input
        type="number"
        className="w-36 h-8 text-sm"
        value={value}
        min={min ?? 0}
        disabled={disabled}
        onChange={(e) => {
          const v = parseInt(e.target.value, 10);
          if (!isNaN(v)) onChange(v);
        }}
      />
    </div>
  );
}

export function InstanceGuardrailsSettings() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);
  const [draft, setDraft] = useState<InstanceGuardsConfig | null>(null);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    setBreadcrumbs([
      { label: "Settings", href: "/company/settings" },
      { label: "Instance settings", href: "/company/settings/instance/general" },
      { label: "Guardrails" },
    ]);
  }, [setBreadcrumbs]);

  const guardsQuery = useQuery({
    queryKey: queryKeys.instance.guardsSettings,
    queryFn: () => instanceSettingsApi.getGuards(),
  });

  useEffect(() => {
    if (guardsQuery.data && !dirty) {
      setDraft(guardsQuery.data);
    }
  }, [guardsQuery.data, dirty]);

  const updateMutation = useMutation({
    mutationFn: (patch: Partial<InstanceGuardsConfig>) => instanceSettingsApi.updateGuards(patch),
    onSuccess: async (updated) => {
      setActionError(null);
      setDraft(updated);
      setDirty(false);
      await queryClient.invalidateQueries({ queryKey: queryKeys.instance.guardsSettings });
    },
    onError: (error) => {
      setActionError(error instanceof Error ? error.message : "Failed to update guardrails settings.");
    },
  });

  function patch<K extends keyof InstanceGuardsConfig>(key: K, value: InstanceGuardsConfig[K]) {
    setDraft((prev) => prev ? { ...prev, [key]: value } : prev);
    setDirty(true);
  }

  function patchBudget(key: keyof InstanceGuardsConfig["budget"], value: unknown) {
    setDraft((prev) => prev ? { ...prev, budget: { ...prev.budget, [key]: value } } : prev);
    setDirty(true);
  }

  function patchPerRun(key: keyof InstanceGuardsConfig["perRun"], value: number) {
    setDraft((prev) => prev ? { ...prev, perRun: { ...prev.perRun, [key]: value } } : prev);
    setDirty(true);
  }

  function patchBreaker(key: keyof InstanceGuardsConfig["breaker"], value: number) {
    setDraft((prev) => prev ? { ...prev, breaker: { ...prev.breaker, [key]: value } } : prev);
    setDirty(true);
  }

  function handleReset() {
    if (guardsQuery.data) {
      setDraft(guardsQuery.data);
      setDirty(false);
    }
  }

  if (guardsQuery.isLoading || !draft) {
    return <div className="text-sm text-muted-foreground">Loading guardrails settings...</div>;
  }

  if (guardsQuery.error) {
    return (
      <div className="text-sm text-destructive">
        {guardsQuery.error instanceof Error
          ? guardsQuery.error.message
          : "Failed to load guardrails settings."}
      </div>
    );
  }

  const disabled = !draft.enabled;

  return (
    <div className="max-w-2xl space-y-8">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Guardrails</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Platform-wide token budgets and anti-loop circuit breakers. Limits apply to every
          agent across all companies, regardless of individual agent configuration.
        </p>
      </div>

      {/* Master switch */}
      <div className="flex items-center justify-between rounded-md border border-border px-4 py-3">
        <div>
          <p className="text-sm font-medium">Guards enabled</p>
          <p className="text-xs text-muted-foreground">
            Master switch — disabling this turns off all automatic budget enforcement and
            circuit breakers. Use only for emergency debugging.
          </p>
        </div>
        <ToggleSwitch
          checked={draft.enabled}
          onCheckedChange={(v) => patch("enabled", v)}
        />
      </div>

      <div className="space-y-8">
        {/* Budget section */}
        <Section
          title="Monthly token budgets"
          description="Hard-stop ceilings reset each calendar month (UTC). When a scope exceeds its ceiling, the agent is paused and an incident is raised for operator review."
        >
          <div className="space-y-4">
            <NumberField
              label="Company monthly tokens"
              description={`Token ceiling per company per month. Default: ${millions(DEFAULT_GUARD_COMPANY_MONTHLY_TOKENS)}`}
              value={draft.budget.companyMonthlyTokens}
              onChange={(v) => patchBudget("companyMonthlyTokens", v)}
              min={0}
              disabled={disabled}
            />
            <NumberField
              label="Agent monthly tokens"
              description={`Token ceiling per agent per month. Default: ${millions(DEFAULT_GUARD_AGENT_MONTHLY_TOKENS)}`}
              value={draft.budget.agentMonthlyTokens}
              onChange={(v) => patchBudget("agentMonthlyTokens", v)}
              min={0}
              disabled={disabled}
            />
            <NumberField
              label="Warn threshold (%)"
              description={`Send a warning event when usage reaches this percentage of the ceiling. Default: ${DEFAULT_GUARD_WARN_PERCENT}`}
              value={draft.budget.warnPercent}
              onChange={(v) => patchBudget("warnPercent", Math.min(100, Math.max(1, v)))}
              min={1}
              disabled={disabled}
            />
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm">Hard stop on ceiling</p>
                <p className="text-xs text-muted-foreground">
                  When disabled, the ceiling raises a warning but does not pause the agent.
                </p>
              </div>
              <ToggleSwitch
                checked={draft.budget.hardStop}
                onCheckedChange={(v) => patchBudget("hardStop", v)}
                disabled={disabled}
              />
            </div>
          </div>
        </Section>

        {/* Per-run section */}
        <Section
          title="Per-run ceilings"
          description="Limits on a single agent run. The turn floor prevents agents configured with a high per-agent cap from burning unbounded turns. The token ceiling cancels a single fat run before it can exhaust the monthly budget."
        >
          <div className="space-y-4">
            <NumberField
              label="Max turns per run"
              description={`Platform floor on turns. Agents configured with more turns are clamped to this. Default: ${DEFAULT_GUARD_MAX_TURNS_PER_RUN}`}
              value={draft.perRun.maxTurnsPerRun}
              onChange={(v) => patchPerRun("maxTurnsPerRun", v)}
              min={1}
              disabled={disabled}
            />
            <NumberField
              label="Max tokens per run"
              description={`Single-run token ceiling. Run continuation is suppressed when this is exceeded. Default: ${millions(DEFAULT_GUARD_MAX_TOKENS_PER_RUN)}`}
              value={draft.perRun.maxTokensPerRun}
              onChange={(v) => patchPerRun("maxTokensPerRun", v)}
              min={0}
              disabled={disabled}
            />
          </div>
        </Section>

        {/* Breaker section */}
        <Section
          title="Anti-loop circuit breaker"
          description="Detects runaway agents and trips automatically. On trip, the agent is paused and an incident is opened — identical to a budget hard-stop, so the existing approve-to-resume flow handles recovery."
        >
          <div className="space-y-4">
            <NumberField
              label="Max runs per agent per hour"
              description={`Wake-rate ceiling. Trips when an agent runs this many times in a rolling 1-hour window. Default: ${DEFAULT_GUARD_MAX_RUNS_PER_AGENT_PER_HOUR}`}
              value={draft.breaker.maxRunsPerAgentPerHour}
              onChange={(v) => patchBreaker("maxRunsPerAgentPerHour", v)}
              min={1}
              disabled={disabled}
            />
            <NumberField
              label="Max consecutive same-issue runs"
              description={`Loop detector. Trips when an agent runs this many consecutive times on the same issue with no other work between them. Default: ${DEFAULT_GUARD_MAX_CONSECUTIVE_SAME_ISSUE_RUNS}`}
              value={draft.breaker.maxConsecutiveSameIssueRuns}
              onChange={(v) => patchBreaker("maxConsecutiveSameIssueRuns", v)}
              min={1}
              disabled={disabled}
              hint="A different-issue run or a manual wake resets the counter."
            />
          </div>
        </Section>
      </div>

      {actionError && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {actionError}
        </div>
      )}

      {dirty && (
        <div className="flex items-center gap-2 pt-2 border-t border-border">
          <Button
            size="sm"
            disabled={updateMutation.isPending}
            onClick={() => updateMutation.mutate(draft)}
          >
            {updateMutation.isPending ? "Saving..." : "Save changes"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={updateMutation.isPending}
            onClick={handleReset}
          >
            Discard
          </Button>
        </div>
      )}
    </div>
  );
}
