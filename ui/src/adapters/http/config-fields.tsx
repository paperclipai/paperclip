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

const HTTP_METHODS = ["POST", "PUT", "PATCH", "DELETE"] as const;

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
  const editEnv = !isCreate
    ? eff("adapterConfig", "env", config.env ?? {})
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
          placeholder="https://hermes-agent-umi2.srv1617039.hstgr.cloud/thomas-bridge/v1/runs"
        />
      </Field>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Method" hint={help.httpMethod ?? "HTTP method (default POST)"}>
          <select
            className={inputClass}
            value={
              isCreate
                ? values!.httpMethod ?? "POST"
                : eff("adapterConfig", "method", String(config.method ?? "POST"))
            }
            onChange={(e) =>
              isCreate
                ? set!({ httpMethod: e.target.value })
                : mark("adapterConfig", "method", normalizeHttpMethod(e.target.value))
            }
          >
            {HTTP_METHODS.map((method) => (
              <option key={method} value={method}>
                {method}
              </option>
            ))}
          </select>
        </Field>

        <Field
          label="Timeout (ms)"
          hint={help.httpTimeoutMs ?? "Maximum wait for the remote endpoint, in milliseconds. Default 15000. Use 600000 (10 min) for long-running agent bridges."}
        >
          <DraftNumberInput
            value={
              isCreate
                ? values!.httpTimeoutMs ?? 15000
                : eff("adapterConfig", "timeoutMs", Number(config.timeoutMs ?? 15000))
            }
            onCommit={(v) => {
              if (!Number.isFinite(v) || v <= 0) return;
              isCreate
                ? set!({ httpTimeoutMs: v })
                : mark("adapterConfig", "timeoutMs", v);
            }}
            immediate
            min={1}
            max={900000}
            className={inputClass}
            placeholder="600000"
          />
        </Field>
      </div>

      <Field
        label="Headers JSON"
        hint={help.httpHeadersJson ?? 'JSON object of HTTP headers. Use ${env:NAME} to reference env-binding values without persisting secrets in adapter config. Example: {"Authorization": "Bearer ${env:BRIDGE_TOKEN}"}'}
      >
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
          immediate
          minRows={4}
          placeholder={'{\n  "Authorization": "Bearer ${env:BRIDGE_TOKEN}",\n  "Content-Type": "application/json"\n}'}
        />
      </Field>

      <Field
        label="Payload template JSON"
        hint={help.httpPayloadTemplate ?? "JSON object merged into the remote request body before Paperclip adds its standard wake/context fields."}
      >
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
          immediate
          minRows={4}
          placeholder={'{\n  "profile": "thomas",\n  "timeoutSec": 420\n}'}
        />
      </Field>

      <Field
        label="Env bindings"
        hint={help.httpEnvBindings ?? "JSON object of NAME to binding values resolved by the server at execute time. Reference values in Headers JSON or Payload template JSON via ${env:NAME}."}
      >
        <DraftTextarea
          value={
            isCreate
              ? values!.envBindingsJson ?? ""
              : JSON.stringify(editEnv ?? {}, null, 2)
          }
          onCommit={(v) =>
            isCreate
              ? set!({ envBindingsJson: v })
              : commitJsonObject(v, (value) => parseJsonObject(value, "Env bindings"), (parsed) =>
                  mark("adapterConfig", "env", parsed),
                )
          }
          immediate
          minRows={4}
          placeholder={'{\n  "BRIDGE_TOKEN": { "type": "secret_ref", "secretId": "secret-id" }\n}'}
        />
      </Field>
    </div>
  );
}
