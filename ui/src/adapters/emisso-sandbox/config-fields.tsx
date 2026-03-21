import type { AdapterConfigFieldsProps } from "../types";
import type { EmissoCreateConfigValues } from "./build-config";
import {
  Field,
  DraftInput,
  DraftNumberInput,
  help,
} from "../../components/agent-config-primitives";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

const textareaClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40 min-h-[80px] resize-y";

export function EmissoSandboxConfigFields({
  isCreate,
  values: rawValues,
  set: rawSet,
  config,
  eff,
  mark,
  models,
}: AdapterConfigFieldsProps) {
  const values = rawValues as EmissoCreateConfigValues | null;
  const set = rawSet as ((patch: Partial<EmissoCreateConfigValues>) => void) | null;
  return (
    <>
      <Field label="Model" hint="Claude model used inside the sandbox.">
        {isCreate ? (
          <select
            className={inputClass}
            value={values!.model ?? "claude-sonnet-4-6"}
            onChange={(e) => set!({ model: e.target.value })}
          >
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        ) : (
          <select
            className={inputClass}
            value={eff("adapterConfig", "model", String(config.model ?? "claude-sonnet-4-6"))}
            onChange={(e) => mark("adapterConfig", "model", e.target.value)}
          >
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        )}
      </Field>

      <Field label="Repo URL" hint="Git clone URL. Falls back to workspace context if not set.">
        <DraftInput
          value={
            isCreate
              ? values!.repoUrl ?? ""
              : eff("adapterConfig", "repoUrl", String(config.repoUrl ?? ""))
          }
          onCommit={(v) =>
            isCreate
              ? set!({ repoUrl: v })
              : mark("adapterConfig", "repoUrl", v || undefined)
          }
          immediate
          className={inputClass}
          placeholder="https://github.com/org/repo.git"
        />
      </Field>

      <Field label="vCPUs" hint="Number of vCPUs (1-8). Higher values cost more but run faster.">
        {isCreate ? (
          <input
            type="number"
            className={inputClass}
            value={values!.vcpus ?? 2}
            min={1}
            max={8}
            onChange={(e) => set!({ vcpus: Number(e.target.value) })}
          />
        ) : (
          <DraftNumberInput
            value={eff("adapterConfig", "vcpus", Number(config.vcpus ?? 2))}
            onCommit={(v) => mark("adapterConfig", "vcpus", v || 2)}
            immediate
            className={inputClass}
          />
        )}
      </Field>

      <Field label="Timeout (seconds)" hint={help.timeoutSec}>
        {isCreate ? (
          <input
            type="number"
            className={inputClass}
            value={values!.timeoutSec ?? 120}
            min={10}
            max={300}
            onChange={(e) => set!({ timeoutSec: Number(e.target.value) })}
          />
        ) : (
          <DraftNumberInput
            value={eff("adapterConfig", "timeoutSec", Number(config.timeoutSec ?? 120))}
            onCommit={(v) => mark("adapterConfig", "timeoutSec", v || 120)}
            immediate
            className={inputClass}
          />
        )}
      </Field>

      <Field label="Max turns per run" hint={help.maxTurnsPerRun}>
        {isCreate ? (
          <input
            type="number"
            className={inputClass}
            value={values!.maxTurns ?? 30}
            onChange={(e) => set!({ maxTurns: Number(e.target.value) })}
          />
        ) : (
          <DraftNumberInput
            value={eff("adapterConfig", "maxTurns", Number(config.maxTurns ?? 30))}
            onCommit={(v) => mark("adapterConfig", "maxTurns", v || 30)}
            immediate
            className={inputClass}
          />
        )}
      </Field>

      <Field label="Snapshot ID" hint="Pre-built sandbox snapshot for fast starts. Skips CLI installation.">
        <DraftInput
          value={
            isCreate
              ? values!.snapshotId ?? ""
              : eff("adapterConfig", "snapshotId", String(config.snapshotId ?? ""))
          }
          onCommit={(v) =>
            isCreate
              ? set!({ snapshotId: v })
              : mark("adapterConfig", "snapshotId", v || undefined)
          }
          immediate
          className={inputClass}
          placeholder="snap_..."
        />
      </Field>

      <Field label="MCP Servers (JSON)" hint="JSON object mapping server names to { command, args?, env? } or { url }.">
        {isCreate ? (
          <textarea
            className={textareaClass}
            value={values!.mcpServersJson ?? ""}
            onChange={(e) => set!({ mcpServersJson: e.target.value })}
            placeholder={'{\n  "github": {\n    "command": "mcp-server-github",\n    "args": ["--token", "$GITHUB_TOKEN"]\n  }\n}'}
          />
        ) : (
          <textarea
            className={textareaClass}
            value={eff(
              "adapterConfig",
              "mcpServersJson",
              config.mcpServers ? JSON.stringify(config.mcpServers, null, 2) : "",
            )}
            onChange={(e) => {
              mark("adapterConfig", "mcpServersJson", e.target.value);
            }}
            placeholder={'{\n  "github": {\n    "command": "mcp-server-github"\n  }\n}'}
          />
        )}
      </Field>
    </>
  );
}
