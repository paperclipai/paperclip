import { useTranslation, t } from "@/i18n";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue, SelectPopover } from "../../components/ui/select";
import { AdapterMark } from "../../components/AdapterMark";
import { MuseRunnerConnection } from "../../components/MuseRunnerConnection";
import { GrokBotConnection } from "../../components/GrokBotConnection";
import { DotRunnerConnection } from "../../components/DotRunnerConnection";
import { getAgentConfigDisplayText } from "../display-translations";
import { configFieldsForSection } from "../config-sections";
import type { AdapterConfigFieldsProps } from "../types";
import type { CreateConfigValues } from "@paperclipai/adapter-utils";
import { buildCodexLocalConfig } from "@paperclipai/adapter-codex-local/ui";
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
  resolveCodexLocalCliPolicy,
} from "@paperclipai/adapter-codex-local";
import {
  PAPERCLIP_RUNNER_IDLE_TIMEOUT_DEFAULT_MS,
  PAPERCLIP_RUNNER_IDLE_TIMEOUT_MAX_MS,
  PAPERCLIP_RUNNER_PERMISSION_CAPABILITIES,
  PAPERCLIP_RUNNER_ACPX_PROFILES,
  isPaperclipRunnerProvider,
  resolvePaperclipRunnerIdleTimeoutMs,
  resolvePaperclipRunnerPermissionMode,
  type PaperclipRunnerPermissionMode,
  type PaperclipRunnerPermissionCapability,
} from "@paperclipai/adapter-utils";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";
const instructionsFileHint =
  () => t("agent-config:absolutePathToAMarkdownFileEG_458b4c0");
const defaultOpenCodeRunnerModel = "openrouter/deepseek/deepseek-v4-flash-0731";
const defaultAcpxClaudeModel = "claude-opus-5-5";
const defaultClaudeManagedModel = "claude-sonnet-5";
const defaultAwsAgentCoreModel = "global.anthropic.claude-sonnet-4-6";
const runnerHarnessOptions = [
  { value: "codex", get label() { return t("agent-config:codex_2c5d5b8"); }, adapter: "codex_local" },
  { value: "opencode", get label() { return t("agent-config:opencode11834_b6d3f6b"); }, adapter: "opencode_local" },
  { value: "claude_managed", get label() { return t("agent-config:claudeManaged_f827ceb"); }, adapter: "claude_local" },
  { value: "aws_agentcore", get label() { return t("agent-config:awsAgentcore_3244d58"); }, adapter: "aws_agentcore" },
  { value: "acpx", get label() { return t("agent-config:acpAgents_1036407"); }, adapter: "acpx_local" },
  { value: "cursor_cloud", get label() { return t("agent-config:cursorCloudExperimental_c2f8684"); }, adapter: "cursor_cloud" },
  { value: "grok", get label() { return t("agent-config:grokBuild_2b95684"); }, adapter: "grok_local" },
];

export function buildCodexRunnerConfig(values: CreateConfigValues): Record<string, unknown> {
  const config = buildCodexLocalConfig(values);
  if (values.codexLegacySandboxBypass !== undefined) {
    config.dangerouslyBypassApprovalsAndSandbox = values.codexLegacySandboxBypass;
  } else if (values.runner !== "legacy") {
    delete config.dangerouslyBypassApprovalsAndSandbox;
  }
  return {
    ...config,
    ...(values.codexPermissionMode !== undefined ? { codexPermissionMode: values.codexPermissionMode } : {}),
    ...(values.paperclipRunnerLifecycleMode !== undefined ? { lifecycleMode: values.paperclipRunnerLifecycleMode } : {}),
    ...(values.paperclipRunnerIdleTimeoutMs !== undefined ? { idleTimeoutMs: values.paperclipRunnerIdleTimeoutMs } : {}),
  };
}

export function CodexLocalConfigFields({
  section,
  companyId,
  agentId,
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
  hideRunnerHarness,
}: AdapterConfigFieldsProps) {
  const { t } = useTranslation("agent-config");
  const runnerManaged = adapterType === "paperclip_runner";
  // The execution engine picks which binary runs on the execution host, and the
  // ACP sub-fields below name host paths. The platform-managed environment owns
  // both, so the managed-sandbox-only policy hides them the same way
  // `runnerManaged` already does for the Paperclip Runner.
  const hideEngineChoice = runnerManaged || managedSandboxOnly === true;
  const configuredRunnerProvider = runnerManaged
    ? isCreate
      ? values!.adapterSchemaValues?.provider
      : eff("adapterConfig", "provider", config.provider === "acpx" && config.acpxAgent === "codex" ? "codex" : config.provider ?? "codex")
    : "codex";
  const runnerProvider = String(configuredRunnerProvider ?? "codex");
  const runnerPermissionCapability: PaperclipRunnerPermissionCapability =
    isPaperclipRunnerProvider(runnerProvider)
      ? PAPERCLIP_RUNNER_PERMISSION_CAPABILITIES[runnerProvider]
      : { configurable: false, defaultMode: "provider-managed", options: [], description: t("agent-config:unknownProviderConfigurationIsPreserved_db6e5f5") };
  const isMuse = runnerProvider === "muse";
  const isCursorCloud = runnerProvider === "cursor_cloud";
  const isExternal = isMuse || runnerProvider === "openai_dot" || runnerProvider === "grok_bot";
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
          isPaperclipRunnerProvider(runnerProvider) ? runnerProvider : "codex",
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
  const bypassEnabled = resolveCodexLocalCliPolicy({
    ...config,
    dangerouslyBypassApprovalsAndSandbox: eff("adapterConfig", "dangerouslyBypassApprovalsAndSandbox", config.dangerouslyBypassApprovalsAndSandbox),
    dangerouslyBypassSandbox: eff("adapterConfig", "dangerouslyBypassSandbox", config.dangerouslyBypassSandbox),
    extraArgs: eff("adapterConfig", "extraArgs", config.extraArgs),
    args: eff("adapterConfig", "args", config.args),
  }).bypass;
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
    ? t("agent-config:fastModeWillBePassedThroughForThis_6f5623d")
    : fastModeSupported
      ? t("agent-config:fastModeConsumesCreditsTokensMuchFasterThan_623c6f8")
      : t("agent-config:fastModeCurrentlyOnlyWorksOnValueOr_239e1af", { value1: supportedModelsLabel });

  return configFieldsForSection(section, (
    <>
      {!hideEngineChoice && (
        <Field
          label={t("agent-config:executionEngine_1f5a0b6")}
          hint={t("agent-config:defaultUsesAcpIfAcpIsUnavailableThe_b2b91a8")}
        >
          <SelectPopover
            aria-label={t("agent-config:executionEngine_1f5a0b6")}
            value={engine}
            onValueChange={(next) => {
              const value =
                next === "acp"
                  ? "acp"
                  : next === "cli"
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
            options={[
              { value: "auto", label: t("agent-config:defaultAcp_b0e3551") },
              { value: "cli", label: t("agent-config:codexCli_01a9b4e") },
              { value: "acp", label: t("agent-config:acp_2601cb8") },
            ]}
          />
        </Field>
      )}
      {runnerManaged && !hideRunnerHarness && !isExternal && (
        <Field configSection="adapter"
          label={t("agent-config:harness_2b7cfd5")}
          hint={t("agent-config:chooseTheAgentHarnessThatRunsYourTasks_0d40b4e")}
        >
          <Select
            value={runnerProvider === "acpx" && runnerSchemaValue("acpxAgent", "claude") === "grok" ? "grok" : runnerProvider}
            onValueChange={(value) => {
              const grok = value === "grok";
              const provider = grok ? "acpx" : isPaperclipRunnerProvider(value)
                ? value
                : "codex";
              const cloudResetKeys = ["codexPermissionMode", "opencodePermissionMode", "acpxPermissionMode", "acpxAgent", "command", "extraArgs", "idleTimeoutMs", "modelReasoningEffort", "reasoningEffort", "effort", "modelParams", "homeMode"];
              const model =
                provider === "openai_dot"
                  ? ""
                  : provider === "opencode"
                  ? defaultOpenCodeRunnerModel
                  : provider === "claude_managed"
                    ? defaultClaudeManagedModel
                    : provider === "aws_agentcore"
                      ? defaultAwsAgentCoreModel
                      : provider === "acpx"
                        ? grok ? "grok-4.7" : defaultAcpxClaudeModel
                        : provider === "cursor_cloud" ? ""
                        : DEFAULT_CODEX_LOCAL_MODEL;
              if (isCreate) {
                set!({
                  model,
                  ...(provider === "cursor_cloud" ? { thinkingEffort: "" } : {}),
                  adapterSchemaValues: {
                    ...values!.adapterSchemaValues,
                    provider,
                    acpxSessionMode: undefined,
                    piThinkingLevel: undefined,
                    ...(provider === "cursor_cloud" ? { ...Object.fromEntries(cloudResetKeys.map(key => [key, undefined])), lifecycleMode: "per_turn" } : {}),
                    ...(provider === "acpx" ? { acpxAgent: grok ? "grok" : "claude" } : {}),
                  },
                });
              } else {
                mark("adapterConfig", "provider", provider);
                mark("adapterConfig", "acpxSessionMode", undefined);
                mark("adapterConfig", "piThinkingLevel", undefined);
                mark("adapterConfig", "model", model);
                if (provider === "openai_dot") {
                  mark("adapterConfig", "lifecycleMode", "per_turn");
                  for (const key of ["cwd", "env", "instructionsFilePath", "command", "extraArgs", "engine", "modelReasoningEffort", "workspaceStrategy", "workspaceRuntime", "idleTimeoutMs", "acpxAgent", "managedProfileId", "agentCoreProfileId"]) mark("adapterConfig", key, undefined);
                }
                if (provider === "acpx") {
                  mark("adapterConfig", "acpxAgent", grok ? "grok" : "claude");
                }
                if (provider === "cursor_cloud") {
                  mark("adapterConfig", "lifecycleMode", "per_turn");
                  for (const key of cloudResetKeys) mark("adapterConfig", key, undefined);
                }
              }
            }}
          >
            <SelectTrigger className="w-full" aria-label={t("agent-config:harness_2b7cfd5")}><SelectValue /></SelectTrigger>
            <SelectContent>
              {!isPaperclipRunnerProvider(runnerProvider) && <SelectItem value={runnerProvider} disabled>{runnerProvider} {t("agent-config:unknownProvider_85fdaa8")}</SelectItem>}
              {runnerHarnessOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  <AdapterMark type={option.adapter} className="size-4" />
                  {getAgentConfigDisplayText(option.label)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      )}
      {runnerManaged && runnerProvider === "grok_bot" && <GrokBotConnection companyId={companyId} agentId={agentId} />}
      {runnerManaged && isCursorCloud && <>
        <p className="text-sm text-muted-foreground">{t("agent-config:experimentalCursorHostsThisAgentSExecutionEnvironment_a96950c")}</p>
        {[
          { key: "repoUrl", label: t("agent-config:githubRepository_c665199"), fallback: "", legacy: undefined, placeholder: "https://github.com/your-org/repo", hint: t("agent-config:selectARepositoryOrANamedCursorCloud_8efbfaf") },
          { key: "repoRef", label: t("agent-config:startingRef_3fd8945"), fallback: config.repoStartingRef ?? "", legacy: "repoStartingRef", placeholder: t("agent-config:repositoryDefault_5b328e1") },
          { key: "prUrl", label: t("agent-config:pullRequestUrl_03bf686"), fallback: config.repoPullRequestUrl ?? "", legacy: "repoPullRequestUrl", placeholder: t("agent-config:optional_0c6c410") },
          { key: "cloudEnvName", label: t("agent-config:cursorCloudEnvironment_b8581b6"), fallback: config.runtimeEnvName ?? "", legacy: "runtimeEnvName", placeholder: t("agent-config:useInsteadOfARepository_be41ad7") },
        ].map(field => <Field key={field.key} configSection="adapter" label={field.label} hint={field.hint}>
          <DraftInput value={String(runnerSchemaValue(field.key, field.fallback))} placeholder={field.placeholder} className={inputClass}
            onCommit={value => {
              if (isCreate) set!({ adapterSchemaValues: { ...values!.adapterSchemaValues, [field.key]: value, ...(field.legacy ? { [field.legacy]: undefined } : {}) } });
              else { if (field.legacy) mark("adapterConfig", field.legacy, undefined); mark("adapterConfig", field.key, value); }
            }} />
        </Field>)}
        {[
          { key: "workOnCurrentBranch", label: t("agent-config:workOnCurrentBranch_52d09c8") },
          { key: "autoCreatePR", label: t("agent-config:autoCreatePullRequest_52f4076") },
          { key: "skipReviewerRequest", label: t("agent-config:skipReviewerRequest_93acc03") },
        ].map(field => <ToggleField key={field.key} label={field.label}
          checked={runnerSchemaValue(field.key, false) === true} onChange={value => updateRunnerSchemaValue(field.key, value)} />)}
      </>}
      {runnerManaged && runnerProvider === "openai_dot" && <>
        <Field configSection="adapter" label={t("agent-config:dotConnection_d7d1f65")} hint={t("agent-config:aVerifiedEventRoundTripIsRequiredBefore_ac48f17")}>
          <DotRunnerConnection companyId={companyId} agentId={agentId} bindingId={String(runnerSchemaValue("dotBindingId", ""))} onBinding={id => updateRunnerSchemaValue("dotBindingId", id)} />
        </Field>
        <ToggleField label={t("agent-config:readTaskAttachments_dcc9919")} hint={t("agent-config:letDotReadFilesAttachedToItsCurrent_8fa2f2d")}
          checked={runnerSchemaValue("dotAttachmentAccess", false) === true} onChange={value => updateRunnerSchemaValue("dotAttachmentAccess", value)} />
        <ToggleField label={t("agent-config:workspaceFilesAndCommands_405c394")} hint={t("agent-config:letDotReadAndWriteItsAssignedWorkspace_5984f78")}
          checked={runnerSchemaValue("dotWorkspaceAccess", false) === true} onChange={value => updateRunnerSchemaValue("dotWorkspaceAccess", value)} />
        <ToggleField label={t("agent-config:allowExternallyBilledProvider_ecfb7d5")} hint={t("agent-config:dotDoesNotReportTokenUsageOrCost_684e587")}
          checked={runnerSchemaValue("allowUnmeteredProvider", false) === true} onChange={value => updateRunnerSchemaValue("allowUnmeteredProvider", value)} />
      </>}
      {runnerManaged && isMuse && <>
        <Field configSection="adapter" label={t("agent-config:museConnection_2aecc10")} hint={t("agent-config:pairingReceiverContactBackgroundReplyAndAgentSetup_0e936b2")}>
          <MuseRunnerConnection companyId={companyId} agentId={agentId} />
        </Field>
        <ToggleField label={t("agent-config:allowExternallyBilledProvider_ecfb7d5")} hint={t("agent-config:museDoesNotReportUsageOrCostPaperclip_3b839be")}
          checked={runnerSchemaValue("allowUnmeteredProvider", false) === true} onChange={value => updateRunnerSchemaValue("allowUnmeteredProvider", value)} />
      </>}
      {runnerManaged && !hideRunnerHarness && runnerProvider === "acpx" && runnerSchemaValue("acpxAgent", "claude") !== "grok" && (
        <Field configSection="adapter" label={t("agent-config:acpAgent_c16f282")} hint={t("agent-config:chooseAQualifiedHarnessAndEnterItsExact_1f102bd")}>
          <Select
            value={String(isCreate ? values!.adapterSchemaValues?.acpxAgent ?? "claude" : eff("adapterConfig", "acpxAgent", config.acpxAgent ?? "claude"))}
            onValueChange={(value) => {
              const profile = PAPERCLIP_RUNNER_ACPX_PROFILES.find(entry => entry.value === value);
              const acpxSessionMode = profile?.value === "cursor" ? "agent" : undefined;
              const piThinkingLevel = profile?.value === "pi" ? "low" : undefined;
              if (!profile?.qualified) return;
              if (isCreate) set!({ model: profile.value === "claude" ? defaultAcpxClaudeModel : "",
                adapterSchemaValues: { ...values!.adapterSchemaValues, acpxAgent: profile.value, acpxSessionMode, piThinkingLevel } });
              else { mark("adapterConfig", "acpxAgent", profile.value); mark("adapterConfig", "acpxSessionMode", acpxSessionMode); mark("adapterConfig", "piThinkingLevel", piThinkingLevel); mark("adapterConfig", "model", profile.value === "claude" ? defaultAcpxClaudeModel : ""); }
            }}>
            <SelectTrigger className="w-full" aria-label={t("agent-config:acpAgent_c16f282")}><SelectValue /></SelectTrigger>
            <SelectContent>
              {PAPERCLIP_RUNNER_ACPX_PROFILES.map(profile => (
                <SelectItem key={profile.value} value={profile.value} disabled={!profile.qualified}>
                  <AdapterMark type={profile.value === "cursor" ? "cursor" : `${profile.value}_local`} className="size-4" />
                  {profile.label}{profile.qualified ? "" : t("agent-config:qualificationPending_34f4aac")}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      )}
      {runnerManaged && runnerProvider === "acpx" && runnerSchemaValue("acpxAgent", "claude") === "cursor" && (
        <Field configSection="adapter" label={t("agent-config:cursorMode_4697327")} hint={t("agent-config:selectCursorSSessionModePermissionsAndCompany_6b17274")}>
          <select className={inputClass} aria-label={t("agent-config:cursorMode_4697327")}
            value={String(runnerSchemaValue("acpxSessionMode", "agent"))}
            onChange={(event) => updateRunnerSchemaValue("acpxSessionMode", event.target.value)}>
            {!["agent", "plan", "ask"].includes(String(runnerSchemaValue("acpxSessionMode", "agent"))) && (
              <option value={String(runnerSchemaValue("acpxSessionMode", "agent"))} disabled>{t("agent-config:unsupportedSavedModeSelectAgentPlanOrAsk_d22d60f")}</option>
            )}
            <option value="agent">{t("agent-config:agent_5ce2e6f")}</option>
            <option value="plan">{t("agent-config:plan_ae2f98a")}</option>
            <option value="ask">{t("agent-config:ask_3562777")}</option>
          </select>
        </Field>
      )}
      {runnerManaged && runnerProvider === "acpx" && runnerSchemaValue("acpxAgent", "claude") === "pi" && (
        <Field configSection="adapter" label={t("agent-config:piThinkingLevel_2a78074")} hint={t("agent-config:theRunnerVerifiesThisExactLevelBeforeEach_aeae4f7")}>
          <select className={inputClass} aria-label={t("agent-config:piThinkingLevel_2a78074")} value={String(runnerSchemaValue("piThinkingLevel", "low"))}
            onChange={(event) => updateRunnerSchemaValue("piThinkingLevel", event.target.value)}>
            {!["off", "low", "high", "max"].includes(String(runnerSchemaValue("piThinkingLevel", "low"))) && <option value={String(runnerSchemaValue("piThinkingLevel", "low"))} disabled>{t("agent-config:unsupportedSavedThinkingLevel_6b0cb34")}</option>}
            <option value="off">{t("agent-config:off_e3de5ab")}</option><option value="low">{t("agent-config:low_a124947")}</option><option value="high">{t("agent-config:high_b1a5954")}</option><option value="max">{t("agent-config:max_a95e85a")}</option>
          </select>
        </Field>
      )}
      {runnerManaged && runnerProvider === "claude_managed" && (
        <>
          <Field
            label={t("agent-config:managedAgentProfile_4512d6e")}
            hint={t("agent-config:companyScopedQualifiedProfileIdOrKeyRemote_c64311f")}
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
            label={t("agent-config:sessionSpendCeilingUsd_8ad9d28")}
            hint={t("agent-config:optionalPerAgentHardCeilingLeave100_1101527")}
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
            label={t("agent-config:acknowledgeManagedRetention_a243e75")}
            hint={t("agent-config:claudeManagedIsAStatefulBetaServiceAnd_7a479d6")}
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
            label={t("agent-config:agentcoreProfile_2b5f6a9")}
            hint={t("agent-config:companyScopedQualifiedProfileIdOrKeyHarness_04b82be")}
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
            label={t("agent-config:estimatedSessionCeilingUsd_0674d33")}
            hint={t("agent-config:paperclipEstimateAwsDoesNotProvideAPer_6e9e5df")}
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
            label={t("agent-config:maximumIterations_f45b097")}
            hint={t("agent-config:qualifiedRangeIs18InvalidValuesFail_e194fe4")}
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
            label={t("agent-config:maximumOutputTokens_dc95e9b")}
            hint={t("agent-config:qualifiedRangeIs14096_3182010")}
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
          <Field configSection="runPolicy"
            label={t("agent-config:invocationTimeoutSeconds_a9cd5aa")}
            hint={t("agent-config:qualifiedRangeIs1300Seconds_b4e68d1")}
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
            label={t("agent-config:acknowledge90DayMemoryRetention_bb3fb5a")}
            hint={t("agent-config:theQualifiedAgentcoreProfileRetainsShortTermMemory_8780092")}
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
      {runnerManaged && !isExternal && runnerPermissionCapability.configurable && (runnerPermissionCapability.options.length > 1 || runnerPermissionModeUnsupported) && (
        <Field
          label={t("agent-config:permissionMode_9c8c621")}
          hint={t("agent-config:valueTheSelectedModeDoesNotWidenPaperclip_4838891", { value1: getAgentConfigDisplayText(runnerPermissionCapability.description) })}
        >
          <Select
            value={
              runnerPermissionModeUnsupported
                ? "__unsupported__"
                : runnerPermissionMode
            }
            onValueChange={(selectedMode) => {
              const value = resolvePaperclipRunnerPermissionMode(
                isPaperclipRunnerProvider(runnerProvider) ? runnerProvider : "codex",
                selectedMode,
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
            <SelectTrigger aria-label={t("agent-config:permissionMode_9c8c621")} className="w-full font-sans">
              <SelectValue>
                {runnerPermissionModeUnsupported
                  ? t("agent-config:unsupportedSavedModeSelectAQualifiedMode_9590b14")
                  : getAgentConfigDisplayText(runnerPermissionCapability.options.find((option) => option.value === runnerPermissionMode)?.label)}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {runnerPermissionModeUnsupported && (
                <SelectItem value="__unsupported__" disabled>{t("agent-config:unsupportedSavedModeSelectAQualifiedMode_9590b14")}</SelectItem>
              )}
              {runnerPermissionCapability.options.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {getAgentConfigDisplayText(option.label)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {runnerPermissionModeUnsupported && runnerProvider === "codex" && (
            <p className="mt-1 text-xs text-destructive" role="alert">{t("agent-config:thisSavedCodexModeCannotStartOrRecover_be2ec0e")}</p>
          )}
        </Field>
      )}
      {runnerManaged && !isExternal && !isCursorCloud && (
        <Field configSection="runPolicy"
          label={t("agent-config:runnerLifecycle_dceecd2")}
          hint={t("agent-config:turnByTurnSuspendsAfterEachRunWarm_70ad2d9")}
        >
          <SelectPopover
            aria-label={t("agent-config:runnerLifecycle_dceecd2")}
            value={runnerLifecycleMode}
            onValueChange={(next) => {
              const value = next === "warm" ? "warm" : "per_turn";
              isCreate
                ? set!({ paperclipRunnerLifecycleMode: value })
                : mark("adapterConfig", "lifecycleMode", value);
            }}
            options={[
              { value: "per_turn", label: t("agent-config:turnByTurn_579f451") },
              { value: "warm", label: t("agent-config:warmSession_39751a7") },
            ]}
          />
        </Field>
      )}
      {runnerManaged && !isExternal && !isCursorCloud && runnerLifecycleMode === "warm" && (
        <Field configSection="runPolicy"
          label={t("agent-config:warmIdleTimeoutMs_f54268a")}
          hint={t("agent-config:afterThisMuchInactivityRunnerdCheckpointsAndSuspends_cf47397")}
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
            <Field configSection="advanced"
              label={t("agent-config:acpServerCommand_d6765f6")}
              hint={t("agent-config:optionalOverrideForTheCodexAcpServerCommand_9ad9ffd")}
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
          <Field configSection="runPolicy"
            label={t("agent-config:acpSessionMode_ceac164")}
            hint={t("agent-config:persistentKeepsAcpSessionStateBetweenRunsOne_360b5f3")}
          >
            <SelectPopover
              aria-label={t("agent-config:acpSessionMode_ceac164")}
              value={
                isCreate
                  ? (values!.codexAcpMode ?? "persistent")
                  : eff(
                      "adapterConfig",
                      "mode",
                      String(config.mode ?? "persistent"),
                    )
              }
              onValueChange={(next) => {
                const value =
                  next === "oneshot" ? "oneshot" : "persistent";
                isCreate
                  ? set!({ codexAcpMode: value })
                  : mark("adapterConfig", "mode", value);
              }}
              options={[
                { value: "persistent", label: t("agent-config:persistent_9260ffc") },
                { value: "oneshot", label: t("agent-config:oneShot_d9d60df") },
              ]}
            />
          </Field>
          <Field
            label={t("agent-config:acpNonInteractivePermissions_99ec060")}
            hint={t("agent-config:fallbackIfTheAcpAgentAsksForInput_b707bad")}
          >
            <SelectPopover
              aria-label={t("agent-config:acpNonInteractivePermissions_99ec060")}
              value={
                isCreate
                  ? (values!.codexAcpNonInteractivePermissions ?? "deny")
                  : eff(
                      "adapterConfig",
                      "nonInteractivePermissions",
                      String(config.nonInteractivePermissions ?? "deny"),
                    )
              }
              onValueChange={(next) => {
                const value = next === "fail" ? "fail" : "deny";
                isCreate
                  ? set!({ codexAcpNonInteractivePermissions: value })
                  : mark("adapterConfig", "nonInteractivePermissions", value);
              }}
              options={[
                { value: "deny", label: t("agent-config:deny_53577bb") },
                { value: "fail", label: t("agent-config:fail_2758e32") },
              ]}
            />
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
          <Field configSection="runPolicy"
            label={t("agent-config:acpWarmProcessIdleMs_99fe6aa")}
            hint={t("agent-config:defaultsTo0WhichClosesTheAcpProcess_5a6f61e")}
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
        <Field label={t("agent-config:agentInstructionsFile_9765d14")} hint={instructionsFileHint()}>
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
            label={t("agent-config:bypassSandbox_3e37155")}
            hint={help.dangerouslyBypassSandbox}
            checked={
              isCreate
                ? resolveCodexLocalCliPolicy(buildCodexRunnerConfig(values!)).bypass
                : bypassEnabled
            }
            onChange={(v) =>
              isCreate
                ? set!({ dangerouslyBypassSandbox: v, codexLegacySandboxBypass: v })
                : mark(
                    "adapterConfig",
                    "dangerouslyBypassApprovalsAndSandbox",
                    v,
                  )
            }
          />
          <ToggleField
            label={t("agent-config:enableSearch_f775991")}
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
            label={t("agent-config:fastMode_ad388d2")}
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
      {!isExternal && <LocalWorkspaceRuntimeFields
        isCreate={isCreate}
        values={values}
        set={set}
        config={config}
        mark={mark}
        eff={eff}
        mode={mode}
        adapterType={adapterType}
        models={models}
      />}
    </>
  ));
}
