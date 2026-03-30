import type { AdapterConfigFieldsProps } from "../types";
import { ClaudeLocalConfigFields } from "../claude-local/config-fields";
import {
  Field,
  DraftInput,
} from "../../components/agent-config-primitives";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

export function LocalLocalConfigFields(props: AdapterConfigFieldsProps) {
  const { isCreate, values, set, config, eff, mark } = props;

  return (
    <>
      {/* Reuse all Claude config fields (model, cwd, instructions, workspace, etc.) */}
      <ClaudeLocalConfigFields {...props} />

      {/* LM Studio specific fields */}
      <Field
        label="LM Studio Base URL"
        hint="LM Studio OpenAI-compatible API endpoint. Local models are routed here."
      >
        <DraftInput
          value={
            isCreate
              ? ""
              : eff(
                  "adapterConfig",
                  "localBaseUrl",
                  String(config.localBaseUrl ?? "http://127.0.0.1:1234/v1"),
                )
          }
          onCommit={(v) =>
            isCreate
              ? set?.({})
              : mark("adapterConfig", "localBaseUrl", v || undefined)
          }
          immediate
          className={inputClass}
          placeholder="http://127.0.0.1:1234/v1"
        />
      </Field>

      <Field
        label="Fallback Model"
        hint="Local model to use when Claude is unavailable (quota/auth). Leave empty for auto-detection."
      >
        <DraftInput
          value={
            isCreate
              ? ""
              : eff(
                  "adapterConfig",
                  "fallbackModel",
                  String(config.fallbackModel ?? ""),
                )
          }
          onCommit={(v) =>
            isCreate
              ? set?.({})
              : mark("adapterConfig", "fallbackModel", v || undefined)
          }
          immediate
          className={inputClass}
          placeholder="qwen/qwen3.5-9b"
        />
      </Field>
    </>
  );
}
