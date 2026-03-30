import type { AdapterConfigFieldsProps } from "../types";
import { DraftInput, DraftTextarea, Field } from "../../components/agent-config-primitives";
import type { CreateConfigValues } from "@paperclipai/adapter-utils";
import { DEFAULT_OLLAMA_BASE_URL, DEFAULT_OLLAMA_MODEL } from "@paperclipai/adapter-ollama-local";
import { OllamaModelPicker } from "./model-picker";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

function asExt(v: CreateConfigValues | null): Record<string, unknown> {
  return (v as unknown as Record<string, unknown>) ?? {};
}

export function OllamaLocalConfigFields({
  isCreate,
  values,
  set,
  config,
  eff,
  mark,
  models,
}: AdapterConfigFieldsProps) {
  const currentModel = isCreate
    ? (values?.model ?? "")
    : eff("adapterConfig", "model", String(config.model ?? ""));

  const currentBaseUrl = isCreate
    ? (asExt(values).baseUrl as string) ?? ""
    : eff("adapterConfig", "baseUrl", String(config.baseUrl ?? ""));

  function setModel(v: string) {
    if (isCreate) {
      set!({ model: v });
    } else {
      mark("adapterConfig", "model", v || undefined);
    }
  }

  return (
    <>
      <Field
        label="Base URL"
        hint={`Ollama server URL. Defaults to ${DEFAULT_OLLAMA_BASE_URL}. Change only if Ollama is running on a non-standard port or remote host.`}
      >
        <DraftInput
          value={
            isCreate
              ? (asExt(values).baseUrl as string) ?? ""
              : eff("adapterConfig", "baseUrl", String(config.baseUrl ?? ""))
          }
          onCommit={(v) =>
            isCreate
              ? set!({ ...asExt(values), baseUrl: v } as unknown as Partial<CreateConfigValues>)
              : mark("adapterConfig", "baseUrl", v || undefined)
          }
          immediate
          className={inputClass}
          placeholder={DEFAULT_OLLAMA_BASE_URL}
        />
      </Field>
      <Field
        label="Model"
        hint={`Choose from installed models or copy the pull command for ones you want to download. Defaults to ${DEFAULT_OLLAMA_MODEL}.`}
      >
        <OllamaModelPicker
          installedModels={models}
          value={currentModel}
          onChange={setModel}
          baseUrl={currentBaseUrl || DEFAULT_OLLAMA_BASE_URL}
        />
      </Field>
      <Field
        label="System prompt"
        hint="Optional system prompt injected as the first message. Leave blank to use the default."
      >
        <DraftTextarea
          value={
            isCreate
              ? (asExt(values).system as string) ?? ""
              : eff("adapterConfig", "system", String(config.system ?? ""))
          }
          onCommit={(v) =>
            isCreate
              ? set!({ ...asExt(values), system: v } as unknown as Partial<CreateConfigValues>)
              : mark("adapterConfig", "system", v || undefined)
          }
          immediate
          placeholder="You are a helpful AI assistant..."
          minRows={3}
        />
      </Field>
    </>
  );
}
