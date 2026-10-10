import { useState } from "react";
import { Network } from "lucide-react";
import { ConnectionChoiceList } from "@/features/connections/ConnectionChoiceList";
import { StepHeader, ConnectionAccessDefaults, connectionDefaultSummarySentence } from "@/features/connections/ConnectionSetupFlow";
import { ProviderApiKeyCard } from "@/components/AdapterLoginChrome";
import { AppLogo } from "@/pages/apps/AppLogo";
import { Button } from "@/components/ui/button";
import {
  AdvancedOptions,
  Choice,
  Footer,
  Notice,
  Surface,
  TextField,
} from "./shared";
import {
  connections,
  formatLabels,
  providers,
  isAdvancedProvider,
  type Connection,
  type Protocol,
  type Provider,
} from "./model";

export type SetupProps = {
  initialProvider?: Provider;
  initialStep?: "provider" | "access" | "connect";
  initialMethod?: string;
  initialProtocol?: Protocol;
  initialError?: "credential" | "endpoint";
  initialAdvanced?: boolean;
  onComplete?: (connection: Connection) => void;
  onCancel?: () => void;
};

/** Shared by the onboarding, Apps, agent, and task prototypes. No network requests. */
export function ConnectionSetup({
  initialProvider = "openrouter",
  initialStep = "provider",
  initialMethod = "key",
  initialProtocol = "responses",
  initialError,
  initialAdvanced = false,
  onComplete,
  onCancel,
}: SetupProps) {
  const [step, setStep] = useState<string>(initialStep === "access" ? "connect" : initialStep);
  const [provider, setProvider] = useState(initialProvider);
  const [method, setMethod] = useState(initialMethod);
  const [protocol, setProtocol] = useState<Protocol>(initialProtocol);
  const [endpoint, setEndpoint] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [secret, setSecret] = useState("");
  const [sessionToken, setSessionToken] = useState("");
  const [region, setRegion] = useState(
    initialProvider === "google" ? "us-central1" : "us-east-1",
  );
  const [project, setProject] = useState("");
  const [header, setHeader] = useState("X-API-Key");
  const [ownership, setOwnership] = useState<"personal" | "shared">("shared");
  const [allAgents, setAllAgents] = useState(true);
  const [agentIds, setAgentIds] = useState(new Set(["nova"]));
  const [error, setError] = useState(initialError);
  const [result, setResult] = useState<Connection>();
  const providerLabel = providers.find(
    (entry) => entry.value === provider,
  )!.label;
  const isDirect = ["openai", "anthropic", "xai"].includes(provider);
  const isAws = provider === "bedrock";
  const isVertex = provider === "google" && method === "identity";
  const needsKey = !["identity", "none", "subscription"].includes(method);
  const canConnect =
    (!needsKey || Boolean(apiKey.trim())) &&
    (method !== "header" || Boolean(header.trim())) &&
    (method !== "aws-keys" || Boolean(secret.trim())) &&
    (provider !== "custom" || Boolean(endpoint.trim())) &&
    (!isVertex || Boolean(project.trim() && region.trim()));

  function connect() {
    if (provider === "custom") {
      try {
        const url = new URL(endpoint);
        if (
          !["http:", "https:"].includes(url.protocol) ||
          url.username ||
          url.password
        )
          throw new Error();
      } catch {
        setError("endpoint");
        return;
      }
    }
    const template = connections.find((entry) => entry.provider === provider);
    const next: Connection = {
      id: "created-connection",
      name: `${ownership === "personal" ? "My" : "Company"} ${provider === "custom" ? new URL(endpoint).hostname : providerLabel}`,
      provider,
      endpoint: isAws
        ? region
        : provider === "custom"
          ? endpoint
          : isVertex
            ? `${project} · ${region}`
            : (template?.endpoint ?? providerLabel),
      protocols:
        provider === "custom"
          ? [protocol]
          : (template?.protocols ?? ["responses", "chat", "messages"]),
      method:
        method === "identity"
          ? "Environment identity"
          : method === "subscription"
            ? "Subscription"
            : method === "none"
              ? "No authentication"
              : method === "aws-keys"
                ? "AWS credentials"
                : "API key",
      ownership,
      models:
        provider === "custom"
          ? ["engineering-coder"]
          : (template?.models ?? ["grok-4.7"]),
      status: "connected",
    };
    setApiKey("");
    setSecret("");
    setSessionToken("");
    setError(undefined);
    setResult(next);
    setStep("done");
  }
  const cancel = () => {
    setApiKey("");
    setSecret("");
    setSessionToken("");
    onCancel?.();
    if (!onCancel) setStep("provider");
  };

  const providerChoices = (advanced: boolean) => (
    <ConnectionChoiceList
      choices={providers
        .filter((entry) => isAdvancedProvider(entry.value) === advanced)
        .map((entry) => ({
          id: entry.value,
          name: entry.label,
          description: entry.description,
          icon:
            entry.value === "custom" ? (
              <span className="flex size-9 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                <Network className="size-5" />
              </span>
            ) : (
              <AppLogo name={entry.label} brandKey={entry.value} />
            ),
        }))}
      onSelect={(id) => {
        setProvider(id as Provider);
        setRegion(id === "google" ? "us-central1" : "us-east-1");
        setApiKey("");
        setSecret("");
        setSessionToken("");
        setEndpoint("");
        setMethod("key");
        setError(undefined);
        setStep("connect");
      }}
    />
  );
  if (step === "provider")
    return (
      <Surface
        title="Connect a model provider"
        description="Choose the account you want to connect."
      >
        {providerChoices(false)}
        <AdvancedOptions
          label="Advanced providers"
          defaultOpen={initialAdvanced}
        >
          {providerChoices(true)}
        </AdvancedOptions>
        <Button variant="ghost" className="self-start" onClick={cancel}>
          Cancel
        </Button>
      </Surface>
    );
  if (step === "done" && result)
    return (
      <Surface title="Connection ready" description={result.name}>
        <Notice>
          Credentials connected. Choose a model and test it in your agent’s
          environment before running tasks.
        </Notice>
        <dl className="grid grid-cols-2 gap-3 text-sm">
          <dt className="text-muted-foreground">Provider</dt>
          <dd>{providerLabel}</dd>
          <dt className="text-muted-foreground">Destination</dt>
          <dd className="break-all font-mono text-xs">{result.endpoint}</dd>
          <dt className="text-muted-foreground">Credential access</dt>
          <dd>
            {ownership === "personal"
              ? "Only me"
              : "Any human in the organization"}
          </dd>
          <dt className="text-muted-foreground">Agent access</dt>
          <dd>
            {allAgents
              ? "Any agent"
              : [...agentIds]
                  .map((id) => (id === "nova" ? "Nova" : "Atlas"))
                  .join(", ")}
          </dd>
        </dl>
        <Footer
          back="Add another"
          onBack={() => setStep("provider")}
          next={onComplete ? "Use connection" : "Done"}
          onNext={() => (onComplete ? onComplete(result) : setStep("provider"))}
        />
      </Surface>
    );
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 p-4 sm:p-6">
      <StepHeader
        title={`Connect ${providerLabel}`}
        subtitle="Connect now — permissions and access are yours to change afterwards."
        step="key"
        activeIndex={0}
        labels={["Connect"]}
      />
      <>
          {isAws && (
            <Choice
              label="AWS region"
              value={region}
              onChange={setRegion}
              options={[
                { value: "us-east-1", label: "US East · N. Virginia" },
                { value: "us-west-2", label: "US West · Oregon" },
                { value: "eu-west-1", label: "Europe · Ireland" },
              ]}
            />
          )}
          {provider === "custom" && (
            <>
              <Choice
                label="API format"
                value={protocol}
                onChange={(value) => setProtocol(value as Protocol)}
                options={Object.entries(formatLabels).map(([value, label]) => ({
                  value,
                  label,
                }))}
              />
              <TextField
                label="Base URL"
                placeholder="https://models.example.com/v1"
                value={endpoint}
                onChange={(event) => {
                  setEndpoint(event.target.value);
                  setError(undefined);
                }}
                hint="Use the base URL supplied by your provider, including any API prefix. Model IDs are configured separately."
              />
            </>
          )}
          <Choice
            label="Authentication"
            value={method}
            onChange={(value) => {
              setMethod(value);
              setApiKey("");
              setSecret("");
              setError(undefined);
            }}
            options={[
              { value: "key", label: isAws ? "Bedrock API key" : "API key" },
              ...(isDirect
                ? [{ value: "subscription", label: "Subscription" }]
                : []),
              ...(isAws || provider === "google"
                ? [
                    {
                      value: "identity",
                      label: isAws
                        ? "Use environment’s AWS identity"
                        : "Vertex AI · environment identity",
                    },
                  ]
                : []),
              ...(provider === "custom"
                ? [
                    { value: "header", label: "Custom authentication header" },
                    { value: "none", label: "No authentication" },
                  ]
                : []),
            ]}
          />
          {method === "identity" && (
            <>
              <Choice
                label="Credential environment"
                value="cloud"
                onChange={() => {}}
                options={[
                  {
                    value: "cloud",
                    label: isAws
                      ? "Company AWS workspace"
                      : "Company Google Cloud workspace",
                  },
                ]}
              />
              <p className="text-xs text-muted-foreground">
                Uses the identity available inside the selected execution
                environment. Agents running elsewhere need an identity there
                too.
              </p>
            </>
          )}
          {isVertex && (
            <>
              <TextField
                label="Google Cloud project"
                value={project}
                onChange={(event) => setProject(event.target.value)}
              />
              <TextField
                label="Location"
                value={region}
                onChange={(event) => setRegion(event.target.value)}
              />
            </>
          )}
          {method === "header" && (
            <TextField
              label="Header name"
              value={header}
              onChange={(event) => setHeader(event.target.value)}
            />
          )}
          {method === "key" ? (
            <ProviderApiKeyCard
              providerName={providerLabel}
              value={apiKey}
              onChange={(value) => {
                setApiKey(value);
                setError(undefined);
              }}
              onSubmit={() => {
                if (canConnect) connect();
              }}
            />
          ) : (
            needsKey && (
              <TextField
                label={
                  method === "aws-keys"
                    ? "Access key ID"
                    : method === "header"
                      ? "Header value"
                      : "API key"
                }
                type="password"
                autoComplete="off"
                value={apiKey}
                onChange={(event) => {
                  setApiKey(event.target.value);
                  setError(undefined);
                }}
                placeholder="Enter credential"
                hint="Stored securely with this connection."
              />
            )
          )}
          {method === "aws-keys" && (
            <>
              <TextField
                label="Secret access key"
                type="password"
                value={secret}
                onChange={(event) => setSecret(event.target.value)}
              />
              <TextField
                label="Session token (optional)"
                type="password"
                value={sessionToken}
                onChange={(event) => setSessionToken(event.target.value)}
              />
            </>
          )}
          {error && (
            <Notice error>
              {error === "credential"
                ? "The provider rejected this credential. Enter a replacement and try again."
                : "Enter a valid HTTP or HTTPS base URL without embedded credentials."}
            </Notice>
          )}
          <ConnectionAccessDefaults
            companyId="company-storybook"
            agents={[{ id: "nova", name: "Nova" }, { id: "atlas", name: "Atlas" }]}
            sentence={connectionDefaultSummarySentence({ grantKind: ownership === "shared" ? "organization" : "user", authKind: method === "none" ? "none" : "api_key", installChoice: allAgents ? "all" : "specific", installCount: agentIds.size })}
            authKind={method === "none" ? "none" : "api_key"}
            grantKinds={["user", "organization"]}
            grantKind={ownership === "shared" ? "organization" : "user"}
            setGrantKind={kind => setOwnership(kind === "organization" ? "shared" : "personal")}
            installChoice={allAgents ? "all" : "specific"}
            setInstallChoice={choice => setAllAgents(choice === "all")}
            installAgentIds={agentIds}
            setInstallAgentIds={setAgentIds}
          />
          <Footer
            onBack={cancel}
            next={method === "subscription" ? "Sign in" : "Connect"}
            onNext={connect}
            disabled={!canConnect}
          />
      </>
    </div>
  );
}
