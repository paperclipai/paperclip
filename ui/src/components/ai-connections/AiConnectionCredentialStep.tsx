import { useTranslation, t } from "@/i18n";
import { agentSetupErrorText } from "@/lib/agent-setup-error";
import { useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type AiProvider, type AiAuthMethod, type AiConnectionLoginIntent } from "@paperclipai/shared";
import { AgentProviderConnection } from "@/components/new-agent/AgentProviderConnection";
import { ProviderApiKeyCard } from "@/components/AdapterLoginChrome";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { aiConnectionsApi } from "@/api/ai-connections";
import { environmentsApi } from "@/api/environments";
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
  useTranslation();
  if (props.provider === "openrouter" || props.provider === "google") return <ApiKeyConnectionStep {...props} />;
  return <SubscriptionConnectionStep {...props} />;
}

function SubscriptionConnectionStep({ companyId, provider, initialMethod, fixedMethod, connectionId, name: initialName, hideName, nameForMethod, ownership, agentIds, allAgents, environmentId: suppliedEnvironmentId, onComplete, onCancel, defaults, disabled }: Props) {
  const { t } = useTranslation();
  const [name, setName] = useState(initialName);
  const [chosenEnvironment, setChosenEnvironment] = useState<string>();
  const client = useQueryClient();
  const envs = useQuery({ queryKey: queryKeys.environments.list(companyId), queryFn: () => environmentsApi.list(companyId) });
  const caps = useQuery({ queryKey: queryKeys.environments.capabilities(companyId), queryFn: () => environmentsApi.capabilities(companyId) });
  const settings = useQuery({ queryKey: queryKeys.instance.settings, queryFn: instanceSettingsApi.get });
  const experimental = useQuery({ queryKey: queryKeys.instance.experimentalSettings, queryFn: instanceSettingsApi.getExperimental });
  const general = useQuery({ queryKey: queryKeys.instance.generalSettings, queryFn: instanceSettingsApi.getGeneral });
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
  } catch (error) { environmentError = error instanceof Error ? agentSetupErrorText(error, t) ?? undefined : t("sep13Connections.environmentError"); }
  const loginEnvironments = (envs.data ?? []).filter((env) =>
    env.status === "active" && (env.driver === "local" || (env.driver === "sandbox" &&
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
  const loading = [envs, caps, settings, experimental, general].some((query) => query.isPending);
  const error = environmentError ?? [envs, caps, settings, experimental, general].find((query) => query.error)?.error?.message;
  const intent: AiConnectionLoginIntent = { provider: provider as AiConnectionLoginIntent["provider"], method: "subscription", name, ownership, agentIds, allAgents, connectionId };
  return <div className="mx-auto w-full min-w-0 max-w-xl space-y-6">
    {!hideName && <label className="block space-y-2 text-sm">{t("sep13Connections.connectionName")}<Input value={name} onChange={(event) => setName(event.target.value)} disabled={Boolean(connectionId)} /></label>}
    {!suppliedEnvironmentId && !forced.forced && loginEnvironments.length > 1 && <Select value={environmentId ?? ""} onValueChange={setChosenEnvironment}>
      <SelectTrigger aria-label={t("sep13Connections.signInEnvironment")}><SelectValue placeholder={t("sep13Connections.signInEnvironment")} /></SelectTrigger>
      <SelectContent>{loginEnvironments.map((env) => <SelectItem key={env.id} value={env.id}>{env.name}</SelectItem>)}</SelectContent>
    </Select>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {defaults}
    {loading ? <p role="status" className="text-sm text-muted-foreground">{t("sep13Connections.preparingSignIn")}</p> : <AgentProviderConnection
      key={environmentId ?? "local"}
      companyId={companyId}
      adapterType={provider === "anthropic" ? "claude_local" : provider === "xai" ? "grok_local" : "codex_local"}
      environmentId={environmentId}
      canLogin={canLogin}
      localEnvironment={environment?.driver === "local"}
      onBack={onCancel}
      onConnected={() => {}}
      testConnection={async () => false}
      managedAccount={{ intent, nameForMethod, initialMethod, fixedMethod: fixedMethod ?? Boolean(connectionId), disabled: disabled || loading || Boolean(error) || !name.trim(), onComplete: (result) => { void client.invalidateQueries({ queryKey: ["ai-connections", companyId] }); void client.invalidateQueries({ queryKey: ["tools"] }); onComplete(result); } }}
    />}
  </div>;
}

function ApiKeyConnectionStep({ companyId, provider, connectionId, name: initialName, hideName, nameForMethod, ownership, agentIds, allAgents, onComplete, onCancel, defaults, disabled }: Props) {
  const { t } = useTranslation();
  const [name, setName] = useState(initialName);
  const [apiKey, setApiKey] = useState("");
  const client = useQueryClient();
  const save = useMutation({
    mutationFn: () => aiConnectionsApi.create(companyId, { provider, method: "api_key", name: connectionId ? name : nameForMethod?.("api_key") ?? name, ownership, agentIds, allAgents, connectionId, apiKey }),
    onSuccess: (result) => { void client.invalidateQueries({ queryKey: ["ai-connections", companyId] }); void client.invalidateQueries({ queryKey: ["tools"] }); onComplete({ ...result, method: "api_key" }); },
    onSettled: () => setApiKey(""),
  });
  return <div className="mx-auto w-full min-w-0 max-w-xl space-y-4">
    {!hideName && <label className="block space-y-2 text-sm">{t("sep13Connections.connectionName")}<Input value={name} onChange={(event) => setName(event.target.value)} disabled={Boolean(connectionId)} /></label>}
    {save.error && <p role="alert" className="text-sm text-destructive">{save.error.message}</p>}
    <ProviderApiKeyCard providerName={provider === "google" ? "Google" : "OpenRouter"} value={apiKey} onChange={setApiKey} onSubmit={() => save.mutate()} disabled={disabled || save.isPending} placeholder={t("sep13Connections.apiKeyPlaceholder")} autoFocus />
    {defaults}
    <div className="flex justify-between gap-2"><Button variant="ghost" onClick={onCancel}>{t("oct5Core.s0345")}</Button><Button disabled={disabled || !name.trim() || !apiKey.trim() || save.isPending} onClick={() => save.mutate()}>{save.isPending ? t("sep13Connections.connecting") : t("sep13Connections.connect")}</Button></div>
  </div>;
}
