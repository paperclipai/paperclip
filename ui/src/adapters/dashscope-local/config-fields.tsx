import type { AdapterConfigFieldsProps } from "../types";
import {
  Field,
  DraftInput,
} from "../../components/agent-config-primitives";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

const textareaClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40 min-h-[120px]";

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

      <Field label="Environment Variables" hint="KEY=VALUE format, one per line (e.g., DASHSCOPE_API_KEY=sk-xxx)">
        <textarea
          defaultValue={
            isCreate
              ? ""
              : (() => {
                  const env = config.env as Record<string, unknown>;
                  if (!env || typeof env !== "object") return "";
                  return Object.entries(env)
                    .filter(([_, v]) => typeof v === "object" && v !== null && "value" in v)
                    .map(([k, v]) => `${k}=${(v as { value: string }).value}`)
                    .join("\n");
                })()
          }
          onChange={(e) => {
            const text = e.target.value;
            if (isCreate) {
              set!({ envVars: text });
            } else {
              // Parse text into env object format for edit mode
              const env: Record<string, { type: "plain"; value: string }> = {};
              text.split(/\r?\n/).forEach((line) => {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith("#")) return;
                const eq = trimmed.indexOf("=");
                if (eq > 0) {
                  const key = trimmed.slice(0, eq).trim();
                  const value = trimmed.slice(eq + 1).trim();
                  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && value) {
                    env[key] = { type: "plain", value };
                  }
                }
              });
              mark("adapterConfig", "env", env);
            }
          }}
          className={textareaClass}
          placeholder="DASHSCOPE_API_KEY=sk-xxxxxxxxx"
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
          <li>Set DASHSCOPE_API_KEY in environment variables above</li>
          <li>API endpoint: https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation</li>
          <li>Uses DashScope native API format</li>
        </ul>
      </div>
    </>
  );
}
