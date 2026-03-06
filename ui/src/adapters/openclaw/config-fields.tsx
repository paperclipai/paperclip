import type { AdapterConfigFieldsProps } from "../types";
import {
  Field,
  DraftInput,
  help,
} from "../../components/agent-config-primitives";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

export function OpenClawConfigFields({
  isCreate,
  values,
  set,
  config,
  eff,
  mark,
}: AdapterConfigFieldsProps) {
  return (
    <>
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
      {!isCreate && (
        <Field label="Webhook auth header (optional)">
          <DraftInput
            value={
              eff("adapterConfig", "webhookAuthHeader", String(config.webhookAuthHeader ?? ""))
            }
            onCommit={(v) => mark("adapterConfig", "webhookAuthHeader", v || undefined)}
            immediate
            className={inputClass}
            placeholder="Bearer <token>"
          />
        </Field>
      )}
    </>
  );
}
