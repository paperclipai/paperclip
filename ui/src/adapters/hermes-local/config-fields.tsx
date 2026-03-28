import type { AdapterConfigFieldsProps } from "../types";
import { Field, ToggleField, DraftInput } from "../../components/agent-config-primitives";
import { ChoosePathButton } from "../../components/PathInstructionsModal";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

const hermesCommandHint =
  "Absolute path to the hermes binary. Defaults to 'hermes' (must be in PATH). " +
  "Example: /home/user/git/hermes-agent/venv/bin/hermes";

const toolsetsHint =
  "Comma-separated list of toolsets to enable (e.g. 'terminal,file,web'). " +
  "Leave blank to use Hermes defaults. Run `hermes toolsets list` to see options.";

const persistSessionHint =
  "Resume the previous conversation session between heartbeat runs. " +
  "Gives the agent memory of past work. Recommended: enabled.";

const worktreeModeHint =
  "Run each task in an isolated git worktree. " +
  "Prevents conflicts when multiple agents work on the same repo.";

const checkpointsHint =
  "Enable filesystem checkpoints. Hermes will snapshot the working directory " +
  "before each tool call, allowing rollback on errors.";

const createModeAdvancedSettingsHint =
  "These settings use Hermes defaults when creating a new agent. " +
  "You can customize them immediately after creation from the agent settings page.";

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
      {/* Hermes binary path */}
      <Field label="Hermes command" hint={hermesCommandHint}>
        <div className="flex items-center gap-2">
          <DraftInput
            value={
              isCreate
                ? values!.command ?? ""
                : eff("adapterConfig", "hermesCommand", String(config.hermesCommand ?? ""))
            }
            onCommit={(v) =>
              isCreate
                ? set!({ command: v })
                : mark("adapterConfig", "hermesCommand", v || undefined)
            }
            immediate
            className={inputClass}
            placeholder="/path/to/venv/bin/hermes  (or just 'hermes' if in PATH)"
          />
          <ChoosePathButton />
        </div>
      </Field>

      {/* Toolsets */}
      <Field label="Toolsets" hint={toolsetsHint}>
        <DraftInput
          value={
            isCreate
              ? ""
              : eff("adapterConfig", "toolsets", String(config.toolsets ?? ""))
          }
          onCommit={(v) =>
            isCreate
              ? undefined
              : mark("adapterConfig", "toolsets", v || undefined)
          }
          immediate
          className={inputClass}
          disabled={isCreate}
          placeholder={
            isCreate
              ? "Uses Hermes defaults at create-time"
              : "terminal,file,web  (leave blank for defaults)"
          }
        />
      </Field>

      {isCreate && (
        <Field label="Advanced Hermes settings" hint={createModeAdvancedSettingsHint}>
          <p className="text-xs text-muted-foreground">
            Persist session, worktree mode, and checkpoints can be tuned after agent creation.
          </p>
        </Field>
      )}

      {!isCreate && (
        <>
          {/* Persist session */}
          <ToggleField
            label="Persist session"
            hint={persistSessionHint}
            checked={eff("adapterConfig", "persistSession", config.persistSession !== false)}
            onChange={(v) => mark("adapterConfig", "persistSession", v)}
          />

          {/* Worktree mode */}
          <ToggleField
            label="Worktree mode"
            hint={worktreeModeHint}
            checked={eff("adapterConfig", "worktreeMode", Boolean(config.worktreeMode))}
            onChange={(v) => mark("adapterConfig", "worktreeMode", v)}
          />

          {/* Checkpoints */}
          <ToggleField
            label="Checkpoints"
            hint={checkpointsHint}
            checked={eff("adapterConfig", "checkpoints", Boolean(config.checkpoints))}
            onChange={(v) => mark("adapterConfig", "checkpoints", v)}
          />
        </>
      )}
    </>
  );
}
