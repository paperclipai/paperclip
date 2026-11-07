import { useTranslation, t as translate } from "@/i18n";
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
    get description() { return translate("connections:chatgpt_subscription_or_api_key_84fc676"); },
  },
  {
    id: "anthropic",
    name: "Anthropic",
    get description() { return translate("connections:claude_subscription_or_api_key_a01787c"); },
  },
  { id: "google", name: "Google", get description() { return translate("connections:antigravity_sign_in_or_gemini_api_key_250eec2"); } },
  { id: "xai", name: "xAI", get description() { return translate("connections:grok_subscription_or_api_key_255bb06"); } },
  {
    id: "openrouter",
    name: "OpenRouter",
    get description() { return translate("connections:models_through_one_api_key_2241530"); },
    advanced: true,
  },
  {
    id: "bedrock",
    name: "Amazon Bedrock",
    get description() { return translate("connections:bedrock_api_key_and_aws_region_5c2e7cd"); },
    advanced: true,
  },
  {
    id: "gateway",
    get name() { return translate("connections:custom_gateway_398e497"); },
    get description() { return translate("connections:emissary_or_another_compatible_endpoint_429103e"); },
    advanced: true,
  },
  {
    id: "local",
    get name() { return translate("connections:local_endpoint_fa69787"); },
    get description() { return translate("connections:a_model_server_in_the_agent_s_ed67f9b"); },
    advanced: true,
  },
] as const;
type ProviderChoice = (typeof providers)[number]["id"] | "github";

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
  const { t } = useTranslation("connections");
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
  const label = providerLabel ?? providers.find((p) => p.id === provider)?.name ?? (provider === "github" ? "GitHub Copilot" : "provider");
  const displayLabel = providerLabel ?? (provider === "gateway" ? t("final-components-b:Custom_gateway_3a1250") : provider === "local" ? t("final-components-b:Local_endpoint_c04191") : providers.find((p) => p.id === provider)?.name ?? (provider === "github" ? "GitHub Copilot" : t("final-components-b:provider_5c4c19")));
  const canonicalLabel = providerLabel ?? (provider === "gateway" ? "Custom gateway" : provider === "local" ? "Local endpoint" : label);
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
              return canonicalLabel;
            }
          })()
        : canonicalLabel
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
          name: p.id === "gateway" ? t("final-components-b:Custom_gateway_3a1250") : p.id === "local" ? t("final-components-b:Local_endpoint_c04191") : p.name,
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
    <label className="block space-y-2 text-xs text-muted-foreground">{t("model_ids_comma_separated_0932da6")}<Input
        aria-label={t("model_ids_f47692a")}
        value={models}
        onChange={(e) => setModels(e.target.value)}
        disabled={Boolean(reconnect)}
      />
      <span className="block">{t("use_the_provider_s_model_id_or_ae628fc")}</span>
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
      notice={!canManageConnections ? [t("final-components-b:Only_a_connection_manager_can_share_this_credential_with_everyone_or_g_dd620b")] : undefined}
    />
  ) : undefined;
  const cancel = () => reconnect || initialProvider ? onCancel() : setStep("provider");
  if (!reconnect && (accounts.isPending || accountsView.kind === "reconnecting")) return <p role="status">{t("loading_connection_permissions_a1e26ea")}</p>;
  if (!reconnect && accountsView.kind === "error") return <QueryErrorState error={accounts.error} action="load connection permissions" onRetry={accountsView.retry} retrying={accountsView.isFetching} />;
  return (
    <div className="mx-auto w-full max-w-2xl space-y-6" onSubmit={(event) => event.stopPropagation()}>
      <div className="space-y-2">
        <h2 className="text-xl font-semibold">
          {step === "provider"
            ? t("connect_a_model_provider_3447ed6")
            : t("_109aebd", { value: reconnect ? t("reconnect_6988b16") : t("connect_b65463c"), label: displayLabel })}
        </h2>
      </div>
      {agentsView.kind === "error" && <QueryErrorState size="inline" error={agents.error} action="load agents" onRetry={agentsView.retry} retrying={agentsView.isFetching} />}
      {step === "provider" ? (
        <>
          {advancedOnly ? choices(true) : <>
          {choices(false)}
          <details>
            <summary className="cursor-pointer text-sm text-muted-foreground">{t("advanced_providers_1a926da")}</summary>
            <div className="pt-4">{choices(true)}</div>
          </details>
          </>}
          <Button type="button" variant="ghost" onClick={onCancel}>{t("cancel_1791a62")}</Button>
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
              <label className="block space-y-2 text-xs text-muted-foreground">{t("provider_url_58718fb")}<Input
                  aria-label={t("provider_url_de1f83e")}
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
              <label className="block space-y-2 text-xs text-muted-foreground">{t("api_format_77ceed6")}<Select
                  value={protocol}
                  onValueChange={(v) => {
                    setProtocol(v as typeof protocol);
                    if (v !== "messages" && auth === "api_key")
                      setAuth("bearer");
                  }}
                  disabled={Boolean(reconnect) || Boolean(initialProtocol)}
                >
                  <SelectTrigger aria-label={t("api_format_ba7636e")} className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="responses">{t("openai_responses_codex_c1de40b")}</SelectItem>
                    <SelectItem value="messages">{t("anthropic_messages_claude_0191994")}</SelectItem>
                    <SelectItem value="chat">{t("chat_completions_opencode_hermes_2b957cb")}</SelectItem>
                  </SelectContent>
                </Select>
              </label>
            </>
          )}
          {provider === "bedrock" && (
            <label className="block space-y-2 text-xs text-muted-foreground">{t("aws_region_6a319e1")}<Input
                aria-label={t("aws_region_81664b8")}
                value={region}
                onChange={(e) => setRegion(e.target.value)}
                disabled={Boolean(reconnect)}
              />
            </label>
          )}
          {provider !== "openrouter" && (
            <label className="block space-y-2 text-xs text-muted-foreground">{t("authentication_169f249")}<Select
                value={auth}
                onValueChange={(v) => setAuth(v as typeof auth)}
                disabled={Boolean(reconnect)}
              >
                <SelectTrigger aria-label={t("authentication_ee1acfa")} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="bearer">
                    {provider === "bedrock"
                      ? t("bedrock_api_key_59d65e8")
                      : t("bearer_token_ffa64bc")}
                  </SelectItem>
                  {provider !== "bedrock" && (
                    <>
                      {protocol === "messages" && (
                        <SelectItem value="api_key">{t("api_key_x_api_key_b52e25b")}</SelectItem>
                      )}
                      <SelectItem value="none">{t("no_authentication_9cd50fe")}</SelectItem>
                    </>
                  )}
                </SelectContent>
              </Select>
            </label>
          )}
          {
            auth !== "none" && (
              <label className="block space-y-2 text-xs text-muted-foreground">{t("api_key_141b651")}<Input
                  aria-label={t("api_key_cf678ca")}
                  type="password"
                  autoComplete="new-password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                />
              </label>
            )
          }
          {reconnect && <details><summary className="cursor-pointer text-sm text-muted-foreground">{t("model_settings_d96087d")}</summary>{modelSettings}</details>}
          <p className="text-xs text-muted-foreground">{t("test_the_connection_with_your_chosen_model_96f97f2")}</p>
          {save.error && (
            <p role="alert" className="text-sm text-destructive">
              {save.error instanceof Error && save.error.name === "ZodError"
                ? t("check_the_url_api_format_and_authentication_92b3eb6")
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
            >{t("back_7a27042")}</Button>
            <Button
              type="submit"
              disabled={
                save.isPending || accounts.isPending || accountsView.kind === "reconnecting" || accountsView.kind === "error" ||
                (!reconnect && ownership === "shared" && !allAgents && agentIds.size === 0) ||
                (auth !== "none" && !apiKey.trim())
              }
            >
              {save.isPending
                ? submitLabel ? t("saving_56a2285") : t("connecting_fd3e796")
                : reconnect
                  ? t("reconnect_6988b16")
                  : submitLabel ?? t("connect_b65463c")}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
