import type { AdapterConfigFieldsProps } from "../types";
import { Field, DraftInput } from "../../components/agent-config-primitives";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

export function HermesGatewayConfigFields({
  isCreate,
  values,
  set,
  config,
  eff,
  mark,
}: AdapterConfigFieldsProps) {
  return (
    <>
      <Field label="Gateway URL">
        <DraftInput
          value={isCreate ? values!.url : eff("adapterConfig", "url", String(config.url ?? ""))}
          onCommit={(v) =>
            isCreate ? set!({ url: v }) : mark("adapterConfig", "url", v || undefined)
          }
          immediate
          className={inputClass}
          placeholder="ws://127.0.0.1:18791/paperclip"
        />
      </Field>

      <Field label="Model override">
        <DraftInput
          value={isCreate ? values!.model : eff("adapterConfig", "model", String(config.model ?? ""))}
          onCommit={(v) =>
            isCreate ? set!({ model: v }) : mark("adapterConfig", "model", v || undefined)
          }
          immediate
          className={inputClass}
          placeholder="gpt-5.4"
        />
      </Field>

      {!isCreate && (
        <>
          <Field label="Session strategy">
            <select
              value={eff("adapterConfig", "sessionKeyStrategy", String(config.sessionKeyStrategy ?? "fixed"))}
              onChange={(e) => mark("adapterConfig", "sessionKeyStrategy", e.target.value)}
              className={inputClass}
            >
              <option value="fixed">Fixed</option>
              <option value="issue">Per issue</option>
              <option value="run">Per run</option>
            </select>
          </Field>

          <Field label="Session key">
            <DraftInput
              value={eff("adapterConfig", "sessionKey", String(config.sessionKey ?? ""))}
              onCommit={(v) => mark("adapterConfig", "sessionKey", v || undefined)}
              immediate
              className={inputClass}
              placeholder="paperclip"
            />
          </Field>

          <Field label="Paperclip API URL override">
            <DraftInput
              value={eff("adapterConfig", "paperclipApiUrl", String(config.paperclipApiUrl ?? ""))}
              onCommit={(v) => mark("adapterConfig", "paperclipApiUrl", v || undefined)}
              immediate
              className={inputClass}
              placeholder="http://localhost:3100/api"
            />
          </Field>

          <Field label="Gateway auth token">
            <DraftInput
              value={eff("adapterConfig", "gatewayAuthToken", String(config.gatewayAuthToken ?? ""))}
              onCommit={(v) => mark("adapterConfig", "gatewayAuthToken", v || undefined)}
              immediate
              className={inputClass}
              placeholder="optional bearer token"
            />
          </Field>
        </>
      )}
    </>
  );
}
