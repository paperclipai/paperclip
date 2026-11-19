import { Field } from "./agent-config-primitives";
import { SelectPopover } from "./ui/select";

export function ExecutionEngineField({ harness, value, onChange }: {
  harness: "claude" | "codex";
  configKey?: string;
  value: string;
  onChange: (value: "auto" | "cli" | "acp") => void;
}) {
  return <Field label="Execution engine" hint="Default uses ACP. If ACP is unavailable, the run fails with a setup error. Choose CLI explicitly to use it.">
    <SelectPopover aria-label="Execution engine" value={value} onValueChange={next => onChange(next === "cli" || next === "acp" ? next : "auto")}
      options={[
        { value: "auto", label: "Default (ACP)" },
        { value: "cli", label: harness === "claude" ? "Claude CLI" : "Codex CLI" },
        { value: "acp", label: "ACP" },
      ]} />
  </Field>;
}
