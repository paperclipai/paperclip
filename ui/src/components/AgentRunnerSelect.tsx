import { t, useTranslation } from "@/i18n";
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
  useTranslation();
  return (
    <Field label={t("oct19Core.coverage026")}>
      <SelectPopover
        aria-label={t("oct19Core.coverage026")}
        disabled={disabled}
        value={value}
        displayValue={value === "auto" ? (defaultRunner ? t("oct19Core.runnerDefault", { runner: defaultRunner === "paperclip" ? "Paperclip Runner" : t("oct19Core.coverage027") }) : pending ? t("oct19Core.coverage028") : t("oct19Core.coverage029")) : undefined}
        onValueChange={next => onChange(next as AgentRunnerChoice)}
        options={[
          { value: "paperclip", label: defaultRunner === "paperclip" ? t("oct19Core.runnerDefault", { runner: "Paperclip Runner" }) : "Paperclip Runner", disabled: !supportedRunners.includes("paperclip") && value !== "paperclip" },
          { value: "legacy", label: defaultRunner === "legacy" ? t("oct19Core.runnerDefault", { runner: t("oct19Core.coverage027") }) : t("oct19Core.coverage027"), disabled: !supportedRunners.includes("legacy") && value !== "legacy" },
        ]}
      />
      {error && <div className="mt-2 space-y-2">
        <p role="alert" className="text-sm text-destructive">{error}</p>
        {onRetry && <Button type="button" variant="outline" size="sm" disabled={pending || disabled} onClick={onRetry}>{t("oct19Core.coverage030")}</Button>}
      </div>}
    </Field>
  );
}
