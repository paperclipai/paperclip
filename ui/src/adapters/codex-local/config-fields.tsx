import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue, SelectPopover } from "../../components/ui/select";
import { AdapterMark } from "../../components/AdapterMark";
import { MuseRunnerConnection } from "../../components/MuseRunnerConnection";
import { GrokBotConnection } from "../../components/GrokBotConnection";
import { DotRunnerConnection } from "../../components/DotRunnerConnection";
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
import { useTranslation } from "@/i18n";
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
const defaultOpenCodeRunnerModel = "openrouter/deepseek/deepseek-v4-flash-0731";
const defaultAcpxClaudeModel = "claude-opus-5-5";
const defaultClaudeManagedModel = "claude-sonnet-5";
const defaultAwsAgentCoreModel = "global.anthropic.claude-sonnet-4-6";
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
  const { t } = useTranslation();
  const instructionsFileHint = t("agents.CodexLocalConfigFields.instructionsFileHint");
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
      : { configurable: false, defaultMode: "provider-managed", options: [], description: t("agents.CodexLocalConfigFields.unknownProviderDescription") };
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
  // "automatic" stores no lifecycleMode: the server keeps measured local
  // harnesses warm for the default idle window and runs others turn by turn.
  const runnerLifecycleMode: "automatic" | "per_turn" | "warm" = runnerManaged
    ? isCreate
      ? (values!.paperclipRunnerLifecycleMode ?? "automatic")
      : eff(
          "adapterConfig",
          "lifecycleMode",
          config.lifecycleMode === "warm" || config.lifecycleMode === "per_turn" ? config.lifecycleMode : "automatic",
        ) ?? "automatic"
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
    ? t("agents.CodexLocalConfigFields.fastModeManualModel")
    : fastModeSupported
      ? t("agents.CodexLocalConfigFields.fastModeCreditsWarning")
      : t("agents.CodexLocalConfigFields.fastModeOnlySupportedModels", { models: supportedModelsLabel });
  const runnerHarnessOptions = [
    { value: "codex", label: "Codex", adapter: "codex_local" },
    { value: "opencode", label: "OpenCode 1.18.34", adapter: "opencode_local" },
    { value: "claude_managed", label: "Claude Managed", adapter: "claude_local" },
    { value: "aws_agentcore", label: "AWS AgentCore", adapter: "aws_agentcore" },
    { value: "acpx", label: t("agents.CodexLocalConfigFields.acpAgents"), adapter: "acpx_local" },
    { value: "cursor_cloud", label: t("agents.CodexLocalConfigFields.cursorCloudExperimental"), adapter: "cursor_cloud" },
    { value: "grok", label: "Grok Build", adapter: "grok_local" },
  ];

  return configFieldsForSection(section, (
    <>
      {!hideEngineChoice && (
        <Field
          label={t("agents.CodexLocalConfigFields.executionEngine")}
          hint={t("agents.CodexLocalConfigFields.executionEngineHint")}
        >
          <SelectPopover
            aria-label={t("agents.CodexLocalConfigFields.executionEngine")}
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
              { value: "auto", label: t("agents.CodexLocalConfigFields.defaultAcp") },
              { value: "cli", label: "Codex CLI" },
              { value: "acp", label: "ACP" },
            ]}
          />
        </Field>
      )}
      {runnerManaged && !hideRunnerHarness && !isExternal && (
        <Field configSection="adapter"
          label="Harness"
          hint={t("agents.CodexLocalConfigFields.harnessHint")}
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
            <SelectTrigger className="w-full" aria-label="Harness"><SelectValue /></SelectTrigger>
            <SelectContent>
              {!isPaperclipRunnerProvider(runnerProvider) && <SelectItem value={runnerProvider} disabled>{t("agents.CodexLocalConfigFields.unknownProvider", { provider: runnerProvider })}</SelectItem>}
              {runnerHarnessOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  <AdapterMark type={option.adapter} className="size-4" />
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      )}
      {runnerManaged && runnerProvider === "grok_bot" && <GrokBotConnection companyId={companyId} agentId={agentId} />}
      {runnerManaged && isCursorCloud && <>
        <p className="text-sm text-muted-foreground">{t("agents.CodexLocalConfigFields.cursorCloudNotice")}</p>
        {[
          { key: "repoUrl", label: t("agents.CodexLocalConfigFields.githubRepository"), fallback: "", legacy: undefined, placeholder: "https://github.com/your-org/repo", hint: t("agents.CodexLocalConfigFields.cloudSourceHint") },
          { key: "repoRef", label: t("agents.CodexLocalConfigFields.startingRef"), fallback: config.repoStartingRef ?? "", legacy: "repoStartingRef", placeholder: t("agents.CodexLocalConfigFields.repositoryDefault") },
          { key: "prUrl", label: t("agents.CodexLocalConfigFields.pullRequestUrl"), fallback: config.repoPullRequestUrl ?? "", legacy: "repoPullRequestUrl", placeholder: t("agents.CodexLocalConfigFields.optional") },
          { key: "cloudEnvName", label: t("agents.CodexLocalConfigFields.cursorCloudEnvironment"), fallback: config.runtimeEnvName ?? "", legacy: "runtimeEnvName", placeholder: t("agents.CodexLocalConfigFields.useInsteadOfRepository") },
        ].map(field => <Field key={field.key} configSection="adapter" label={field.label} hint={field.hint}>
          <DraftInput value={String(runnerSchemaValue(field.key, field.fallback))} placeholder={field.placeholder} className={inputClass}
            onCommit={value => {
              if (isCreate) set!({ adapterSchemaValues: { ...values!.adapterSchemaValues, [field.key]: value, ...(field.legacy ? { [field.legacy]: undefined } : {}) } });
              else { if (field.legacy) mark("adapterConfig", field.legacy, undefined); mark("adapterConfig", field.key, value); }
            }} />
        </Field>)}
        {[
          { key: "workOnCurrentBranch", label: t("agents.CodexLocalConfigFields.workOnCurrentBranch") },
          { key: "autoCreatePR", label: t("agents.CodexLocalConfigFields.autoCreatePullRequest") },
          { key: "skipReviewerRequest", label: t("agents.CodexLocalConfigFields.skipReviewerRequest") },
        ].map(field => <ToggleField key={field.key} label={field.label}
          checked={runnerSchemaValue(field.key, false) === true} onChange={value => updateRunnerSchemaValue(field.key, value)} />)}
      </>}
      {runnerManaged && runnerProvider === "openai_dot" && <>
        <Field configSection="adapter" label={t("agents.CodexLocalConfigFields.dotConnection")} hint={t("agents.CodexLocalConfigFields.dotConnectionHint")}>
          <DotRunnerConnection companyId={companyId} agentId={agentId} bindingId={String(runnerSchemaValue("dotBindingId", ""))} onBinding={id => updateRunnerSchemaValue("dotBindingId", id)} />
        </Field>
        <ToggleField label={t("agents.CodexLocalConfigFields.readTaskAttachments")} hint={t("agents.CodexLocalConfigFields.readTaskAttachmentsHint")}
          checked={runnerSchemaValue("dotAttachmentAccess", false) === true} onChange={value => updateRunnerSchemaValue("dotAttachmentAccess", value)} />
        <ToggleField label={t("agents.CodexLocalConfigFields.workspaceFilesAndCommands")} hint={t("agents.CodexLocalConfigFields.workspaceFilesAndCommandsHint")}
          checked={runnerSchemaValue("dotWorkspaceAccess", false) === true} onChange={value => updateRunnerSchemaValue("dotWorkspaceAccess", value)} />
        <ToggleField label={t("agents.CodexLocalConfigFields.allowExternallyBilledProvider")} hint={t("agents.CodexLocalConfigFields.dotAllowExternallyBilledHint")}
          checked={runnerSchemaValue("allowUnmeteredProvider", false) === true} onChange={value => updateRunnerSchemaValue("allowUnmeteredProvider", value)} />
      </>}
      {runnerManaged && isMuse && <>
        <Field configSection="adapter" label={t("agents.CodexLocalConfigFields.museConnection")} hint={t("agents.CodexLocalConfigFields.museConnectionHint")}>
          <MuseRunnerConnection companyId={companyId} agentId={agentId} />
        </Field>
        <ToggleField label={t("agents.CodexLocalConfigFields.allowExternallyBilledProvider")} hint={t("agents.CodexLocalConfigFields.museAllowExternallyBilledHint")}
          checked={runnerSchemaValue("allowUnmeteredProvider", false) === true} onChange={value => updateRunnerSchemaValue("allowUnmeteredProvider", value)} />
      </>}
      {runnerManaged && !hideRunnerHarness && runnerProvider === "acpx" && runnerSchemaValue("acpxAgent", "claude") !== "grok" && (
        <Field configSection="adapter" label={t("agents.CodexLocalConfigFields.acpAgent")} hint={t("agents.CodexLocalConfigFields.acpAgentHint")}>
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
            <SelectTrigger className="w-full" aria-label={t("agents.CodexLocalConfigFields.acpAgent")}><SelectValue /></SelectTrigger>
            <SelectContent>
              {PAPERCLIP_RUNNER_ACPX_PROFILES.map(profile => (
                <SelectItem key={profile.value} value={profile.value} disabled={!profile.qualified}>
                  <AdapterMark type={profile.value === "cursor" ? "cursor" : `${profile.value}_local`} className="size-4" />
                  {profile.label}{profile.qualified ? "" : t("agents.CodexLocalConfigFields.qualificationPending")}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      )}
      {runnerManaged && runnerProvider === "acpx" && runnerSchemaValue("acpxAgent", "claude") === "cursor" && (
        <Field configSection="adapter" label={t("agents.CodexLocalConfigFields.cursorMode")} hint={t("agents.CodexLocalConfigFields.cursorModeHint")}>
          <select className={inputClass} aria-label={t("agents.CodexLocalConfigFields.cursorMode")}
            value={String(runnerSchemaValue("acpxSessionMode", "agent"))}
            onChange={(event) => updateRunnerSchemaValue("acpxSessionMode", event.target.value)}>
            {!["agent", "plan", "ask"].includes(String(runnerSchemaValue("acpxSessionMode", "agent"))) && (
              <option value={String(runnerSchemaValue("acpxSessionMode", "agent"))} disabled>{t("agents.CodexLocalConfigFields.unsupportedSavedCursorMode")}</option>
            )}
            <option value="agent">{t("agents.CodexLocalConfigFields.cursorModeAgent")}</option>
            <option value="plan">{t("agents.CodexLocalConfigFields.cursorModePlan")}</option>
            <option value="ask">{t("agents.CodexLocalConfigFields.cursorModeAsk")}</option>
          </select>
        </Field>
      )}
      {runnerManaged && runnerProvider === "acpx" && runnerSchemaValue("acpxAgent", "claude") === "pi" && (
        <Field configSection="adapter" label={t("agents.CodexLocalConfigFields.piThinkingLevel")} hint={t("agents.CodexLocalConfigFields.piThinkingLevelHint")}>
          <select className={inputClass} aria-label={t("agents.CodexLocalConfigFields.piThinkingLevel")} value={String(runnerSchemaValue("piThinkingLevel", "low"))}
            onChange={(event) => updateRunnerSchemaValue("piThinkingLevel", event.target.value)}>
            {!["off", "low", "high", "max"].includes(String(runnerSchemaValue("piThinkingLevel", "low"))) && <option value={String(runnerSchemaValue("piThinkingLevel", "low"))} disabled>{t("agents.CodexLocalConfigFields.unsupportedThinkingLevel")}</option>}
            <option value="off">{t("agents.CodexLocalConfigFields.thinkingOff")}</option><option value="low">{t("agents.CodexLocalConfigFields.thinkingLow")}</option><option value="high">{t("agents.CodexLocalConfigFields.thinkingHigh")}</option><option value="max">{t("agents.CodexLocalConfigFields.thinkingMax")}</option>
          </select>
        </Field>
      )}
      {runnerManaged && runnerProvider === "claude_managed" && (
        <>
          <Field
            label={t("agents.CodexLocalConfigFields.managedAgentProfile")}
            hint={t("agents.CodexLocalConfigFields.managedAgentProfileHint")}
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
            label={t("agents.CodexLocalConfigFields.sessionSpendCeiling")}
            hint={t("agents.CodexLocalConfigFields.sessionSpendCeilingHint")}
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
            label={t("agents.CodexLocalConfigFields.acknowledgeManagedRetention")}
            hint={t("agents.CodexLocalConfigFields.acknowledgeManagedRetentionHint")}
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
            label={t("agents.CodexLocalConfigFields.agentCoreProfile")}
            hint={t("agents.CodexLocalConfigFields.agentCoreProfileHint")}
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
            label={t("agents.CodexLocalConfigFields.estimatedSessionCeiling")}
            hint={t("agents.CodexLocalConfigFields.estimatedSessionCeilingHint")}
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
            label={t("agents.CodexLocalConfigFields.maximumIterations")}
            hint={t("agents.CodexLocalConfigFields.maximumIterationsHint")}
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
            label={t("agents.CodexLocalConfigFields.maximumOutputTokens")}
            hint={t("agents.CodexLocalConfigFields.maximumOutputTokensHint")}
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
            label={t("agents.CodexLocalConfigFields.invocationTimeout")}
            hint={t("agents.CodexLocalConfigFields.invocationTimeoutHint")}
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
            label={t("agents.CodexLocalConfigFields.acknowledgeMemoryRetention")}
            hint={t("agents.CodexLocalConfigFields.acknowledgeMemoryRetentionHint")}
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
          label={t("agents.CodexLocalConfigFields.permissionMode")}
          hint={t("agents.CodexLocalConfigFields.permissionModeHint", { description: runnerPermissionCapability.description })}
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
            <SelectTrigger aria-label={t("agents.CodexLocalConfigFields.permissionMode")} className="w-full font-sans">
              <SelectValue>
                {runnerPermissionModeUnsupported
                  ? t("agents.CodexLocalConfigFields.unsupportedModeSelectQualified")
                  : runnerPermissionCapability.options.find((option) => option.value === runnerPermissionMode)?.label}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {runnerPermissionModeUnsupported && (
                <SelectItem value="__unsupported__" disabled>
                  {t("agents.CodexLocalConfigFields.unsupportedModeSelectQualified")}
                </SelectItem>
              )}
              {runnerPermissionCapability.options.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {runnerPermissionModeUnsupported && runnerProvider === "codex" && (
            <p className="mt-1 text-xs text-destructive" role="alert">
              {t("agents.CodexLocalConfigFields.savedCodexModeRecovery")}
            </p>
          )}
        </Field>
      )}
      {runnerManaged && !isExternal && !isCursorCloud && (
        <Field configSection="runPolicy"
          label={t("agents.CodexLocalConfigFields.runnerLifecycle")}
          hint={t("agents.CodexLocalConfigFields.runnerLifecycleHint", "Automatic keeps Codex and OpenCode warm on this computer for 5 minutes after a run, so a follow-up starts faster, and runs other harnesses turn by turn. Turn by turn suspends after each run. Warm keeps the same provider process available between governed runs.")}
        >
          <SelectPopover
            aria-label={t("agents.CodexLocalConfigFields.runnerLifecycle")}
            value={runnerLifecycleMode}
            onValueChange={(next) => {
              const value = next === "warm" || next === "per_turn" ? next : undefined;
              isCreate
                ? set!({ paperclipRunnerLifecycleMode: value })
                : mark("adapterConfig", "lifecycleMode", value);
            }}
            options={[
              { value: "automatic", label: t("agents.CodexLocalConfigFields.automatic", "Automatic") },
              { value: "per_turn", label: t("agents.CodexLocalConfigFields.turnByTurn") },
              { value: "warm", label: t("agents.CodexLocalConfigFields.warmSession") },
            ]}
          />
        </Field>
      )}
      {runnerManaged && !isExternal && !isCursorCloud && runnerLifecycleMode === "warm" && (
        <Field configSection="runPolicy"
          label={t("agents.CodexLocalConfigFields.warmIdleTimeout")}
          hint={t("agents.CodexLocalConfigFields.warmIdleTimeoutHint")}
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
              label={t("agents.CodexLocalConfigFields.acpServerCommand")}
              hint={t("agents.CodexLocalConfigFields.acpServerCommandHint")}
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
            label={t("agents.CodexLocalConfigFields.acpSessionMode")}
            hint={t("agents.CodexLocalConfigFields.acpSessionModeHint")}
          >
            <SelectPopover
              aria-label={t("agents.CodexLocalConfigFields.acpSessionMode")}
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
                { value: "persistent", label: t("agents.CodexLocalConfigFields.persistent") },
                { value: "oneshot", label: t("agents.CodexLocalConfigFields.oneShot") },
              ]}
            />
          </Field>
          <Field
            label={t("agents.CodexLocalConfigFields.acpNonInteractivePermissions")}
            hint={t("agents.CodexLocalConfigFields.acpNonInteractivePermissionsHint")}
          >
            <SelectPopover
              aria-label={t("agents.CodexLocalConfigFields.acpNonInteractivePermissions")}
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
                { value: "deny", label: t("agents.CodexLocalConfigFields.deny") },
                { value: "fail", label: t("agents.CodexLocalConfigFields.fail") },
              ]}
            />
          </Field>
          {!managedSandboxOnly && (
            <Field
              label={t("agents.CodexLocalConfigFields.acpStateDirectory")}
              hint={t("agents.CodexLocalConfigFields.acpStateDirectoryHint")}
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
            label={t("agents.CodexLocalConfigFields.acpWarmProcessIdleMs")}
            hint={t("agents.CodexLocalConfigFields.acpWarmProcessIdleMsHint")}
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
        <Field label={t("agents.CodexLocalConfigFields.agentInstructionsFile")} hint={instructionsFileHint}>
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
            label={t("agents.CodexLocalConfigFields.bypassSandbox")}
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
            label={t("agents.CodexLocalConfigFields.enableSearch")}
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
            label={t("agents.CodexLocalConfigFields.fastMode")}
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
