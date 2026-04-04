import type { AdapterConfigFieldsProps } from "../types";
import {
  Field,
  DraftInput,
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
          <li>API: https://coding.dashscope.aliyuncs.com/v1/chat/completions</li>
          <li>OpenAI-compatible format (阿里云百炼专属套餐)</li>
        </ul>
      </div>
    </>
  );
}
