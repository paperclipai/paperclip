import { t, useTranslation } from "@/i18n";
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
import {
  DEFAULT_CODEX_LOCAL_MODEL,
  CODEX_LOCAL_FAST_MODE_SUPPORTED_MODELS,
  isCodexLocalFastModeSupported,
  isCodexLocalManualModel,
} from "@paperclipai/adapter-codex-local";
import {
  PAPERCLIP_RUNNER_IDLE_TIMEOUT_DEFAULT_MS,
  PAPERCLIP_RUNNER_IDLE_TIMEOUT_MAX_MS,
  PAPERCLIP_RUNNER_PERMISSION_CAPABILITIES,
  isPaperclipRunnerProvider,
  resolvePaperclipRunnerIdleTimeoutMs,
  resolvePaperclipRunnerPermissionMode,
  type PaperclipRunnerPermissionMode,
  type PaperclipRunnerProvider,
} from "@paperclipai/adapter-utils";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";
const instructionsFileHint = () => t("localizationAgents.codexInstructionsHint");
const defaultOpenCodeRunnerModel = "openrouter/deepseek/deepseek-v4-flash-0731";
const acpxRunnerModels = {
  claude: "claude-sonnet-5",
  codex: "gpt-5.6-sol",
} as const;
const defaultClaudeManagedModel = "claude-sonnet-5";
const defaultAwsAgentCoreModel = "global.anthropic.claude-sonnet-4-6";

export function CodexLocalConfigFields({
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
  managedSandboxOnly,
}: AdapterConfigFieldsProps) {
  const { t } = useTranslation();
  const runnerManaged = adapterType === "paperclip_runner";
  // The execution engine picks which binary runs on the execution host, and the
  // ACP sub-fields below name host paths. The platform-managed environment owns
  // both, so the managed-sandbox-only policy hides them the same way
  // `runnerManaged` already does for the Paperclip Runner.
  const hideEngineChoice = runnerManaged || managedSandboxOnly === true;
  const configuredRunnerProvider = runnerManaged
    ? isCreate
      ? values!.adapterSchemaValues?.provider
      : eff("adapterConfig", "provider", config.provider ?? "codex")
    : "codex";
  const runnerProvider: PaperclipRunnerProvider = isPaperclipRunnerProvider(
    configuredRunnerProvider,
  )
    ? configuredRunnerProvider
    : "codex";
  const runnerPermissionCapability =
    PAPERCLIP_RUNNER_PERMISSION_CAPABILITIES[runnerProvider];
  const runnerPermissionDescription = t(`localizationAgents.runnerDescription_${runnerProvider}`);
  const configuredRunnerPermissionMode =
    runnerManaged && runnerPermissionCapability.configurable
      ? isCreate
        ? (values!.adapterSchemaValues?.[
            runnerPermissionCapability.configKey
          ] ??
          (runnerProvider === "codex"
            ? values!.codexPermissionMode
            : undefined))
        : eff(
            "adapterConfig",
            runnerPermissionCapability.configKey,
            config[runnerPermissionCapability.configKey],
          )
      : undefined;
  const runnerPermissionModeUnsupported =
    runnerManaged &&
    runnerPermissionCapability.configurable &&
    configuredRunnerPermissionMode !== undefined &&
    !runnerPermissionCapability.options.some(
      (option) => option.value === configuredRunnerPermissionMode,
    );
  const runnerPermissionMode =
    runnerManaged && runnerPermissionCapability.configurable
      ? resolvePaperclipRunnerPermissionMode(
          runnerProvider,
          configuredRunnerPermissionMode,
        )
      : runnerPermissionCapability.defaultMode;
  const runnerSchemaValue = (key: string, fallback: unknown): unknown =>
    isCreate
      ? (values!.adapterSchemaValues?.[key] ?? fallback)
      : eff("adapterConfig", key, config[key] ?? fallback);
  const updateRunnerSchemaValue = (key: string, value: unknown): void => {
    if (isCreate) {
      set!({
        adapterSchemaValues: {
          ...values!.adapterSchemaValues,
          [key]: value,
        },
      });
    } else {
      mark("adapterConfig", key, value);
    }
  };
  const configuredAcpxAgent =
    runnerManaged && runnerProvider === "acpx"
      ? isCreate
        ? values!.adapterSchemaValues?.acpxAgent
        : eff("adapterConfig", "acpxAgent", config.acpxAgent ?? "claude")
      : "claude";
  const acpxAgent = configuredAcpxAgent === "codex" ? "codex" : "claude";
  const runnerLifecycleMode = runnerManaged
    ? isCreate
      ? (values!.paperclipRunnerLifecycleMode ?? "per_turn")
      : eff(
          "adapterConfig",
          "lifecycleMode",
          config.lifecycleMode === "warm" ? "warm" : "per_turn",
        )
    : "per_turn";
  const runnerIdleTimeoutMs = runnerManaged
    ? resolvePaperclipRunnerIdleTimeoutMs(
        isCreate
          ? values!.paperclipRunnerIdleTimeoutMs
          : eff("adapterConfig", "idleTimeoutMs", config.idleTimeoutMs),
      )
    : PAPERCLIP_RUNNER_IDLE_TIMEOUT_DEFAULT_MS;
  const rawEngine = runnerManaged
    ? "cli"
    : isCreate
      ? (values!.codexEngine ?? "auto")
      : eff("adapterConfig", "engine", String(config.engine ?? "auto"));
  const engine =
    rawEngine === "acp" || rawEngine === "cli" ? rawEngine : "auto";
  const acpSelected = engine === "acp";
  const bypassEnabled =
    config.dangerouslyBypassApprovalsAndSandbox === true ||
    config.dangerouslyBypassSandbox === true;
  const fastModeEnabled = isCreate
    ? Boolean(values!.fastMode)
    : eff("adapterConfig", "fastMode", Boolean(config.fastMode));
  const currentModel = isCreate
    ? String(values!.model ?? "")
    : eff("adapterConfig", "model", String(config.model ?? ""));
  const fastModeManualModel = isCodexLocalManualModel(currentModel);
  const fastModeSupported = isCodexLocalFastModeSupported(currentModel);
  const supportedModelsLabel =
    CODEX_LOCAL_FAST_MODE_SUPPORTED_MODELS.join(", ");
  const fastModeMessage = fastModeManualModel
    ? t("localizationAgents.fastModeManual")
    : fastModeSupported
      ? t("localizationAgents.fastModeCost")
      : t("localizationAgents.fastModeUnsupported", { models: supportedModelsLabel });

  return (
    <>
      {!hideEngineChoice && (
        <Field
          label={t("localizationAgents.ui303_Execution_engine")}
          hint={t("localizationAgents.ui304_Auto_uses_ACP_when_prerequisites_pass_and_falls_back_to_Code")}
        >
          <select
            className={inputClass}
            value={engine}
            onChange={(e) => {
              const value =
                e.target.value === "acp"
                  ? "acp"
                  : e.target.value === "cli"
                    ? "cli"
                    : "auto";
              isCreate
                ? set!({ codexEngine: value })
                : mark(
                    "adapterConfig",
                    "engine",
                    value === "auto" ? undefined : value,
                  );
            }}
          >
            <option value="auto">{t("localizationAgents.ui305_Auto_ACP_preferred_")}</option>
            <option value="cli">Codex CLI</option>
            <option value="acp">ACP</option>
          </select>
        </Field>
      )}
      {runnerManaged && (
        <Field
          label={t("pages.secrets.fields.provider")}
          hint={t("localizationAgents.ui308_The_runner_persists_this_provider_with_each_run_so_recovery_")}
        >
          <select
            className={inputClass}
            value={runnerProvider}
            onChange={(event) => {
              const provider = isPaperclipRunnerProvider(event.target.value)
                ? event.target.value
                : "codex";
              const model =
                provider === "opencode"
                  ? defaultOpenCodeRunnerModel
                  : provider === "claude_managed"
                    ? defaultClaudeManagedModel
                    : provider === "aws_agentcore"
                      ? defaultAwsAgentCoreModel
                      : provider === "acpx"
                        ? acpxRunnerModels.claude
                        : DEFAULT_CODEX_LOCAL_MODEL;
              if (isCreate) {
                set!({
                  model,
                  adapterSchemaValues: {
                    ...values!.adapterSchemaValues,
                    provider,
                    ...(provider === "acpx" ? { acpxAgent: "claude" } : {}),
                  },
                });
              } else {
                mark("adapterConfig", "provider", provider);
                mark("adapterConfig", "model", model);
                if (provider === "acpx") {
                  mark("adapterConfig", "acpxAgent", "claude");
                }
              }
            }}
          >
            <option value="codex">Codex</option>
            <option value="opencode">OpenCode 1.18.29</option>
            <option value="claude_managed">Claude Managed</option>
            <option value="aws_agentcore">AWS AgentCore</option>
            <option value="acpx">ACPX</option>
          </select>
        </Field>
      )}
      {runnerManaged && !runnerPermissionCapability.configurable && (
        <Field
          label={t("localizationAgents.ui314_Permission_mode")}
          hint={runnerPermissionDescription}
        >
          <div className={`${inputClass} text-muted-foreground`}>{t("localizationAgents.ui316_Provider_managed")}</div>
        </Field>
      )}
      {runnerManaged && runnerProvider === "claude_managed" && (
        <>
          <Field
            label={t("localizationAgents.ui317_Managed_Agent_profile")}
            hint={t("localizationAgents.ui318_Company_scoped_qualified_profile_ID_or_key_Remote_resource_i")}
          >
            <DraftInput
              value={String(runnerSchemaValue("managedProfileId", ""))}
              onCommit={(value) =>
                updateRunnerSchemaValue("managedProfileId", value.trim())
              }
              immediate
              className={inputClass}
              placeholder="managed-primary"
            />
          </Field>
          <Field
            label={t("localizationAgents.ui320_Session_spend_ceiling_USD_")}
            hint={t("localizationAgents.ui321_Optional_per_agent_hard_ceiling_Leave_1_00_to_use_a_conserva")}
          >
            <DraftNumberInput
              value={Number(runnerSchemaValue("maxSessionListCostUsd", 1))}
              min={0.01}
              onCommit={(value) =>
                updateRunnerSchemaValue("maxSessionListCostUsd", value)
              }
              immediate
              className={inputClass}
            />
          </Field>
          <ToggleField
            label={t("localizationAgents.ui322_Acknowledge_managed_retention")}
            hint={t("localizationAgents.ui323_Claude_Managed_is_a_stateful_beta_service_and_is_not_eligibl")}
            checked={
              runnerSchemaValue("managedAgentsRetentionAcknowledged", false) ===
              true
            }
            onChange={(value) =>
              updateRunnerSchemaValue(
                "managedAgentsRetentionAcknowledged",
                value,
              )
            }
          />
        </>
      )}
      {runnerManaged && runnerProvider === "aws_agentcore" && (
        <>
          <Field
            label={t("localizationAgents.ui324_AgentCore_profile")}
            hint={t("localizationAgents.ui325_Company_scoped_qualified_profile_ID_or_key_Harness_Memory_IA")}
          >
            <DraftInput
              value={String(runnerSchemaValue("agentCoreProfileId", ""))}
              onCommit={(value) =>
                updateRunnerSchemaValue("agentCoreProfileId", value.trim())
              }
              immediate
              className={inputClass}
              placeholder="agentcore-primary"
            />
          </Field>
          <Field
            label={t("localizationAgents.ui327_Estimated_session_ceiling_USD_")}
            hint={t("localizationAgents.ui328_Paperclip_estimate_AWS_does_not_provide_a_per_session_curren")}
          >
            <DraftNumberInput
              value={Number(runnerSchemaValue("maxEstimatedSessionCostUsd", 1))}
              min={0.01}
              onCommit={(value) =>
                updateRunnerSchemaValue("maxEstimatedSessionCostUsd", value)
              }
              immediate
              className={inputClass}
            />
          </Field>
          <Field
            label={t("localizationAgents.ui329_Maximum_iterations")}
            hint={t("localizationAgents.ui330_Qualified_range_is_1_8_Invalid_values_fail_closed_to_8_")}
          >
            <DraftNumberInput
              value={Number(runnerSchemaValue("maxIterations", 8))}
              min={1}
              max={8}
              onCommit={(value) =>
                updateRunnerSchemaValue("maxIterations", value)
              }
              immediate
              className={inputClass}
            />
          </Field>
          <Field
            label={t("localizationAgents.ui331_Maximum_output_tokens")}
            hint={t("localizationAgents.ui332_Qualified_range_is_1_4096_")}
          >
            <DraftNumberInput
              value={Number(runnerSchemaValue("maxOutputTokens", 4_096))}
              min={1}
              max={4_096}
              onCommit={(value) =>
                updateRunnerSchemaValue("maxOutputTokens", value)
              }
              immediate
              className={inputClass}
            />
          </Field>
          <Field
            label={t("localizationAgents.ui333_Invocation_timeout_seconds_")}
            hint={t("localizationAgents.ui334_Qualified_range_is_1_300_seconds_")}
          >
            <DraftNumberInput
              value={Number(runnerSchemaValue("timeoutSeconds", 300))}
              min={1}
              max={300}
              onCommit={(value) =>
                updateRunnerSchemaValue("timeoutSeconds", value)
              }
              immediate
              className={inputClass}
            />
          </Field>
          <ToggleField
            label={t("localizationAgents.ui335_Acknowledge_90_day_Memory_retention")}
            hint={t("localizationAgents.ui336_The_qualified_AgentCore_profile_retains_short_term_Memory_ev")}
            checked={
              runnerSchemaValue("agentCoreRetentionAcknowledged", false) ===
              true
            }
            onChange={(value) =>
              updateRunnerSchemaValue("agentCoreRetentionAcknowledged", value)
            }
          />
        </>
      )}
      {runnerManaged && runnerProvider === "acpx" && (
        <Field
          label={t("localizationAgents.ui337_ACP_agent")}
          hint={t("localizationAgents.ui338_Only_the_pinned_Claude_and_Codex_profiles_are_qualified_Pi_i")}
        >
          <select
            className={inputClass}
            value={acpxAgent}
            onChange={(event) => {
              const agent = event.target.value === "codex" ? "codex" : "claude";
              const model = acpxRunnerModels[agent];
              if (isCreate) {
                set!({
                  model,
                  adapterSchemaValues: {
                    ...values!.adapterSchemaValues,
                    acpxAgent: agent,
                  },
                });
              } else {
                mark("adapterConfig", "acpxAgent", agent);
                mark("adapterConfig", "model", model);
              }
            }}
          >
            <option value="claude">{t("localizationAgents.ui339_Claude_via_ACPX")}</option>
            <option value="codex">{t("localizationAgents.ui340_Codex_via_ACPX")}</option>
          </select>
        </Field>
      )}
      {runnerManaged && runnerPermissionCapability.configurable && (
        <Field
          label={t("localizationAgents.ui314_Permission_mode")}
          hint={t("localizationAgents.runnerPermissionBoundary", { description: runnerPermissionDescription })}
        >
          <select
            className={inputClass}
            value={
              runnerPermissionModeUnsupported
                ? "__unsupported__"
                : runnerPermissionMode
            }
            onChange={(event) => {
              const value = resolvePaperclipRunnerPermissionMode(
                runnerProvider,
                event.target.value,
              ) as PaperclipRunnerPermissionMode;
              if (isCreate) {
                set!({
                  adapterSchemaValues: {
                    ...values!.adapterSchemaValues,
                    [runnerPermissionCapability.configKey]: value,
                  },
                });
              } else {
                mark(
                  "adapterConfig",
                  runnerPermissionCapability.configKey,
                  value,
                );
              }
            }}
          >
            {runnerPermissionModeUnsupported && (
              <option value="__unsupported__" disabled>{t("localizationAgents.ui342_Unsupported_saved_mode_select_a_qualified_mode")}</option>
            )}
            {runnerPermissionCapability.options.map((option) => (
              <option key={option.value} value={option.value}>
                {t(`localizationAgents.runnerPermission_${option.value}`, { defaultValue: option.label })}
              </option>
            ))}
          </select>
          {runnerPermissionModeUnsupported && runnerProvider === "codex" && (
            <p className="mt-1 text-xs text-destructive" role="alert">{t("localizationAgents.ui343_This_saved_Codex_mode_cannot_start_or_recover_a_Paperclip_Ru")}</p>
          )}
        </Field>
      )}
      {runnerManaged && (
        <Field
          label={t("localizationAgents.ui344_Runner_lifecycle")}
          hint={t("localizationAgents.ui345_Turn_by_turn_suspends_after_each_run_Warm_keeps_the_same_pro")}
        >
          <select
            className={inputClass}
            value={runnerLifecycleMode}
            onChange={(event) => {
              const value = event.target.value === "warm" ? "warm" : "per_turn";
              isCreate
                ? set!({ paperclipRunnerLifecycleMode: value })
                : mark("adapterConfig", "lifecycleMode", value);
            }}
          >
            <option value="per_turn">{t("localizationAgents.ui346_Turn_by_turn")}</option>
            <option value="warm">{t("localizationAgents.ui347_Warm_session")}</option>
          </select>
        </Field>
      )}
      {runnerManaged && runnerLifecycleMode === "warm" && (
        <Field
          label={t("localizationAgents.ui348_Warm_idle_timeout_ms_")}
          hint={t("localizationAgents.ui349_After_this_much_inactivity_runnerd_checkpoints_and_suspends_")}
        >
          {isCreate ? (
            <input
              type="number"
              min={1}
              max={PAPERCLIP_RUNNER_IDLE_TIMEOUT_MAX_MS}
              className={inputClass}
              value={runnerIdleTimeoutMs}
              onChange={(event) =>
                set!({
                  paperclipRunnerIdleTimeoutMs:
                    resolvePaperclipRunnerIdleTimeoutMs(
                      Number(event.target.value),
                    ),
                })
              }
            />
          ) : (
            <DraftNumberInput
              value={runnerIdleTimeoutMs}
              min={1}
              max={PAPERCLIP_RUNNER_IDLE_TIMEOUT_MAX_MS}
              onCommit={(value) =>
                mark(
                  "adapterConfig",
                  "idleTimeoutMs",
                  resolvePaperclipRunnerIdleTimeoutMs(value),
                )
              }
              immediate
              className={inputClass}
            />
          )}
        </Field>
      )}
      {acpSelected && (
        <>
          {!managedSandboxOnly && (
            <Field
              label={t("localizationAgents.ui350_ACP_server_command")}
              hint={t("localizationAgents.ui351_Optional_override_for_the_Codex_ACP_server_command_Defaults_")}
            >
              <DraftInput
                value={
                  isCreate
                    ? (values!.codexAcpAgentCommand ?? "")
                    : eff(
                        "adapterConfig",
                        "agentCommand",
                        String(config.agentCommand ?? ""),
                      )
                }
                onCommit={(v) =>
                  isCreate
                    ? set!({ codexAcpAgentCommand: v })
                    : mark("adapterConfig", "agentCommand", v || undefined)
                }
                immediate
                className={inputClass}
                placeholder="codex-acp"
              />
            </Field>
          )}
          <Field
            label={t("localizationAgents.ui353_ACP_session_mode")}
            hint={t("localizationAgents.ui354_Persistent_keeps_ACP_session_state_between_runs_One_shot_sta")}
          >
            <select
              className={inputClass}
              value={
                isCreate
                  ? (values!.codexAcpMode ?? "persistent")
                  : eff(
                      "adapterConfig",
                      "mode",
                      String(config.mode ?? "persistent"),
                    )
              }
              onChange={(e) => {
                const value =
                  e.target.value === "oneshot" ? "oneshot" : "persistent";
                isCreate
                  ? set!({ codexAcpMode: value })
                  : mark("adapterConfig", "mode", value);
              }}
            >
              <option value="persistent">{t("localizationAgents.ui355_Persistent")}</option>
              <option value="oneshot">{t("localizationAgents.ui356_One_shot")}</option>
            </select>
          </Field>
          <Field
            label={t("localizationAgents.ui357_ACP_non_interactive_permissions")}
            hint={t("localizationAgents.ui358_Fallback_if_the_ACP_agent_asks_for_input_outside_an_interact")}
          >
            <select
              className={inputClass}
              value={
                isCreate
                  ? (values!.codexAcpNonInteractivePermissions ?? "deny")
                  : eff(
                      "adapterConfig",
                      "nonInteractivePermissions",
                      String(config.nonInteractivePermissions ?? "deny"),
                    )
              }
              onChange={(e) => {
                const value = e.target.value === "fail" ? "fail" : "deny";
                isCreate
                  ? set!({ codexAcpNonInteractivePermissions: value })
                  : mark("adapterConfig", "nonInteractivePermissions", value);
              }}
            >
              <option value="deny">{t("localizationAgents.ui359_Deny")}</option>
              <option value="fail">{t("localizationAgents.ui360_Fail")}</option>
            </select>
          </Field>
          {!managedSandboxOnly && (
            <Field
              label={t("localizationAgents.ui361_ACP_state_directory")}
              hint={t("localizationAgents.ui362_Optional_ACP_session_state_directory_Defaults_to_Paperclip_m")}
            >
              <div className="flex items-center gap-2">
                <DraftInput
                  value={
                    isCreate
                      ? (values!.codexAcpStateDir ?? "")
                      : eff(
                          "adapterConfig",
                          "stateDir",
                          String(config.stateDir ?? ""),
                        )
                  }
                  onCommit={(v) =>
                    isCreate
                      ? set!({ codexAcpStateDir: v })
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
          <Field
            label={t("localizationAgents.ui364_ACP_warm_process_idle_ms")}
            hint={t("localizationAgents.ui365_Defaults_to_0_which_closes_the_ACP_process_after_each_run_wh")}
          >
            {isCreate ? (
              <input
                type="number"
                className={inputClass}
                value={values!.codexAcpWarmHandleIdleMs ?? 0}
                onChange={(e) =>
                  set!({ codexAcpWarmHandleIdleMs: Number(e.target.value) })
                }
              />
            ) : (
              <DraftNumberInput
                value={eff(
                  "adapterConfig",
                  "warmHandleIdleMs",
                  Number(config.warmHandleIdleMs ?? 0),
                )}
                onCommit={(v) =>
                  mark("adapterConfig", "warmHandleIdleMs", v || 0)
                }
                immediate
                className={inputClass}
              />
            )}
          </Field>
        </>
      )}
      {!runnerManaged && !hideInstructionsFile && (
        <Field label={t("localizationAgents.ui270_Agent_instructions_file")} hint={instructionsFileHint()}>
          <div className="flex items-center gap-2">
            <DraftInput
              value={
                isCreate
                  ? (values!.instructionsFilePath ?? "")
                  : eff(
                      "adapterConfig",
                      "instructionsFilePath",
                      String(config.instructionsFilePath ?? ""),
                    )
              }
              onCommit={(v) =>
                isCreate
                  ? set!({ instructionsFilePath: v })
                  : mark(
                      "adapterConfig",
                      "instructionsFilePath",
                      v || undefined,
                    )
              }
              immediate
              className={inputClass}
              placeholder="/absolute/path/to/AGENTS.md"
            />
            <ChoosePathButton />
          </div>
        </Field>
      )}
      {!runnerManaged && (
        <>
          <ToggleField
            label={t("localizationAgents.ui366_Bypass_sandbox")}
            hint={help.dangerouslyBypassSandbox}
            checked={
              isCreate
                ? values!.dangerouslyBypassSandbox
                : eff(
                    "adapterConfig",
                    "dangerouslyBypassApprovalsAndSandbox",
                    bypassEnabled,
                  )
            }
            onChange={(v) =>
              isCreate
                ? set!({ dangerouslyBypassSandbox: v })
                : mark(
                    "adapterConfig",
                    "dangerouslyBypassApprovalsAndSandbox",
                    v,
                  )
            }
          />
          <ToggleField
            label={t("localizationAgents.ui367_Enable_search")}
            hint={help.search}
            checked={
              isCreate
                ? values!.search
                : eff("adapterConfig", "search", !!config.search)
            }
            onChange={(v) =>
              isCreate
                ? set!({ search: v })
                : mark("adapterConfig", "search", v)
            }
          />
          <ToggleField
            label={t("localizationAgents.ui368_Fast_mode")}
            hint={help.fastMode}
            checked={fastModeEnabled}
            onChange={(v) =>
              isCreate
                ? set!({ fastMode: v })
                : mark("adapterConfig", "fastMode", v)
            }
          />
          {fastModeEnabled && (
            <div className="rounded-md border border-amber-300/70 bg-amber-50/80 px-3 py-2 text-sm text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100">
              {fastModeMessage}
            </div>
          )}
        </>
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
