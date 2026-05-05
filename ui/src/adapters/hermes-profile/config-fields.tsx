import type { AdapterConfigFieldsProps } from "../types";
import { Field, DraftInput } from "../../components/agent-config-primitives";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

export function HermesProfileConfigFields({ isCreate, values, set, config, eff, mark }: AdapterConfigFieldsProps) {
  return (
    <Field
      label="Profile name"
      hint="Hermes profile name for this agent (e.g. stella). Must be allowlisted in the adapter config."
    >
      <DraftInput
        value={
          isCreate
            ? (values!.command ?? "")
            : eff("adapterConfig", "profile", String(config.profile ?? ""))
        }
        onCommit={(v) =>
          isCreate ? set!({ command: v }) : mark("adapterConfig", "profile", v || undefined)
        }
        immediate
        className={inputClass}
        placeholder="stella"
      />
    </Field>
  );
}
