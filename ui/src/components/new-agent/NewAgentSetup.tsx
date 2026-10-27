import { COPILOT_MODEL_DISCOVERY_QUERY_OPTIONS } from "@/lib/copilot-task-model-catalog";
import { ExternalAgentInviteDialog } from "./ExternalAgentInviteDialog";
import { useConnectionModels } from "../ai-connections/useConnectionModels";
import { AgentCharacter } from "../AgentCharacter";
import { useAgentAppearanceDraft } from "../../hooks/useAgentAppearanceDraft";
import { AiConnectionField, aiProviderForAdapter } from "../ai-connections/AiConnectionField";
import type { AiConnectionBinding } from "@paperclipai/shared";
import type { AgentRunner, AgentRunnerChoice } from "@paperclipai/shared";
import { AgentRunnerSelect } from "../AgentRunnerSelect";
import { SelectPopover } from "../ui/select";
import { DEFAULT_CODEX_LOCAL_MODEL } from "@paperclipai/adapter-codex-local";
import {
  SETUP_CREDENTIAL_KEYS,
  SETUP_LOGIN_HINTS,
  setupEfforts,
  setupProviderKeys,
} from "@/lib/agent-setup-fields";
import { testAgentSetup } from "@/lib/test-agent-setup";
import { needsClaudeSetupQualification, qualifyClaudeSetup } from "@/lib/qualify-claude-setup";
import { useCloudInstance } from "@/hooks/useCloudInstance";
import { isNewAgentAdapterAllowed } from "@/lib/new-agent-adapters";
import { useEffect, useRef, useState } from "react";
import { hashKey, useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion, MotionConfig } from "motion/react";
import { ArrowLeft, ArrowRight, Check, Settings2 } from "lucide-react";
import type {
  AdapterEnvironmentTestResult,
  Agent,
  EnvBinding,
} from "@paperclipai/shared";
import { ADAPTER_AUTH_MISSING_CHECK_CODE, paperclipRunnerProfileForHarness } from "@paperclipai/shared";
import { useNavigate, useSearchParams } from "@/lib/router";
import { agentsApi } from "@/api/agents";
import { ApiError } from "@/api/client";
import { adaptersApi } from "@/api/adapters";
import { environmentsApi } from "@/api/environments";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { secretsApi } from "@/api/secrets";
import { useCompany } from "@/context/CompanyContext";
import { useDialogActions } from "@/context/DialogContext";
import { queryKeys } from "@/lib/queryKeys";
import { cn, agentUrl } from "@/lib/utils";
import { getUIAdapter } from "@/adapters";
import { getAdapterDisplay } from "@/adapters/adapter-display-registry";
import {
  resolveAdapterTestEnvironmentId,
  resolveLocalDefaultEnvironmentId,
  resolveManagedSandboxEnvironmentId,
} from "@/lib/adapter-test-environment";
import { resolveForcedKubernetesEnvironment } from "@/lib/forced-kubernetes-environment";
import { environmentDisplayLabel } from "@/lib/managed-sandbox-environment";
import { buildNewAgentRuntimeConfig } from "@/lib/new-agent-runtime-config";
import {
  PROVIDER_ENV_KEYS,
  storeProviderApiKey,
  storeOrganizationApiKey,
} from "@/lib/provider-credential";
import { defaultCreateValues } from "../agent-config-defaults";
import { ModelDropdown } from "../AgentConfigForm";
import { Field, ToggleField } from "../agent-config-primitives";
import { SecretPicker } from "../environment-variables-editor/SecretPicker";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { NativeSelect, nativeSelectClassName } from "../ui/select";
import {
  OnboardingCard,
  OnboardingHeading,
} from "../onboarding/OnboardingPrimitives";
import { stepMotion } from "../onboarding/onboarding-motion";
import { RuntimeTestCard, type TestState } from "../RuntimeTestCard";
import { AgentBasicsDialog, AdapterMark } from "./AgentBasicsDialog";
import {
  AgentProviderConnection,
  type ProviderConnection,
} from "./AgentProviderConnection";
import { adapterCuratesModelOrder } from "../../lib/model-utils";

const controlClass = nativeSelectClassName;
const blocking = (result: AdapterEnvironmentTestResult) =>
  result.status === "fail" ||
  result.checks.some((check) => check.code === ADAPTER_AUTH_MISSING_CHECK_CODE);

export function NewAgentSetup() {
  const { selectedCompanyId } = useCompany();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  if (!selectedCompanyId)
    return (
      <p className="text-sm text-muted-foreground">
        Select an organization to create an agent.
      </p>
    );
  if (params.get("adapterType") === "muse" || params.get("runnerProvider") === "muse") return <ExternalAgentInviteDialog companyId={selectedCompanyId} initialPreset="muse" initialMuseName={params.get("name") ?? ""} onClose={() => navigate("/agents/all")} onBack={() => navigate("/agents/all")} />;
  return (
    <Setup
      key={`${selectedCompanyId}:${params.get("name")}:${params.get("adapterType")}:${params.get("runnerProvider") ?? "codex"}:${params.get("runner") ?? "auto"}`}
      companyId={selectedCompanyId}
      name={params.get("name") ?? ""}
      adapterType={params.get("adapterType") === "paperclip_runner" && ["codex", "claude", "opencode", "pi"].includes(params.get("runnerProvider") ?? "codex") ? params.get("runnerProvider") === "claude" ? "claude_local" : params.get("runnerProvider") === "opencode" ? "opencode_local" : params.get("runnerProvider") === "pi" ? "pi_local" : "codex_local" : params.get("adapterType") ?? ""}
      initialRunner={params.get("runner") ?? (params.get("adapterType") === "paperclip_runner" && ["codex", "claude", "opencode", "pi"].includes(params.get("runnerProvider") ?? "codex") ? "paperclip" : params.has("setupAgentId") && ["codex_local", "claude_local", "opencode_local", "pi_local"].includes(params.get("adapterType") ?? "") ? "legacy" : "auto")}
      preserveNativeHarness={params.get("adapterType") === "paperclip_runner" && ["codex", "claude", "opencode", "pi"].includes(params.get("runnerProvider") ?? "codex")}
      runnerProvider={params.get("runnerProvider") ?? "codex"}
      createdAgentId={params.get("createdAgentId")}
      setupAgentId={params.get("setupAgentId")}
    />
  );
}

function Setup({
  companyId,
  name,
  adapterType,
  runnerProvider,
  initialRunner,
  preserveNativeHarness,
  createdAgentId,
  setupAgentId,
}: {
  companyId: string;
  name: string;
  adapterType: string;
  runnerProvider: string;
  initialRunner: string;
  preserveNativeHarness: boolean;
  createdAgentId: string | null;
  setupAgentId: string | null;
}) {
  const navigate = useNavigate();
  const cache = useQueryClient();
  const { openNewIssue } = useDialogActions();
  const appearanceDraft = useAgentAppearanceDraft(`${companyId}:new-agent`);
  const [runner, setRunner] = useState<AgentRunnerChoice>(initialRunner === "legacy" || initialRunner === "paperclip" ? initialRunner : "auto");
  const isRunner = adapterType === "paperclip_runner";
  const isDot = isRunner && runnerProvider === "openai_dot";
  const brandType = isDot ? "openai_dot" : isRunner
    ? runnerProvider === "copilot"
      ? "copilot_runtime"
      : runnerProvider === "grok"
      ? "grok_local"
      : runnerProvider === "claude"
      ? "claude_local"
      : runnerProvider === "opencode"
        ? "opencode_local"
        : runnerProvider === "pi" ? "pi_local" : runnerProvider === "codex" ? "codex_local" : runnerProvider
    : adapterType;
  const connectionAdapter =
    brandType === "claude_local" || brandType === "codex_local" || brandType === "grok_local"
      ? brandType
      : null;
  const multiProvider =
    brandType === "opencode_local" || brandType === "pi_local";
  const providerKeys = setupProviderKeys(brandType);
  const chooseProvider = multiProvider || brandType === "hermes_local";
  const hasCredentialField =
    chooseProvider || Boolean(SETUP_CREDENTIAL_KEYS[adapterType]);
  const showModel = !isDot && !["cursor_cloud", "hermes_gateway"].includes(adapterType);
  const [allowUnmeteredProvider, setAllowUnmeteredProvider] = useState(false);
  const [gatewayUrl, setGatewayUrl] = useState("");
  const [kimiModel, setKimiModel] = useState("");
  const [kimiBaseUrl, setKimiBaseUrl] = useState("");
  const [kimiProtocol, setKimiProtocol] = useState("kimi");
  const [screen, setScreen] = useState<"connect" | "runtime" | "saved">(
    createdAgentId ? "saved" : connectionAdapter ? "connect" : "runtime",
  );
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [modelOpen, setModelOpen] = useState(false);
  const [environmentOverride, setEnvironmentOverride] = useState("");
  const [provider, setProvider] = useState("openrouter");
  const [apiKey, setApiKey] = useState("");
  const [providerBinding, setProviderBinding] = useState<EnvBinding | null>(
    null,
  );
  const [runtimeAiBinding, setRuntimeAiBinding] = useState<AiConnectionBinding | undefined>(() =>
    brandType === "copilot_runtime"
      ? { provider: "github", method: "api_key", mode: "responsible_user" }
      : brandType === "opencode_local"
      ? { provider: "openrouter", method: "api_key", mode: "responsible_user" }
      : undefined,
  );
  const [connection, setConnection] = useState<ProviderConnection | null>(null);
  const aiBinding = runtimeAiBinding ?? connection?.aiConnection;
  const connectionModels = useConnectionModels(companyId, aiBinding, brandType);
  const [repository, setRepository] = useState("");
  const [branch, setBranch] = useState("");
  const [createdInSession, setCreated] = useState<Agent | null>(null);
  const setupId = useRef(setupAgentId ?? crypto.randomUUID());
  if (setupAgentId) setupId.current = setupAgentId;
  const creating = useRef(false);
  const restored = useRef<string | null>(null);
  const [creationAttempt, setCreationAttempt] = useState(0);
  const recordId = createdAgentId ?? setupAgentId;
  const currentCreated = !recordId || createdInSession?.id === recordId ? createdInSession : null;
  const savedAgent = useQuery({
    queryKey: queryKeys.agents.detail(recordId ?? "new"),
    queryFn: () => agentsApi.get(recordId!, companyId),
    enabled: Boolean(recordId) && !creating.current,
    refetchInterval: query => query.state.data?.pauseReason === "setup"
      && ["preparing", "pausing"].includes(query.state.data.lifecycleState ?? "") && !query.state.data.lifecycleError ? 1000 : false,
    retry: false,
  });
  const created =
    (savedAgent.data?.companyId === companyId ? savedAgent.data : null) ?? currentCreated;
  const completed = Boolean(created && created.pauseReason !== "setup");
  useEffect(() => {
    if (brandType !== "pi_local" || created?.adapterType !== "paperclip_runner"
      || created.runtimeConfig.aiConnection) return;
    const env = (created.adapterConfig.env ?? {}) as Record<string, unknown>;
    if (Object.values(PROVIDER_ENV_KEYS).some(key => env[key] !== undefined)) return;
    setRuntimeAiBinding(current => current ?? { provider: "openrouter", method: "api_key", mode: "responsible_user" });
  }, [brandType, created?.id, created?.adapterType]);
  const savedNativeMultiProvider = multiProvider && (Boolean(setupAgentId) || runner === "legacy")
    && created?.adapterType === "paperclip_runner";
  const requestAdapterType = savedNativeMultiProvider || (preserveNativeHarness && runner === "paperclip")
    ? "paperclip_runner" : adapterType;
  const [saving, setSaving] = useState(false);
  const [testState, setTestState] = useState<TestState | "warn">("idle");
  const [result, setResult] = useState<AdapterEnvironmentTestResult | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [environmentSaving, setEnvironmentSaving] = useState(false);
  const [environmentSaveError, setEnvironmentSaveError] = useState<string | null>(null);
  const generation = useRef(0);
  const qualificationTransition = useRef<{ run: number; companyId: string; environmentId: string | null; runner: AgentRunner } | null>(null);
  const savingRef = useRef(false);
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  const resetTest = () => {
    qualificationTransition.current = null;
    generation.current++;
    setResult(null);
    setTestState("idle");
    setError(null);
  };
  const editConnection = () => {
    setConnection(null);
    setRuntimeAiBinding(undefined);
    resetTest();
    setScreen("connect");
  };
  const adapterInventory = useQuery({
    queryKey: queryKeys.adapters.all,
    queryFn: () => adaptersApi.list(),
  });
  const agents = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
  });
  const envs = useQuery({
    queryKey: queryKeys.environments.list(companyId),
    queryFn: () => environmentsApi.list(companyId),
  });
  const settings = useQuery({
    queryKey: queryKeys.instance.settings,
    queryFn: instanceSettingsApi.get,
  });
  const experimental = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: instanceSettingsApi.getExperimental,
  });
  const general = useQuery({
    queryKey: queryKeys.instance.generalSettings,
    queryFn: instanceSettingsApi.getGeneral,
  });
  const caps = useQuery({
    queryKey: queryKeys.environments.capabilities(companyId),
    queryFn: () => environmentsApi.capabilities(companyId),
  });
  const companySecrets = useQuery({
    queryKey: queryKeys.secrets.list(companyId),
    queryFn: () => secretsApi.list(companyId),
    enabled: hasCredentialField && adapterType !== "cursor_cloud",
  });
  const userSecrets = useQuery({
    queryKey: queryKeys.secrets.myUserSecrets(companyId),
    queryFn: () => secretsApi.listMyUserSecrets(companyId),
    enabled: hasCredentialField && adapterType !== "cursor_cloud",
    retry: false,
  });
  const forced = resolveForcedKubernetesEnvironment(
    general.data?.executionMode,
    envs.data ?? [],
  );
  const managedOnly = experimental.data?.enableManagedSandboxOnly === true;
  let environmentId: string | null = null;
  let environmentError: string | null = null;
  try {
    environmentId = forced.forced
      ? (forced.kubernetesEnvironment?.id ?? null)
      : resolveAdapterTestEnvironmentId({
          agentDefaultEnvironmentId: environmentOverride || null,
          instanceDefaultEnvironmentId:
            settings.data?.defaultEnvironmentId ?? null,
          localDefaultEnvironmentId: resolveLocalDefaultEnvironmentId(
            envs.data ?? [],
          ),
          managedSandboxOnly: managedOnly,
          managedSandboxEnvironmentId: resolveManagedSandboxEnvironmentId(
            envs.data ?? [],
          ),
          visibleEnvironmentIds: (envs.data ?? []).map((env) => env.id),
        });
  } catch (cause) {
    environmentError =
      cause instanceof Error
        ? cause.message
        : "Could not resolve the environment.";
  }
  const requestCopilotModels = brandType === "copilot_runtime" && showModel && !connectionModels && Boolean(aiBinding)
    && envs.isSuccess && settings.isSuccess && experimental.isSuccess && general.isSuccess && !environmentError;
  const copilotModelScope = JSON.stringify([companyId, environmentId, aiBinding]);
  const models = useQuery({
    queryKey: queryKeys.agents.adapterModels(companyId, brandType, environmentId, brandType === "copilot_runtime" ? JSON.stringify(aiBinding ?? null) : aiBinding?.provider),
    queryFn: () => agentsApi.adapterModels(companyId, brandType === "copilot_runtime" ? "paperclip_runner" : brandType, brandType === "copilot_runtime"
      ? { provider: "acpx", acpxAgent: "copilot", aiConnection: aiBinding, environmentId }
      : { provider: aiBinding?.provider, environmentId }),
    ...(brandType === "copilot_runtime" ? COPILOT_MODEL_DISCOVERY_QUERY_OPTIONS : {}),
    enabled: Boolean(brandType) && showModel && !connectionModels && (brandType !== "copilot_runtime" || requestCopilotModels),
    retry: false,
  });
  const refreshCopilotModels = models.refetch;
  useEffect(() => {
    if (requestCopilotModels) void refreshCopilotModels();
  }, [requestCopilotModels, copilotModelScope, refreshCopilotModels]);
  const environment = envs.data?.find((env) => env.id === environmentId);
  const setupEnvironmentKey = JSON.stringify([companyId, environmentId, environment?.config]);
  const setupEnvironmentRef = useRef("");
  setupEnvironmentRef.current = setupEnvironmentKey;
  useEffect(() => { resetTest(); }, [setupEnvironmentKey]);
  const adapters = useQuery({
    queryKey: queryKeys.adapters.availability(companyId, environmentId),
    queryFn: () => adaptersApi.list({ companyId, environmentId }),
  });
  const defaultRunner = adapters.data?.find(adapter => adapter.type === adapterType)?.defaultRunner;
  const efforts = brandType === "pi_local" && (runner === "paperclip" || (runner === "auto" && defaultRunner === "paperclip"))
    ? ["off", "low", "high", "max"] : isRunner ? [] : setupEfforts(adapterType, model);
  useEffect(() => {
    const transition = qualificationTransition.current;
    if (transition?.run === generation.current && transition.companyId === companyId
      && transition.environmentId === environmentId && transition.runner === defaultRunner) return;
    resetTest();
  }, [companyId, environmentId, runner === "auto" ? defaultRunner : undefined]);
  const sandboxProvider =
    typeof environment?.config?.provider === "string"
      ? environment.config.provider
      : "";
  const canLogin =
    environment?.driver === "sandbox" &&
    caps.data?.sandboxProviders?.[sandboxProvider]?.supportsLoginPty === true;
  const envKey =
    SETUP_CREDENTIAL_KEYS[adapterType] ?? providerKeys[provider] ?? "API_KEY";
  const savedKey = userSecrets.data?.find(
    (entry) => entry.definition.key === envKey && entry.secret,
  );
  const savedOrganizationKey = companySecrets.data?.find(
    (entry) => entry.key === envKey && entry.status === "active",
  );
  const selectedBinding =
    adapterType === "cursor_cloud"
      ? null
      : (providerBinding ??
        (savedOrganizationKey
          ? {
              type: "secret_ref" as const,
              secretId: savedOrganizationKey.id,
              version: "latest" as const,
            }
          : savedKey
            ? {
                type: "user_secret_ref" as const,
                key: envKey,
                version: "latest" as const,
              }
            : null));
  const usingKimiApi =
    adapterType === "kimi_local" && Boolean(apiKey.trim() || selectedBinding);
  const cloud = Boolean(useCloudInstance());
  const available =
    isNewAgentAdapterAllowed(adapterType, {
      cloud,
      nativeRunnerEnabled: experimental.data?.enableNativeRunner === true,
      openAiDotEnabled: experimental.data?.enableOpenAiDot === true,
      runnerProvider,
    }) &&
    adapterInventory.data?.some(
      (adapter) =>
        adapter.type === adapterType &&
        adapter.loaded &&
        !adapter.disabled &&
        !getAdapterDisplay(adapterType).comingSoon,
    ) && (requestAdapterType !== "paperclip_runner" || adapterType === "paperclip_runner" || adapterInventory.data?.some(adapter => adapter.type === "paperclip_runner" && adapter.loaded && !adapter.disabled));
  const connectionSettingsReady = Boolean(
    available &&
    (!["codex_local", "claude_local", "opencode_local", "pi_local"].includes(adapterType) || runner !== "auto" || Boolean(adapters.data)) &&
    !environmentError &&
    !envs.isPending &&
    !settings.isPending &&
    !experimental.isPending &&
    !general.isPending &&
    !agents.isPending &&
    !caps.isPending &&
    !envs.error &&
    !settings.error &&
    !experimental.error &&
    !general.error &&
    !agents.error &&
    !caps.error &&
    (!(managedOnly || forced.forced) || environmentId),
  );
  const needsCurrentSetup = ["codex_local", "claude_local", "opencode_local", "pi_local"].includes(adapterType);
  const preparingComputer = created?.pauseReason === "setup" && ["preparing", "pausing"].includes(created.lifecycleState ?? "");
  const environmentSelectionSaved = (!environmentOverride && created?.defaultEnvironmentId == null)
    || (created?.defaultEnvironmentId ?? null) === (environmentOverride || (forced.forced || managedOnly ? environmentId : null));
  const ready = Boolean(created) && environmentSelectionSaved && !environmentSaving && !preparingComputer && connectionSettingsReady && (!needsCurrentSetup || (
    envs.isSuccess && !envs.isFetching
    && settings.isSuccess && !settings.isFetching
    && experimental.isSuccess && !experimental.isFetching
    && general.isSuccess && !general.isFetching
    && (runner !== "auto" || (adapters.isSuccess && !adapters.isFetching))
  ));
  const busy = testState === "running" || saving || environmentSaving;

  function buildConfig(
    nextConnection = connection,
    binding = selectedBinding,
    setupRunner?: AgentRunner,
  ): Record<string, unknown> {
    const values = {
      ...defaultCreateValues,
      adapterType,
      runner,
      resolvedRunner: runner === "auto" ? setupRunner ?? defaultRunner : runner,
      model:
        model || (brandType === "codex_local" ? DEFAULT_CODEX_LOCAL_MODEL : ""),
      thinkingEffort: effort,
      dangerouslyBypassSandbox: adapterType === "codex_local" && runner === "legacy",
      envBindings: nextConnection?.env ?? {},
      ...(isRunner
        ? {
            adapterSchemaValues: {
              provider: ["claude", "grok", "copilot", "pi"].includes(runnerProvider) ? "acpx" : runnerProvider,
              ...(isDot ? { allowUnmeteredProvider } : {}),
              ...(["claude", "grok", "copilot", "pi"].includes(runnerProvider) ? { acpxAgent: runnerProvider } : {}),
            },
          }
        : {}),
    };
    const profile = paperclipRunnerProfileForHarness(brandType);
    const nativeSchema = profile ? {
      ...profile,
      ...(profile.provider === "acpx" ? { acpxPermissionMode: "approve-all" } : {}),
      ...(brandType === "pi_local" && effort ? { piThinkingLevel: effort } : {}),
    } : {};
    const config = getUIAdapter(preserveNativeHarness && runner === "paperclip" && brandType !== "pi_local" ? "paperclip_runner" : adapterType).buildAdapterConfig(preserveNativeHarness && runner === "paperclip" ? { ...values, adapterSchemaValues: nativeSchema } : values);
    if (preserveNativeHarness && runner === "paperclip" && profile) {
      Object.assign(config, nativeSchema, profile.provider === "opencode" ? { opencodePermissionMode: "allow" } : profile.provider === "codex" ? { codexPermissionMode: "never" } : {}, { lifecycleMode: "per_turn" });
    }
    if (isRunner)
      Object.assign(config, {
        provider: ["claude", "grok", "copilot", "pi"].includes(runnerProvider) ? "acpx" : runnerProvider,
        ...(["claude", "grok", "copilot", "pi"].includes(runnerProvider) ? { acpxAgent: runnerProvider } : {}),
        ...(model ? { model } : {}),
      });
    if (multiProvider && created) {
      // The simplified setup page does not edit these saved runtime policies.
      const saved = created.adapterConfig;
      for (const [key, value] of Object.entries(saved)) {
        if (!(key in config)) config[key] = value;
      }
      for (const key of ["dangerouslySkipPermissions", "opencodePermissionMode", "acpxPermissionMode", "acpxSessionMode", "lifecycleMode", "idleTimeoutMs"]) {
        if (saved[key] !== undefined) config[key] = saved[key];
      }
      if (brandType === "pi_local" && created.adapterType === "paperclip_runner" && runner !== "legacy" && effort) {
        config.piThinkingLevel = effort;
        delete config.thinking;
      }
      config.model = model;
      config.env = { ...((saved.env as object) ?? {}), ...((config.env as object) ?? {}) };
    }
    if (!aiBinding && !nextConnection?.aiConnection && hasCredentialField && binding) {
      if (adapterType === "hermes_gateway") config.apiKey = binding;
      else
        config.env = { ...((config.env as object) ?? {}), [envKey]: binding };
    }
    if (adapterType === "cursor_cloud")
      Object.assign(config, {
        repoUrl: repository.trim(),
        ...(branch.trim() ? { repoStartingRef: branch.trim() } : {}),
      });
    if (adapterType === "hermes_gateway") config.apiBaseUrl = gatewayUrl.trim();
    if (usingKimiApi) {
      // --model overrides Kimi's environment-defined model. Let KIMI_MODEL_NAME win.
      delete config.model;
      config.kimiApi = { model: kimiModel.trim(), protocol: kimiProtocol, baseUrl: kimiBaseUrl.trim() };
      config.env = {
        ...((config.env as object) ?? {}),
        KIMI_MODEL_NAME: { type: "plain", value: kimiModel.trim() },
        KIMI_MODEL_PROVIDER_TYPE: { type: "plain", value: kimiProtocol },
        ...(kimiBaseUrl.trim()
          ? {
              KIMI_MODEL_BASE_URL: { type: "plain", value: kimiBaseUrl.trim() },
            }
          : {}),
      };
    }
    return config;
  }
  function preparedConfig(nextConnection = connection, setupRunner?: AgentRunner) {
    if (brandType === "copilot_runtime" && !models.data?.some(candidate => candidate.id === model))
      throw new Error("Refresh Copilot models and select an available model before creating this agent.");
    if (isDot && !allowUnmeteredProvider) throw new Error("Acknowledge external provider billing before creating your Dot agent.");
    if (multiProvider && (!model.trim() || !model.includes("/")))
      throw new Error("Choose or enter a model in provider/model format.");
    if (
      adapterType === "cursor_cloud" &&
      !/^https:\/\/github\.com\/[^/]+\/[^/]+/.test(repository.trim())
    )
      throw new Error("Enter a GitHub repository URL.");
    if (
      ["cursor_cloud", "hermes_gateway"].includes(adapterType) &&
      !apiKey.trim() &&
      !selectedBinding
    )
      throw new Error(
        adapterType === "cursor_cloud"
          ? "Enter a Cursor API key."
          : `Enter ${envKey} or select an organization secret.`,
      );
    if (adapterType === "hermes_gateway") {
      try {
        const url = new URL(gatewayUrl.trim());
        if (!["https:", "http:"].includes(url.protocol)) throw new Error();
      } catch {
        throw new Error("Enter the Hermes API base URL.");
      }
    }
    if (usingKimiApi && !kimiModel.trim())
      throw new Error("Enter the Kimi API model name.");
    return buildConfig(nextConnection, selectedBinding, setupRunner);
  }
  function pendingCredentials(nextConnection = connection) {
    if (aiBinding || nextConnection?.aiConnection) return {};
    return {
      ...nextConnection?.credentials,
      ...(hasCredentialField && apiKey.trim()
        ? { [envKey]: apiKey.trim() }
        : {}),
    };
  }

  useEffect(() => {
    if (!name || !adapterType || !connectionSettingsReady || createdAgentId || created || creating.current
      || (setupAgentId && !savedAgent.isError)) return;
    if (savedAgent.error && (!(savedAgent.error instanceof ApiError) || savedAgent.error.status !== 404)) return;
    creating.current = true;
    setError(null);
    navigate(`/agents/new?${new URLSearchParams({ name, adapterType, runnerProvider,
      runner, setupAgentId: setupId.current })}`, { replace: true });
    const existing = agents.data ?? [];
    const leader = existing.find(agent => agent.role === "ceo" && agent.status !== "terminated");
    void agentsApi.create(companyId, {
      setupId: setupId.current, name, appearance: appearanceDraft.appearance,
      role: existing.length ? "general" : "ceo", ...(leader ? { reportsTo: leader.id } : {}),
      adapterType: requestAdapterType, runner,
      adapterConfig: requestAdapterType === "paperclip_runner" ? {
        provider: ["claude", "grok", "copilot", "pi"].includes(runnerProvider) ? "acpx" : runnerProvider,
        ...(["claude", "grok", "copilot", "pi"].includes(runnerProvider) ? { acpxAgent: runnerProvider } : {}),
      } : {}, defaultEnvironmentId: environmentOverride || (forced.forced || managedOnly ? environmentId : null),
      runtimeConfig: buildNewAgentRuntimeConfig({ heartbeatEnabled: false }),
    }).then(async agent => {
      await cache.cancelQueries({ queryKey: queryKeys.agents.detail(agent.id) });
      setCreated(agent);
      cache.setQueryData(queryKeys.agents.detail(agent.id), agent);
      void cache.invalidateQueries({ queryKey: queryKeys.agents.list(companyId) });
    }).catch(cause => setError(cause instanceof Error ? cause.message : "Could not create the agent."))
      .finally(() => { creating.current = false; });
  }, [name, adapterType, companyId, connectionSettingsReady, creationAttempt, createdAgentId, setupAgentId, savedAgent.isError, created]);

  useEffect(() => {
    if (!savedAgent.data || restored.current === savedAgent.data.id || savedAgent.data.companyId !== companyId) return;
    restored.current = savedAgent.data.id;
    const agent = savedAgent.data;
    if (agent.pauseReason !== "setup") { setScreen("saved"); return; }
    const config = agent.adapterConfig;
    if (multiProvider) setRunner(agent.adapterType === "paperclip_runner" ? "paperclip" : "legacy");
    setModel(typeof config.model === "string" ? config.model : "");
    setEffort(String(config.modelReasoningEffort ?? config.reasoningEffort ?? config.effort ?? config.thinkingEffort ?? config.piThinkingLevel ?? config.thinking ?? ""));
    setEnvironmentOverride(agent.defaultEnvironmentId ?? "");
    setRepository(typeof config.repoUrl === "string" ? config.repoUrl : "");
    setBranch(typeof config.repoStartingRef === "string" ? config.repoStartingRef : "");
    setGatewayUrl(typeof config.apiBaseUrl === "string" ? config.apiBaseUrl : "");
    setAllowUnmeteredProvider(config.allowUnmeteredProvider === true);
    const kimiApi = config.kimiApi as { model?: string; protocol?: string; baseUrl?: string } | undefined;
    setKimiModel(kimiApi?.model ?? "");
    setKimiProtocol(kimiApi?.protocol ?? "kimi");
    setKimiBaseUrl(kimiApi?.baseUrl ?? "");
    const env = typeof config.env === "object" && config.env !== null ? config.env as Record<string, unknown> : {};
    const providerEntry = Object.entries(providerKeys).find(([, key]) => env[key]);
    if (providerEntry) setProvider(providerEntry[0]);
    const credential = config.apiKey ?? env[providerEntry?.[1] ?? envKey];
    if (credential && typeof credential === "object" && "type" in credential
      && ["secret_ref", "user_secret_ref"].includes(String(credential.type))) setProviderBinding(credential as EnvBinding);
    const binding = agent.runtimeConfig.aiConnection as AiConnectionBinding | undefined;
    if (binding && connectionAdapter) setConnection({ env: {}, aiConnection: binding });
    else if (binding) setRuntimeAiBinding(binding);
    setScreen(binding || !connectionAdapter ? "runtime" : "connect");
  }, [savedAgent.data, companyId, connectionAdapter, brandType]);

  async function saveDraft(nextConnection = connection, exit = false, testedConfig?: Record<string, unknown>, selectedEnvironment = environmentOverride) {
    if (!created || completed) return;
    const binding = runtimeAiBinding ?? nextConnection?.aiConnection;
    const config = testedConfig ?? buildConfig(nextConnection);
    const staged: Array<{ remove: () => Promise<unknown> }> = [];
    let submitted = false;
    const rememberCredentials = () => {
      if (!staged.length) return;
      setApiKey("");
      setProviderBinding((adapterType === "hermes_gateway" ? config.apiKey : (config.env as Record<string, EnvBinding>)?.[envKey]) as EnvBinding);
    };
    try {
      for (const [key, value] of Object.entries(pendingCredentials(nextConnection))) {
        const secret = await (connectionAdapter ? storeProviderApiKey : storeOrganizationApiKey)(companyId, key, value);
        staged.push(secret);
        if (adapterType === "hermes_gateway" && key === "API_SERVER_KEY") config.apiKey = secret.binding;
        else config.env = { ...((config.env as object) ?? {}), [key]: secret.binding };
      }
      submitted = true;
      const agent = await agentsApi.update(created.id, {
        adapterType: requestAdapterType, runner, adapterConfig: config,
        defaultEnvironmentId: selectedEnvironment || (forced.forced || managedOnly ? environmentId : null),
        runtimeConfig: { ...created.runtimeConfig, ...(binding ? { aiConnection: binding } : {}) },
        ...(nextConnection?.applyStoredClaudeLogin ? { applyStoredClaudeLogin: true } : {}),
      }, companyId);
      rememberCredentials();
      await cache.cancelQueries({ queryKey: queryKeys.agents.detail(agent.id) });
      setCreated(agent);
      cache.setQueryData(queryKeys.agents.detail(agent.id), agent);
      if (exit) navigate("/agents/all");
      return agent;
    } catch (cause) {
      if (submitted && !(cause instanceof ApiError && cause.status >= 400 && cause.status < 500 && cause.status !== 408)) {
        rememberCredentials();
      } else {
        try { await Promise.all(staged.map(secret => secret.remove())); }
        catch { throw new Error(`${cause instanceof Error ? cause.message : "Could not save agent setup."} Could not remove an unused setup credential. Remove it from Secrets before retrying.`); }
      }
      throw cause;
    }
  }

  async function saveAndExit() {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try { await saveDraft(connection, true); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save agent setup."); }
    finally { savingRef.current = false; setSaving(false); }
  }

  async function changeEnvironment(selected = environmentOverride) {
    setEnvironmentOverride(selected);
    resetTest();
    setEnvironmentSaving(true);
    setEnvironmentSaveError(null);
    try { await saveDraft(connection, false, undefined, selected); }
    catch (cause) { setEnvironmentSaveError(cause instanceof Error ? cause.message : "Could not save the environment."); }
    finally { setEnvironmentSaving(false); }
  }

  async function runTest(nextConnection = connection): Promise<Record<string, unknown> | null> {
    if (!ready) return null;
    const run = ++generation.current;
    const setupEnvironment = setupEnvironmentRef.current;
    setTestState("running");
    setResult(null);
    setError(null);
    try {
      preparedConfig(nextConnection);
      const selection = { adapterType, runner, savedAgentId: completed ? createdAgentId : null, environment };
      const qualified = await qualifyClaudeSetup({ ...selection,
        readAdapters: () => adaptersApi.list({ companyId, environmentId }),
        probeEnvironment: () => environmentsApi.probe(environmentId!, companyId),
        isCurrent: () => run === generation.current && setupEnvironmentRef.current === setupEnvironment,
      });
      if (run !== generation.current || setupEnvironmentRef.current !== setupEnvironment
        || (needsClaudeSetupQualification(selection) && !qualified)) return null;
      if (qualified) {
        qualificationTransition.current = { run, companyId, environmentId, runner: qualified.runner };
        cache.setQueryData(queryKeys.adapters.availability(companyId, environmentId), qualified.adapters);
      }
      const config = preparedConfig(nextConnection, qualified?.runner);
      const tested = await testAgentSetup({
        companyId,
        agentId: created?.id,
        adapterType: requestAdapterType,
        providerAdapter: brandType,
        ...(["codex_local", "claude_local", "opencode_local", "pi_local"].includes(adapterType) && (qualified || runner !== "auto") ? { runner: qualified?.runner ?? runner } : {}),
        adapterConfig: config,
        testCredentials: pendingCredentials(nextConnection),
        aiConnection: runtimeAiBinding ?? nextConnection?.aiConnection,
        environmentId,
      });
    if (run !== generation.current) return null;
      setResult(tested);
      setTestState(blocking(tested) ? "fail" : tested.status);
      return (
        !blocking(tested) &&
        (tested.checks.some(check => check.code === "environment_agent_approval_required") || !connectionAdapter ||
          tested.checks.some((check) =>
            check.code.endsWith("hello_probe_passed") || check.code === "ai_connection_api_key_reverified",
          ))
      ) ? config : null;
    } catch (cause) {
      if (run === generation.current) {
        setError(
          cause instanceof Error ? cause.message : "Could not test the agent.",
        );
        setTestState("fail");
      }
      return null;
    }
  }
  async function finish() {
    if (
      savingRef.current ||
      completed ||
      !created ||
      !ready ||
      !name.trim() ||
      testState === "running" ||
      testState === "fail" ||
      (connectionAdapter && !connection)
    )
      return;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      const credentials = pendingCredentials();
      const config = (connectionAdapter && testState === "idle") || Object.keys(credentials).length
        ? await runTest()
        : preparedConfig();
      if (!config) return;
      if (Object.keys(credentials).length) await saveDraft(connection, false, config);
      const response = await agentsApi.hire(companyId, {
        setupAgentId: created.id,
        name: created.name,
        appearance: created.appearance ?? appearanceDraft.appearance,
        role: created.role,
        reportsTo: created.reportsTo,
        adapterType: requestAdapterType,
        ...(["codex_local", "claude_local", "opencode_local", "pi_local"].includes(adapterType) && runner !== "auto" ? { runner } : {}),
        adapterConfig: config,
        defaultEnvironmentId:
          environmentOverride ||
          (forced.forced || managedOnly ? environmentId : null),
        runtimeConfig: { ...buildNewAgentRuntimeConfig({ heartbeatEnabled: false }), ...(aiBinding ? { aiConnection: aiBinding } : {}) },
        budgetMonthlyCents: 0,
        ...(connection?.storedSessionId
          ? { storedSessionId: connection.storedSessionId }
          : {}),
        ...(connection?.applyStoredClaudeLogin
          ? { applyStoredClaudeLogin: true }
          : {}),
      });
      setApiKey("");
      setConnection(null);
      await cache.cancelQueries({ queryKey: queryKeys.agents.detail(response.agent.id) });
      setCreated(response.agent);
      appearanceDraft.clear();
      setScreen("saved");
      navigate(
        `/agents/new?${new URLSearchParams({ name: response.agent.name, adapterType, runnerProvider, ...(runner !== "auto" ? { runner } : {}), createdAgentId: response.agent.id })}`,
        { replace: true },
      );
      cache.setQueryData(
        queryKeys.agents.detail(response.agent.id),
        response.agent,
      );
      await Promise.all([
        cache.invalidateQueries({ queryKey: queryKeys.agents.list(companyId) }),
        cache.invalidateQueries({
          queryKey: queryKeys.approvals.list(companyId),
        }),
      ]);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not create the agent.",
      );
    } finally {
      void cache.invalidateQueries({
        queryKey: queryKeys.secrets.myUserSecrets(companyId),
      });
      void cache.invalidateQueries({
        queryKey: queryKeys.secrets.list(companyId),
      });
      savingRef.current = false;
      setSaving(false);
    }
  }
  if (recordId && !created && !creating.current && savedAgent.error && !(savedAgent.error instanceof ApiError && savedAgent.error.status === 404))
    return (
      <p
        role={savedAgent.error ? "alert" : "status"}
        className="text-sm text-muted-foreground"
      >
        {savedAgent.error
          ? "Could not load the created agent. Return to Agents to view it."
          : "Loading your agent…"}
      </p>
    );
  if (!name || !adapterType || created?.metadata?.setupAdapterPending === true)
    return (
      <AgentBasicsDialog
        open
        initialAdapter={created?.metadata?.setupAdapterPending ? "" : adapterType}
        initialName={created?.name ?? name}
        setupAgentId={created?.metadata?.setupAdapterPending ? created.id : setupAgentId ?? undefined}
        onClose={() => navigate("/agents/all")}
        onContinue={(basics) =>
          navigate(`/agents/new?${new URLSearchParams(basics)}`, {
            replace: true,
          })
        }
      />
    );
  if (!created && connectionSettingsReady) return <div className="space-y-4">
    <p role={error ? "alert" : "status"}>{error ?? "Creating your agent…"}</p>
    {error && <Button onClick={() => setCreationAttempt(value => value + 1)}>Retry</Button>}
  </div>;
  const steps = [
    ...(connectionAdapter ? ["connect" as const] : []),
    "runtime" as const,
    "saved" as const,
  ];
  const labels = {
    connect: "Connect",
    runtime: "Configure",
    saved: "Confirmation",
  };
  const confirmationEnvironment = created?.defaultEnvironmentId
    ? envs.data?.find((env) => env.id === created.defaultEnvironmentId)
    : environment;
  const createdKimiModel = (
    created?.adapterConfig?.env as Record<string, unknown> | undefined
  )?.KIMI_MODEL_NAME;
  const confirmationModel =
    created?.adapterConfig?.model ||
    (created?.adapterConfig?.kimiApi as { model?: string } | undefined)?.model ||
    (typeof createdKimiModel === "string"
      ? createdKimiModel
      : (createdKimiModel as { value?: string } | undefined)?.value) ||
    model ||
    "Default";
  const environmentLabel =
    adapterType === "cursor_cloud"
      ? "Cursor Cloud"
      : adapterType === "hermes_gateway"
        ? "Hermes Gateway"
        : confirmationEnvironment
          ? environmentDisplayLabel(confirmationEnvironment)
          : "Local machine";
  const setupError =
    adapters.error ??
    adapterInventory.error ??
    envs.error ??
    settings.error ??
    experimental.error ??
    general.error ??
    agents.error ??
    caps.error;
  return (
    <MotionConfig reducedMotion="user">
      <div className="mx-auto flex max-w-5xl flex-col gap-8 py-6">
        <header className="flex items-center gap-4">
          <AgentCharacter appearance={created?.appearance ?? appearanceDraft.appearance} size={256} className="size-48" trackingScope="page"
            state={completed || testState === "pass" ? "success" : testState === "running" ? "loading" : "sleepy"}
            muted={!completed && testState !== "pass"} />
          <div className="space-y-2">
            <h1 className="text-2xl font-semibold tracking-tight">{name}</h1>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <AdapterMark type={brandType} />
              <span>{getAdapterDisplay(brandType).label}</span>
              {isRunner && !isDot && (
                <span>
                  ·{" "}
                  {runnerProvider === "codex"
                    ? "Native app server runner"
                    : "Paperclip Runner"}
                </span>
              )}
            </div>
          </div>
        </header>
        {environmentError && !envs.isPending && (
          <p role="alert" className="text-sm text-destructive">
            {environmentError}
          </p>
        )}
        {preparingComputer && <p role="status" className="text-sm text-muted-foreground">Preparing your agent computer…</p>}
        {created?.lifecycleError && <div className="space-y-2">
          <p role="alert" className="text-sm text-destructive">{created.lifecycleError}</p>
          <Button disabled={busy} onClick={() => {
            setEnvironmentSaving(true);
            void agentsApi.retryLifecycle(created.id, companyId).then(async agent => {
              await cache.cancelQueries({ queryKey: queryKeys.agents.detail(agent.id) });
              setCreated(agent);
              cache.setQueryData(queryKeys.agents.detail(agent.id), agent);
            }).catch(cause => setError(cause instanceof Error ? cause.message : "Could not retry computer preparation."))
              .finally(() => setEnvironmentSaving(false));
          }}>Retry preparation</Button>
        </div>}
        {setupError && (
          <p role="alert" className="text-sm text-destructive">
            {setupError.message}
          </p>
        )}
        {adapterInventory.data && !available && (
          <p role="alert" className="text-sm text-destructive">
            This adapter is unavailable. Choose an enabled adapter.
          </p>
        )}
        {(managedOnly || forced.forced) &&
          !envs.isPending &&
          !environmentId && (
            <p role="alert" className="text-sm text-destructive">
              No managed environment is available. Configure an environment
              before continuing.
            </p>
          )}
        <div className="flex flex-col gap-8 md:flex-row">
          <nav aria-label="Agent setup steps" className="shrink-0 md:w-44">
            <ol className="flex flex-wrap gap-2 md:flex-col">
              {steps.map((step, index) => (
                <li key={step}>
                  <button
                    type="button"
                    aria-current={step === screen ? "step" : undefined}
                    disabled={
                      busy || completed || step === "saved"
                    }
                    onClick={() => step === "connect" && screen !== "connect" ? editConnection() : setScreen(step)}
                    className={cn(
                      "flex w-full items-center gap-3 rounded-md px-3 py-3 text-left text-sm",
                      step === screen
                        ? "bg-accent font-medium"
                        : "text-muted-foreground",
                    )}
                  >
                    <span
                      className={cn(
                        "flex size-6 shrink-0 items-center justify-center rounded-full border text-xs",
                        step === screen
                          ? "border-foreground bg-foreground text-background"
                          : "border-border",
                      )}
                    >
                      {index + 1}
                    </span>
                    {labels[step]}
                  </button>
                </li>
              ))}
            </ol>
          </nav>
          <div className="min-w-0 flex-1">
            <AnimatePresence mode="wait" initial={false}>
              <motion.div key={screen} {...stepMotion}>
                {screen === "connect" && connectionAdapter ? (
                  <OnboardingCard className="mx-auto">
                    <div className="mb-8">
                      <OnboardingHeading
                        title="Connect a model"
                        center
                      />
                    </div>
                    {connectionSettingsReady ? <fieldset disabled={!ready} className="contents"><AgentProviderConnection
                      key={environmentId ?? "local"}
                      companyId={companyId}
                      adapterType={connectionAdapter}
                      environmentId={environmentId}
                      canLogin={canLogin}
                      localEnvironment={environment?.driver === "local"}
                      advancedConnection={{
                        value: aiBinding,
                        content: (
                          <AiConnectionField
                            companyId={companyId}
                            agentName={name}
                            adapterType={brandType}
                            model={model}
                            environmentId={environmentId ?? undefined}
                            value={aiBinding}
                            preferAdvanced
                            onChange={binding => {
                              if (binding.mode === "router") return;
                              setConnection(null);
                              setRuntimeAiBinding(binding);
                              resetTest();
                            }}
                          />
                        ),
                      }}
                      onBack={() => void saveAndExit()}
                      onDraftChanged={() => {
                        setConnection(null);
                        setRuntimeAiBinding(undefined);
                        resetTest();
                      }}
                      testConnection={async next => (await runTest(next)) !== null}
                      testError={
                        error ??
                        (
                          result?.checks.find(
                            (check) => check.level === "error",
                          ) ??
                          result?.checks.find(
                            (check) =>
                              (check.code.includes("hello_probe") || check.code.startsWith("environment_agent_")) &&
                              check.level === "warn",
                          )
                        )?.message
                      }
                      onConnected={(next) => {
                        void saveDraft(next).then(() => {
                          setConnection(next);
                          setRuntimeAiBinding(undefined);
                          setScreen("runtime");
                        }).catch(cause => setError(cause instanceof Error ? cause.message : "Could not save agent setup."));
                      }}
                    /></fieldset> : <p role="status" className="text-sm text-muted-foreground">Loading connection settings…</p>}
                    {["codex_local", "claude_local", "opencode_local", "pi_local"].includes(adapterType) && <details className="mt-5 space-y-3">
                      <summary className="cursor-pointer text-sm text-muted-foreground">Advanced</summary>
                      <AgentRunnerSelect value={runner} disabled={busy}
                        pending={adapters.isFetching} error={adapters.error?.message} onRetry={() => { void adapters.refetch(); }}
                        defaultRunner={adapters.data?.find(item => item.type === adapterType)?.defaultRunner}
                        supportedRunners={adapters.data?.find(item => item.type === adapterType)?.supportedRunners}
                        onChange={value => { setRunner(value); resetTest(); }} />
                    </details>}
                  </OnboardingCard>
                ) : screen === "saved" && created ? (
                  <div className="space-y-6">
                    <div className="space-y-6 rounded-lg border border-border p-6">
                      <h2 className="flex items-center gap-3 text-lg font-semibold">
                        <Check className="size-5" />
                        {created.status === "pending_approval"
                          ? "Agent submitted for approval"
                          : isDot ? "Your Dot agent has been created" : "Your agent is ready"}
                      </h2>
                      <dl className="grid grid-cols-2 gap-4 text-sm">
                        <dt className="text-muted-foreground">Adapter</dt>
                        <dd>{getAdapterDisplay(isDot ? "openai_dot" : adapterType).label}</dd>
                        {showModel && (
                          <>
                            <dt className="text-muted-foreground">Model</dt>
                            <dd className="break-all">
                              {String(confirmationModel)}
                            </dd>
                          </>
                        )}
                        <dt className="text-muted-foreground">Environment</dt>
                        <dd>{environmentLabel}</dd>
                      </dl>
                      <p className="text-sm text-muted-foreground">
                        {created.status === "pending_approval"
                          ? "An organization administrator must approve this agent before it can work."
                          : isDot ? "Pair your Dot and test event delivery in configuration before assigning work." : "Assign a task when you’re ready for this agent to work."}
                      </p>
                    </div>
                    <div className="flex flex-wrap justify-between gap-3">
                      <Button
                        variant="outline"
                        onClick={() => navigate(isDot ? "/agents/all" : `${agentUrl(created)}/runtime`)}
                      >
                        <Settings2 className="size-4" />
                        {isDot ? "Back to Agents" : "Edit configuration"}
                      </Button>
                      <Button
                        disabled={created.status === "pending_approval"}
                        onClick={() => isDot
                          ? navigate(`${agentUrl(created)}/runtime`)
                          : openNewIssue({ assigneeAgentId: created.id, status: "todo" })
                        }
                      >
                        {isDot ? "Pair Dot" : `Assign ${created.name} a Task`}
                        <ArrowRight className="size-4" />
                      </Button>
                    </div>
                  </div>
                ) : (
                  <form
                    className="space-y-8"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void finish();
                    }}
                  >
                    <h2 className="text-xl font-semibold">
                      Configure your agent
                    </h2>
                    <fieldset disabled={busy} className="space-y-8">
                      <section className="space-y-5">
                        {isDot && <>
                          <p className="text-sm text-muted-foreground">Create this agent, then copy its pairing prompt to your Dot.</p>
                          {experimental.data?.enablePublicMcp !== true && <p className="text-sm text-muted-foreground">Enable Assistant connections (MCP) in Experimental settings before pairing.</p>}
                          <ToggleField label="Allow externally billed provider" hint="Dot does not report token usage or cost. Paperclip cannot enforce a provider spend ceiling; known company and agent budget limits still apply."
                            checked={allowUnmeteredProvider} onChange={value => { setAllowUnmeteredProvider(value); resetTest(); }} />
                        </>}
                        {!connectionAdapter && aiProviderForAdapter(brandType) && (
                          <AiConnectionField companyId={companyId} agentName={name} adapterType={brandType} model={model} environmentId={environmentId ?? undefined} value={aiBinding}
                            onChange={binding => { binding.mode !== "router" && setRuntimeAiBinding(binding); resetTest();
                              if (brandType === "copilot_runtime" && hashKey([aiBinding ?? null]) === hashKey([binding ?? null])) void refreshCopilotModels();
                            }} />
                        )}
                        {(connectionModels ? connectionModels.error : models.error) && <p role="alert" className="text-sm text-destructive">Could not load models. Retry or enter a model ID manually.</p>}
                        {((showModel && !usingKimiApi) ||
                          efforts.length > 0) && (
                          <div className="grid items-start gap-5 sm:grid-cols-2">
                            {showModel && !usingKimiApi && (
                              <ModelDropdown
                                presentation={brandType === "codex_local" ? "searchable" : "native"}
                                models={connectionModels?.models ?? models.data ?? []}
                                loadingModels={connectionModels?.isLoading ?? models.isLoading}
                                onRefreshModels={connectionModels?.refreshModels ?? (brandType === "copilot_runtime" ? async () => { await models.refetch(); } : undefined)}
                                refreshingModels={connectionModels?.refreshing ?? (brandType === "copilot_runtime" ? models.isFetching : undefined)}
                                value={model}
                                onChange={(value) => {
                                  setModel(connectionModels?.resolveModel(value) ?? value);
                                  if (
                                    effort &&
                                    !setupEfforts(adapterType, value).includes(
                                      effort,
                                    )
                                  )
                                    setEffort("");
                                  const nextProvider = value.split("/")[0];
                                  if (
                                    multiProvider &&
                                    PROVIDER_ENV_KEYS[nextProvider] &&
                                    nextProvider !== provider
                                  ) {
                                    setProvider(nextProvider);
                                    setApiKey("");
                                    setProviderBinding(null);
                                  }
                                  resetTest();
                                }}
                                open={modelOpen}
                                onOpenChange={setModelOpen}
                                allowDefault={!multiProvider && brandType !== "copilot_runtime"}
                                required={multiProvider || brandType === "copilot_runtime"}
                                creatable={brandType !== "copilot_runtime"}
                                groupByProvider={multiProvider && !connectionModels}
                                preserveOrder={Boolean(connectionModels) || adapterCuratesModelOrder(brandType)}
                              />
                            )}
                            {efforts.length > 0 && (
                              <Field label="Thinking effort">
                                {brandType === "codex_local" ? <SelectPopover aria-label="Thinking effort" value={effort}
                                  onValueChange={value => { setEffort(value); resetTest(); }}
                                  options={[{ value: "", label: "Auto" }, ...efforts.map(value => ({ value, label: value }))]} /> : <NativeSelect
                                  aria-label="Thinking effort"
                                  value={effort}
                                  onChange={(event) => {
                                    setEffort(event.target.value);
                                    resetTest();
                                  }}
                                >
                                  <option value="">Auto</option>
                                  {efforts.map((value) => (
                                    <option key={value} value={value}>
                                      {value}
                                    </option>
                                  ))}
                                </NativeSelect>}
                              </Field>
                            )}
                          </div>
                        )}
                        {!aiBinding && SETUP_LOGIN_HINTS[adapterType] && (
                          <p className="text-sm text-muted-foreground">
                            {SETUP_LOGIN_HINTS[adapterType]}
                          </p>
                        )}
                        {hasCredentialField && !aiBinding && (
                          <div className="grid gap-5 sm:grid-cols-2">
                            {chooseProvider && (
                              <Field label="API key provider">
                                <select
                                  aria-label="API key provider"
                                  className={controlClass}
                                  value={provider}
                                  onChange={(event) => {
                                    setProvider(event.target.value);
                                    setModel("");
                                    setApiKey("");
                                    setProviderBinding(null);
                                    resetTest();
                                  }}
                                >
                                  {Object.keys(providerKeys).map((key) => (
                                    <option key={key} value={key}>
                                      {key === "openrouter"
                                        ? "OpenRouter"
                                        : key === "openai"
                                          ? "OpenAI"
                                          : key === "anthropic"
                                            ? "Anthropic"
                                            : ({
                                                google: "Google",
                                                xai: "xAI",
                                                groq: "Groq",
                                                opencode: "OpenCode",
                                              }[key] ?? key)}
                                    </option>
                                  ))}
                                </select>
                              </Field>
                            )}
                            <div
                              className={
                                adapterType === "cursor_cloud"
                                  ? "sm:col-span-2"
                                  : undefined
                              }
                            >
                              <Field label={envKey}>
                                <div className="flex items-center gap-3">
                                  <Input
                                    aria-label={envKey}
                                    type="password"
                                    autoComplete="off"
                                    value={apiKey}
                                    onChange={(event) => {
                                      setApiKey(event.target.value);
                                      setProviderBinding(null);
                                      resetTest();
                                    }}
                                    placeholder={
                                      selectedBinding
                                        ? "Using saved key"
                                        : [
                                              "cursor_cloud",
                                              "hermes_gateway",
                                            ].includes(adapterType)
                                          ? "Required"
                                          : "Optional if already configured"
                                    }
                                  />
                                  {adapterType === "cursor_cloud" && (
                                    <a
                                      href="https://cursor.com/dashboard/api?section=user-keys#user-api-keys"
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="shrink-0 text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
                                    >
                                      get api key
                                    </a>
                                  )}
                                </div>
                              </Field>
                            </div>
                            {adapterType !== "cursor_cloud" && (
                              <div
                                className={
                                  chooseProvider ? "sm:col-span-2" : undefined
                                }
                              >
                                <Field label="Or use an organization secret">
                                  <SecretPicker
                                    secretId={
                                      selectedBinding &&
                                      typeof selectedBinding === "object" &&
                                      selectedBinding.type === "secret_ref"
                                        ? selectedBinding.secretId
                                        : ""
                                    }
                                    secrets={companySecrets.data ?? []}
                                    disabled={busy}
                                    onSelect={(secretId) => {
                                      setProviderBinding({
                                        type: "secret_ref",
                                        secretId,
                                        version: "latest",
                                      });
                                      setApiKey("");
                                      resetTest();
                                    }}
                                  />
                                </Field>
                              </div>
                            )}
                            <p className="text-xs text-muted-foreground sm:col-span-2">
                              New keys are saved as organization secrets when
                              you finish setup.
                              {multiProvider && ` Use a ${provider}/model ID.`}
                            </p>
                          </div>
                        )}
                        {adapterType === "hermes_gateway" && (
                          <Field label="Hermes API base URL">
                            <Input
                              aria-label="Hermes API base URL"
                              value={gatewayUrl}
                              onChange={(event) => {
                                setGatewayUrl(event.target.value);
                                resetTest();
                              }}
                              placeholder="https://hermes.example.com"
                            />
                          </Field>
                        )}
                        {usingKimiApi && (
                          <div className="grid gap-5 sm:grid-cols-2">
                            <Field label="Kimi API model name">
                              <Input
                                aria-label="Kimi API model name"
                                value={kimiModel}
                                onChange={(event) => {
                                  setKimiModel(event.target.value);
                                  resetTest();
                                }}
                                placeholder="kimi-for-coding"
                              />
                            </Field>
                            <Field label="Kimi API protocol">
                              <select
                                aria-label="Kimi API protocol"
                                className={controlClass}
                                value={kimiProtocol}
                                onChange={(event) => {
                                  setKimiProtocol(event.target.value);
                                  resetTest();
                                }}
                              >
                                {["kimi", "anthropic", "openai"].map(
                                  (value) => (
                                    <option key={value}>{value}</option>
                                  ),
                                )}
                              </select>
                            </Field>
                            <Field
                              label="Kimi API base URL"
                              hint="Optional override for your provider endpoint."
                            >
                              <Input
                                aria-label="Kimi API base URL"
                                value={kimiBaseUrl}
                                onChange={(event) => {
                                  setKimiBaseUrl(event.target.value);
                                  resetTest();
                                }}
                                placeholder="Provider default"
                              />
                            </Field>
                          </div>
                        )}
                        {adapterType === "cursor_cloud" && (
                          <div className="grid gap-5 sm:grid-cols-2">
                            <Field label="GitHub repository">
                              <Input
                                aria-label="GitHub repository"
                                value={repository}
                                onChange={(event) => {
                                  setRepository(event.target.value);
                                  resetTest();
                                }}
                                placeholder="https://github.com/your-org/repo"
                              />
                            </Field>
                            <Field label="Branch">
                              <Input
                                aria-label="Branch"
                                placeholder="Repository default"
                                value={branch}
                                onChange={(event) => {
                                  setBranch(event.target.value);
                                  resetTest();
                                }}
                              />
                            </Field>
                          </div>
                        )}
                        {["codex_local", "claude_local", "opencode_local", "pi_local"].includes(adapterType) && <details className="space-y-3">
                          <summary className="cursor-pointer text-sm text-muted-foreground">Advanced</summary>
                          <AgentRunnerSelect value={runner} disabled={busy}
                            pending={adapters.isFetching} error={adapters.error?.message} onRetry={() => { void adapters.refetch(); }}
                            defaultRunner={adapters.data?.find(item => item.type === adapterType)?.defaultRunner}
                            supportedRunners={adapters.data?.find(item => item.type === adapterType)?.supportedRunners}
                            onChange={value => { setRunner(value); resetTest(); }} />
                        </details>}
                      </section>
                      {!["cursor_cloud", "hermes_gateway"].includes(
                        adapterType,
                      ) && (
                        <section className="space-y-5">
                          <h3 className="text-sm font-semibold">Environment</h3>
                          <select
                            aria-label="Environment"
                            className={controlClass}
                            value={environmentOverride}
                            disabled={forced.forced}
                            onChange={(event) => {
                              void changeEnvironment(event.target.value);
                            }}
                          >
                            <option value="">
                              Default: {environmentLabel}
                            </option>
                            {(envs.data ?? [])
                              .filter((env) => env.status === "active" && (!managedOnly || env.driver !== "local"))
                              .map((env) => (
                                <option key={env.id} value={env.id}>
                                  {environmentDisplayLabel(env)}
                                </option>
                              ))}
                          </select>
                        </section>
                      )}
                    </fieldset>
                    <RuntimeTestCard
                      variant={isDot ? "prerequisites" : "connection"}
                      metadataOnly={brandType === "copilot_runtime"}
                      state={testState}
                      result={result}
                      error={error}
                      disabled={!ready || busy || Boolean(connectionAdapter && !connection)}
                      onTest={() => void runTest()}
                    />
                    {error && testState !== "fail" && (
                      <p role="alert" className="text-sm text-destructive">
                        {error}
                      </p>
                    )}
                    {environmentSaveError && <p role="alert" className="text-sm text-destructive">{environmentSaveError}</p>}
                    {environmentSaveError && !environmentSelectionSaved && <Button disabled={busy} onClick={() => void changeEnvironment()}>Retry saving environment</Button>}
                    <div className="flex justify-between border-t border-border py-5">
                      <div className="flex items-center gap-3">
                        <Button type="button" variant="ghost" disabled={busy} onClick={() => void saveAndExit()}>Save & exit</Button>
                      {connectionAdapter ? (
                        <Button
                          type="button"
                          variant="ghost"
                          disabled={busy}
                          onClick={editConnection}
                        >
                          <ArrowLeft className="size-4" />
                          Connection
                        </Button>
                      ) : (
                        null
                      )}
                      </div>
                      {connectionAdapter && !connection ? <Button
                        type="button"
                        disabled={!ready || busy}
                        onClick={() => setScreen("connect")}
                      >
                        Connect model
                        <ArrowRight className="size-4" />
                      </Button> : <Button
                        type="submit"
                        disabled={
                          !ready ||
                          busy ||
                          testState === "fail" ||
                          Boolean(connectionAdapter && !connection)
                        }
                      >
                        {saving ? "Saving…" : "Finish setup"}
                        <Check className="size-4" />
                      </Button>}
                    </div>
                  </form>
                )}
              </motion.div>
            </AnimatePresence>
          </div>
        </div>
      </div>
    </MotionConfig>
  );
}
