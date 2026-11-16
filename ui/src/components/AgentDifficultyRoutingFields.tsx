import { DIFFICULTY_TIERS, type DifficultyRoutingConfig, type DifficultyTier } from "@paperclipai/shared";
import type { AdapterModel } from "../api/agents";
import { NativeSelect } from "@/components/ui/select";
import { DIFFICULTY_TIER_LABELS, setDifficultyTierSetting } from "../lib/difficulty-routing";
import { ToggleField } from "./agent-config-primitives";

export type DifficultyEffortOption = { id: string; label: string };

export const DIFFICULTY_ROUTING_HELP =
  "Before an agent's first run on a task, Paperclip rates the task's difficulty and picks the tier's model and effort. It uses the company decision model when it is on. Otherwise it uses this agent's own sign-in, such as a ChatGPT or Claude subscription, and then fixed rules. Tasks with a manual model or effort override keep it.";

export function AgentDifficultyRoutingFields({
  value,
  onChange,
  models,
  agentModel,
  effortOptionsForModel,
}: {
  value: DifficultyRoutingConfig;
  onChange: (next: DifficultyRoutingConfig) => void;
  models: AdapterModel[];
  agentModel: string;
  effortOptionsForModel: ((model: string) => ReadonlyArray<DifficultyEffortOption>) | null;
}) {
  const updateTier = (tier: DifficultyTier, patch: { model?: string; effort?: string }) =>
    onChange(setDifficultyTierSetting(value, tier, patch));

  return (
    <div className="space-y-2" data-testid="difficulty-routing-fields">
      <ToggleField
        label="Automatic model by difficulty"
        checked={value.enabled}
        onChange={(enabled) => onChange({ ...value, enabled })}
      />
      <p className="text-xs text-muted-foreground">{DIFFICULTY_ROUTING_HELP}</p>
      {value.enabled && DIFFICULTY_TIERS.map((tier) => {
        const setting = value.tiers[tier] ?? {};
        const model = setting.model ?? "";
        const effort = setting.effort ?? "";
        const effortOptions = effortOptionsForModel?.(model || agentModel) ?? null;
        const modelOptions = model && !models.some((entry) => entry.id === model)
          ? [{ id: model, label: model }, ...models]
          : models;
        const tierName = `${tier} (${DIFFICULTY_TIER_LABELS[tier]})`;
        return (
          <div key={tier} className="flex items-center gap-2">
            <span className="w-24 shrink-0 text-xs text-muted-foreground">{tierName}</span>
            <NativeSelect
              aria-label={`${tierName} model`}
              value={model}
              onChange={(event) => {
                const nextModel = event.target.value;
                const nextEfforts = effortOptionsForModel?.(nextModel || agentModel) ?? [];
                const keepEffort = !effort || nextEfforts.some((option) => option.id === effort);
                updateTier(tier, { model: nextModel, ...(keepEffort ? {} : { effort: "" }) });
              }}
            >
              <option value="">Agent default</option>
              {modelOptions.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
            </NativeSelect>
            {effortOptions && (
              <NativeSelect
                aria-label={`${tierName} effort`}
                value={effort}
                onChange={(event) => updateTier(tier, { effort: event.target.value })}
              >
                {effortOptions.map((option) => (
                  <option key={option.id} value={option.id}>{option.id ? option.label : "Agent default"}</option>
                ))}
              </NativeSelect>
            )}
          </div>
        );
      })}
    </div>
  );
}
