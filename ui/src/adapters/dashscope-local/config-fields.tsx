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
  // Get effective model value
  const effectiveModel = isCreate
    ? String(values?.model ?? "qwen3.5-plus")
    : eff("adapterConfig", "model", String(config.model ?? "qwen3.5-plus"));

  // Get effective baseUrl value (default to Coding Plan endpoint)
  const defaultBaseUrl = "https://coding.dashscope.aliyuncs.com/v1";
  const effectiveBaseUrl = isCreate
    ? String(values?.baseUrl ?? defaultBaseUrl)
    : eff("adapterConfig", "baseUrl", String(config.baseUrl ?? defaultBaseUrl));

  return (
    <>
      <Field label="Model" hint="Select a DashScope model">
        <select
          value={effectiveModel}
          onChange={(e) =>
            isCreate
              ? set!({ model: e.target.value })
              : mark("adapterConfig", "model", e.target.value || undefined)
          }
          className={inputClass}
        >
          {models && models.length > 0 ? (
            models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))
          ) : (
            <>
              <option value="qwen3.5-plus">Qwen 3.5 Plus ✨ (推荐)</option>
              <option value="qwen3-max">Qwen 3 Max ✨ (最强)</option>
              <option value="qwen-max">Qwen Max</option>
              <option value="qwen-plus">Qwen Plus</option>
              <option value="qwen-turbo">Qwen Turbo (快速)</option>
              <option value="qwen-long">Qwen Long (长文本)</option>
              <option value="qwen-vl-max">Qwen VL Max (多模态)</option>
              <option value="qwen-vl-plus">Qwen VL Plus (多模态)</option>
              <option value="qwen-coder-plus">Qwen Coder Plus (代码)</option>
              <option value="qwen-coder-turbo">Qwen Coder Turbo (代码)</option>
              <option value="qwen-math-plus">Qwen Math Plus (数学)</option>
              <option value="qwen-math-turbo">Qwen Math Turbo (数学)</option>
            </>
          )}
        </select>
      </Field>

      <Field 
        label="API Base URL" 
        hint="DashScope Coding Plan endpoint"
      >
        <DraftInput
          value={effectiveBaseUrl}
          onCommit={(v: string) =>
            isCreate
              ? set!({ baseUrl: v })
              : mark("adapterConfig", "baseUrl", v || undefined)
          }
          immediate
          className={inputClass}
          placeholder="https://coding.dashscope.aliyuncs.com/v1"
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
        <p className="font-medium mb-1">配置说明:</p>
        <ul className="list-disc list-inside space-y-1 mb-2">
          <li><strong>Base URL:</strong> <code className="bg-muted px-1 rounded">https://coding.dashscope.aliyuncs.com/v1</code></li>
          <li><strong>API Key:</strong> 使用订阅密钥 (sk-sp-xxx)</li>
        </ul>
        <p className="font-medium mt-2">推荐模型:</p>
        <ul className="list-disc list-inside space-y-1">
          <li>qwen3.5-plus ✨ (综合推荐)</li>
          <li>qwen3-max ✨ (最强性能)</li>
          <li>qwen-coder-plus (代码专用)</li>
        </ul>
      </div>
    </>
  );
}
