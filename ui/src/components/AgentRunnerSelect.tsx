import { useTranslation } from "@/i18n";
import type { AgentRunner, AgentRunnerChoice } from "@paperclipai/shared";
import { Field } from "./agent-config-primitives";
import { SelectPopover } from "./ui/select";
import { Button } from "./ui/button";

export function AgentRunnerSelect({
  value,
  onChange,
  defaultRunner,
  supportedRunners = ["legacy"],
  disabled,
  pending,
  error,
  onRetry,
}: {
  value: AgentRunnerChoice;
  onChange: (value: AgentRunnerChoice) => void;
  defaultRunner?: AgentRunner;
  supportedRunners?: readonly AgentRunner[];
  disabled?: boolean;
  pending?: boolean;
  error?: string;
  onRetry?: () => void;
}) {
  const { t } = useTranslation("agent-config");
  return (
    <Field label={t("agent-config:runner_ae2e3ae")}>
      <SelectPopover
        aria-label={t("agent-config:runner_ae2e3ae")}
        disabled={disabled}
        value={value}
        displayValue={value === "auto" ? (defaultRunner ? t("defaultRunnerLabel", { runner: defaultRunner === "paperclip" ? t("paperclipRunner_f50f4c1") : t("legacyRunner_c9e0bac") }) : pending ? t("checkingRunnerAvailability_df17697") : t("automaticSelectionUnavailable_25866ca")) : undefined}
        onValueChange={next => onChange(next as AgentRunnerChoice)}
        options={[
          { value: "paperclip", label: defaultRunner === "paperclip" ? t("defaultRunnerLabel", { runner: t("paperclipRunner_f50f4c1") }) : t("paperclipRunner_f50f4c1"), disabled: !supportedRunners.includes("paperclip") && value !== "paperclip" },
          { value: "legacy", label: defaultRunner === "legacy" ? t("defaultRunnerLabel", { runner: t("legacyRunner_c9e0bac") }) : t("legacyRunner_c9e0bac"), disabled: !supportedRunners.includes("legacy") && value !== "legacy" },
        ]}
      />
      {error && <div className="mt-2 space-y-2">
        <p role="alert" className="text-sm text-destructive">{error}</p>
        {onRetry && <Button type="button" variant="outline" size="sm" disabled={pending || disabled} onClick={onRetry}>{t("agent-config:retryRunnerDiscovery_4e4cd53")}</Button>}
      </div>}
    </Field>
  );
}
