import type { AdapterConfigFieldsProps } from "../types";
import { Field, DraftInput } from "../../components/agent-config-primitives";
import { DEFAULT_OLLAMA_ENDPOINT } from "@paperclipai/adapter-ollama-local";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

function getSchemaString(
  values: AdapterConfigFieldsProps["values"],
  key: string,
  fallback: string,
): string {
  const raw = values?.adapterSchemaValues?.[key];
  return typeof raw === "string" && raw.length > 0 ? raw : fallback;
}

export function OllamaLocalConfigFields({
  isCreate,
  values,
  set,
  config,
  eff,
  mark,
}: AdapterConfigFieldsProps) {
  const endpointHint =
    "Base URL of the local Ollama server. Defaults to http://127.0.0.1:11434.";
  return (
    <>
      <Field label="Ollama endpoint" hint={endpointHint}>
        <DraftInput
          value={
            isCreate
              ? getSchemaString(values, "endpoint", DEFAULT_OLLAMA_ENDPOINT)
              : eff(
                  "adapterConfig",
                  "endpoint",
                  String(config.endpoint ?? DEFAULT_OLLAMA_ENDPOINT),
                )
          }
          onCommit={(v) =>
            isCreate
              ? set!({
                  adapterSchemaValues: {
                    ...(values?.adapterSchemaValues ?? {}),
                    endpoint: v,
                  },
                })
              : mark("adapterConfig", "endpoint", v || DEFAULT_OLLAMA_ENDPOINT)
          }
          immediate
          className={inputClass}
          placeholder={DEFAULT_OLLAMA_ENDPOINT}
        />
      </Field>
    </>
  );
}
