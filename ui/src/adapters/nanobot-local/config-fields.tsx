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
          {visible ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
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

export function NanobotLocalConfigFields({
  isCreate,
  values,
  set,
  config,
  eff,
  mark,
}: AdapterConfigFieldsProps) {
  return (
    <>
      <Field label="Nanobot URL" hint={help.webhookUrl}>
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
          placeholder="http://localhost:9800"
        />
      </Field>

      <SecretField
        label="API Key"
        value={
          isCreate
            ? String((values!.envBindings as Record<string, unknown>)?.nanobotApiKey ?? "")
            : eff("adapterConfig", "apiKey", String(config.apiKey ?? ""))
        }
        onCommit={(v) => {
          const trimmed = v.trim();
          if (isCreate) {
            set!({ envBindings: { ...((values!.envBindings as Record<string, unknown>) ?? {}), nanobotApiKey: trimmed || undefined } });
          } else {
            mark("adapterConfig", "apiKey", trimmed || undefined);
          }
        }}
        placeholder="Bearer token for Paperclip channel"
      />

      <Field label="Timeout (seconds)">
        <DraftInput
          value={
            isCreate
              ? String((values!.envBindings as Record<string, unknown>)?.nanobotTimeoutSec ?? "300")
              : eff("adapterConfig", "timeoutSec", String(config.timeoutSec ?? "300"))
          }
          onCommit={(v) => {
            const parsed = Number.parseInt(v.trim(), 10);
            if (isCreate) {
              set!({ envBindings: { ...((values!.envBindings as Record<string, unknown>) ?? {}), nanobotTimeoutSec: Number.isFinite(parsed) && parsed > 0 ? parsed : undefined } });
            } else {
              mark(
                "adapterConfig",
                "timeoutSec",
                Number.isFinite(parsed) && parsed > 0 ? parsed : undefined,
              );
            }
          }}
          immediate
          className={inputClass}
          placeholder="300"
        />
      </Field>
    </>
  );
}
