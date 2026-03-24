import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import type { AdapterConfigFieldsProps } from "../types";
import {
  Field,
  DraftInput,
  help,
} from "../../components/agent-config-primitives";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

export function HttpConfigFields({
  isCreate,
  values,
  set,
  config,
  eff,
  mark,
}: AdapterConfigFieldsProps) {
  const [authVisible, setAuthVisible] = useState(false);

  // Edit mode: read the stored headers object and derive the Authorization value from it,
  // mirroring the pattern used by the openclaw-gateway adapter.
  const configuredHeaders =
    config.headers && typeof config.headers === "object" && !Array.isArray(config.headers)
      ? (config.headers as Record<string, unknown>)
      : {};
  const effectiveHeaders =
    (eff("adapterConfig", "headers", configuredHeaders) as Record<string, unknown>) ?? {};
  const effectiveAuthorization =
    typeof effectiveHeaders["Authorization"] === "string" ? effectiveHeaders["Authorization"] : "";

  const commitAuthorization = (rawValue: string) => {
    const nextHeaders: Record<string, unknown> = { ...effectiveHeaders };
    if (rawValue) {
      nextHeaders["Authorization"] = rawValue;
    } else {
      delete nextHeaders["Authorization"];
    }
    mark("adapterConfig", "headers", Object.keys(nextHeaders).length > 0 ? nextHeaders : undefined);
  };

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
      <Field label="Authorization header" hint="Bearer token Paperclip will send with each heartbeat request (optional).">
        <div className="relative">
          <button
            type="button"
            onClick={() => setAuthVisible((v) => !v)}
            className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground/50 hover:text-muted-foreground transition-colors"
          >
            {authVisible ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
          </button>
          <DraftInput
            value={
              isCreate
                ? (values!.authorizationHeader ?? "")
                : effectiveAuthorization
            }
            onCommit={(v) =>
              isCreate
                ? set!({ authorizationHeader: v || undefined })
                : commitAuthorization(v)
            }
            immediate
            type={authVisible ? "text" : "password"}
            className={inputClass + " pl-8"}
            placeholder="Bearer ..."
          />
        </div>
      </Field>
      <Field label="Timeout (ms)" hint="How long Paperclip waits for a response from the webhook before marking the heartbeat as failed.">
        <DraftInput
          value={
            isCreate
              ? String(values!.timeoutMs ?? 15000)
              : eff("adapterConfig", "timeoutMs", String(config.timeoutMs ?? 15000))
          }
          onCommit={(v) => {
            const ms = parseInt(v, 10);
            const val = isNaN(ms) || ms <= 0 ? 15000 : ms;
            isCreate
              ? set!({ timeoutMs: val })
              : mark("adapterConfig", "timeoutMs", val);
          }}
          immediate
          className={inputClass}
          placeholder="15000"
        />
      </Field>
    </div>
  );
}
