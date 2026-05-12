import type { AdapterConfigFieldsProps } from "../types";
import { Field, DraftInput } from "../../components/agent-config-primitives";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

export function PicoClawConfigFields({
  isCreate,
  values,
  set,
  config,
  eff,
  mark,
}: AdapterConfigFieldsProps) {
  return (
    <Field
      label="Working directory"
      hint="Absolute path for the picoclaw process to run in. Defaults to $HOME if left blank."
    >
      <DraftInput
        value={isCreate ? (values!.cwd ?? "") : eff("adapterConfig", "cwd", String(config.cwd ?? ""))}
        onCommit={(v) =>
          isCreate ? set!({ cwd: v || undefined }) : mark("adapterConfig", "cwd", v || undefined)
        }
        immediate
        className={inputClass}
        placeholder="/home/user (optional)"
      />
    </Field>
  );
}
