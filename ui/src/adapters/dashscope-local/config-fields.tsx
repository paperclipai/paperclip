import type { AdapterConfigFieldsProps } from "../types";
import {
  Field,
  DraftInput,
  DraftNumberInput,
  help,
} from "../../components/agent-config-primitives";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

export function DashScopeLocalConfigFields({
  isCreate,
  values,
  set,
  config,
  eff,
  mark,
  models,
}: AdapterConfigFieldsProps) {
  return (
    <>
      <Field label="Model" hint="DashScope model (e.g., qwen3.5-plus, qwen-max)">
        <DraftInput
          value={
            isCreate
              ? String(values?.model ?? "qwen3.5-plus")
              : eff("adapterConfig", "model", String(config.model ?? "qwen3.5-plus"))
          }
          onCommit={(v: string) =>
            isCreate
              ? set!({ model: v })
              : mark("adapterConfig", "model", v || undefined)
          }
          className={inputClass}
          placeholder="qwen3.5-plus"
        />
      </Field>

      <Field label="API Base URL (optional)" hint="Leave empty for standard endpoint">
        <DraftInput
          value={
            isCreate
              ? String(values?.baseUrl ?? "")
              : eff("adapterConfig", "baseUrl", String(config.baseUrl ?? ""))
          }
          onCommit={(v: string) =>
            isCreate
              ? set!({ baseUrl: v })
              : mark("adapterConfig", "baseUrl", v || undefined)
          }
          className={inputClass}
          placeholder="Leave empty for standard endpoint"
        />
      </Field>

      <Field label="Temperature" hint={help.temperature}>
        <DraftNumberInput
          value={
            isCreate
              ? values!.temperature ?? 0.7
              : eff("adapterConfig", "temperature", Number(config.temperature ?? 0.7))
          }
          onCommit={(v: number) =>
            isCreate
              ? set!({ temperature: v })
              : mark("adapterConfig", "temperature", v ?? 0.7)
          }
          min={0}
          max={2}
          step={0.1}
          className={inputClass}
        />
      </Field>

      <Field label="Top P" hint={help.topP}>
        <DraftNumberInput
          value={
            isCreate
              ? values!.topP ?? 0.8
              : eff("adapterConfig", "topP", Number(config.topP ?? 0.8))
          }
          onCommit={(v: number) =>
            isCreate
              ? set!({ topP: v })
              : mark("adapterConfig", "topP", v ?? 0.8)
          }
          min={0}
          max={1}
          step={0.05}
          className={inputClass}
        />
      </Field>

      <Field label="Max Tokens" hint={help.maxTokens}>
        <DraftNumberInput
          value={
            isCreate
              ? values!.maxTokens ?? 2048
              : eff("adapterConfig", "maxTokens", Number(config.maxTokens ?? 2048))
          }
          onCommit={(v: number) =>
            isCreate
              ? set!({ maxTokens: v })
              : mark("adapterConfig", "maxTokens", v ?? 2048)
          }
          min={1}
          className={inputClass}
        />
      </Field>

      <Field label="Timeout (sec)" hint={help.timeoutSec}>
        <DraftNumberInput
          value={
            isCreate
              ? values!.timeoutSec ?? 0
              : eff("adapterConfig", "timeoutSec", Number(config.timeoutSec ?? 0))
          }
          onCommit={(v: number) =>
            isCreate
              ? set!({ timeoutSec: v })
              : mark("adapterConfig", "timeoutSec", v ?? 0)
          }
          min={0}
          className={inputClass}
        />
      </Field>

      <Field label="Interrupt grace period (sec)" hint={help.graceSec}>
        <DraftNumberInput
          value={
            isCreate
              ? values!.graceSec ?? 15
              : eff("adapterConfig", "graceSec", Number(config.graceSec ?? 15))
          }
          onCommit={(v: number) =>
            isCreate
              ? set!({ graceSec: v })
              : mark("adapterConfig", "graceSec", v ?? 15)
          }
          min={0}
          className={inputClass}
        />
      </Field>

      <div className="rounded-md bg-muted/50 p-3 text-xs text-muted-foreground mt-4">
        <p className="font-medium mb-1">Available models:</p>
        <ul className="list-disc list-inside space-y-1 mb-2">
          <li>qwen3.5-plus ✨ (推荐)</li>
          <li>qwen3-max ✨ (最强)</li>
          <li>qwen-max</li>
          <li>qwen-plus</li>
          <li>qwen-turbo (快速)</li>
        </ul>
        <p className="font-medium mt-2">Notes:</p>
        <ul className="list-disc list-inside space-y-1">
          <li>Set DASHSCOPE_API_KEY in environment variables</li>
          <li>API endpoint: https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation</li>
          <li>Uses DashScope native API format</li>
        </ul>
      </div>
    </>
  );
}
