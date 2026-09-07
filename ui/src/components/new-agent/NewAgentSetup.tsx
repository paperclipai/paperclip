import { DEFAULT_CODEX_LOCAL_MODEL } from "@paperclipai/adapter-codex-local";
import { testAgentSetup } from "@/lib/test-agent-setup";
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion, MotionConfig } from "motion/react";
import { ArrowLeft, ArrowRight, Check, Settings2 } from "lucide-react";
import type {
  AdapterEnvironmentTestResult,
  Agent,
  EnvBinding,
} from "@paperclipai/shared";
import { ADAPTER_AUTH_MISSING_CHECK_CODE } from "@paperclipai/shared";
import { useNavigate, useSearchParams } from "@/lib/router";
import { agentsApi } from "@/api/agents";
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
} from "@/lib/provider-credential";
import { defaultCreateValues } from "../agent-config-defaults";
import { ModelDropdown } from "../AgentConfigForm";
import { Field } from "../agent-config-primitives";
import { SecretPicker } from "../environment-variables-editor/SecretPicker";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { PillGuy } from "../onboarding/PillGuy";
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

const controlClass =
  "w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm leading-5 outline-none focus-visible:ring-2 focus-visible:ring-ring";
const blocking = (result: AdapterEnvironmentTestResult) =>
  result.status === "fail" ||
  result.checks.some((check) => check.code === ADAPTER_AUTH_MISSING_CHECK_CODE);

export function NewAgentSetup() {
  const { selectedCompanyId } = useCompany();
  const [params] = useSearchParams();
  if (!selectedCompanyId)
    return (
      <p className="text-sm text-muted-foreground">
        Select an organization to create an agent.
      </p>
    );
  return (
    <Setup
      key={`${selectedCompanyId}:${params.get("name")}:${params.get("adapterType")}:${params.get("runnerProvider")}`}
      companyId={selectedCompanyId}
      name={params.get("name") ?? ""}
      adapterType={params.get("adapterType") ?? ""}
      runnerProvider={params.get("runnerProvider") ?? "codex"}
      createdAgentId={params.get("createdAgentId")}
    />
  );
}

function Setup({
  companyId,
  name,
  adapterType,
  runnerProvider,
  createdAgentId,
}: {
  companyId: string;
  name: string;
  adapterType: string;
  runnerProvider: string;
  createdAgentId: string | null;
}) {
  const navigate = useNavigate();
  const cache = useQueryClient();
  const { openNewIssue } = useDialogActions();
  const isRunner = adapterType === "paperclip_runner";
  const brandType = isRunner
    ? runnerProvider === "claude"
      ? "claude_local"
      : runnerProvider === "opencode"
        ? "opencode_local"
        : "codex_local"
    : adapterType;
  const connectionAdapter =
    brandType === "claude_local" || brandType === "codex_local"
      ? brandType
      : null;
  const multiProvider =
    brandType === "opencode_local" || brandType === "pi_local";
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
  const [connection, setConnection] = useState<ProviderConnection | null>(null);
  const [repository, setRepository] = useState("");
  const [branch, setBranch] = useState("main");
  const [createdInSession, setCreated] = useState<Agent | null>(null);
  const savedAgent = useQuery({
    queryKey: queryKeys.agents.detail(createdAgentId ?? "new"),
    queryFn: () => agentsApi.get(createdAgentId!, companyId),
    enabled: Boolean(createdAgentId),
    retry: false,
  });
  const created =
    createdInSession ??
    (savedAgent.data?.companyId === companyId ? savedAgent.data : null);
  const [saving, setSaving] = useState(false);
  const [testState, setTestState] = useState<TestState | "warn">("idle");
  const [result, setResult] = useState<AdapterEnvironmentTestResult | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const savingRef = useRef(false);
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  const resetTest = () => {
    generation.current++;
    setResult(null);
    setTestState("idle");
    setError(null);
  };
  const adapters = useQuery({
    queryKey: queryKeys.adapters.all,
    queryFn: adaptersApi.list,
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
  const models = useQuery({
    queryKey: queryKeys.agents.adapterModels(companyId, brandType),
    queryFn: () => agentsApi.adapterModels(companyId, brandType),
    enabled: Boolean(brandType),
    retry: false,
  });
  const companySecrets = useQuery({
    queryKey: queryKeys.secrets.list(companyId),
    queryFn: () => secretsApi.list(companyId),
    enabled: multiProvider,
  });
  const userSecrets = useQuery({
    queryKey: queryKeys.secrets.myUserSecrets(companyId),
    queryFn: () => secretsApi.listMyUserSecrets(companyId),
    enabled: multiProvider,
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
  const environment = envs.data?.find((env) => env.id === environmentId);
  const sandboxProvider =
    typeof environment?.config?.provider === "string"
      ? environment.config.provider
      : "";
  const canLogin =
    environment?.driver === "sandbox" &&
    caps.data?.sandboxProviders?.[sandboxProvider]?.supportsLoginPty === true;
  const envKey = PROVIDER_ENV_KEYS[provider] ?? "API_KEY";
  const savedKey = userSecrets.data?.find(
    (entry) => entry.definition.key === envKey && entry.secret,
  );
  const available = adapters.data?.some(
    (adapter) =>
      adapter.type === adapterType &&
      adapter.loaded &&
      !adapter.disabled &&
      !getAdapterDisplay(adapterType).comingSoon,
  );
  const ready = Boolean(
    available &&
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
  const busy = testState === "running" || saving;

  function buildConfig(
    nextConnection = connection,
    binding = providerBinding,
  ): Record<string, unknown> {
    const values = {
      ...defaultCreateValues,
      adapterType,
      model:
        model || (brandType === "codex_local" ? DEFAULT_CODEX_LOCAL_MODEL : ""),
      thinkingEffort: effort,
      dangerouslyBypassSandbox: adapterType === "codex_local",
      envBindings: nextConnection?.env ?? {},
      ...(isRunner
        ? {
            adapterSchemaValues: {
              provider: runnerProvider === "claude" ? "acpx" : runnerProvider,
              ...(runnerProvider === "claude" ? { acpxAgent: "claude" } : {}),
            },
          }
        : {}),
    };
    const config = getUIAdapter(adapterType).buildAdapterConfig(values);
    if (isRunner)
      Object.assign(config, {
        provider: runnerProvider === "claude" ? "acpx" : runnerProvider,
        ...(runnerProvider === "claude" ? { acpxAgent: "claude" } : {}),
        ...(model ? { model } : {}),
      });
    if (multiProvider && (binding || savedKey))
      config.env = {
        ...((config.env as object) ?? {}),
        [envKey]: binding ?? {
          type: "user_secret_ref",
          key: envKey,
          version: "latest",
        },
      };
    if (adapterType === "cursor_cloud")
      Object.assign(config, { repository, branch });
    return config;
  }
  function preparedConfig(nextConnection = connection) {
    if (multiProvider && (!model.trim() || !model.includes("/")))
      throw new Error("Choose or enter a model in provider/model format.");
    if (
      adapterType === "cursor_cloud" &&
      !/^https:\/\/github\.com\/[^/]+\/[^/]+/.test(repository)
    )
      throw new Error("Enter a GitHub repository URL.");
    return buildConfig(nextConnection);
  }
  function pendingCredentials(nextConnection = connection) {
    return {
      ...nextConnection?.credentials,
      ...(multiProvider && apiKey.trim() ? { [envKey]: apiKey.trim() } : {}),
    };
  }

  async function runTest(nextConnection = connection): Promise<boolean> {
    if (!ready) return false;
    const run = ++generation.current;
    setTestState("running");
    setResult(null);
    setError(null);
    try {
      const config = await preparedConfig(nextConnection);
      const tested = await testAgentSetup({
        companyId,
        adapterType,
        providerAdapter: brandType,
        adapterConfig: config,
        testCredentials: pendingCredentials(nextConnection),
        environmentId,
      });
      if (run !== generation.current) return false;
      setResult(tested);
      setTestState(blocking(tested) ? "fail" : tested.status);
      return (
        !blocking(tested) &&
        (!connectionAdapter ||
          tested.checks.some((check) =>
            check.code.endsWith("hello_probe_passed"),
          ))
      );
    } catch (cause) {
      if (run === generation.current) {
        setError(
          cause instanceof Error ? cause.message : "Could not test the agent.",
        );
        setTestState("fail");
      }
      return false;
    }
  }
  async function finish() {
    if (
      savingRef.current ||
      createdAgentId ||
      created ||
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
    const staged: Awaited<ReturnType<typeof storeProviderApiKey>>[] = [];
    let hired = false;
    try {
      const config = preparedConfig();
      const credentials = pendingCredentials();
      // Untested entered keys must pass a probe before they can be stored.
      if (Object.keys(credentials).length && !(await runTest())) return;
      for (const [key, value] of Object.entries(credentials)) {
        const secret = await storeProviderApiKey(companyId, key, value);
        staged.push(secret);
        config.env = { ...((config.env as object) ?? {}), [key]: secret.binding };
      }
      const existing = agents.data ?? [];
      const leader = existing.find(
        (agent) => agent.role === "ceo" && agent.status !== "terminated",
      );
      const response = await agentsApi.hire(companyId, {
        name: name.trim(),
        role: existing.length ? "general" : "ceo",
        ...(leader ? { reportsTo: leader.id } : {}),
        adapterType,
        adapterConfig: config,
        defaultEnvironmentId:
          environmentOverride ||
          (forced.forced || managedOnly ? environmentId : null),
        runtimeConfig: buildNewAgentRuntimeConfig({ heartbeatEnabled: false }),
        budgetMonthlyCents: 0,
        ...(connection?.storedSessionId
          ? { storedSessionId: connection.storedSessionId }
          : {}),
        ...(connection?.applyStoredClaudeLogin
          ? { applyStoredClaudeLogin: true }
          : {}),
      });
      hired = true;
      setApiKey("");
      setConnection(null);
      setCreated(response.agent);
      setScreen("saved");
      navigate(
        `/agents/new?${new URLSearchParams({ name: response.agent.name, adapterType, runnerProvider, createdAgentId: response.agent.id })}`,
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
      if (!hired) {
        try { await Promise.all(staged.map((secret) => secret.remove())); }
        catch { setError((original) => `${original ? `${original} ` : ""}Could not remove an unused setup credential. Remove it from My Secrets before retrying.`); }
      }
      void cache.invalidateQueries({ queryKey: queryKeys.secrets.myUserSecrets(companyId) });
      savingRef.current = false;
      setSaving(false);
    }
  }
  if (createdAgentId && !created)
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
  if (!name || !adapterType)
    return (
      <AgentBasicsDialog
        open
        initialAdapter={adapterType}
        onClose={() => navigate("/agents/all")}
        onContinue={(basics) =>
          navigate(`/agents/new?${new URLSearchParams(basics)}`, {
            replace: true,
          })
        }
      />
    );
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
  const environmentLabel = confirmationEnvironment
    ? environmentDisplayLabel(confirmationEnvironment)
    : "Local machine";
  const setupError =
    adapters.error ??
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
          <PillGuy
            state={created ? "alive" : "dormant"}
            className="size-14 shrink-0"
          />
          <div className="space-y-2">
            <h1 className="text-2xl font-semibold tracking-tight">{name}</h1>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <AdapterMark type={brandType} />
              <span>{getAdapterDisplay(brandType).label}</span>
              {isRunner && (
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
        {setupError && (
          <p role="alert" className="text-sm text-destructive">
            {setupError.message}
          </p>
        )}
        {adapters.data && !available && (
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
                      busy || Boolean(created) || index > steps.indexOf(screen)
                    }
                    onClick={() => setScreen(step)}
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
                        lede={`Connect ${name} to ${connectionAdapter === "claude_local" ? "Claude" : "OpenAI"}.`}
                        center
                      />
                    </div>
                    <AgentProviderConnection
                      key={environmentId ?? "local"}
                      companyId={companyId}
                      adapterType={connectionAdapter}
                      environmentId={environmentId}
                      canLogin={canLogin}
                      onBack={() => navigate("/agents/all")}
                      testConnection={runTest}
                      testError={
                        error ??
                        (
                          result?.checks.find(
                            (check) => check.level === "error",
                          ) ??
                          result?.checks.find(
                            (check) =>
                              check.code.includes("hello_probe") &&
                              check.level === "warn",
                          )
                        )?.message
                      }
                      onConnected={(next) => {
                        setConnection(next);
                        resetTest();
                        setScreen("runtime");
                      }}
                    />
                  </OnboardingCard>
                ) : screen === "saved" && created ? (
                  <div className="space-y-6">
                    <div className="space-y-6 rounded-lg border border-border p-6">
                      <h2 className="flex items-center gap-3 text-lg font-semibold">
                        <Check className="size-5" />
                        {created.status === "pending_approval"
                          ? "Agent submitted for approval"
                          : "Your agent is ready"}
                      </h2>
                      <dl className="grid grid-cols-2 gap-4 text-sm">
                        <dt className="text-muted-foreground">Adapter</dt>
                        <dd>{getAdapterDisplay(adapterType).label}</dd>
                        <dt className="text-muted-foreground">Model</dt>
                        <dd className="break-all">
                          {String(
                            created.adapterConfig?.model || model || "Default",
                          )}
                        </dd>
                        <dt className="text-muted-foreground">Environment</dt>
                        <dd>{environmentLabel}</dd>
                      </dl>
                      <p className="text-sm text-muted-foreground">
                        {created.status === "pending_approval"
                          ? "An organization administrator must approve this agent before it can work."
                          : "Your agent has not started running."}
                      </p>
                    </div>
                    <div className="flex flex-wrap justify-between gap-3">
                      <Button
                        variant="outline"
                        onClick={() => navigate(`${agentUrl(created)}/runtime`)}
                      >
                        <Settings2 className="size-4" />
                        Edit configuration
                      </Button>
                      <Button
                        disabled={created.status === "pending_approval"}
                        onClick={() =>
                          openNewIssue({
                            assigneeAgentId: created.id,
                            status: "todo",
                          })
                        }
                      >
                        Assign {created.name} a Task
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
                        <h3 className="text-sm font-semibold">Runtime</h3>
                        <div className="grid items-start gap-5 sm:grid-cols-2">
                          <ModelDropdown
                            models={models.data ?? []}
                            value={model}
                            onChange={(value) => {
                              setModel(value);
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
                            allowDefault={!multiProvider}
                            required={multiProvider}
                            creatable
                            groupByProvider={multiProvider}
                          />
                          {!isRunner && (
                            <Field label="Thinking effort">
                              <select
                                aria-label="Thinking effort"
                                className={controlClass}
                                value={effort}
                                onChange={(event) => {
                                  setEffort(event.target.value);
                                  resetTest();
                                }}
                              >
                                <option value="">Auto</option>
                                <option value="low">Low</option>
                                <option value="medium">Medium</option>
                                <option value="high">High</option>
                              </select>
                            </Field>
                          )}
                        </div>
                        {models.error && (
                          <p className="text-xs text-muted-foreground">
                            Couldn’t load models. You can enter a model ID
                            manually.
                          </p>
                        )}
                        {multiProvider && (
                          <div className="grid gap-5 sm:grid-cols-2">
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
                                {Object.keys(PROVIDER_ENV_KEYS).map((key) => (
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
                            <Field label={envKey}>
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
                                  providerBinding || savedKey
                                    ? "Using saved key"
                                    : "Optional if already configured"
                                }
                              />
                            </Field>
                            <div className="space-y-2 sm:col-span-2">
                              <label className="text-xs text-muted-foreground">
                                Or use an organization secret
                              </label>
                              <SecretPicker
                                secretId={
                                  providerBinding &&
                                  typeof providerBinding === "object" &&
                                  providerBinding.type === "secret_ref"
                                    ? providerBinding.secretId
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
                            </div>
                            <p className="text-xs text-muted-foreground sm:col-span-2">
                              {provider === "openrouter"
                                ? "Choose an openrouter/provider/model ID. The key is stored as a secret and supplied through OPENROUTER_API_KEY."
                                : `Use a ${provider}/model ID. Keys are supplied through ${envKey}.`}
                            </p>
                          </div>
                        )}
                        {adapterType === "cursor_cloud" && (
                          <div className="grid gap-5 sm:grid-cols-2">
                            <Field label="GitHub repository">
                              <Input
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
                                value={branch}
                                onChange={(event) => {
                                  setBranch(event.target.value);
                                  resetTest();
                                }}
                              />
                            </Field>
                          </div>
                        )}
                      </section>
                      {adapterType !== "cursor_cloud" && (
                        <section className="space-y-5">
                          <h3 className="text-sm font-semibold">Environment</h3>
                          <select
                            aria-label="Environment"
                            className={controlClass}
                            value={environmentOverride}
                            disabled={forced.forced || managedOnly}
                            onChange={(event) => {
                              setEnvironmentOverride(event.target.value);
                              setConnection(null);
                              resetTest();
                              if (connectionAdapter) setScreen("connect");
                            }}
                          >
                            <option value="">
                              Default: {environmentLabel}
                            </option>
                            {(envs.data ?? [])
                              .filter((env) => env.status === "active")
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
                      state={testState}
                      result={result}
                      error={error}
                      disabled={!ready || busy}
                      onTest={() => void runTest()}
                    />
                    {error && testState !== "fail" && (
                      <p role="alert" className="text-sm text-destructive">
                        {error}
                      </p>
                    )}
                    <div className="flex justify-between border-t border-border py-5">
                      {connectionAdapter ? (
                        <Button
                          type="button"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => setScreen("connect")}
                        >
                          <ArrowLeft className="size-4" />
                          Connection
                        </Button>
                      ) : (
                        <span />
                      )}
                      <Button
                        type="submit"
                        disabled={
                          !ready ||
                          busy ||
                          testState === "fail" ||
                          Boolean(connectionAdapter && !connection)
                        }
                      >
                        {saving ? "Creating…" : "Finish setup"}
                        <Check className="size-4" />
                      </Button>
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
