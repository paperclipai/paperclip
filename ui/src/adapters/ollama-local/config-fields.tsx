import type { AdapterConfigFieldsProps } from "../types";
import { Field, DraftInput } from "../../components/agent-config-primitives";

const inputClass = "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono";

export function OllamaLocalConfigFields({ isCreate, values, set, config, eff, mark }: AdapterConfigFieldsProps) {
  return (
    <>
      <Field label="Ollama base URL" hint="Native Ollama server or OpenAI-compatible Ollama endpoint.">
        <DraftInput
          value={isCreate ? String(values?.adapterSchemaValues?.baseUrl ?? "http://127.0.0.1:11434") : eff("adapterConfig", "baseUrl", String(config.baseUrl ?? "http://127.0.0.1:11434"))}
          onCommit={(value) => isCreate ? set!({ adapterSchemaValues: { ...(values?.adapterSchemaValues ?? {}), baseUrl: value } }) : mark("adapterConfig", "baseUrl", value || undefined)}
          immediate className={inputClass} placeholder="http://127.0.0.1:11434"
        />
      </Field>
      <Field label="Model" hint="An installed Ollama model name, such as qwen3:8b.">
        <DraftInput
          value={isCreate ? values?.model ?? "" : eff("adapterConfig", "model", String(config.model ?? ""))}
          onCommit={(value) => isCreate ? set!({ model: value }) : mark("adapterConfig", "model", value || undefined)}
          immediate className={inputClass} placeholder="qwen3:8b"
        />
      </Field>
    </>
  );
}
