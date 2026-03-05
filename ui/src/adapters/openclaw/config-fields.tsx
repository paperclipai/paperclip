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
  const transport = eff(
    "adapterConfig",
    "streamTransport",
    String(config.streamTransport ?? "sse"),
  );
  const sessionStrategy = eff(
    "adapterConfig",
    "sessionKeyStrategy",
    String(config.sessionKeyStrategy ?? "fixed"),
  );

  return (
    <>
      <Field label="Gateway URL" hint={help.webhookUrl}>
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
        <>
          <Field label="Transport">
            <select
              value={transport}
              onChange={(e) => mark("adapterConfig", "streamTransport", e.target.value)}
              className={inputClass}
            >
              <option value="sse">SSE (recommended)</option>
              <option value="webhook">Webhook</option>
            </select>
          </Field>

          <Field label="Session strategy">
            <select
              value={sessionStrategy}
              onChange={(e) => mark("adapterConfig", "sessionKeyStrategy", e.target.value)}
              className={inputClass}
            >
              <option value="fixed">Fixed</option>
              <option value="issue">Per issue</option>
              <option value="run">Per run</option>
            </select>
          </Field>

          {sessionStrategy === "fixed" && (
            <Field label="Session key">
              <DraftInput
                value={eff("adapterConfig", "sessionKey", String(config.sessionKey ?? "paperclip"))}
                onCommit={(v) => mark("adapterConfig", "sessionKey", v || undefined)}
                immediate
                className={inputClass}
                placeholder="paperclip"
              />
            </Field>
          )}

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
        </>
      )}
    </>
  );
}
