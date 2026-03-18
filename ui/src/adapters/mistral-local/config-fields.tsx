import type { AdapterConfigFieldsProps } from "../types";
import { Field, DraftInput } from "../../components/agent-config-primitives";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

export function MistralLocalConfigFields({
  isCreate,
  values,
  set,
  config,
  eff,
  mark,
}: AdapterConfigFieldsProps) {
  return (
    <Field label="MISTRAL_API_KEY" hint="Your Mistral API key. Can also be set via the env config block below.">
      <DraftInput
        value={
          isCreate
            ? values!.envVars ?? ""
            : eff("adapterConfig", "envVars", String(config.envVars ?? ""))
        }
        onCommit={(v) =>
          isCreate
            ? set!({ envVars: v })
            : mark("adapterConfig", "envVars", v || undefined)
        }
        immediate
        className={inputClass}
        placeholder="MISTRAL_API_KEY=sk-..."
      />
    </Field>
  );
}
