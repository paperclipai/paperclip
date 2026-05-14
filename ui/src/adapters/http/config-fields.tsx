import type { AdapterConfigFieldsProps } from "../types";
import {
  Field,
  DraftInput,
  DraftNumberInput,
  DraftTextarea,
  help,
} from "../../components/agent-config-primitives";
import { normalizeHttpMethod, parseHeadersObject, parseJsonObject } from "./build-config";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

function commitJsonObject(
  rawValue: string,
  parse: (value: string) => Record<string, unknown> | undefined,
  commit: (value: Record<string, unknown> | undefined) => void,
) {
  if (!rawValue.trim()) {
    commit(undefined);
    return;
  }
  try {
    const parsed = parse(rawValue);
    if (parsed) commit(parsed);
  } catch {
    // Keep the draft text visible and do not persist invalid JSON.
  }
}

function commitHttpMethod(rawValue: string, commit: (value: string) => void) {
  try {
    commit(normalizeHttpMethod(rawValue));
  } catch {
    // Keep the draft text visible and do not persist unsupported methods.
  }
}

export function HttpConfigFields({
  isCreate,
  values,
  set,
  config,
  eff,
  mark,
}: AdapterConfigFieldsProps) {
  const editHeaders = !isCreate
    ? eff("adapterConfig", "headers", config.headers ?? {})
    : undefined;
  const editPayloadTemplate = !isCreate
    ? eff("adapterConfig", "payloadTemplate", config.payloadTemplate ?? {})
    : undefined;

  return (
    <div className="space-y-3">
      <Field label="Webhook URL" hint={help.webhookUrl}>
        <DraftInput
          value={
            isCreate
              ? values!.url
              : eff("adapterConfig", "url", String(config.url ?? ""))
          }
          onCommit={(v) =>
            isCreate
              ? set!({ url: v })
              : mark("adapterConfig", "url", v || undefined)
          }
          immediate
          className={inputClass}
          placeholder="https://..."
        />
      </Field>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Method" hint="HTTP method used when Paperclip wakes this agent.">
          <DraftInput
            value={
              isCreate
                ? values!.httpMethod ?? "POST"
                : eff("adapterConfig", "method", String(config.method ?? "POST"))
            }
            onCommit={(v) =>
              isCreate
                ? set!({ httpMethod: v || "POST" })
                : commitHttpMethod(v, (method) => mark("adapterConfig", "method", method))
            }
            immediate
            className={inputClass}
            placeholder="POST"
          />
        </Field>

        <Field label="Timeout (ms)" hint="Maximum request duration. Use up to 900000 for long-running remote agents.">
          <DraftNumberInput
            value={
              isCreate
                ? values!.httpTimeoutMs ?? 15000
                : eff("adapterConfig", "timeoutMs", Number(config.timeoutMs ?? 15000))
            }
            onCommit={(v) =>
              isCreate
                ? set!({ httpTimeoutMs: v })
                : mark("adapterConfig", "timeoutMs", v || 15000)
            }
            immediate
            min={1}
            max={900000}
            className={inputClass}
          />
        </Field>
      </div>

      <Field label="Headers JSON" hint="Optional request headers as a JSON object. Use secret references for bearer tokens.">
        <DraftTextarea
          value={
            isCreate
              ? values!.httpHeadersJson ?? ""
              : JSON.stringify(editHeaders ?? {}, null, 2)
          }
          onCommit={(v) =>
            isCreate
              ? set!({ httpHeadersJson: v })
              : commitJsonObject(v, parseHeadersObject, (parsed) =>
                  mark("adapterConfig", "headers", parsed),
                )
          }
          immediate={false}
          minRows={4}
          placeholder={'{\n  "Authorization": "Bearer ${env:BRIDGE_TOKEN}",\n  "Content-Type": "application/json"\n}'}
        />
      </Field>

      <Field label="Payload template JSON" hint={help.payloadTemplateJson}>
        <DraftTextarea
          value={
            isCreate
              ? values!.payloadTemplateJson ?? ""
              : JSON.stringify(editPayloadTemplate ?? {}, null, 2)
          }
          onCommit={(v) =>
            isCreate
              ? set!({ payloadTemplateJson: v })
              : commitJsonObject(v, (value) => parseJsonObject(value, "Payload template"), (parsed) =>
                  mark("adapterConfig", "payloadTemplate", parsed),
                )
          }
          immediate={false}
          minRows={4}
          placeholder={'{\n  "profile": "florence",\n  "timeoutSec": 420\n}'}
        />
      </Field>
    </div>
  );
}
