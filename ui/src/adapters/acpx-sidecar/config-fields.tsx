import type { AdapterConfigFieldsProps } from "../types";
import { Field, DraftInput } from "../../components/agent-config-primitives";
import { ChoosePathButton } from "../../components/PathInstructionsModal";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

export function AcpxSidecarConfigFields({
  isCreate,
  values,
  set,
  config,
  eff,
  mark,
}: AdapterConfigFieldsProps) {
  return (
    <>
      <Field label="Sidecar URL" hint="HTTP base URL for the external acpx sidecar service.">
        <DraftInput
          value={isCreate ? values!.url : eff("adapterConfig", "url", String(config.url ?? ""))}
          onCommit={(v) => (isCreate ? set!({ url: v }) : mark("adapterConfig", "url", v || undefined))}
          immediate
          className={inputClass}
          placeholder="http://sidecar-gemini-shared:8730"
        />
      </Field>
      <Field label="ACPX runtime" hint="Runtime name passed to acpx (for example gemini, claude, codex, openclaw).">
        <DraftInput
          value={isCreate ? values!.command : eff("adapterConfig", "agentCommand", String(config.agentCommand ?? config.command ?? ""))}
          onCommit={(v) => (isCreate ? set!({ command: v }) : mark("adapterConfig", "agentCommand", v || undefined))}
          immediate
          className={inputClass}
          placeholder="gemini"
        />
      </Field>
      <Field label="Sidecar working directory" hint="Per-agent working directory inside the sidecar container.">
        <div className="flex items-center gap-2">
          <DraftInput
            value={isCreate ? values!.cwd : eff("adapterConfig", "cwd", String(config.cwd ?? ""))}
            onCommit={(v) => (isCreate ? set!({ cwd: v }) : mark("adapterConfig", "cwd", v || undefined))}
            immediate
            className={inputClass}
            placeholder="/home/node/workspaces/agent"
          />
          <ChoosePathButton />
        </div>
      </Field>
      <Field label="Agent instructions file" hint="Absolute path to a markdown instructions file prepended to the prompt.">
        <div className="flex items-center gap-2">
          <DraftInput
            value={isCreate ? values!.instructionsFilePath ?? "" : eff("adapterConfig", "instructionsFilePath", String(config.instructionsFilePath ?? ""))}
            onCommit={(v) => (isCreate ? set!({ instructionsFilePath: v }) : mark("adapterConfig", "instructionsFilePath", v || undefined))}
            immediate
            className={inputClass}
            placeholder="/absolute/path/to/AGENTS.md"
          />
          <ChoosePathButton />
        </div>
      </Field>
    </>
  );
}
