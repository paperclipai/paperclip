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

const NANOCLAW_AGENTS = ["dozer", "scout", "myco", "sally"] as const;

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

export function NanoClawGatewayConfigFields({
  isCreate,
  values,
  set,
  config,
  eff,
  mark,
}: AdapterConfigFieldsProps) {
  const configuredHeaders =
    config.headers && typeof config.headers === "object" && !Array.isArray(config.headers)
      ? (config.headers as Record<string, unknown>)
      : {};
  const effectiveHeaders =
    (eff("adapterConfig", "headers", configuredHeaders) as Record<string, unknown>) ?? {};

  const effectiveGatewayToken = typeof effectiveHeaders["x-openclaw-token"] === "string"
    ? String(effectiveHeaders["x-openclaw-token"])
    : typeof effectiveHeaders["x-openclaw-auth"] === "string"
      ? String(effectiveHeaders["x-openclaw-auth"])
      : "";

  const commitGatewayToken = (rawValue: string) => {
    const nextValue = rawValue.trim();
    const nextHeaders: Record<string, unknown> = { ...effectiveHeaders };
    if (nextValue) {
      nextHeaders["x-openclaw-token"] = nextValue;
      delete nextHeaders["x-openclaw-auth"];
    } else {
      delete nextHeaders["x-openclaw-token"];
      delete nextHeaders["x-openclaw-auth"];
    }
    mark("adapterConfig", "headers", Object.keys(nextHeaders).length > 0 ? nextHeaders : undefined);
  };

  const sessionStrategy = eff(
    "adapterConfig",
    "sessionKeyStrategy",
    String(config.sessionKeyStrategy ?? "issue"),
  );

  const effectiveAgentName = eff(
    "adapterConfig",
    "agentName",
    String(config.agentName ?? "dozer"),
  );

  return (
    <>
      <Field label="Gateway URL" hint={help.webhookUrl}>
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
          placeholder="ws://127.0.0.1:18789"
        />
      </Field>

      <Field label="Agent Name">
        {isCreate ? (
          <select
            value={values?.model ?? "dozer"}
            onChange={(e) => set!({ model: e.target.value })}
            className={inputClass}
          >
            {NANOCLAW_AGENTS.map((name) => (
              <option key={name} value={name}>
                {name.charAt(0).toUpperCase() + name.slice(1)}
              </option>
            ))}
            <option value="">Custom...</option>
          </select>
        ) : (
          <>
            <select
              value={NANOCLAW_AGENTS.includes(effectiveAgentName as typeof NANOCLAW_AGENTS[number]) ? effectiveAgentName : "__custom__"}
              onChange={(e) => {
                if (e.target.value === "__custom__") {
                  mark("adapterConfig", "agentName", "");
                } else {
                  mark("adapterConfig", "agentName", e.target.value);
                }
              }}
              className={inputClass}
            >
              {NANOCLAW_AGENTS.map((name) => (
                <option key={name} value={name}>
                  {name.charAt(0).toUpperCase() + name.slice(1)}
                </option>
              ))}
              <option value="__custom__">Custom...</option>
            </select>
            {!NANOCLAW_AGENTS.includes(effectiveAgentName as typeof NANOCLAW_AGENTS[number]) && (
              <DraftInput
                value={effectiveAgentName}
                onCommit={(v) => mark("adapterConfig", "agentName", v || undefined)}
                immediate
                className={inputClass + " mt-1.5"}
                placeholder="custom-agent-name"
              />
            )}
          </>
        )}
      </Field>

      {!isCreate && (
        <>
          <SecretField
            label="Gateway auth token (x-openclaw-token)"
            value={effectiveGatewayToken}
            onCommit={commitGatewayToken}
            placeholder="OpenClaw gateway token"
          />

          <Field label="Timeout (seconds)">
            <DraftInput
              value={eff("adapterConfig", "timeoutSec", String(config.timeoutSec ?? "300"))}
              onCommit={(v) => {
                const parsed = Number.parseInt(v.trim(), 10);
                mark(
                  "adapterConfig",
                  "timeoutSec",
                  Number.isFinite(parsed) && parsed > 0 ? parsed : undefined,
                );
              }}
              immediate
              className={inputClass}
              placeholder="300"
            />
          </Field>

          <Field label="Session strategy">
            <select
              value={sessionStrategy}
              onChange={(e) => mark("adapterConfig", "sessionKeyStrategy", e.target.value)}
              className={inputClass}
            >
              <option value="issue">Per issue</option>
              <option value="fixed">Fixed</option>
              <option value="run">Per run</option>
            </select>
          </Field>

          {sessionStrategy === "fixed" && (
            <Field label="Session key">
              <DraftInput
                value={eff("adapterConfig", "sessionKey", String(config.sessionKey ?? "paperclip"))}
                onCommit={(v) => mark("adapterConfig", "sessionKey", v || undefined)}
                immediate
                className={inputClass}
                placeholder="paperclip"
              />
            </Field>
          )}
        </>
      )}
    </>
  );
}
