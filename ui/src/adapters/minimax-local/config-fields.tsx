import type { AdapterConfigFieldsProps } from "../types";
import {
  DraftInput,
  DraftNumberInput,
  Field,
  ToggleField,
} from "../../components/agent-config-primitives";
import { ChoosePathButton } from "../../components/PathInstructionsModal";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";
const instructionsFileHint =
  "Absolute path to a markdown file (e.g. AGENTS.md) that defines this agent's behavior. Prepended to the MiniMax request prompt.";

function readSchemaValue<T>(
  values: AdapterConfigFieldsProps["values"],
  key: string,
  fallback: T,
): T {
  if (!values?.adapterSchemaValues || !(key in values.adapterSchemaValues)) return fallback;
  return values.adapterSchemaValues[key] as T;
}

export function MiniMaxLocalConfigFields({
  isCreate,
  values,
  set,
  config,
  eff,
  mark,
  hideInstructionsFile,
}: AdapterConfigFieldsProps) {
  const writeSchemaValue = (key: string, value: unknown) => {
    if (isCreate) {
      const current = values?.adapterSchemaValues ?? {};
      set!({ adapterSchemaValues: { ...current, [key]: value } });
      return;
    }
    mark("adapterConfig", key, value);
  };

  return (
    <>
      {!hideInstructionsFile && (
        <Field label="Agent instructions file" hint={instructionsFileHint}>
          <div className="flex items-center gap-2">
            <DraftInput
              value={
                isCreate
                  ? values!.instructionsFilePath ?? ""
                  : eff(
                      "adapterConfig",
                      "instructionsFilePath",
                      String(config.instructionsFilePath ?? ""),
                    )
              }
              onCommit={(v) =>
                isCreate
                  ? set!({ instructionsFilePath: v })
                  : mark("adapterConfig", "instructionsFilePath", v || undefined)
              }
              immediate
              className={inputClass}
              placeholder="/absolute/path/to/AGENTS.md"
            />
            <ChoosePathButton />
          </div>
        </Field>
      )}

      <Field label="Base URL" hint="MiniMax OpenAI-compatible API base URL.">
        <DraftInput
          value={
            isCreate
              ? readSchemaValue(values, "baseUrl", "https://api.minimax.io/v1")
              : eff("adapterConfig", "baseUrl", String(config.baseUrl ?? "https://api.minimax.io/v1"))
          }
          onCommit={(v) => writeSchemaValue("baseUrl", v || "https://api.minimax.io/v1")}
          immediate
          className={inputClass}
          placeholder="https://api.minimax.io/v1"
        />
      </Field>

      <Field label="Primary model" hint="Optional explicit primaryModel override. Defaults to model.">
        <DraftInput
          value={
            isCreate
              ? readSchemaValue(values, "primaryModel", String(values?.model ?? "MiniMax-M3"))
              : eff("adapterConfig", "primaryModel", String(config.primaryModel ?? config.model ?? "MiniMax-M3"))
          }
          onCommit={(v) => writeSchemaValue("primaryModel", v || undefined)}
          immediate
          className={inputClass}
          placeholder="MiniMax-M3"
        />
      </Field>

      <Field label="Temperature" hint="Sampling temperature for completions.">
        <DraftNumberInput
          value={
            isCreate
              ? readSchemaValue(values, "temperature", 0.2)
              : eff("adapterConfig", "temperature", Number(config.temperature ?? 0.2))
          }
          onCommit={(v) => writeSchemaValue("temperature", v)}
          immediate
          className={inputClass}
        />
      </Field>

      <Field label="Max completion tokens" hint="Upper bound for MiniMax completion tokens.">
        <DraftNumberInput
          value={
            isCreate
              ? readSchemaValue(values, "max_completion_tokens", 2048)
              : eff(
                  "adapterConfig",
                  "max_completion_tokens",
                  Number(config.max_completion_tokens ?? config.maxTokens ?? 2048),
                )
          }
          onCommit={(v) => writeSchemaValue("max_completion_tokens", v)}
          immediate
          className={inputClass}
        />
      </Field>

      <ToggleField
        label="Strip <think> blocks"
        hint="Remove <think>...</think> sections from the final stored output."
        checked={
          isCreate
            ? readSchemaValue(values, "stripThink", true)
            : eff("adapterConfig", "stripThink", config.stripThink !== false)
        }
        onChange={(v) => writeSchemaValue("stripThink", v)}
      />
    </>
  );
}
