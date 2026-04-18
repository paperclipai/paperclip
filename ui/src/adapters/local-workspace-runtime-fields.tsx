import type { AdapterConfigFieldsProps } from "./types";
import { Field, DraftInput } from "../components/agent-config-primitives";
import { ChoosePathButton } from "../components/PathInstructionsModal";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

export function LocalWorkspaceRuntimeFields({
  isCreate,
  values,
  set,
  config,
  eff,
  mark,
}: AdapterConfigFieldsProps) {
  return (
    <Field
      label="Working directory"
      hint="Absolute path to the directory where the agent runs commands. Defaults to the project workspace if not set."
    >
      <div className="flex items-center gap-2">
        <DraftInput
          value={
            isCreate
              ? values!.cwd ?? ""
              : eff("adapterConfig", "cwd", String(config.cwd ?? ""))
          }
          onCommit={(v) =>
            isCreate
              ? set!({ cwd: v })
              : mark("adapterConfig", "cwd", v || undefined)
          }
          immediate
          className={inputClass}
          placeholder="/absolute/path/to/project"
        />
        <ChoosePathButton />
      </div>
    </Field>
  );
}
