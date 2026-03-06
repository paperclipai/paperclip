import type { AdapterConfigFieldsProps } from "../types";
import {
  Field,
  DraftInput,
} from "../../components/agent-config-primitives";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

export function OpenClawConfigFields({
  isCreate,
  values,
  set,
  config,
  eff,
  mark,
}: AdapterConfigFieldsProps) {
  return (
    <>
      <Field label="Gateway URL" hint="WebSocket URL of the OpenClaw gateway.">
        <DraftInput
          value={
            isCreate
              ? (values as any).gatewayUrl ?? "ws://127.0.0.1:5555"
              : eff("adapterConfig", "gatewayUrl", String(config.gatewayUrl ?? "ws://127.0.0.1:5555"))
          }
          onCommit={(v) =>
            isCreate
              ? set!({ gatewayUrl: v } as any)
              : mark("adapterConfig", "gatewayUrl", v || undefined)
          }
          immediate
          className={inputClass}
          placeholder="ws://127.0.0.1:5555"
        />
      </Field>
      <Field label="Agent ID" hint="Identifier for the agent on the OpenClaw gateway.">
        <DraftInput
          value={
            isCreate
              ? (values as any).agentId ?? ""
              : eff("adapterConfig", "agentId", String(config.agentId ?? ""))
          }
          onCommit={(v) =>
            isCreate
              ? set!({ agentId: v } as any)
              : mark("adapterConfig", "agentId", v || undefined)
          }
          immediate
          className={inputClass}
          placeholder="main"
        />
      </Field>
      <Field label="Auth Token (optional)" hint="Bearer token for authenticating with the gateway.">
        <DraftInput
          type="password"
          value={
            isCreate
              ? (values as any).authToken ?? ""
              : eff("adapterConfig", "authToken", String(config.authToken ?? ""))
          }
          onCommit={(v) =>
            isCreate
              ? set!({ authToken: v } as any)
              : mark("adapterConfig", "authToken", v || undefined)
          }
          immediate
          className={inputClass}
          placeholder="Bearer token or leave empty"
        />
      </Field>
    </>
  );
}
