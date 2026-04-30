import type { AdapterConfigFieldsProps } from "../types";
import { Field, DraftInput } from "../../components/agent-config-primitives";
import { LocalWorkspaceRuntimeFields } from "../local-workspace-runtime-fields";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

const ollamaBaseUrlHint =
  "URL of the Ollama HTTP API. Leave blank to use http://localhost:11434.";

const systemPromptHint =
  "Optional system message. When blank, defaults to the agent's Capabilities text — usually correct.";

export function OllamaLocalConfigFields({
  mode,
  isCreate,
  adapterType,
  values,
  set,
  config,
  eff,
  mark,
  models,
}: AdapterConfigFieldsProps) {
  return (
    <>
      <Field label="Ollama base URL (optional)" hint={ollamaBaseUrlHint}>
        <DraftInput
          value={
            isCreate
              ? ""
              : eff("adapterConfig", "ollamaBaseUrl", String(config.ollamaBaseUrl ?? ""))
          }
          onCommit={(v) =>
            isCreate
              ? undefined
              : mark("adapterConfig", "ollamaBaseUrl", v || undefined)
          }
          immediate
          className={inputClass}
          placeholder="http://localhost:11434"
        />
      </Field>
      <Field label="System prompt override (optional)" hint={systemPromptHint}>
        <DraftInput
          value={
            isCreate
              ? ""
              : eff("adapterConfig", "systemPrompt", String(config.systemPrompt ?? ""))
          }
          onCommit={(v) =>
            isCreate
              ? undefined
              : mark("adapterConfig", "systemPrompt", v || undefined)
          }
          immediate
          className={inputClass}
          placeholder="Defaults to the agent's Capabilities text"
        />
      </Field>
      <LocalWorkspaceRuntimeFields
        isCreate={isCreate}
        values={values}
        set={set}
        config={config}
        mark={mark}
        eff={eff}
        mode={mode}
        adapterType={adapterType}
        models={models}
      />
    </>
  );
}
