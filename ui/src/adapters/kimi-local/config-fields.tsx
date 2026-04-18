import type { AdapterConfigFieldsProps } from "../types";
import {
  Field,
  ToggleField,
  DraftInput,
  DraftNumberInput,
  help,
} from "../../components/agent-config-primitives";
import { ChoosePathButton } from "../../components/PathInstructionsModal";
import { LocalWorkspaceRuntimeFields } from "../local-workspace-runtime-fields";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

const instructionsFileHint =
  "Absolute path to a markdown file (e.g. AGENTS.md) that defines this agent's behavior. Injected into the system prompt at runtime.";

export function KimiLocalConfigFields({
  mode,
  isCreate,
  adapterType,
  values,
  set,
  config,
  eff,
  mark,
  models,
  hideInstructionsFile,
}: AdapterConfigFieldsProps) {
  // Get max turns value as a proper number
  const maxTurnsValue = isCreate
    ? (values?.maxTurnsPerRun ?? 0)
    : (config.maxStepsPerTurn as number ?? 0);

  return (
    <>
      {!hideInstructionsFile && (
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
              placeholder="/absolute/path/to/AGENTS.md"
            />
            <ChoosePathButton />
          </div>
        </Field>
      )}
      
      {/* Kimi-specific settings */}
      <ToggleField
        label="Enable thinking mode"
        hint="Enable Kimi's thinking mode for complex reasoning tasks"
        checked={
          isCreate
            ? values!.thinkingEffort === "high" || values!.thinkingEffort === "medium"
            : eff("adapterConfig", "thinking", config.thinking === true)
        }
        onChange={(v) =>
          isCreate
            ? set!({ thinkingEffort: v ? "high" : "low" })
            : mark("adapterConfig", "thinking", v)
        }
      />
      
      <Field label="Max steps per turn" hint="Maximum number of steps Kimi can take in one turn (0 = unlimited)">
        <DraftNumberInput
          value={Number(maxTurnsValue)}
          onCommit={(v) =>
            isCreate
              ? set!({ maxTurnsPerRun: v })
              : mark("adapterConfig", "maxStepsPerTurn", v || undefined)
          }
          min={0}
          className={inputClass}
        />
      </Field>
      
      <Field label="Command" hint="Kimi CLI command (default: kimi)">
        <DraftInput
          value={
            isCreate
              ? values!.command ?? ""
              : eff("adapterConfig", "command", String(config.command ?? "kimi"))
          }
          onCommit={(v) =>
            isCreate
              ? set!({ command: v })
              : mark("adapterConfig", "command", v || undefined)
          }
          immediate
          className={inputClass}
          placeholder="kimi"
        />
      </Field>
      
      <Field label="Extra arguments" hint={help.extraArgs}>
        <DraftInput
          value={
            isCreate
              ? values!.extraArgs ?? ""
              : eff("adapterConfig", "extraArgs", String(config.extraArgs ?? ""))
          }
          onCommit={(v) =>
            isCreate
              ? set!({ extraArgs: v })
              : mark("adapterConfig", "extraArgs", v || undefined)
          }
          immediate
          className={inputClass}
          placeholder="--flag value"
        />
      </Field>

      <LocalWorkspaceRuntimeFields
        isCreate={isCreate}
        values={values}
        set={set}
        config={config}
        mark={mark}
        eff={eff}
        mode={mode}
        adapterType={adapterType}
        models={models}
      />
    </>
  );
}
