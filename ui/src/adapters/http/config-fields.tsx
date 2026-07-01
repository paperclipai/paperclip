import type { AdapterConfigFieldsProps } from "../types";
import {
  Field,
  DraftInput,
  help,
} from "../../components/agent-config-primitives";

const inputClass =
  "font-mono placeholder:text-muted-foreground/40";

export function HttpConfigFields({
  isCreate,
  values,
  set,
  config,
  eff,
  mark,
}: AdapterConfigFieldsProps) {
  return (
    <Field label="Webhook URL" hint={help.webhookUrl}>
      <DraftInput
        value={
          isCreate
            ? values!.url
            : eff("adapterConfig", "url", String(config.url ?? ""))
        }
        onCommit={(v) =>
          isCreate
            ? set!({ url: v })
            : mark("adapterConfig", "url", v || undefined)
        }
        immediate
        className={inputClass}
        placeholder="https://..."
      />
    </Field>
  );
}
