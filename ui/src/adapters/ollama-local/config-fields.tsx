import type { AdapterConfigFieldsProps } from "../types";
import { Field, DraftInput } from "../../components/agent-config-primitives";

const inputClass = "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono";

export function OllamaLocalConfigFields({ isCreate, values, set, config, eff, mark }: AdapterConfigFieldsProps) {
  const readValue = (key: string, fallback: unknown) =>
    isCreate ? values?.adapterSchemaValues?.[key] ?? fallback : eff("adapterConfig", key, (config[key] ?? fallback) as never);
  const writeValue = (key: string, value: unknown) => {
    if (isCreate) {
      set?.({ adapterSchemaValues: { ...(values?.adapterSchemaValues ?? {}), [key]: value } });
    } else {
      mark("adapterConfig", key, value);
    }
  };

  const apiMode = String(readValue("apiMode", "openai"));
  const configuredApiKey = config.apiKey;
  const apiKey = isCreate
    ? String(readValue("apiKey", "") ?? "")
    : typeof configuredApiKey === "string" ? String(eff("adapterConfig", "apiKey", configuredApiKey)) : "";

  return (
    <>
      <Field label="Ollama base URL" hint="Native Ollama server or OpenAI-compatible Ollama endpoint.">
        <DraftInput
          value={isCreate ? String(values?.adapterSchemaValues?.baseUrl ?? "http://127.0.0.1:11434") : eff("adapterConfig", "baseUrl", String(config.baseUrl ?? "http://127.0.0.1:11434"))}
          onCommit={(value) => isCreate ? set!({ adapterSchemaValues: { ...(values?.adapterSchemaValues ?? {}), baseUrl: value } }) : mark("adapterConfig", "baseUrl", value || undefined)}
          immediate className={inputClass} placeholder="http://127.0.0.1:11434"
        />
      </Field>
      <Field label="API mode" hint="Use OpenAI-compatible /v1/chat/completions or native Ollama /api/chat.">
        <select
          aria-label="API mode"
          value={apiMode}
          onChange={(event) => writeValue("apiMode", event.target.value)}
          className={inputClass}
        >
          <option value="openai">OpenAI-compatible</option>
          <option value="ollama">Native Ollama</option>
        </select>
      </Field>
      <Field label="API key" hint="Optional bearer token for protected OpenAI-compatible or Ollama endpoints.">
        <DraftInput
          value={apiKey}
          onCommit={(value) => writeValue("apiKey", value || undefined)}
          immediate
          type="password"
          className={inputClass}
          placeholder="Optional bearer token"
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
