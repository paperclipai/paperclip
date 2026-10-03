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
import { ConnectionChoiceList } from "@/features/connections/ConnectionChoiceList";
import { AccessStepContent } from "@/features/connections/ConnectionSetupFlow";
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
    description: "ChatGPT subscription or API key",
  },
  {
    id: "anthropic",
    name: "Anthropic",
    description: "Claude subscription or API key",
  },
  { id: "google", name: "Google", description: "Gemini API key" },
  { id: "xai", name: "xAI", description: "Grok subscription or API key" },
  {
    id: "openrouter",
    name: "OpenRouter",
    description: "Models through one API key",
    advanced: true,
  },
  {
    id: "bedrock",
    name: "Amazon Bedrock",
    description: "Bedrock API key and AWS region",
    advanced: true,
  },
  {
    id: "gateway",
    name: "Custom gateway",
    description: "Emissary or another compatible endpoint",
    advanced: true,
  },
  {
    id: "local",
    name: "Local endpoint",
    description: "A model server in the agent’s environment",
    advanced: true,
  },
] as const;
type ProviderChoice = (typeof providers)[number]["id"];

export function AiProviderSetup({
  companyId,
  agentId,
  environmentId,
  initialProvider,
  reconnect,
  onCancel,
  onComplete,
}: {
  companyId: string;
  agentId?: string;
  environmentId?: string;
  initialProvider?: ProviderChoice;
  reconnect?: AiManagedConnectionSummary;
  onCancel: () => void;
  onComplete: (
    binding: Exclude<AiConnectionBinding, { mode: "responsible_user" }>,
  ) => void;
}) {
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
    reconnect ? "connect" : initialProvider ? "access" : "provider",
  );
  const [ownership, setOwnership] = useState<"personal" | "shared">(
    reconnect?.ownership ?? "personal",
  );
  const [allAgentsChoice, setAllAgents] = useState<boolean>();
  const [agentIds, setAgentIds] = useState(new Set(agentId ? [agentId] : []));
  const [protocol, setProtocol] = useState<AiProviderRouting["protocol"]>(
    reconnect?.routing?.protocol ?? "responses",
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
  const canManageConnections = accounts.data?.canManageConnections ?? false;
  const allAgents = allAgentsChoice ?? (!agentId && canManageConnections);
  const agents = useQuery({
    queryKey: ["agents", companyId, "provider-access"],
    queryFn: () => agentsApi.list(companyId),
  });
  const label = providers.find((p) => p.id === provider)?.name ?? "provider";
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
        setStep("access");
        setApiKey("");
        setAuth("bearer");
        save.reset();
      }}
    />
  );
  return (
    <div className="mx-auto w-full max-w-2xl space-y-6" onSubmit={(event) => event.stopPropagation()}>
      <div className="space-y-2">
        <h2 className="text-xl font-semibold">
          {step === "provider"
            ? "Connect a model provider"
            : `${reconnect ? "Reconnect" : "Connect"} ${label}`}
        </h2>
        {step !== "provider" && (
          <p className="text-xs text-muted-foreground">
            {step === "access" ? "Access" : "Connect"}
          </p>
        )}
      </div>
      {step === "provider" ? (
        <>
          {choices(false)}
          <details>
            <summary className="cursor-pointer text-sm text-muted-foreground">
              Advanced providers
            </summary>
            <div className="pt-4">{choices(true)}</div>
          </details>
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        </>
      ) : step === "access" ? (
        <>
          {accounts.error && <p role="alert" className="text-sm text-destructive">Could not load connection permissions. <Button type="button" variant="ghost" onClick={() => void accounts.refetch()}>Retry</Button></p>}
          {agents.error && (
            <p role="alert" className="text-sm text-destructive">
              Could not load agents. Try again.
            </p>
          )}
          <AccessStepContent
            agents={agents.data ?? []}
            pending={accounts.isPending || Boolean(accounts.error)}
            capabilities={{ canCreateOrganizationGrant: canManageConnections, canSetCompanyInstall: canManageConnections }}
            authKind="api_key"
            grantKind={ownership === "shared" ? "organization" : "user"}
            grantKinds={["user", "organization"]}
            setGrantKind={(kind) =>
              setOwnership(kind === "organization" ? "shared" : "personal")
            }
            installChoice={allAgents ? "all" : "specific"}
            setInstallChoice={(choice) => setAllAgents(choice === "all")}
            installAgentIds={agentIds}
            setInstallAgentIds={setAgentIds}
            submitLabel="Continue"
            onBack={() => setStep("provider")}
            onContinue={() => setStep("connect")}
            bare
          />
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
          onCancel={() => (reconnect ? onCancel() : setStep("access"))}
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
                Provider URL
                <Input
                  aria-label="Provider URL"
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
                API format
                <Select
                  value={protocol}
                  onValueChange={(v) => {
                    setProtocol(v as typeof protocol);
                    if (v !== "messages" && auth === "api_key")
                      setAuth("bearer");
                  }}
                  disabled={Boolean(reconnect)}
                >
                  <SelectTrigger aria-label="API format">
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
              AWS region
              <Input
                aria-label="AWS region"
                value={region}
                onChange={(e) => setRegion(e.target.value)}
                disabled={Boolean(reconnect)}
              />
            </label>
          )}
          {provider !== "openrouter" && (
            <label className="block space-y-2 text-xs text-muted-foreground">
              Authentication
              <Select
                value={auth}
                onValueChange={(v) => setAuth(v as typeof auth)}
                disabled={Boolean(reconnect)}
              >
                <SelectTrigger aria-label="Authentication">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="bearer">
                    {provider === "bedrock"
                      ? "Bedrock API key"
                      : "Bearer token"}
                  </SelectItem>
                  {provider !== "bedrock" && (
                    <>
                      {protocol === "messages" && (
                        <SelectItem value="api_key">
                          API key · x-api-key
                        </SelectItem>
                      )}
                      <SelectItem value="none">No authentication</SelectItem>
                    </>
                  )}
                </SelectContent>
              </Select>
            </label>
          )}
          {
            auth !== "none" && (
              <label className="block space-y-2 text-xs text-muted-foreground">
                API key
                <Input
                  aria-label="API key"
                  type="password"
                  autoComplete="new-password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                />
              </label>
            )
          }
          <details>
            <summary className="cursor-pointer text-sm text-muted-foreground">
              Advanced model settings
            </summary>
            <label className="mt-4 block space-y-2 text-xs text-muted-foreground">
              Model IDs (comma separated)
              <Input
                aria-label="Model IDs"
                value={models}
                onChange={(e) => setModels(e.target.value)}
                disabled={Boolean(reconnect)}
              />
              <span className="block">
                Use the provider’s model ID or your gateway’s alias. You can
                also enter one on the agent.
              </span>
            </label>
          </details>
          <p className="text-xs text-muted-foreground">
            Test the connection with your chosen model in the agent’s execution
            environment after connecting.
          </p>
          {save.error && (
            <p role="alert" className="text-sm text-destructive">
              {save.error instanceof Error && save.error.name === "ZodError"
                ? "Check the URL, API format, and authentication fields."
                : save.error.message}
            </p>
          )}
          <div className="flex items-center justify-between gap-3">
            <Button
              type="button"
              variant="ghost"
              onClick={() => (reconnect ? onCancel() : setStep("access"))}
              disabled={save.isPending}
            >
              Back
            </Button>
            <Button
              type="submit"
              disabled={
                save.isPending ||
                (auth !== "none" && !apiKey.trim())
              }
            >
              {save.isPending
                ? "Connecting…"
                : reconnect
                  ? "Reconnect"
                  : "Connect"}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
