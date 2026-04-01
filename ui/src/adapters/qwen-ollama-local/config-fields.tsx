import type { AdapterConfigFieldsProps } from "../types";
import {
  Field,
  DraftInput,
} from "../../components/agent-config-primitives";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

const selectClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm placeholder:text-muted-foreground/40";

export function QwenOllamaConfigFields({
  isCreate,
  values,
  set,
  config,
  eff,
  mark,
}: AdapterConfigFieldsProps) {
  const ollamaUrl = isCreate
    ? (values as any)?.ollama_url ?? "http://localhost:11434"
    : eff("adapterConfig", "ollama_url", String(config.ollama_url ?? "http://localhost:11434"));

  const model = isCreate
    ? (values as any)?.model ?? "qwen3.5"
    : eff("adapterConfig", "model", String(config.model ?? "qwen3.5"));

  return (
    <>
      <Field
        label="Ollama URL"
        hint="The URL where Ollama is running (usually http://localhost:11434)"
      >
        <DraftInput
          value={ollamaUrl}
          onCommit={(v) =>
            isCreate
              ? set?.({ ollama_url: v } as any)
              : mark("adapterConfig", "ollama_url", v || "http://localhost:11434")
          }
          className={inputClass}
          placeholder="http://localhost:11434"
        />
      </Field>

      <Field
        label="Model"
        hint="The Ollama model to use for code generation"
      >
        <select
          value={model}
          onChange={(e) => {
            const newValue = (e.target as HTMLSelectElement).value;
            if (isCreate) {
              set?.({ model: newValue } as any);
            } else {
              mark("adapterConfig", "model", newValue);
            }
          }}
          className={selectClass}
        >
          <option value="qwen3.5">Qwen 3.5</option>
          <option value="qwen2.5">Qwen 2.5</option>
          <option value="qwen1.5">Qwen 1.5</option>
        </select>
      </Field>
    </>
  );
}

