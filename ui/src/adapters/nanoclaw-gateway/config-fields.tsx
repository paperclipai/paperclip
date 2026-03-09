import { useState } from "react";
import type { AdapterConfigFieldsProps } from "../types";
import {
  Field,
  DraftInput,
  help,
} from "../../components/agent-config-primitives";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

const NANOCLAW_AGENTS = ["dozer", "scout", "myco", "sally"] as const;

export function NanoClawGatewayConfigFields({
  isCreate,
  values,
  set,
  config,
  eff,
  mark,
}: AdapterConfigFieldsProps) {
  const effectiveAgentName = isCreate
    ? (values?.model ?? "dozer")
    : eff("adapterConfig", "agentName", String(config.agentName ?? "dozer"));

  return (
    <>
      <Field label="NanoClaw URL" hint="HTTP base URL for NanoClaw's MCP server">
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
          placeholder="http://127.0.0.1:18790"
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
        <Field label="Timeout (ms)">
          <DraftInput
            value={eff("adapterConfig", "timeoutMs", String(config.timeoutMs ?? "30000"))}
            onCommit={(v) => {
              const parsed = Number.parseInt(v.trim(), 10);
              mark(
                "adapterConfig",
                "timeoutMs",
                Number.isFinite(parsed) && parsed > 0 ? parsed : undefined,
              );
            }}
            immediate
            className={inputClass}
            placeholder="30000"
          />
        </Field>
      )}
    </>
  );
}
