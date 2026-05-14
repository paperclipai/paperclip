import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import type { AdapterConfigFieldsProps } from "../types";
import {
  Field,
  DraftInput,
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

export function KilocodeGatewayConfigFields({
  config,
  eff,
  mark,
}: AdapterConfigFieldsProps) {
  return (
    <>
      <SecretField
        label="API Key"
        value={eff("adapterConfig", "apiKey", String(config.apiKey ?? ""))}
        onCommit={(v) => mark("adapterConfig", "apiKey", v || undefined)}
        placeholder="kilo-..."
      />

      <Field label="Model">
        <DraftInput
          value={eff("adapterConfig", "model", String(config.model ?? ""))}
          onCommit={(v) => mark("adapterConfig", "model", v || undefined)}
          immediate
          className={inputClass}
          placeholder="anthropic/claude-sonnet-4.5"
        />
      </Field>

      <Field label="Base URL">
        <DraftInput
          value={eff("adapterConfig", "baseUrl", String(config.baseUrl ?? ""))}
          onCommit={(v) => mark("adapterConfig", "baseUrl", v || undefined)}
          immediate
          className={inputClass}
          placeholder="https://api.kilo.ai/api/gateway"
        />
      </Field>

      <Field label="Temperature">
        <DraftInput
          value={eff("adapterConfig", "temperature", String(config.temperature ?? "0.7"))}
          onCommit={(v) => {
            const parsed = parseFloat(v.trim());
            mark("adapterConfig", "temperature", isFinite(parsed) ? parsed : undefined);
          }}
          immediate
          className={inputClass}
          placeholder="0.7"
        />
      </Field>

      <Field label="Max tokens">
        <DraftInput
          value={eff("adapterConfig", "maxTokens", String(config.maxTokens ?? "8192"))}
          onCommit={(v) => {
            const parsed = parseInt(v.trim(), 10);
            mark("adapterConfig", "maxTokens", isFinite(parsed) && parsed > 0 ? parsed : undefined);
          }}
          immediate
          className={inputClass}
          placeholder="8192"
        />
      </Field>

      <Field label="Timeout (seconds)">
        <DraftInput
          value={eff("adapterConfig", "timeoutSec", String(config.timeoutSec ?? "120"))}
          onCommit={(v) => {
            const parsed = parseInt(v.trim(), 10);
            mark("adapterConfig", "timeoutSec", isFinite(parsed) && parsed > 0 ? parsed : undefined);
          }}
          immediate
          className={inputClass}
          placeholder="120"
        />
      </Field>
    </>
  );
}
