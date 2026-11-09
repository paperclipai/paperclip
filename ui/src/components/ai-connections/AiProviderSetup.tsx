import { t, useTranslation } from "@/i18n";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Network, Monitor } from "lucide-react";
import {
  aiProviderRoutingSchema,
  createAiConnectionSchema,
  type AiProvider,
  type AiProviderRouting,
  type AiConnectionBinding,
  type AiManagedConnectionSummary,
} from "@paperclipai/shared";
import { aiConnectionsApi } from "@/api/ai-connections";
import { agentsApi } from "@/api/agents";
import { describeError } from "@/api/errors";
import { QueryErrorState, useQueryView } from "@/components/QueryView";
import { ConnectionChoiceList } from "@/features/connections/ConnectionChoiceList";
import { ConnectionAccessDefaults, connectionDefaultSummarySentence } from "@/features/connections/ConnectionSetupFlow";
import { AppLogo } from "@/pages/apps/AppLogo";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AiConnectionCredentialStep } from "./AiConnectionCredentialStep";

const providers = [
  {
    id: "openai",
    name: "OpenAI",
  },
  {
    id: "anthropic",
    name: "Anthropic",
  },
  { id: "google", name: "Google" },
  { id: "xai", name: "xAI" },
  {
    id: "openrouter",
    name: "OpenRouter",
    advanced: true,
  },
  {
    id: "bedrock",
    name: "Amazon Bedrock",
    advanced: true,
  },
  {
    id: "gateway",
    name: "Custom gateway",
    advanced: true,
  },
  {
    id: "local",
    name: "Local endpoint",
    advanced: true,
  },
] as const;
type ProviderChoice = (typeof providers)[number]["id"] | "github";

function providerDescription(id: string) {
  switch (id) {
    case "openai": return t("agents.AiProviderSetup.providerDescription.openai");
    case "anthropic": return t("agents.AiProviderSetup.providerDescription.anthropic");
    case "google": return t("agents.AiProviderSetup.providerDescription.google");
    case "xai": return t("agents.AiProviderSetup.providerDescription.xai");
    case "openrouter": return t("agents.AiProviderSetup.providerDescription.openrouter");
    case "bedrock": return t("agents.AiProviderSetup.providerDescription.bedrock");
    case "gateway": return t("agents.AiProviderSetup.providerDescription.gateway");
    case "local": return t("agents.AiProviderSetup.providerDescription.local");
    default: return "";
  }
}

export function AiProviderSetup({
  companyId,
  agentId,
  environmentId,
  initialProvider,
  initialProtocol,
  providerLabel,
  advancedOnly = false,
  submitLabel,
  reconnect,
  onCancel,
  onComplete,
}: {
  companyId: string;
  agentId?: string;
  environmentId?: string;
  initialProvider?: ProviderChoice;
  initialProtocol?: AiProviderRouting["protocol"];
  providerLabel?: string;
  advancedOnly?: boolean;
  submitLabel?: string;
  reconnect?: AiManagedConnectionSummary;
  onCancel: () => void;
  onComplete: (
    binding: Exclude<AiConnectionBinding, { mode: "responsible_user" }>,
  ) => void;
}) {
  const { t } = useTranslation();
  const [provider, setProvider] = useState<ProviderChoice | undefined>(
    reconnect
      ? reconnect.routing?.kind === "gateway" ||
        reconnect.routing?.kind === "local" ||
        reconnect.routing?.kind === "bedrock"
        ? reconnect.routing.kind
        : reconnect.provider
      : initialProvider,
  );
  const [step, setStep] = useState(
    reconnect || initialProvider ? "connect" : "provider",
  );
  const [ownershipChoice, setOwnership] = useState<"personal" | "shared">();
  const [allAgentsChoice, setAllAgents] = useState<boolean>();
  const [agentIds, setAgentIds] = useState(new Set(agentId ? [agentId] : []));
  const [protocol, setProtocol] = useState<AiProviderRouting["protocol"]>(
    reconnect?.routing?.protocol ?? initialProtocol ?? "responses",
  );
  const [auth, setAuth] = useState<AiProviderRouting["auth"]>(
    reconnect?.routing?.auth ?? "bearer",
  );
  const [baseUrl, setBaseUrl] = useState(reconnect?.routing?.baseUrl ?? "");
  const [region, setRegion] = useState(
    reconnect?.routing?.region ?? "us-east-1",
  );
  const [models, setModels] = useState(
    reconnect?.routing?.models.map((m) => m.id).join(", ") ?? "",
  );
  const [apiKey, setApiKey] = useState("");
  const client = useQueryClient();
  const accounts = useQuery({
    queryKey: ["ai-connections", companyId, agentId],
    queryFn: () => aiConnectionsApi.list(companyId, agentId),
  });
  const accountsView = useQueryView(accounts);
  const canManageConnections = accounts.data?.canManageConnections ?? false;
  const ownership = reconnect?.ownership ?? ownershipChoice ?? (!agentId && canManageConnections ? "shared" : "personal");
  const allAgents = allAgentsChoice ?? (!agentId && canManageConnections);
  const agents = useQuery({
    queryKey: ["agents", companyId, "provider-access"],
    queryFn: () => agentsApi.list(companyId),
  });
  const agentsView = useQueryView(agents);
  const label = providerLabel ?? providers.find((p) => p.id === provider)?.name ?? (provider === "github" ? "GitHub Copilot" : t("agents.AiProviderSetup.providerFallback"));
  const advanced = reconnect ? Boolean(reconnect.routing) : ["openrouter", "bedrock", "gateway", "local"].includes(provider ?? "");
  const nativeProvider: AiProvider =
    provider === "bedrock"
      ? "anthropic"
      : provider === "gateway" || provider === "local"
        ? protocol === "messages"
          ? "anthropic"
          : "openai"
        : (provider ?? "openai");
  const name =
    reconnect?.name ??
    `${ownership === "personal" ? "My" : "Company"} ${
      provider === "gateway" && baseUrl
        ? (() => {
            try {
              return new URL(baseUrl).hostname;
            } catch {
              return label;
            }
          })()
        : label
    }`;
  const complete = (result: {
    connectionId: string;
    grantId: string;
    method?: "api_key" | "subscription";
  }) => {
    void client.invalidateQueries({ queryKey: ["ai-connections", companyId] });
    void client.invalidateQueries({ queryKey: ["tools"] });
    onComplete({
      provider: nativeProvider,
      method: result.method ?? "api_key",
      mode: ownership === "shared" ? "shared" : "delegated",
      ...result,
    });
  };
  const save = useMutation({
    mutationFn: () => {
      const routing =
        reconnect?.routing ??
        aiProviderRoutingSchema.parse({
          kind: provider,
          protocol: provider === "bedrock" ? "bedrock" : protocol,
          auth: provider === "openrouter" ? "bearer" : auth,
          ...(provider === "bedrock"
            ? { region }
            : provider === "gateway" || provider === "local"
              ? { baseUrl }
              : {}),
          models: models
            .split(",")
            .map((id) => id.trim())
            .filter(Boolean)
            .map((id) => ({ id })),
        });
      return aiConnectionsApi.create(
        companyId,
        createAiConnectionSchema.parse({
          provider: nativeProvider,
          method: "api_key",
          name,
          ownership,
          allAgents,
          agentIds: [...agentIds],
          connectionId: reconnect?.id,
          routing,
          ...(auth !== "none" ? { apiKey } : {}),
        }),
      );
    },
    onSuccess: complete,
    onSettled: () => {
      setApiKey("");
    },
  });
  const choices = (advancedOnly: boolean) => (
    <ConnectionChoiceList
      choices={providers
        .filter((p) => Boolean("advanced" in p && p.advanced) === advancedOnly)
        .map((p) => ({
          ...p,
          description: providerDescription(p.id),
          icon:
            p.id === "gateway" || p.id === "local" ? (
              <span className="flex size-9 items-center justify-center rounded-lg bg-muted">
                {p.id === "gateway" ? (
                  <Network className="size-5" />
                ) : (
                  <Monitor className="size-5" />
                )}
              </span>
            ) : (
              <AppLogo name={p.name} brandKey={p.id} />
            ),
        }))}
      onSelect={(id) => {
        setProvider(id as ProviderChoice);
        setStep("connect");
        setApiKey("");
        setAuth("bearer");
        save.reset();
      }}
    />
  );
  const modelSettings = (
    <label className="block space-y-2 text-xs text-muted-foreground">
      {t("agents.AiProviderSetup.modelIds")}
      <Input
        aria-label={t("agents.AiProviderSetup.modelIdsAria")}
        value={models}
        onChange={(e) => setModels(e.target.value)}
        disabled={Boolean(reconnect)}
      />
      <span className="block">
        {t("agents.AiProviderSetup.modelIdsHint")}
      </span>
    </label>
  );
  const accessDefaults = !reconnect ? (
    <ConnectionAccessDefaults
      companyId={companyId}
      extra={advanced ? modelSettings : undefined}
      agents={agents.data ?? []}
      sentence={connectionDefaultSummarySentence({ grantKind: ownership === "shared" ? "organization" : "user", authKind: auth === "none" ? "none" : "api_key", installChoice: allAgents ? "all" : "specific", installCount: agentIds.size })}
      capabilities={{ canCreateOrganizationGrant: canManageConnections, canSetCompanyInstall: canManageConnections }}
      authKind={auth === "none" ? "none" : "api_key"}
      grantKind={ownership === "shared" ? "organization" : "user"}
      grantKinds={["user", "organization"]}
      setGrantKind={kind => setOwnership(kind === "organization" ? "shared" : "personal")}
      installChoice={allAgents ? "all" : "specific"}
      setInstallChoice={choice => setAllAgents(choice === "all")}
      installAgentIds={agentIds}
      setInstallAgentIds={setAgentIds}
      disabled={save.isPending}
      notice={!canManageConnections ? [t("agents.AiProviderSetup.onlyManagersShare")] : undefined}
    />
  ) : undefined;
  const cancel = () => reconnect || initialProvider ? onCancel() : setStep("provider");
  if (!reconnect && (accounts.isPending || accountsView.kind === "reconnecting")) return <p role="status">{t("agents.AiProviderSetup.loadingPermissions")}</p>;
  if (!reconnect && accountsView.kind === "error") return <QueryErrorState error={accounts.error} action={t("errorActions.loadConnectionPermissions")} onRetry={accountsView.retry} retrying={accountsView.isFetching} />;
  return (
    <div className="mx-auto w-full max-w-2xl space-y-6" onSubmit={(event) => event.stopPropagation()}>
      <div className="space-y-2">
        <h2 className="text-xl font-semibold">
          {step === "provider"
            ? t("agents.AiProviderSetup.connectProviderTitle")
            : reconnect ? t("agents.AiProviderSetup.reconnectTitle", { label }) : t("agents.AiProviderSetup.connectTitle", { label })}
        </h2>
      </div>
      {agentsView.kind === "error" && <QueryErrorState size="inline" error={agents.error} action={t("errorActions.loadAgents")} onRetry={agentsView.retry} retrying={agentsView.isFetching} />}
      {step === "provider" ? (
        <>
          {advancedOnly ? choices(true) : <>
          {choices(false)}
          <details>
            <summary className="cursor-pointer text-sm text-muted-foreground">
              {t("agents.AiProviderSetup.advancedProviders")}
            </summary>
            <div className="pt-4">{choices(true)}</div>
          </details>
          </>}
          <Button type="button" variant="ghost" onClick={onCancel}>
            {t("agents.AiProviderSetup.cancel")}
          </Button>
        </>
      ) : !advanced ? (
        <AiConnectionCredentialStep
          companyId={companyId}
          provider={nativeProvider}
          connectionId={reconnect?.id}
          initialMethod={reconnect?.method}
          fixedMethod={Boolean(reconnect)}
          name={name}
          hideName
          ownership={ownership}
          allAgents={allAgents}
          agentIds={[...agentIds]}
          environmentId={environmentId}
          onCancel={cancel}
          defaults={accessDefaults}
          disabled={!reconnect && ownership === "shared" && !allAgents && agentIds.size === 0}
          onComplete={complete}
        />
      ) : (
        <form
          className="space-y-5"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          {(provider === "gateway" || provider === "local") && (
            <>
              <label className="block space-y-2 text-xs text-muted-foreground">
                {t("agents.AiProviderSetup.providerUrl")}
                <Input
                  aria-label={t("agents.AiProviderSetup.providerUrl")}
                  placeholder={
                    provider === "local"
                      ? "http://localhost:11434/v1"
                      : "https://gateway.example.com/v1"
                  }
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  disabled={Boolean(reconnect)}
                />
              </label>
              <label className="block space-y-2 text-xs text-muted-foreground">
                {t("agents.AiProviderSetup.apiFormat")}
                <Select
                  value={protocol}
                  onValueChange={(v) => {
                    setProtocol(v as typeof protocol);
                    if (v !== "messages" && auth === "api_key")
                      setAuth("bearer");
                  }}
                  disabled={Boolean(reconnect) || Boolean(initialProtocol)}
                >
                  <SelectTrigger aria-label={t("agents.AiProviderSetup.apiFormat")} className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="responses">
                      OpenAI Responses · Codex
                    </SelectItem>
                    <SelectItem value="messages">
                      Anthropic Messages · Claude
                    </SelectItem>
                    <SelectItem value="chat">
                      Chat Completions · OpenCode, Hermes
                    </SelectItem>
                  </SelectContent>
                </Select>
              </label>
            </>
          )}
          {provider === "bedrock" && (
            <label className="block space-y-2 text-xs text-muted-foreground">
              {t("agents.AiProviderSetup.awsRegion")}
              <Input
                aria-label={t("agents.AiProviderSetup.awsRegion")}
                value={region}
                onChange={(e) => setRegion(e.target.value)}
                disabled={Boolean(reconnect)}
              />
            </label>
          )}
          {provider !== "openrouter" && (
            <label className="block space-y-2 text-xs text-muted-foreground">
              {t("agents.AiProviderSetup.authentication")}
              <Select
                value={auth}
                onValueChange={(v) => setAuth(v as typeof auth)}
                disabled={Boolean(reconnect)}
              >
                <SelectTrigger aria-label={t("agents.AiProviderSetup.authentication")} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="bearer">
                    {provider === "bedrock"
                      ? t("agents.AiProviderSetup.bedrockApiKey")
                      : t("agents.AiProviderSetup.bearerToken")}
                  </SelectItem>
                  {provider !== "bedrock" && (
                    <>
                      {protocol === "messages" && (
                        <SelectItem value="api_key">
                          {t("agents.AiProviderSetup.apiKeyXApiKey")}
                        </SelectItem>
                      )}
                      <SelectItem value="none">{t("agents.AiProviderSetup.noAuthentication")}</SelectItem>
                    </>
                  )}
                </SelectContent>
              </Select>
            </label>
          )}
          {
            auth !== "none" && (
              <label className="block space-y-2 text-xs text-muted-foreground">
                {t("agents.AiProviderSetup.apiKey")}
                <Input
                  aria-label={t("agents.AiProviderSetup.apiKey")}
                  type="password"
                  autoComplete="new-password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                />
              </label>
            )
          }
          {reconnect && <details><summary className="cursor-pointer text-sm text-muted-foreground">{t("agents.AiProviderSetup.modelSettings")}</summary>{modelSettings}</details>}
          <p className="text-xs text-muted-foreground">
            {t("agents.AiProviderSetup.testConnection")}
          </p>
          {save.error && (
            <p role="alert" className="text-sm text-destructive">
              {save.error instanceof Error && save.error.name === "ZodError"
                ? t("agents.AiProviderSetup.zodError")
                : describeError(save.error).body}
            </p>
          )}
          {accessDefaults}
          <div className="flex items-center justify-between gap-3">
            <Button
              type="button"
              variant="ghost"
              onClick={cancel}
              disabled={save.isPending}
            >
              {t("agents.AiProviderSetup.back")}
            </Button>
            <Button
              type="submit"
              disabled={
                save.isPending || accounts.isPending || accountsView.kind === "reconnecting" || accountsView.kind === "error" ||
                (!reconnect && ownership === "shared" && !allAgents && agentIds.size === 0) ||
                (auth !== "none" && !apiKey.trim())
              }
            >
              {save.isPending
                ? submitLabel ? t("agents.AiProviderSetup.saving") : t("agents.AiProviderSetup.connecting")
                : reconnect
                  ? t("agents.AiProviderSetup.reconnectAction")
                  : submitLabel ?? t("agents.AiProviderSetup.connectAction")}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
