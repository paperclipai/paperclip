import type { AdapterConfigFieldsProps } from "../types";
import { Field, DraftInput } from "../../components/agent-config-primitives";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

export function OpenRouterLocalConfigFields({
  isCreate,
  values,
  set,
  config,
  eff,
  mark,
}: AdapterConfigFieldsProps) {
  return (
    <>
      <Field label="API Key" hint="OpenRouter API key. Falls back to OPENROUTER_API_KEY environment variable.">
        <DraftInput
          value={
            isCreate
              ? String(values?.envVars ?? "")
              : eff("adapterConfig", "apiKey", String(config.apiKey ?? ""))
          }
          onCommit={(v) =>
            isCreate
              ? set?.({ envVars: v })
              : mark("adapterConfig", "apiKey", v || undefined)
          }
          immediate
          className={inputClass}
          placeholder="sk-or-v1-... (optional if set as env var)"
        />
      </Field>
      <Field label="System prompt" hint="Optional system message prepended to every request.">
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
          placeholder="You are a helpful assistant..."
        />
      </Field>
    </>
  );
}
