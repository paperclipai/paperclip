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
import { t } from "@/i18n";

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
        <Field label={t("app.claudeLocalConfigFields.agentInstructionsFile", { defaultValue: "Agent instructions file" })} hint={instructionsFileHint}>
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
  const rawEngine = isCreate
    ? values!.claudeEngine ?? "auto"
    : eff("adapterConfig", "engine", String(config.engine ?? "auto"));
  const engine = rawEngine === "acp" || rawEngine === "cli" ? rawEngine : "auto";
  const acpSelected = engine === "acp";

  return (
    <>
      <Field label={t("app.claudeLocalConfigFields.executionEngine", { defaultValue: "Execution engine" })} hint={t("app.claudeLocalConfigFields.autoUsesAcpWhenPrerequisitesPassAndFallsBackToClaudeCliWithDiagnostics", { defaultValue: "Auto uses ACP when prerequisites pass and falls back to Claude CLI with diagnostics." })}>
        <select
          className={inputClass}
          value={engine}
          onChange={(e) => {
            const value = e.target.value === "acp" ? "acp" : e.target.value === "cli" ? "cli" : "auto";
            isCreate
              ? set!({ claudeEngine: value })
              : mark("adapterConfig", "engine", value === "auto" ? undefined : value);
          }}
        >
          <option value="auto">Auto (ACP preferred)</option>
          <option value="cli">{ t("app.claudeLocalConfigFields.claudeCli", { defaultValue: "Claude CLI" }) }</option>
          <option value="acp">{ t("app.claudeLocalConfigFields.acp", { defaultValue: "ACP" }) }</option>
        </select>
      </Field>
      {acpSelected && (
        <>
          <Field
            label={t("app.claudeLocalConfigFields.acpServerCommand", { defaultValue: "ACP server command" })}
            hint={t("app.claudeLocalConfigFields.optionalOverrideForTheClaudeAcpServerCommandDefaultsToThePackageLocalClaudeAgentAcpBinary", { defaultValue: "Optional override for the Claude ACP server command. Defaults to the package-local claude-agent-acp binary." })}
          >
            <DraftInput
              value={
                isCreate
                  ? values!.claudeAcpAgentCommand ?? ""
                  : eff("adapterConfig", "agentCommand", String(config.agentCommand ?? ""))
              }
              onCommit={(v) =>
                isCreate
                  ? set!({ claudeAcpAgentCommand: v })
                  : mark("adapterConfig", "agentCommand", v || undefined)
              }
              immediate
              className={inputClass}
              placeholder="claude-agent-acp"
            />
          </Field>
          <Field label={t("app.claudeLocalConfigFields.acpSessionMode", { defaultValue: "ACP session mode" })} hint={t("app.claudeLocalConfigFields.persistentKeepsAcpSessionStateBetweenRunsOneShotStartsFreshEachRun", { defaultValue: "Persistent keeps ACP session state between runs. One-shot starts fresh each run." })}>
            <select
              className={inputClass}
              value={
                isCreate
                  ? values!.claudeAcpMode ?? "persistent"
                  : eff("adapterConfig", "mode", String(config.mode ?? "persistent"))
              }
              onChange={(e) => {
                const value = e.target.value === "oneshot" ? "oneshot" : "persistent";
                isCreate
                  ? set!({ claudeAcpMode: value })
                  : mark("adapterConfig", "mode", value);
              }}
            >
              <option value="persistent">{ t("app.claudeLocalConfigFields.persistent", { defaultValue: "Persistent" }) }</option>
              <option value="oneshot">{ t("app.claudeLocalConfigFields.oneShot", { defaultValue: "One-shot" }) }</option>
            </select>
          </Field>
          <Field
            label={t("app.claudeLocalConfigFields.acpNonInteractivePermissions", { defaultValue: "ACP non-interactive permissions" })}
            hint={t("app.claudeLocalConfigFields.fallbackIfTheAcpAgentAsksForInputOutsideAnInteractiveSession", { defaultValue: "Fallback if the ACP agent asks for input outside an interactive session." })}
          >
            <select
              className={inputClass}
              value={
                isCreate
                  ? values!.claudeAcpNonInteractivePermissions ?? "deny"
                  : eff("adapterConfig", "nonInteractivePermissions", String(config.nonInteractivePermissions ?? "deny"))
              }
              onChange={(e) => {
                const value = e.target.value === "fail" ? "fail" : "deny";
                isCreate
                  ? set!({ claudeAcpNonInteractivePermissions: value })
                  : mark("adapterConfig", "nonInteractivePermissions", value);
              }}
            >
              <option value="deny">{ t("app.claudeLocalConfigFields.deny", { defaultValue: "Deny" }) }</option>
              <option value="fail">{ t("app.claudeLocalConfigFields.fail", { defaultValue: "Fail" }) }</option>
            </select>
          </Field>
          <Field
            label={t("app.claudeLocalConfigFields.acpStateDirectory", { defaultValue: "ACP state directory" })}
            hint="Optional ACP session state directory. Defaults to Paperclip-managed company/agent scoped storage."
          >
            <div className="flex items-center gap-2">
              <DraftInput
                value={
                  isCreate
                    ? values!.claudeAcpStateDir ?? ""
                    : eff("adapterConfig", "stateDir", String(config.stateDir ?? ""))
                }
                onCommit={(v) =>
                  isCreate
                    ? set!({ claudeAcpStateDir: v })
                    : mark("adapterConfig", "stateDir", v || undefined)
                }
                immediate
                className={inputClass}
                placeholder="/path/to/acp-state"
              />
              <ChoosePathButton />
            </div>
          </Field>
          <Field
            label={t("app.claudeLocalConfigFields.acpWarmProcessIdleMs", { defaultValue: "ACP warm process idle ms" })}
            hint={t("app.claudeLocalConfigFields.defaultsTo0WhichClosesTheAcpProcessAfterEachRunWhileRetainingPersistentSessionState", { defaultValue: "Defaults to 0, which closes the ACP process after each run while retaining persistent session state." })}
          >
            {isCreate ? (
              <input
                type="number"
                className={inputClass}
                value={values!.claudeAcpWarmHandleIdleMs ?? 0}
                onChange={(e) => set!({ claudeAcpWarmHandleIdleMs: Number(e.target.value) })}
              />
            ) : (
              <DraftNumberInput
                value={eff(
                  "adapterConfig",
                  "warmHandleIdleMs",
                  Number(config.warmHandleIdleMs ?? 0),
                )}
                onCommit={(v) => mark("adapterConfig", "warmHandleIdleMs", v || 0)}
                immediate
                className={inputClass}
              />
            )}
          </Field>
        </>
      )}
      <ToggleField
        label={t("app.claudeLocalConfigFields.enableChrome", { defaultValue: "Enable Chrome" })}
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
        label={t("app.claudeLocalConfigFields.skipPermissions", { defaultValue: "Skip permissions" })}
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
      <Field label={t("app.claudeLocalConfigFields.maxTurnsPerRun", { defaultValue: "Max turns per run" })} hint={help.maxTurnsPerRun}>
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
    </>
  );
}
