import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AI_GATEWAY_PROVIDERS, type AiProvider, type AiAuthMethod, type AiConnectionLoginIntent } from "@paperclipai/shared";
import { AgentProviderConnection } from "@/components/new-agent/AgentProviderConnection";
import { ProviderApiKeyCard } from "@/components/AdapterLoginChrome";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
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
  ownership: "personal" | "shared";
  agentIds: string[];
  allAgents: boolean;
  environmentId?: string;
  /** Set when reconnecting a connection that routes through a custom gateway. */
  gatewayBaseUrl?: string;
  onComplete: (result: { connectionId: string; grantId: string; method: AiAuthMethod }) => void;
  onCancel: () => void;
};

/** Connections hosts the same provider step as agent setup, with its own save intent. */
export function AiConnectionCredentialStep(props: Props) {
  const [gateway, setGateway] = useState(Boolean(props.gatewayBaseUrl));
  if (props.provider === "openrouter") return <ApiKeyConnectionStep {...props} />;
  if (gateway) return <ApiKeyConnectionStep {...props} gateway onCancel={props.gatewayBaseUrl ? props.onCancel : () => setGateway(false)} />;
  const offerGateway = (AI_GATEWAY_PROVIDERS as readonly string[]).includes(props.provider) && !props.connectionId && !props.fixedMethod;
  return <div className="space-y-4">
    <SubscriptionConnectionStep {...props} />
    {offerGateway && <p className="mx-auto w-full max-w-xl text-sm text-muted-foreground">
      Using LiteLLM or another proxy? <button type="button" className="underline underline-offset-4" onClick={() => setGateway(true)}>Connect through a custom gateway</button>
    </p>}
  </div>;
}

/** One `Name: value` per line. Returns an error message for the first bad line. */
export function parseGatewayHeaders(text: string): Record<string, string> | string {
  const headers: Record<string, string> = {};
  for (const line of text.split("\n").map((l) => l.trim()).filter(Boolean)) {
    const separator = line.indexOf(":");
    if (separator <= 0) return `Use "Name: value" on each line: ${line}`;
    headers[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return headers;
}

function SubscriptionConnectionStep({ companyId, provider, initialMethod, fixedMethod, connectionId, name: initialName, ownership, agentIds, allAgents, environmentId: suppliedEnvironmentId, onComplete, onCancel }: Props) {
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
  } catch (error) { environmentError = error instanceof Error ? error.message : "Could not resolve the sign-in environment."; }
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
  const intent: AiConnectionLoginIntent = { provider, method: "subscription", name, ownership, agentIds, allAgents, connectionId };
  return <div className="mx-auto w-full min-w-0 max-w-xl space-y-6">
    <label className="block space-y-2 text-sm">Connection name<Input value={name} onChange={(event) => setName(event.target.value)} disabled={Boolean(connectionId)} /></label>
    {!suppliedEnvironmentId && !forced.forced && loginEnvironments.length > 1 && <Select value={environmentId ?? ""} onValueChange={setChosenEnvironment}>
      <SelectTrigger aria-label="Sign-in environment"><SelectValue placeholder="Sign-in environment" /></SelectTrigger>
      <SelectContent>{loginEnvironments.map((env) => <SelectItem key={env.id} value={env.id}>{env.name}</SelectItem>)}</SelectContent>
    </Select>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {loading ? <p role="status" className="text-sm text-muted-foreground">Preparing sign-in…</p> : <AgentProviderConnection
      key={environmentId ?? "local"}
      companyId={companyId}
      adapterType={provider === "anthropic" ? "claude_local" : provider === "xai" ? "grok_local" : "codex_local"}
      environmentId={environmentId}
      canLogin={canLogin}
      localEnvironment={environment?.driver === "local"}
      onBack={onCancel}
      onConnected={() => {}}
      testConnection={async () => false}
      managedAccount={{ intent, initialMethod, fixedMethod: fixedMethod || Boolean(connectionId), disabled: loading || Boolean(error) || !name.trim(), onComplete: (result) => { void client.invalidateQueries({ queryKey: ["ai-connections", companyId] }); onComplete(result); } }}
    />}
  </div>;
}

function ApiKeyConnectionStep({ companyId, provider, connectionId, name: initialName, ownership, agentIds, allAgents, gatewayBaseUrl, gateway, onComplete, onCancel }: Props & { gateway?: boolean }) {
  const [name, setName] = useState(initialName);
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState(gatewayBaseUrl ?? "");
  const [headerText, setHeaderText] = useState("");
  const headers = parseGatewayHeaders(headerText);
  const reconnect = Boolean(connectionId);
  const client = useQueryClient();
  const save = useMutation({
    mutationFn: () => aiConnectionsApi.create(companyId, {
      provider, method: "api_key", name, ownership, agentIds, allAgents, connectionId, apiKey,
      // A reconnect keeps the stored endpoint; the server rejects changing it.
      ...(gateway && !reconnect ? { endpoint: { baseUrl: baseUrl.trim(), ...(typeof headers === "object" && Object.keys(headers).length ? { headers } : {}) } } : {}),
    }),
    onSuccess: (result) => { void client.invalidateQueries({ queryKey: ["ai-connections", companyId] }); onComplete({ ...result, method: "api_key" }); },
    onSettled: () => setApiKey(""),
  });
  const canSubmit = Boolean(name.trim() && apiKey.trim()) && !save.isPending &&
    !(gateway && (!baseUrl.trim() || typeof headers === "string"));
  const submit = () => { if (canSubmit) save.mutate(); };
  return <div className="mx-auto w-full min-w-0 max-w-xl space-y-4">
    <label className="block space-y-2 text-sm">Connection name<Input value={name} onChange={(event) => setName(event.target.value)} disabled={Boolean(connectionId)} /></label>
    {gateway && <>
      <label className="block space-y-2 text-sm">Gateway URL
        <Input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} disabled={reconnect} placeholder={provider === "anthropic" ? "https://litellm.example.com" : "https://litellm.example.com/v1"} />
        <span className="block text-xs text-muted-foreground">{provider === "anthropic" ? "The address Claude Code uses as ANTHROPIC_BASE_URL, without /v1." : "The OpenAI-compatible base URL Codex calls, including /v1."}</span>
      </label>
      {!reconnect && <label className="block space-y-2 text-sm">Extra headers (optional)
        <Textarea value={headerText} onChange={(event) => setHeaderText(event.target.value)} placeholder="x-team: platform" rows={2} />
        <span className="block text-xs text-muted-foreground">One "Name: value" per line, sent with every request. Not for credentials.</span>
        {typeof headers === "string" && <span role="alert" className="block text-xs text-destructive">{headers}</span>}
      </label>}
    </>}
    {save.error && <p role="alert" className="text-sm text-destructive">{save.error.message}</p>}
    <ProviderApiKeyCard providerName={gateway ? "gateway" : "OpenRouter"} value={apiKey} onChange={setApiKey} onSubmit={submit} disabled={save.isPending} placeholder="Enter API key here" autoFocus={!gateway} />
    <div className="flex justify-between gap-2"><Button variant="ghost" onClick={onCancel}>{gateway && !gatewayBaseUrl ? "Back" : "Cancel"}</Button><Button disabled={!canSubmit} onClick={submit}>{save.isPending ? "Connecting…" : "Connect"}</Button></div>
  </div>;
}
