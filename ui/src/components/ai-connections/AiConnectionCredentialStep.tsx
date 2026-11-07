import { useTranslation } from "@/i18n";
import { useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type AiProvider, type AiAuthMethod, type AiConnectionLoginIntent } from "@paperclipai/shared";
import { AgentProviderConnection } from "@/components/new-agent/AgentProviderConnection";
import { ProviderApiKeyCard } from "@/components/AdapterLoginChrome";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { aiConnectionsApi } from "@/api/ai-connections";
import { describeError } from "@/api/errors";
import { environmentsApi } from "@/api/environments";
import { QueryErrorState, useQueryView } from "@/components/QueryView";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { queryKeys } from "@/lib/queryKeys";
import { resolveAdapterTestEnvironmentId, resolveLocalDefaultEnvironmentId, resolveManagedSandboxEnvironmentId } from "@/lib/adapter-test-environment";
import { resolveForcedKubernetesEnvironment } from "@/lib/forced-kubernetes-environment";

type Props = {
  companyId: string;
  provider: AiProvider;
  initialMethod?: AiAuthMethod;
  fixedMethod?: boolean;
  connectionId?: string;
  name: string;
  hideName?: boolean;
  nameForMethod?: (method: AiAuthMethod) => string;
  ownership: "personal" | "shared";
  agentIds: string[];
  allAgents: boolean;
  environmentId?: string;
  defaults?: ReactNode;
  disabled?: boolean;
  onComplete: (result: { connectionId: string; grantId: string; method: AiAuthMethod }) => void;
  onCancel: () => void;
};

/** Connections hosts the same provider step as agent setup, with its own save intent. */
export function AiConnectionCredentialStep(props: Props) {
  if (props.provider === "openrouter" || props.provider === "github") return <ApiKeyConnectionStep {...props} />;
  return <SubscriptionConnectionStep {...props} />;
}

function SubscriptionConnectionStep({ companyId, provider, initialMethod, fixedMethod, connectionId, name: initialName, hideName, nameForMethod, ownership, agentIds, allAgents, environmentId: suppliedEnvironmentId, onComplete, onCancel, defaults, disabled }: Props) {
  const { t } = useTranslation("connections");
  const [name, setName] = useState(initialName);
  const [chosenEnvironment, setChosenEnvironment] = useState<string>();
  const client = useQueryClient();
  const envs = useQuery({ queryKey: queryKeys.environments.list(companyId), queryFn: () => environmentsApi.list(companyId) });
  const caps = useQuery({ queryKey: queryKeys.environments.capabilities(companyId), queryFn: () => environmentsApi.capabilities(companyId) });
  const settings = useQuery({ queryKey: queryKeys.instance.settings, queryFn: instanceSettingsApi.get });
  const experimental = useQuery({ queryKey: queryKeys.instance.experimentalSettings, queryFn: instanceSettingsApi.getExperimental });
  const general = useQuery({ queryKey: queryKeys.instance.generalSettings, queryFn: instanceSettingsApi.getGeneral });
  const envsView = useQueryView(envs);
  const capsView = useQueryView(caps);
  const settingsView = useQueryView(settings);
  const experimentalView = useQueryView(experimental);
  const generalView = useQueryView(general);
  const views = [envsView, capsView, settingsView, experimentalView, generalView];
  const forced = resolveForcedKubernetesEnvironment(general.data?.executionMode, envs.data ?? []);
  let environmentId: string | null = null;
  let environmentError: string | undefined;
  try {
    environmentId = forced.forced ? forced.kubernetesEnvironment?.id ?? null : resolveAdapterTestEnvironmentId({
      agentDefaultEnvironmentId: suppliedEnvironmentId ?? chosenEnvironment,
      instanceDefaultEnvironmentId: settings.data?.defaultEnvironmentId,
      localDefaultEnvironmentId: resolveLocalDefaultEnvironmentId(envs.data),
      managedSandboxOnly: experimental.data?.enableManagedSandboxOnly,
      managedSandboxEnvironmentId: resolveManagedSandboxEnvironmentId(envs.data),
      visibleEnvironmentIds: envs.data?.map((env) => env.id),
    });
  } catch (error) { environmentError = describeError(error).body; }
  const loginEnvironments = (envs.data ?? []).filter((env) =>
    env.status === "active" && (env.driver === "local" || (provider !== "google" && env.driver === "sandbox" &&
    typeof env.config.provider === "string" &&
    caps.data?.sandboxProviders?.[env.config.provider]?.supportsLoginPty === true)),
  );
  // Signing in may use a different environment from later agent execution.
  // Prefer a supported login environment without changing any agent routing.
  if (!forced.forced && !suppliedEnvironmentId && !chosenEnvironment &&
      !loginEnvironments.some((env) => env.id === environmentId)) {
    environmentId = loginEnvironments[0]?.id ?? null;
  }
  const environment = envs.data?.find((env) => env.id === environmentId);
  const sandboxProvider = typeof environment?.config.provider === "string" ? environment.config.provider : "";
  const canLogin = environment?.driver === "sandbox" && caps.data?.sandboxProviders?.[sandboxProvider]?.supportsLoginPty === true;
  const loading = [envs, caps, settings, experimental, general].some((query) => query.isPending) || views.some((view) => view.kind === "reconnecting");
  const loadError = views.find((view) => view.kind === "error");
  const intent: AiConnectionLoginIntent = { provider: provider as AiConnectionLoginIntent["provider"], method: "subscription", name, ownership, agentIds, allAgents, connectionId };
  return <div className="mx-auto w-full min-w-0 max-w-xl space-y-6">
    {!hideName && <label className="block space-y-2 text-sm">{t("connection_name_5584ef8")}<Input value={name} onChange={(event) => setName(event.target.value)} disabled={Boolean(connectionId)} /></label>}
    {!suppliedEnvironmentId && !forced.forced && loginEnvironments.length > 1 && <Select value={environmentId ?? ""} onValueChange={setChosenEnvironment}>
      <SelectTrigger aria-label={t("sign_in_environment_fe3a85b")}><SelectValue placeholder={t("sign_in_environment_fe3a85b")} /></SelectTrigger>
      <SelectContent>{loginEnvironments.map((env) => <SelectItem key={env.id} value={env.id}>{env.name}</SelectItem>)}</SelectContent>
    </Select>}
    {loadError ? <QueryErrorState size="inline" error={loadError.error} action="prepare sign-in" onRetry={loadError.retry} retrying={loadError.isFetching} />
      : environmentError ? <p role="alert" className="text-sm text-destructive">{environmentError}</p> : null}
    {defaults}
    {loading ? <p role="status" className="text-sm text-muted-foreground">{t("preparing_sign_in_514845a")}</p> : <AgentProviderConnection
      key={environmentId ?? "local"}
      companyId={companyId}
      adapterType={provider === "google" ? "antigravity_runtime" : provider === "anthropic" ? "claude_local" : provider === "xai" ? "grok_local" : "codex_local"}
      environmentId={environmentId}
      canLogin={canLogin}
      localEnvironment={environment?.driver === "local"}
      onBack={onCancel}
      onConnected={() => {}}
      testConnection={async () => false}
      managedAccount={{ intent, nameForMethod, initialMethod, fixedMethod: fixedMethod ?? Boolean(connectionId), disabled: disabled || loading || Boolean(environmentError) || Boolean(loadError) || !name.trim(), onComplete: (result) => { void client.invalidateQueries({ queryKey: ["ai-connections", companyId] }); void client.invalidateQueries({ queryKey: ["tools"] }); onComplete(result); } }}
    />}
  </div>;
}

function ApiKeyConnectionStep({ companyId, provider, connectionId, name: initialName, hideName, nameForMethod, ownership, agentIds, allAgents, environmentId: suppliedEnvironmentId, defaults, disabled, onComplete, onCancel }: Props) {
  const { t } = useTranslation("connections");
  const [name, setName] = useState(initialName);
  const [apiKey, setApiKey] = useState("");
  const client = useQueryClient();
  const [chosenEnvironment, setChosenEnvironment] = useState<string>();
  const copilot = provider === "github";
  const envs = useQuery({ queryKey: queryKeys.environments.list(companyId), queryFn: () => environmentsApi.list(companyId), enabled: copilot });
  const settings = useQuery({ queryKey: queryKeys.instance.settings, queryFn: instanceSettingsApi.get, enabled: copilot });
  const environmentId = suppliedEnvironmentId ?? chosenEnvironment ?? settings.data?.defaultEnvironmentId ?? resolveLocalDefaultEnvironmentId(envs.data);
  const environmentError = copilot ? envs.error?.message ?? settings.error?.message : undefined;
  const preparing = copilot && (envs.isPending || settings.isPending);
  const save = useMutation({
    mutationFn: () => aiConnectionsApi.create(companyId, { provider, method: "api_key", name: connectionId ? name : nameForMethod?.("api_key") ?? name, ownership, agentIds, allAgents, connectionId, apiKey, ...(copilot ? { environmentId } : {}) }),
    onSuccess: (result) => { void client.invalidateQueries({ queryKey: ["ai-connections", companyId] }); void client.invalidateQueries({ queryKey: ["tools"] }); onComplete({ ...result, method: "api_key" }); },
    onSettled: () => setApiKey(""),
  });
  return <div className="mx-auto w-full min-w-0 max-w-xl space-y-4">
    {!hideName && <label className="block space-y-2 text-sm">{t("connection_name_5584ef8")}<Input value={name} onChange={(event) => setName(event.target.value)} disabled={Boolean(connectionId)} /></label>}
    {save.error && <p role="alert" className="text-sm text-destructive">{describeError(save.error).body}</p>}
    {copilot && <p className="text-sm text-muted-foreground">{t("use_a_personal_fine_grained_token_with_bc25fad")}<a className="underline" href="https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/authenticate-copilot-cli" target="_blank" rel="noreferrer">{t("github_token_instructions_c4f0b2e")}</a>{t("verification_discovers_models_in_the_selected_environment_fbb5347")}</p>}
    {copilot && !suppliedEnvironmentId && <Select value={environmentId ?? ""} onValueChange={setChosenEnvironment} disabled={preparing || save.isPending}>
      <SelectTrigger aria-label={t("copilot_execution_environment_e062699")}><SelectValue placeholder={t("execution_environment_8a44fb2")} /></SelectTrigger>
      <SelectContent>{(envs.data ?? []).filter(env => env.status === "active").map(env => <SelectItem key={env.id} value={env.id}>{env.name}</SelectItem>)}</SelectContent>
    </Select>}
    {environmentError && <p role="alert" className="text-sm text-destructive">{environmentError}</p>}
    {defaults}
    <ProviderApiKeyCard providerName={copilot ? "GitHub Copilot" : provider === "google" ? "Google" : "OpenRouter"} value={apiKey} onChange={setApiKey} onSubmit={() => { if (!preparing && !environmentError && name.trim() && apiKey.trim()) save.mutate(); }} disabled={disabled || save.isPending || preparing || Boolean(environmentError)} placeholder={copilot ? "github_pat_..." : t("enter_api_key_here_4991fd6")} autoFocus />
    <div className="flex justify-between gap-2"><Button variant="ghost" onClick={onCancel}>{t("cancel_77dfd21")}</Button><Button disabled={disabled || !name.trim() || !apiKey.trim() || save.isPending || preparing || Boolean(environmentError)} onClick={() => save.mutate()}>{save.isPending ? t("connecting_fd3e796") : t("connect_b65463c")}</Button></div>
  </div>;
}
