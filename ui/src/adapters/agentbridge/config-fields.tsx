import { configFieldsForSection } from "../config-sections";
import type { AdapterConfigFieldsProps } from "../types";
import { Field, DraftInput } from "../../components/agent-config-primitives";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

export function AgentBridgeConfigFields({
  section,
  isCreate,
  values,
  set,
  config,
  eff,
  mark,
}: AdapterConfigFieldsProps) {
  return configFieldsForSection(section, (
    <>
      <Field
        label="AgentBridge URL"
        hint="Base address of the AgentBridge server. Loopback and private origins must be listed in PAPERCLIP_HTTP_ADAPTER_PRIVATE_ENDPOINT_ALLOWLIST."
      >
        <DraftInput
          value={
            isCreate
              ? values!.url
              : eff("adapterConfig", "url", String(config.url ?? "http://localhost:5290"))
          }
          onCommit={(v) =>
            isCreate ? set!({ url: v }) : mark("adapterConfig", "url", v || undefined)
          }
          immediate
          className={inputClass}
          placeholder="http://localhost:5290"
        />
      </Field>

      <Field label="Agent set" hint="AgentBridge agent set (see GET /v1/models).">
        <DraftInput
          value={
            isCreate
              ? values!.model
              : eff("adapterConfig", "model", String(config.model ?? "default-agent"))
          }
          onCommit={(v) =>
            isCreate ? set!({ model: v }) : mark("adapterConfig", "model", v || undefined)
          }
          immediate
          className={inputClass}
          placeholder="default-agent"
        />
      </Field>

      {!isCreate && (
        <>
          <Field label="LLM provider" hint="Optional AgentBridge LLM provider override.">
            <DraftInput
              value={eff("adapterConfig", "llmProvider", String(config.llmProvider ?? ""))}
              onCommit={(v) => mark("adapterConfig", "llmProvider", v || undefined)}
              immediate
              className={inputClass}
              placeholder="Zai"
            />
          </Field>

          <Field label="API key" hint="Optional bearer token for the Authorization header.">
            <DraftInput
              value={eff("adapterConfig", "apiKey", String(config.apiKey ?? ""))}
              onCommit={(v) => mark("adapterConfig", "apiKey", v || undefined)}
              immediate
              className={inputClass}
              placeholder=""
            />
          </Field>

          <Field configSection="runPolicy" label="Request timeout (ms)">
            <DraftInput
              value={eff("adapterConfig", "timeoutMs", String(config.timeoutMs ?? ""))}
              onCommit={(v) => {
                const parsed = Number.parseInt(v.trim(), 10);
                mark("adapterConfig", "timeoutMs", Number.isFinite(parsed) && parsed > 0 ? parsed : undefined);
              }}
              immediate
              className={inputClass}
              placeholder="0"
            />
          </Field>
        </>
      )}
    </>
  ));
}
