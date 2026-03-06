import type { AdapterConfigFieldsProps } from "../types";
import {
  Field,
  ToggleField,
  DraftInput,
  help,
} from "../../components/agent-config-primitives";
import { ChoosePathButton } from "../../components/PathInstructionsModal";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

const instructionsFileHint =
  "Absolute path to a markdown file (e.g. GEMINI.md) that defines this agent's behavior. Passed to Gemini CLI at runtime.";

export function GeminiLocalConfigFields({
  isCreate,
  values,
  set,
  config,
  eff,
  mark,
}: AdapterConfigFieldsProps) {
  return (
    <>
      <Field label="Agent instructions file" hint={instructionsFileHint}>
        <div className="flex items-center gap-2">
          <DraftInput
            value={
              isCreate
                ? values!.instructionsFilePath ?? ""
                : eff(
                    "adapterConfig",
                    "instructionsFilePath",
                    String(config.instructionsFilePath ?? ""),
                  )
            }
            onCommit={(v) =>
              isCreate
                ? set!({ instructionsFilePath: v })
                : mark("adapterConfig", "instructionsFilePath", v || undefined)
            }
            immediate
            className={inputClass}
            placeholder="/absolute/path/to/GEMINI.md"
          />
          <ChoosePathButton />
        </div>
      </Field>
      <ToggleField
        label="Yolo mode"
        hint="Auto-approve all tool calls without confirmation (--yolo)"
        checked={
          isCreate
            ? values!.dangerouslySkipPermissions
            : eff("adapterConfig", "yolo", config.yolo === true)
        }
        onChange={(v) =>
          isCreate
            ? set!({ dangerouslySkipPermissions: v })
            : mark("adapterConfig", "yolo", v)
        }
      />
      <ToggleField
        label="Sandbox"
        hint="Run in a Docker/Podman sandbox for isolation (--sandbox)"
        checked={
          isCreate
            ? !(values!.dangerouslyBypassSandbox ?? true)
            : eff("adapterConfig", "sandbox", config.sandbox === true)
        }
        onChange={(v) =>
          isCreate
            ? set!({ dangerouslyBypassSandbox: !v })
            : mark("adapterConfig", "sandbox", v)
        }
      />
    </>
  );
}
