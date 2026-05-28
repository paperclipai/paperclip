import type { AdapterConfigFieldsProps } from "../types";
import {
  DraftInput,
  Field,
} from "../../components/agent-config-primitives";
import { ChoosePathButton } from "../../components/PathInstructionsModal";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

export function GoogleAdkConfigFields({
  isCreate,
  values,
  set,
  config,
  eff,
  mark,
  hideInstructionsFile,
}: AdapterConfigFieldsProps) {
  return (
    <>
      <Field
        label="ADK agent path"
        hint="Absolute path passed to `adk run`. This can be an ADK agent folder or another agent entry path accepted by the ADK CLI."
      >
        <div className="flex items-center gap-2">
          <DraftInput
            value={
              isCreate
                ? values!.cwd ?? ""
                : eff("adapterConfig", "agentPath", String(config.agentPath ?? ""))
            }
            onCommit={(v) =>
              isCreate
                ? set!({ cwd: v })
                : mark("adapterConfig", "agentPath", v || undefined)
            }
            immediate
            className={inputClass}
            placeholder="/absolute/path/to/my_adk_agent"
          />
          <ChoosePathButton />
        </div>
      </Field>
      {!hideInstructionsFile && (
        <Field
          label="Bizbox instructions file"
          hint="Optional markdown instructions prepended to the Bizbox wake prompt before the ADK agent runs."
        >
          <div className="flex items-center gap-2">
            <DraftInput
              value={
                isCreate
                  ? values!.instructionsFilePath ?? ""
                  : eff("adapterConfig", "instructionsFilePath", String(config.instructionsFilePath ?? ""))
              }
              onCommit={(v) =>
                isCreate
                  ? set!({ instructionsFilePath: v })
                  : mark("adapterConfig", "instructionsFilePath", v || undefined)
              }
              immediate
              className={inputClass}
              placeholder="/absolute/path/to/AGENTS.md"
            />
            <ChoosePathButton />
          </div>
        </Field>
      )}
    </>
  );
}
