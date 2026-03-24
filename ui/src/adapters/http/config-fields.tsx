import type { AdapterConfigFieldsProps } from "../types";
import {
  Field,
  DraftInput,
  help,
} from "../../components/agent-config-primitives";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

export function HttpConfigFields({
  isCreate,
  values,
  set,
  config,
  eff,
  mark,
}: AdapterConfigFieldsProps) {
  return (
    <div className="space-y-3">
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
      <Field label="Authorization header" hint="Bearer token Paperclip will send with each heartbeat request (optional).">
        <DraftInput
          value={
            isCreate
              ? (values!.authorizationHeader ?? "")
              : eff("adapterConfig", "authorizationHeader", String(config.authorizationHeader ?? ""))
          }
          onCommit={(v) =>
            isCreate
              ? set!({ authorizationHeader: v || undefined })
              : mark("adapterConfig", "authorizationHeader", v || undefined)
          }
          immediate
          className={inputClass}
          placeholder="Bearer ..."
        />
      </Field>
      <Field label="Timeout (ms)" hint="How long Paperclip waits for a response from the webhook before marking the heartbeat as failed.">
        <DraftInput
          value={
            isCreate
              ? String(values!.timeoutMs ?? 15000)
              : eff("adapterConfig", "timeoutMs", String(config.timeoutMs ?? 15000))
          }
          onCommit={(v) => {
            const ms = parseInt(v, 10);
            const val = isNaN(ms) || ms <= 0 ? 15000 : ms;
            isCreate
              ? set!({ timeoutMs: val })
              : mark("adapterConfig", "timeoutMs", val);
          }}
          immediate
          className={inputClass}
          placeholder="15000"
        />
      </Field>
    </div>
  );
}
