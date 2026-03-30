import type { AdapterConfigFieldsProps } from "../types";
import { ClaudeLocalConfigFields } from "../claude-local/config-fields";
import {
  Field,
  DraftInput,
} from "../../components/agent-config-primitives";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

const selectClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40 appearance-none cursor-pointer";

export function HybridLocalConfigFields(props: AdapterConfigFieldsProps) {
  const { isCreate, values, set, config, eff, mark, models } = props;

  const currentFallback = isCreate
    ? ""
    : eff("adapterConfig", "fallbackModel", String(config.fallbackModel ?? ""));

  return (
    <>
      {/* Reuse all Claude config fields (model, cwd, instructions, workspace, etc.) */}
      <ClaudeLocalConfigFields {...props} />

      <Field
        label="Local endpoint URL"
        hint="OpenAI-compatible API endpoint for local models (LM Studio, Ollama, LiteLLM, etc.)"
      >
        <DraftInput
          value={
            isCreate
              ? ""
              : eff(
                  "adapterConfig",
                  "localBaseUrl",
                  String(config.localBaseUrl ?? "http://127.0.0.1:11434/v1"),
                )
          }
          onCommit={(v) =>
            isCreate
              ? set?.({})
              : mark("adapterConfig", "localBaseUrl", v || undefined)
          }
          immediate
          className={inputClass}
          placeholder="http://127.0.0.1:11434/v1"
        />
      </Field>

      <Field
        label="Quota threshold %"
        hint="Skip Claude and use local when Claude quota exceeds this %. Default: 80. Set to 0 to disable."
      >
        <input
          type="number"
          min={0}
          max={100}
          className={inputClass}
          value={
            isCreate
              ? 80
              : eff("adapterConfig", "quotaThresholdPercent", Number(config.quotaThresholdPercent ?? 80))
          }
          onChange={(e) => {
            const v = Number(e.target.value);
            if (isCreate) {
              set?.({});
            } else {
              mark("adapterConfig", "quotaThresholdPercent", v);
            }
          }}
        />
      </Field>

      <Field
        label="Fallback model"
        hint="Model to use when the primary is unavailable. Claude → local fallback, or local → Claude fallback. Leave as 'None' to disable."
      >
        <select
          className={selectClass}
          value={currentFallback}
          onChange={(e) => {
            const v = e.target.value;
            if (isCreate) {
              set?.({});
            } else {
              mark("adapterConfig", "fallbackModel", v || undefined);
            }
          }}
        >
          <option value="">None (no fallback)</option>
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      </Field>
    </>
  );
}
