import type { AdapterConfigFieldsProps } from "../types";
import {
  Field,
  ToggleField,
  DraftInput,
  DraftNumberInput,
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

      {/* Thinking mode toggle */}
      <ToggleField
        label="Enable thinking mode"
        hint="Enable Kimi's thinking mode for deeper reasoning"
        checked={
          isCreate
            ? (values!.adapterSchemaValues?.thinking as boolean | undefined) ?? true
            : eff("adapterConfig", "thinking", config.thinking !== false)
        }
        onChange={(v) =>
          isCreate
            ? set!({ adapterSchemaValues: { ...(values!.adapterSchemaValues ?? {}), thinking: v } })
            : mark("adapterConfig", "thinking", v)
        }
      />

      {/* Max steps per turn */}
      <Field label="Max steps per turn" hint="Maximum number of steps per turn (0 = use default)">
        {isCreate ? (
          <input
            type="number"
            min={0}
            className={inputClass}
            value={(values!.adapterSchemaValues?.maxStepsPerTurn as number | undefined) ?? ""}
            onChange={(e) => {
              const val = e.target.value;
              set!({ 
                adapterSchemaValues: { 
                  ...(values!.adapterSchemaValues ?? {}), 
                  maxStepsPerTurn: val ? Number(val) : undefined 
                } 
              });
            }}
          />
        ) : (
          <DraftNumberInput
            value={eff(
              "adapterConfig",
              "maxStepsPerTurn",
              Number(config.maxStepsPerTurn ?? 0),
            )}
            onCommit={(v) => mark("adapterConfig", "maxStepsPerTurn", v || 0)}
            immediate
            className={inputClass}
          />
        )}
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
