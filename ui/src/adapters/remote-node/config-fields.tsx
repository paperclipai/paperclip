import type { AdapterConfigFieldsProps } from "../types";
import {
  Field,
  DraftInput,
  DraftNumberInput,
} from "../../components/agent-config-primitives";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

export function RemoteNodeConfigFields({
  isCreate,
  values,
  set,
  config,
  eff,
  mark,
}: AdapterConfigFieldsProps) {
  return (
    <>
      <Field label="Node ID" hint="UUID of the registered remote node">
        <DraftInput
          value={
            isCreate
              ? ((values as unknown as Record<string, unknown>)?.nodeId as string) ?? ""
              : eff("adapterConfig", "nodeId", String(config.nodeId ?? ""))
          }
          onCommit={(v) =>
            isCreate
              ? set!({ ...(values as unknown as Record<string, unknown>), nodeId: v } as never)
              : mark("adapterConfig", "nodeId", v || undefined)
          }
          immediate
          className={inputClass}
          placeholder="e.g. abc-123-def-..."
        />
      </Field>

      {!isCreate && (
        <>
          <Field label="Local adapter type" hint="Adapter the remote node uses to execute (e.g. claude_local)">
            <select
              value={eff("adapterConfig", "localAdapterType", String(config.localAdapterType ?? "claude_local"))}
              onChange={(e) => mark("adapterConfig", "localAdapterType", e.target.value)}
              className={inputClass}
            >
              <option value="claude_local">Claude Code (local)</option>
              <option value="codex_local">Codex (local)</option>
              <option value="opencode_local">OpenCode (local)</option>
              <option value="pi_local">Pi (local)</option>
              <option value="cursor">Cursor (local)</option>
            </select>
          </Field>

          <Field label="Remote CWD" hint="Working directory on the remote node">
            <DraftInput
              value={eff("adapterConfig", "localAdapterConfig.cwd", String(
                (config.localAdapterConfig as Record<string, unknown>)?.cwd ?? "",
              ))}
              onCommit={(v) => {
                const existing = (config.localAdapterConfig as Record<string, unknown>) ?? {};
                mark("adapterConfig", "localAdapterConfig", { ...existing, cwd: v || undefined });
              }}
              immediate
              className={inputClass}
              placeholder="/Users/dev/project"
            />
          </Field>

          <Field label="Timeout (seconds)" hint="Max time to wait for the remote node to complete">
            <DraftNumberInput
              value={eff("adapterConfig", "timeoutSec", Number(config.timeoutSec ?? 3600))}
              onCommit={(v) => mark("adapterConfig", "timeoutSec", v > 0 ? v : undefined)}
              min={60}
              max={86400}
              className={inputClass}
            />
          </Field>
        </>
      )}
    </>
  );
}
