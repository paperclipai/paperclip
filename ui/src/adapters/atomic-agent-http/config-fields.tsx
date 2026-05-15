import type { AdapterConfigFieldsProps } from "../types";
import {
  Field,
  DraftInput,
  help,
} from "../../components/agent-config-primitives";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

export function AtomicAgentHttpConfigFields({
  isCreate,
  values,
  set,
  config,
  eff,
  mark,
}: AdapterConfigFieldsProps) {
  return (
    <>
      <Field
        label="API base URL"
        hint="Atomic Chat or atomic-agent serve (no /v1 suffix). Examples: http://127.0.0.1:1337 or http://127.0.0.1:8787"
      >
        <DraftInput
          value={
            isCreate
              ? values!.url
              : eff("adapterConfig", "baseUrl", String(config.baseUrl ?? ""))
          }
          onCommit={(v) =>
            isCreate
              ? set!({ url: v })
              : mark("adapterConfig", "baseUrl", v || undefined)
          }
          immediate
          className={inputClass}
          placeholder="http://127.0.0.1:1337"
        />
      </Field>
      <Field label="Model id" hint={help.model}>
        <DraftInput
          value={
            isCreate
              ? values!.model
              : eff("adapterConfig", "model", String(config.model ?? ""))
          }
          onCommit={(v) =>
            isCreate
              ? set!({ model: v })
              : mark("adapterConfig", "model", v || undefined)
          }
          immediate
          className={inputClass}
          placeholder="From GET /v1/models (optional if only one model)"
        />
      </Field>
      <Field
        label="HTTP API key"
        hint="Only if your Atomic serve endpoint requires --api-key. Stored in adapter config."
      >
        <DraftInput
          value={
            isCreate
              ? values!.atomicAgentApiKey ?? ""
              : eff("adapterConfig", "apiKey", String(config.apiKey ?? ""))
          }
          onCommit={(v) =>
            isCreate
              ? set!({ atomicAgentApiKey: v })
              : mark("adapterConfig", "apiKey", v || undefined)
          }
          immediate
          className={inputClass}
          type="password"
          placeholder="Optional Bearer token"
        />
      </Field>
    </>
  );
}
