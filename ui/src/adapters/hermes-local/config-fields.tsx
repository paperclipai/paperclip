import type { AdapterConfigFieldsProps } from "../types";
import {
  Field,
  DraftInput,
  help,
} from "../../components/agent-config-primitives";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

export function HermesLocalConfigFields({
  isCreate,
  values,
  set,
  config,
  eff,
  mark,
}: AdapterConfigFieldsProps) {
  return (
    <>
      <Field label="Model" hint="Model in provider/name format (e.g. anthropic/claude-sonnet-4)">
        <DraftInput
          value={
            isCreate
              ? values!.model
              : eff("adapterConfig", "model", String(config.model ?? "anthropic/claude-sonnet-4"))
          }
          onCommit={(v) =>
            isCreate
              ? set!({ model: v })
              : mark("adapterConfig", "model", v || undefined)
          }
          immediate
          className={inputClass}
          placeholder="anthropic/claude-sonnet-4"
        />
      </Field>

      <Field label="Working directory" hint={help.cwd}>
        <DraftInput
          value={
            isCreate
              ? values!.cwd
              : eff("adapterConfig", "cwd", String(config.cwd ?? ""))
          }
          onCommit={(v) =>
            isCreate
              ? set!({ cwd: v })
              : mark("adapterConfig", "cwd", v || undefined)
          }
          immediate
          className={inputClass}
          placeholder="/path/to/workspace"
        />
      </Field>

      {!isCreate && (
        <>
          <Field label="Hermes CLI path">
            <DraftInput
              value={eff("adapterConfig", "hermesCommand", String(config.hermesCommand ?? "hermes"))}
              onCommit={(v) => mark("adapterConfig", "hermesCommand", v || undefined)}
              immediate
              className={inputClass}
              placeholder="hermes"
            />
          </Field>

          <Field label="Toolsets (comma-separated)">
            <DraftInput
              value={eff("adapterConfig", "toolsets", String(config.toolsets ?? ""))}
              onCommit={(v) => mark("adapterConfig", "toolsets", v || undefined)}
              immediate
              className={inputClass}
              placeholder="terminal,file,web"
            />
          </Field>

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
        </>
      )}
    </>
  );
}
