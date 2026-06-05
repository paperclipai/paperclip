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

export function ClaudeLocalConfigFields({
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

export function ClaudeLocalAdvancedFields({
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
        label="Enable Chrome"
        hint={help.chrome}
        checked={
          isCreate
            ? values!.chrome
            : eff("adapterConfig", "chrome", config.chrome === true)
        }
        onChange={(v) =>
          isCreate
            ? set!({ chrome: v })
            : mark("adapterConfig", "chrome", v)
        }
      />
      <ToggleField
        label="Skip permissions"
        hint={help.dangerouslySkipPermissions}
        checked={
          isCreate
            ? values!.dangerouslySkipPermissions
            : eff(
                "adapterConfig",
                "dangerouslySkipPermissions",
                config.dangerouslySkipPermissions !== false,
              )
        }
        onChange={(v) =>
          isCreate
            ? set!({ dangerouslySkipPermissions: v })
            : mark("adapterConfig", "dangerouslySkipPermissions", v)
        }
      />
      <Field label="Max turns per run" hint={help.maxTurnsPerRun}>
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
              "maxTurnsPerRun",
              Number(config.maxTurnsPerRun ?? 1000),
            )}
            onCommit={(v) => mark("adapterConfig", "maxTurnsPerRun", v || 1000)}
            immediate
            className={inputClass}
          />
        )}
      </Field>
      {!isCreate && (
        <>
          <Field label="Session refresh policy" hint={help.sessionRefreshPolicy}>
            <select
              className={inputClass}
              value={
                typeof eff("adapterConfig", "sessionRefreshPolicy", config.sessionRefreshPolicy) ===
                "string"
                  ? (eff("adapterConfig", "sessionRefreshPolicy", config.sessionRefreshPolicy) as string)
                  : "none"
              }
              onChange={(e) => {
                const v = e.target.value;
                if (v === "none") {
                  mark("adapterConfig", "sessionRefreshPolicy", undefined);
                  mark("adapterConfig", "sessionInactivityTtlSec", undefined);
                  mark("adapterConfig", "sessionDailyRefreshHour", undefined);
                } else {
                  mark("adapterConfig", "sessionRefreshPolicy", v);
                }
              }}
            >
              <option value="none">None (resume until max turns / error)</option>
              <option value="per_run">Every run (fresh session)</option>
              <option value="inactivity">After idle (TTL)</option>
              <option value="daily">Daily (UTC window)</option>
            </select>
          </Field>
          {eff("adapterConfig", "sessionRefreshPolicy", config.sessionRefreshPolicy) ===
            "inactivity" && (
            <Field label="Idle TTL (seconds)" hint={help.sessionInactivityTtlSec}>
              <DraftNumberInput
                value={eff(
                  "adapterConfig",
                  "sessionInactivityTtlSec",
                  Number(config.sessionInactivityTtlSec ?? 1800),
                )}
                onCommit={(v) =>
                  mark("adapterConfig", "sessionInactivityTtlSec", v > 0 ? v : 1800)
                }
                immediate
                className={inputClass}
              />
            </Field>
          )}
          {eff("adapterConfig", "sessionRefreshPolicy", config.sessionRefreshPolicy) === "daily" && (
            <Field label="UTC day boundary hour" hint={help.sessionDailyRefreshHour}>
              <DraftNumberInput
                value={eff(
                  "adapterConfig",
                  "sessionDailyRefreshHour",
                  Number(config.sessionDailyRefreshHour ?? 0),
                )}
                onCommit={(v) =>
                  mark(
                    "adapterConfig",
                    "sessionDailyRefreshHour",
                    Math.min(23, Math.max(0, Math.floor(v))),
                  )
                }
                immediate
                className={inputClass}
              />
            </Field>
          )}
        </>
      )}
    </>
  );
}
