import { useTranslation, t } from "@/i18n";
import { configFieldsForSection } from "../config-sections";
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
  () => t("agent-config:absolutePathToAMarkdownFileEG_62d9ce4");

export function ClaudeLocalConfigFields({
  section,
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
  const { t } = useTranslation("agent-config");
  return configFieldsForSection(section, (
    <>
      {!hideInstructionsFile && (
        <Field label={t("agent-config:agentInstructionsFile_9765d14")} hint={instructionsFileHint()}>
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
  ));
}

export function ClaudeLocalAdvancedFields({
  section,
  isCreate,
  values,
  set,
  config,
  eff,
  mark,
  managedSandboxOnly,
}: AdapterConfigFieldsProps) {
  const { t } = useTranslation("agent-config");
  const rawEngine = isCreate
    ? values!.claudeEngine ?? "auto"
    : eff("adapterConfig", "engine", String(config.engine ?? "auto"));
  const engine = rawEngine === "acp" || rawEngine === "cli" ? rawEngine : "auto";
  const acpSelected = engine === "acp";

  return configFieldsForSection(section, (
    <>
      {/*
        The execution engine picks which binary runs on the execution host, and
        the ACP sub-fields below name host paths. The platform-managed
        environment owns both, so the managed-sandbox-only policy hides them,
        the same way `runnerManaged` hides them for the Paperclip Runner.
      */}
      {!managedSandboxOnly && <Field label={t("agent-config:executionEngine_1f5a0b6")} hint={t("agent-config:defaultUsesAcpIfAcpIsUnavailableThe_b2b91a8")}>
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
          <option value="auto">{t("agent-config:defaultAcp_b0e3551")}</option>
          <option value="cli">{t("agent-config:claudeCli_6c7b775")}</option>
          <option value="acp">{t("agent-config:acp_2601cb8")}</option>
        </select>
      </Field>}
      {acpSelected && (
        <>
          {!managedSandboxOnly && (
            <Field configSection="advanced"
              label={t("agent-config:acpServerCommand_d6765f6")}
              hint={t("agent-config:optionalOverrideForTheClaudeAcpServerCommand_36bc45d")}
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
          )}
          <Field configSection="runPolicy" label={t("agent-config:acpSessionMode_ceac164")} hint={t("agent-config:persistentKeepsAcpSessionStateBetweenRunsOne_360b5f3")}>
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
              <option value="persistent">{t("agent-config:persistent_9260ffc")}</option>
              <option value="oneshot">{t("agent-config:oneShot_d9d60df")}</option>
            </select>
          </Field>
          <Field
            label={t("agent-config:acpNonInteractivePermissions_99ec060")}
            hint={t("agent-config:fallbackIfTheAcpAgentAsksForInput_b707bad")}
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
              <option value="deny">{t("agent-config:deny_53577bb")}</option>
              <option value="fail">{t("agent-config:fail_2758e32")}</option>
            </select>
          </Field>
          {!managedSandboxOnly && (
            <Field
              label={t("agent-config:acpStateDirectory_a828d34")}
              hint={t("agent-config:optionalAcpSessionStateDirectoryDefaultsToPaperclip_57e9565")}
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
          )}
          <Field configSection="runPolicy"
            label={t("agent-config:acpWarmProcessIdleMs_99fe6aa")}
            hint={t("agent-config:defaultsTo0WhichClosesTheAcpProcess_5a6f61e")}
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
        label={t("agent-config:enableChrome_fcef4fb")}
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
        label={t("agent-config:skipPermissions_d11982c")}
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
      <Field label={t("agent-config:maxTurnsPerRun_720fbaf")} hint={help.maxTurnsPerRun}>
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
  ));
}
