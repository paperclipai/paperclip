import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import type { AdapterConfigFieldsProps } from "../types";
import {
  DraftInput,
  Field,
} from "../../components/agent-config-primitives";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

function readCreateString(values: AdapterConfigFieldsProps["values"], key: string): string {
  const raw = values?.adapterSchemaValues?.[key];
  if (typeof raw === "string") return raw;
  if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
  return "";
}

function readEditString(
  eff: AdapterConfigFieldsProps["eff"],
  config: Record<string, unknown>,
  key: string,
): string {
  return eff("adapterConfig", key, String(config[key] ?? ""));
}

function writeCreateValue(
  values: AdapterConfigFieldsProps["values"],
  set: AdapterConfigFieldsProps["set"],
  key: string,
  value: unknown,
) {
  const next = { ...(values?.adapterSchemaValues ?? {}) };
  if (value === undefined || value === null || value === "") {
    delete next[key];
  } else {
    next[key] = value;
  }
  set?.({ adapterSchemaValues: next });
}

function commitPositiveNumber(
  rawValue: string,
  onCommit: (value: number | undefined) => void,
  options?: { allowZero?: boolean },
) {
  const trimmed = rawValue.trim();
  if (!trimmed) {
    onCommit(undefined);
    return;
  }

  const parsed = Number.parseFloat(trimmed);
  const isValid = Number.isFinite(parsed) && (options?.allowZero ? parsed >= 0 : parsed > 0);
  onCommit(isValid ? parsed : undefined);
}

function SecretField({
  label,
  value,
  onCommit,
  placeholder,
}: {
  label: string;
  value: string;
  onCommit: (v: string) => void;
  placeholder?: string;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <Field label={label}>
      <div className="relative">
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground/50 hover:text-muted-foreground transition-colors"
        >
          {visible ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
        </button>
        <DraftInput
          value={value}
          onCommit={onCommit}
          immediate
          type={visible ? "text" : "password"}
          className={inputClass + " pl-8"}
          placeholder={placeholder}
        />
      </div>
    </Field>
  );
}

export function CloudflareWorkersAiConfigFields({
  isCreate,
  values,
  set,
  config,
  eff,
  mark,
  hideInstructionsFile,
}: AdapterConfigFieldsProps) {
  const accountId = isCreate
    ? readCreateString(values, "accountId")
    : readEditString(eff, config, "accountId");
  const apiToken = isCreate
    ? readCreateString(values, "apiToken")
    : readEditString(eff, config, "apiToken");
  const gatewayId = isCreate
    ? readCreateString(values, "gatewayId")
    : readEditString(eff, config, "gatewayId");
  const timeoutSec = isCreate
    ? readCreateString(values, "timeoutSec")
    : readEditString(eff, config, "timeoutSec");
  const maxCompletionTokens = isCreate
    ? readCreateString(values, "maxCompletionTokens")
    : readEditString(eff, config, "maxCompletionTokens");
  const temperature = isCreate
    ? readCreateString(values, "temperature")
    : readEditString(eff, config, "temperature");

  const commitString = (key: string, value: string) => {
    if (isCreate) {
      writeCreateValue(values, set, key, value.trim() || undefined);
    } else {
      mark("adapterConfig", key, value.trim() || undefined);
    }
  };

  const commitNumber = (key: string, rawValue: string, options?: { allowZero?: boolean }) => {
    commitPositiveNumber(rawValue, (nextValue) => {
      if (isCreate) {
        writeCreateValue(values, set, key, nextValue);
      } else {
        mark("adapterConfig", key, nextValue);
      }
    }, options);
  };

  return (
    <>
      <Field label="Account ID" hint="Cloudflare account ID used for Workers AI and AI Gateway requests.">
        <DraftInput
          value={accountId}
          onCommit={(v) => commitString("accountId", v)}
          immediate
          className={inputClass}
          placeholder="your-cloudflare-account-id"
        />
      </Field>

      <SecretField
        label="API token"
        value={apiToken}
        onCommit={(v) => commitString("apiToken", v)}
        placeholder="Cloudflare API token"
      />

      <Field
        label="Gateway ID (optional)"
        hint="When set, requests route through Cloudflare AI Gateway's compat chat completions endpoint; otherwise Paperclip calls Workers AI directly."
      >
        <DraftInput
          value={gatewayId}
          onCommit={(v) => commitString("gatewayId", v)}
          immediate
          className={inputClass}
          placeholder="default"
        />
      </Field>

      {!hideInstructionsFile && (
        <Field
          label="Instructions file"
          hint="Optional path to a local markdown file prepended to the generated Cloudflare prompt."
        >
          <DraftInput
            value={isCreate ? values!.instructionsFilePath ?? "" : readEditString(eff, config, "instructionsFilePath")}
            onCommit={(v) =>
              isCreate
                ? set!({ instructionsFilePath: v })
                : mark("adapterConfig", "instructionsFilePath", v || undefined)
            }
            immediate
            className={inputClass}
            placeholder="/absolute/path/to/AGENTS.md"
          />
        </Field>
      )}

      <div className="rounded-md border border-blue-500/20 bg-blue-500/10 px-3 py-2 text-xs text-blue-100">
        Leave the model blank to use <code>@cf/qwen/qwen2.5-coder-32b-instruct</code>. Add a gateway ID to route the same request through Cloudflare AI Gateway.
      </div>

      <Field label="Timeout (sec, optional)" hint="Request timeout for the Cloudflare API call.">
        <DraftInput
          value={timeoutSec}
          onCommit={(v) => commitNumber("timeoutSec", v)}
          immediate
          className={inputClass}
          placeholder="120"
        />
      </Field>

      <Field label="Max completion tokens (optional)" hint="Optional cap for completion tokens.">
        <DraftInput
          value={maxCompletionTokens}
          onCommit={(v) => commitNumber("maxCompletionTokens", v)}
          immediate
          className={inputClass}
          placeholder="2048"
        />
      </Field>

      <Field label="Temperature (optional)" hint="Optional Cloudflare model temperature override.">
        <DraftInput
          value={temperature}
          onCommit={(v) => commitNumber("temperature", v, { allowZero: true })}
          immediate
          className={inputClass}
          placeholder="0.2"
        />
      </Field>
    </>
  );
}
