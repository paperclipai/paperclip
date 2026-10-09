import type { AgentRunner, AgentRunnerChoice } from "@paperclipai/shared";
import { Field } from "./agent-config-primitives";
import { SelectPopover } from "./ui/select";
import { Button } from "./ui/button";

/** The override is request-level. Automatic selection is resolved by the server. */
export function CodexRunnerSelect({
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
  return (
    <Field label="Runner">
      <SelectPopover
        aria-label="Runner"
        disabled={disabled}
        value={value}
        displayValue={value === "auto" ? (defaultRunner ? `${defaultRunner === "paperclip" ? "Paperclip Runner" : "Legacy runner"} (default)` : pending ? "Checking runner availability…" : "Automatic selection unavailable") : undefined}
        onValueChange={next => onChange(next as AgentRunnerChoice)}
        options={[
          { value: "paperclip", label: `Paperclip Runner${defaultRunner === "paperclip" ? " (default)" : ""}`, disabled: !supportedRunners.includes("paperclip") && value !== "paperclip" },
          { value: "legacy", label: `Legacy runner${defaultRunner === "legacy" ? " (default)" : ""}`, disabled: !supportedRunners.includes("legacy") && value !== "legacy" },
        ]}
      />
      {error && <div className="mt-2 space-y-2">
        <p role="alert" className="text-sm text-destructive">{error}</p>
        {onRetry && <Button type="button" variant="outline" size="sm" disabled={pending || disabled} onClick={onRetry}>Retry runner discovery</Button>}
      </div>}
    </Field>
  );
}
