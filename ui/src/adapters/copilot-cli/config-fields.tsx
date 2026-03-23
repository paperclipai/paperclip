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

export function CopilotCliConfigFields({
  mode,
  isCreate,
  adapterType,
  values,
  set,
  config,
  eff,
  mark,
  models,
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
            placeholder="/absolute/path/to/AGENTS.md"
          />
          <ChoosePathButton />
        </div>
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

export function CopilotCliAdvancedFields({
  isCreate,
  values,
  set,
  config,
  eff,
  mark,
}: AdapterConfigFieldsProps) {
  return (
    <>
      <ToggleField
        label="Allow all permissions"
        hint="Pass --yolo to Copilot CLI, bypassing all permission prompts"
        checked={
          isCreate
            ? values!.dangerouslySkipPermissions
            : eff(
                "adapterConfig",
                "allowAll",
                config.allowAll !== false,
              )
        }
        onChange={(v) =>
          isCreate
            ? set!({ dangerouslySkipPermissions: v })
            : mark("adapterConfig", "allowAll", v)
        }
      />
      <Field label="Max autopilot continues" hint="Maximum autonomous turns via --max-autopilot-continues">
        {isCreate ? (
          <input
            type="number"
            className={inputClass}
            value={values!.maxTurnsPerRun}
            onChange={(e) => set!({ maxTurnsPerRun: Number(e.target.value) })}
          />
        ) : (
          <DraftNumberInput
            value={eff(
              "adapterConfig",
              "maxAutopilotContinues",
              Number(config.maxAutopilotContinues ?? 100),
            )}
            onCommit={(v) => mark("adapterConfig", "maxAutopilotContinues", v || 100)}
            immediate
            className={inputClass}
          />
        )}
      </Field>
      <Field label="Allowed tools" hint="Comma-separated tool names to allow without prompting (--allow-tool)">
        <DraftInput
          value={
            isCreate
              ? values!.allowTool ?? ""
              : eff(
                  "adapterConfig",
                  "allowTool",
                  Array.isArray(config.allowTool) ? config.allowTool.join(", ") : String(config.allowTool ?? ""),
                )
          }
          onCommit={(v) => {
            if (isCreate) {
              set!({ allowTool: v });
            } else {
              const parsed = v
                .split(",")
                .map((s: string) => s.trim())
                .filter(Boolean);
              mark("adapterConfig", "allowTool", parsed.length > 0 ? parsed : undefined);
            }
          }}
          immediate
          className={inputClass}
          placeholder="e.g. bash, gh, write_file"
        />
      </Field>
      <Field label="Denied tools" hint="Comma-separated tool names to always deny (--deny-tool)">
        <DraftInput
          value={
            isCreate
              ? values!.denyTool ?? ""
              : eff(
                  "adapterConfig",
                  "denyTool",
                  Array.isArray(config.denyTool) ? config.denyTool.join(", ") : String(config.denyTool ?? ""),
                )
          }
          onCommit={(v) => {
            if (isCreate) {
              set!({ denyTool: v });
            } else {
              const parsed = v
                .split(",")
                .map((s: string) => s.trim())
                .filter(Boolean);
              mark("adapterConfig", "denyTool", parsed.length > 0 ? parsed : undefined);
            }
          }}
          immediate
          className={inputClass}
          placeholder="e.g. rm, curl"
        />
      </Field>
    </>
  );
}
