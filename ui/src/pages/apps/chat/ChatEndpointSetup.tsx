import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Check, ExternalLink, Eye, EyeOff, Loader2 } from "lucide-react";
import { AgentSelect } from "@/components/AgentMultiSelect";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { useToast } from "@/context/ToastContext";
import { agentsApi } from "@/api/agents";
import {
  chatEndpointsApi,
  type ChatEndpoint,
  type ChatProvider,
  type ChatEndpointSetupAction,
} from "@/api/chatEndpoints";
import { useNavigate, useSearchParams } from "@/lib/router";
import { isAgentStatusInvokable } from "@paperclipai/shared";

const providerNames: Record<ChatProvider, string> = {
  slack: "Slack",
  github: "GitHub",
  "microsoft-teams": "Microsoft Teams",
  telegram: "Telegram",
};

const knownProviders = new Set(Object.keys(providerNames));

function isProvider(value: string | null): value is ChatProvider {
  return value !== null && knownProviders.has(value);
}

function slackBotNameForAgent(agentName: string): string {
  const safeName = agentName
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  return safeName || "paperclip-agent";
}

function publicOrigin(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function SetupRail({ step }: { step: number }) {
  return (
    <ol className="space-y-2 text-sm" aria-label="Connection setup progress">
      {["Choose agent", "Connect provider", "Try it"].map((label, index) => (
        <li key={label} className="flex items-center gap-2">
          <span
            className={`flex h-6 w-6 items-center justify-center rounded-full border ${index < step ? "border-primary bg-primary text-primary-foreground" : index === step ? "border-foreground text-foreground" : "border-border text-muted-foreground"}`}
          >
            {index < step ? <Check className="h-3.5 w-3.5" /> : index + 1}
          </span>
          <span
            className={
              index === step
                ? "font-medium text-foreground"
                : "text-muted-foreground"
            }
          >
            {label}
          </span>
        </li>
      ))}
    </ol>
  );
}

export function ChatEndpointSetup() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const provider = isProvider(params.get("provider"))
    ? (params.get("provider") as ChatProvider)
    : null;
  const toolHref = params.get("toolHref") || "/apps";
  const preselectedAgent = params.get("agentId") ?? "";
  const resumeEndpointId = params.get("resume") ?? "";
  const [purpose, setPurpose] = useState<"choice" | "chat">(
    params.get("purpose") === "chat" ? "chat" : "choice",
  );
  const [agentId, setAgentId] = useState(preselectedAgent);
  const [endpoint, setEndpoint] = useState<ChatEndpoint | null>(null);
  const [credentials, setCredentials] = useState<Record<string, string>>({});

  useEffect(() => {
    setBreadcrumbs([
      { label: "Connectors", href: "/apps" },
      { label: "Connect chat" },
    ]);
    return () => setBreadcrumbs([]);
  }, [setBreadcrumbs]);

  const agentsQuery = useQuery({
    queryKey: ["chat-endpoint-setup-agents", selectedCompanyId],
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });
  const resumeQuery = useQuery({
    queryKey: ["chat-endpoint-setup-resume", resumeEndpointId],
    queryFn: () => chatEndpointsApi.get(resumeEndpointId),
    enabled: Boolean(resumeEndpointId),
  });
  useEffect(() => {
    if (!resumeQuery.data) return;
    setEndpoint(resumeQuery.data);
    setAgentId(resumeQuery.data.assignedAgentId);
    setPurpose("chat");
  }, [resumeQuery.data]);
  const activeAgents = useMemo(
    () =>
      (agentsQuery.data ?? []).filter((agent) =>
        isAgentStatusInvokable(agent.status),
      ),
    [agentsQuery.data],
  );
  const createEndpoint = useMutation({
    mutationFn: () =>
      chatEndpointsApi.create(selectedCompanyId!, {
        provider: provider!,
        assignedAgentId: agentId,
      }),
    onSuccess: setEndpoint,
    onError: (error) =>
      pushToast({
        title: "Couldn't start setup",
        body: error instanceof Error ? error.message : "Try again.",
        tone: "error",
      }),
  });
  const setupAction = useMutation({
    mutationFn: ({
      action,
      values,
    }: {
      action: ChatEndpointSetupAction;
      values?: Record<string, string>;
    }) => chatEndpointsApi.setup(endpoint!.id, { action, credentials: values }),
    onSuccess: setEndpoint,
    onError: (error) =>
      pushToast({
        title: "Connection failed",
        body:
          error instanceof Error
            ? error.message
            : "Check the required values and try again.",
        tone: "error",
      }),
  });
  const testConnection = useMutation({
    mutationFn: () => chatEndpointsApi.test(endpoint!.id),
    onSuccess: (next) => {
      if (next.status === "active") navigate(`/apps/chat/${next.id}/settings`);
      else setEndpoint(next);
    },
    onError: (error) =>
      pushToast({
        title: "Test not complete",
        body:
          error instanceof Error
            ? error.message
            : "Send the provider message, then try again.",
        tone: "error",
      }),
  });

  if (!provider)
    return (
      <p className="text-sm text-destructive">
        This chat provider is not supported.
      </p>
    );
  if (!selectedCompanyId)
    return (
      <p className="text-sm text-muted-foreground">
        Select an organization to connect chat.
      </p>
    );

  if (purpose === "choice") {
    return (
      <div className="max-w-2xl space-y-6">
        <div>
          <h1 className="text-xl font-bold">Choose how to connect</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            What should this {providerNames[provider]} connection do?
          </p>
        </div>
        <div className="grid gap-3">
          <button
            type="button"
            className="rounded-xl border border-border p-4 text-left hover:bg-accent/40"
            onClick={() => setPurpose("chat")}
          >
            <span className="block text-sm font-semibold">
              Chat with an agent
            </span>
            <span className="mt-1 block text-sm text-muted-foreground">
              People in {providerNames[provider]} can start and continue
              Paperclip tasks.
            </span>
          </button>
          <button
            type="button"
            className="rounded-xl border border-border p-4 text-left hover:bg-accent/40"
            onClick={() => navigate(toolHref)}
          >
            <span className="block text-sm font-semibold">
              Use this connection as an agent tool
            </span>
            <span className="mt-1 block text-sm text-muted-foreground">
              Let agents use {providerNames[provider]} actions and data while
              they work.
            </span>
          </button>
        </div>
      </div>
    );
  }

  const repairing = Boolean(
    resumeEndpointId &&
    endpoint &&
    (endpoint.status === "attention" || endpoint.status === "revoked"),
  );
  const step = endpoint
    ? !repairing &&
      (endpoint.setup?.step === "test" || endpoint.setup?.step === "complete")
      ? 2
      : 1
    : 0;
  const selectedAgent = activeAgents.find((agent) => agent.id === agentId);
  return (
    <div className="grid max-w-4xl gap-8 md:grid-cols-(--gtc-11)">
      <SetupRail step={step} />
      <main className="min-w-0 space-y-6">
        {!endpoint ? (
          <>
            <div>
              <h1 className="text-xl font-bold">
                Which agent do you want to chat with?
              </h1>
              <p className="mt-1 text-sm text-muted-foreground">
                This agent is permanent for the connection. Connect another
                channel to represent a different agent.
              </p>
            </div>
            <AgentSelect
              agents={activeAgents}
              value={agentId}
              onChange={setAgentId}
              placeholder="Choose an active agent"
              emptyMessage="No active agents are available."
            />
            <div className="flex justify-end">
              <Button
                disabled={!agentId || createEndpoint.isPending}
                onClick={() => createEndpoint.mutate()}
              >
                {createEndpoint.isPending && (
                  <Loader2 className="h-4 w-4 animate-spin" />
                )}
                Continue
              </Button>
            </div>
          </>
        ) : step === 1 ? (
          <ProviderConnectStep
            provider={provider}
            agentName={selectedAgent?.name ?? endpoint.assignedAgentName}
            endpoint={endpoint}
            credentials={credentials}
            setCredentials={setCredentials}
            repairing={repairing}
            pending={setupAction.isPending}
            onAction={(action, values) =>
              setupAction.mutate({ action, values })
            }
          />
        ) : (
          <TryStep
            provider={provider}
            agentName={selectedAgent?.name ?? endpoint.assignedAgentName}
            botLabel={endpoint.botLabel}
            botUsername={endpoint.botUsername}
            providerUrl={endpoint.setup?.providerUrl}
            pending={testConnection.isPending}
            onTest={() => testConnection.mutate()}
          />
        )}
        <div className="flex justify-start">
          <Button variant="ghost" onClick={() => navigate("/apps")}>
            Save &amp; exit
          </Button>
        </div>
      </main>
    </div>
  );
}

function ProviderConnectStep({
  provider,
  agentName,
  endpoint,
  credentials,
  setCredentials,
  repairing,
  pending,
  onAction,
}: {
  provider: ChatProvider;
  agentName: string;
  endpoint: ChatEndpoint;
  credentials: Record<string, string>;
  setCredentials: (next: Record<string, string>) => void;
  repairing: boolean;
  pending: boolean;
  onAction: (
    action: ChatEndpointSetupAction,
    values?: Record<string, string>,
  ) => void;
}) {
  const field = (key: string, label: string, type = "password") => (
    <label className="grid gap-2 text-sm font-medium">
      {label}
      <Input
        type={type}
        value={credentials[key] ?? ""}
        onChange={(event) =>
          setCredentials({ ...credentials, [key]: event.target.value })
        }
      />
    </label>
  );
  const openProviderSetup = (fallback: string) =>
    window.open(
      endpoint.setup?.authorizationUrl ??
        endpoint.setup?.providerUrl ??
        fallback,
      "_blank",
      "noopener,noreferrer",
    );
  const endpointValue = (label: string, value: string | null | undefined) => (
    <div className="grid gap-2">
      <p className="text-sm font-medium">{label}</p>
      <div className="rounded-lg border border-border bg-muted p-3 font-mono text-xs break-all">
        {value ??
          "This endpoint is unavailable. Check the server's public URL."}
      </div>
    </div>
  );
  const [manifestCopied, setManifestCopied] = useState(false);
  const [privateKeyVisible, setPrivateKeyVisible] = useState(false);
  const slackCommand =
    endpoint.setup?.command ??
    `/${
      agentName
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 24) || "paperclip"
    }`;
  const slackBotName = slackBotNameForAgent(agentName);
  const slackAppName = `${slackBotName.slice(0, 25)}-paperclip`;
  const slackWebhookUrl =
    endpoint.setup?.webhookUrl ?? "<paperclip-webhook-url>";
  const slackManifest = `display_information:
  name: ${JSON.stringify(slackAppName)}
features:
  bot_user:
    display_name: ${JSON.stringify(slackBotName)}
  slash_commands:
    - command: ${JSON.stringify(slackCommand)}
      description: Start or manage work with ${JSON.stringify(agentName)}
      usage_hint: ${JSON.stringify("status | new <task> | <task>")}
      should_escape: false
      url: ${JSON.stringify(slackWebhookUrl)}
oauth_config:
  scopes:
    bot:
      - app_mentions:read
      - channels:history
      - channels:read
      - chat:write
      - commands
      - files:read
      - files:write
      - groups:history
      - groups:read
      - im:history
      - im:read
      - mpim:history
      - mpim:read
      - reactions:write
      - users:read
settings:
  org_deploy_enabled: false
  socket_mode_enabled: false
  token_rotation_enabled: false
  event_subscriptions:
    request_url: ${JSON.stringify(slackWebhookUrl)}
    bot_events:
      - app_mention
      - message.channels
      - message.groups
      - message.im
      - message.mpim
      - member_joined_channel
      - member_left_channel
      - channel_archive
      - channel_unarchive
      - channel_deleted
      - channel_rename
      - app_uninstalled
      - tokens_revoked
  interactivity:
    is_enabled: true
    request_url: ${JSON.stringify(slackWebhookUrl)}`;
  const teamsClientId =
    credentials.clientId?.trim() || "<application-client-id>";
  const teamsManifestSettings = JSON.stringify(
    {
      bots: [
        {
          botId: teamsClientId,
          scopes: ["personal", "team", "groupchat"],
          supportsFiles: true,
          isNotificationOnly: false,
        },
      ],
      webApplicationInfo: {
        id: teamsClientId,
        resource: `api://paperclip-chat/${teamsClientId}`,
      },
      authorization: {
        permissions: {
          resourceSpecific: [
            { name: "ChannelMessage.Read.Group", type: "Application" },
            { name: "ChatMessage.Read.Chat", type: "Application" },
          ],
        },
      },
    },
    null,
    2,
  );
  if (provider === "telegram")
    return (
      <div className="space-y-5">
        <div>
          <h1 className="text-xl font-bold">Create {agentName} in Telegram</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Create a bot with BotFather, then paste the token it gives you.
          </p>
        </div>
        <ol className="list-decimal space-y-2 pl-5 text-sm">
          <li>
            Open BotFather and send <code>/newbot</code>.
          </li>
          <li>Enter the bot display name.</li>
          <li>
            Choose an available username ending in <code>bot</code>.
          </li>
          <li>
            Leave privacy mode enabled. Paperclip supports private chats,
            groups, supergroups, and forum topics. In a group or topic, start
            with an <code>@mention</code> or command and continue with replies
            addressed to the bot.
          </li>
        </ol>
        <p className="text-sm text-muted-foreground">
          Connect bot replaces any webhook already registered for this token, so
          use a bot dedicated to this Paperclip connection.
        </p>
        <Button
          variant="outline"
          onClick={() => openProviderSetup("https://t.me/BotFather")}
        >
          Open BotFather <ExternalLink />
        </Button>
        {field("botToken", "Bot token")}
        {!endpoint.setup?.webhookUrl && (
          <p className="text-sm text-destructive">
            Configure a public HTTPS URL for this Paperclip instance before
            connecting Telegram.
          </p>
        )}
        <Button
          disabled={
            !credentials.botToken || !endpoint.setup?.webhookUrl || pending
          }
          onClick={() => onAction("configure", credentials)}
        >
          {pending && <Loader2 className="h-4 w-4 animate-spin" />}Connect bot
        </Button>
      </div>
    );
  if (provider === "microsoft-teams")
    return (
      <div className="space-y-5">
        <div>
          <h1 className="text-xl font-bold">
            Connect {agentName} to Microsoft Teams
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Use your own Microsoft app credentials for this bot.
          </p>
        </div>
        <ol className="list-decimal space-y-2 pl-5 text-sm">
          <li>
            In Microsoft Entra, create a single-tenant app registration. Copy
            its Application (client) ID and Directory (tenant) ID, then create a
            client secret and copy its value.
          </li>
          <li>
            In Azure, create an Azure Bot. Choose Single Tenant, use that
            Application ID, set its messaging endpoint to the Paperclip URL
            below, and add the Microsoft Teams channel.
          </li>
          <li>
            In Teams Developer Portal, create an app, add a bot with the same
            Application ID, then apply the manifest settings shown below. These
            are Teams resource-specific consent permissions in the app manifest,
            not Microsoft Graph permissions in Entra. Download the package and
            upload it to the target standard channel or chat.
          </li>
        </ol>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline">
            <a
              href="https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade"
              target="_blank"
              rel="noreferrer"
            >
              Open Microsoft Entra <ExternalLink />
            </a>
          </Button>
          <Button asChild variant="outline">
            <a
              href="https://portal.azure.com/#create/Microsoft.AzureBot"
              target="_blank"
              rel="noreferrer"
            >
              Create Azure Bot <ExternalLink />
            </a>
          </Button>
          <Button asChild variant="outline">
            <a
              href="https://dev.teams.microsoft.com/apps"
              target="_blank"
              rel="noreferrer"
            >
              Open Teams Developer Portal <ExternalLink />
            </a>
          </Button>
        </div>
        {endpointValue(
          "Paperclip messaging endpoint",
          endpoint.setup?.messagingEndpoint,
        )}
        {field("clientId", "Application / Client ID", "text")}
        {field("tenantId", "Directory / Tenant ID", "text")}
        {field("clientSecret", "Client secret value")}
        <label className="grid gap-2 text-sm font-medium">
          Required Teams app manifest settings
          <Textarea
            className="min-h-80 font-mono text-xs"
            readOnly
            value={teamsManifestSettings}
          />
        </label>
        <p className="text-sm text-muted-foreground">
          This release supports personal chats, group chats, and standard team
          channels—not private channels. <code>supportsFiles: true</code>{" "}
          enables native file receipt only in personal chat; channel and
          group-chat files need a separate Microsoft Graph connection and are
          not ingested here.
        </p>
        {!endpoint.setup?.messagingEndpoint && (
          <p className="text-sm text-destructive">
            Configure a public HTTPS URL for this Paperclip instance before
            connecting Microsoft Teams.
          </p>
        )}
        <Button
          disabled={
            !credentials.clientId ||
            !credentials.tenantId ||
            !credentials.clientSecret ||
            !endpoint.setup?.messagingEndpoint ||
            pending
          }
          onClick={() => onAction("configure", credentials)}
        >
          {pending && <Loader2 className="h-4 w-4 animate-spin" />}
          Verify Microsoft credentials
        </Button>
      </div>
    );
  if (provider === "github")
    return (
      <div className="space-y-5">
        <div>
          <h1 className="text-xl font-bold">Create or connect a GitHub App</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Configure its webhook and permissions, then verify the App with
            Paperclip.
          </p>
        </div>
        <ol className="list-decimal space-y-2 pl-5 text-sm">
          <li>
            Under the target user or organization, create a new GitHub App. Give
            it a globally unique name (34 characters or fewer), use the
            Paperclip homepage URL below, and leave user authorization off.
          </li>
          <li>
            Keep <strong>Webhooks · Active</strong> on. Enter the Paperclip
            webhook URL and a new webhook secret, and keep{" "}
            <strong>Enable SSL verification</strong> selected.
          </li>
          <li>
            Under Repository permissions, set <strong>Issues</strong> and{" "}
            <strong>Pull requests</strong> to <strong>Read &amp; write</strong>.
            Leave every other permission at its default; Metadata remains
            read-only.
          </li>
          <li>
            Subscribe to exactly <strong>Issue comment</strong> (
            <code>issue_comment</code>), <strong>Pull request</strong> (
            <code>pull_request</code>), and{" "}
            <strong>Pull request review comment</strong> (
            <code>pull_request_review_comment</code>).
          </li>
          <li>
            Choose <strong>Only on this account</strong>, create the App, copy
            its App ID, generate one private key, then install it on the
            selected repositories.
          </li>
        </ol>
        {endpointValue(
          "Paperclip homepage URL",
          publicOrigin(endpoint.setup?.webhookUrl),
        )}
        {endpointValue("Paperclip webhook URL", endpoint.setup?.webhookUrl)}
        <Button
          variant="outline"
          onClick={() =>
            window.open(
              "https://github.com/settings/apps",
              "_blank",
              "noopener,noreferrer",
            )
          }
        >
          Open GitHub App settings <ExternalLink />
        </Button>
        {field("appId", "GitHub App ID", "text")}
        <label className="grid gap-2 text-sm font-medium">
          Private key (PEM)
          <div className="relative">
            <Textarea
              className="min-h-24 pr-11 font-mono text-xs"
              style={
                privateKeyVisible
                  ? undefined
                  : ({ WebkitTextSecurity: "disc" } as CSSProperties)
              }
              value={credentials.privateKey ?? ""}
              onChange={(event) =>
                setCredentials({
                  ...credentials,
                  privateKey: event.target.value,
                })
              }
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="absolute right-1 top-1"
              aria-label={
                privateKeyVisible ? "Hide private key" : "Show private key"
              }
              onClick={() => setPrivateKeyVisible((visible) => !visible)}
            >
              {privateKeyVisible ? <EyeOff /> : <Eye />}
            </Button>
          </div>
        </label>
        {field("webhookSecret", "Webhook secret")}
        {!endpoint.setup?.webhookUrl && (
          <p className="text-sm text-destructive">
            Configure a public HTTPS URL for this Paperclip instance before
            connecting GitHub.
          </p>
        )}
        <Button
          disabled={
            !credentials.appId ||
            !credentials.privateKey ||
            !credentials.webhookSecret ||
            !endpoint.setup?.webhookUrl ||
            pending
          }
          onClick={() => onAction("configure", credentials)}
        >
          {pending && <Loader2 className="h-4 w-4 animate-spin" />}
          Connect and verify
        </Button>
      </div>
    );
  if (endpoint.providerAccountId && !repairing)
    return (
      <div className="space-y-5">
        <div>
          <h1 className="text-xl font-bold">Finish Slack setup</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Point the Slack app at Paperclip now that its signing secret is
            connected.
          </p>
        </div>
        {endpointValue("Paperclip webhook URL", endpoint.setup?.webhookUrl)}
        <ol className="list-decimal space-y-2 pl-5 text-sm">
          <li>
            Return to <strong>App Manifest</strong> in Slack and click{" "}
            <strong>Save Changes</strong>. The copied manifest already contains
            the event, interaction, and slash-command URLs; saving now lets
            Slack verify them against the connected signing secret.
          </li>
        </ol>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            onClick={() => openProviderSetup("https://api.slack.com/apps")}
          >
            Open Slack app settings <ExternalLink />
          </Button>
          <Button disabled={pending} onClick={() => onAction("verify")}>
            {pending && <Loader2 className="h-4 w-4 animate-spin" />}
            Start Slack message test
          </Button>
        </div>
      </div>
    );
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-bold">Connect a Slack app</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Bring your own Slack app. The manifest requests the scopes Paperclip
          needs; credentials remain write-only.
        </p>
      </div>
      <ol className="list-decimal space-y-2 pl-5 text-sm">
        <li>
          Copy the manifest, then create a Slack app{" "}
          <strong>From an app manifest</strong> in the target workspace.
        </li>
        <li>
          Open <strong>OAuth &amp; Permissions</strong>, install the app to the
          workspace, and copy its Bot User OAuth Token.
        </li>
        <li>
          Open <strong>Basic Information</strong> and copy its Signing Secret.
        </li>
      </ol>
      <div className="space-y-2 rounded-lg border border-border p-3 text-sm">
        <div className="flex items-center justify-between gap-4">
          <span className="text-muted-foreground">Slack app name</span>
          <code>{slackAppName}</code>
        </div>
        <div className="flex items-center justify-between gap-4">
          <span className="text-muted-foreground">Bot display name</span>
          <code>{slackBotName}</code>
        </div>
        <div className="flex items-center justify-between gap-4">
          <span className="text-muted-foreground">Slash command</span>
          <code>{slackCommand}</code>
        </div>
      </div>
      <label className="grid gap-2 text-sm font-medium">
        Slack app manifest
        <Textarea
          className="min-h-56 font-mono text-xs"
          readOnly
          value={slackManifest}
        />
      </label>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          onClick={() => {
            void navigator.clipboard
              .writeText(slackManifest)
              .then(() => setManifestCopied(true));
          }}
        >
          {manifestCopied ? "Manifest copied" : "Copy manifest"}
        </Button>
        <Button
          variant="outline"
          onClick={() => openProviderSetup("https://api.slack.com/apps")}
        >
          Open Slack app settings <ExternalLink />
        </Button>
      </div>
      {field("botToken", "Bot User OAuth Token")}
      {field("signingSecret", "Signing Secret")}
      {!endpoint.setup?.webhookUrl && (
        <p className="text-sm text-destructive">
          Configure a public HTTPS URL for this Paperclip instance before
          connecting Slack.
        </p>
      )}
      <Button
        disabled={
          !credentials.botToken ||
          !credentials.signingSecret ||
          !endpoint.setup?.webhookUrl ||
          pending
        }
        onClick={() => onAction("configure", credentials)}
      >
        {pending && <Loader2 className="h-4 w-4 animate-spin" />}
        Connect Slack app
      </Button>
    </div>
  );
}

function TryStep({
  provider,
  agentName,
  botLabel,
  botUsername,
  providerUrl,
  pending,
  onTest,
}: {
  provider: ChatProvider;
  agentName: string;
  botLabel?: string | null;
  botUsername?: string | null;
  providerUrl?: string | null;
  pending: boolean;
  onTest: () => void;
}) {
  const botMention = botUsername
    ? `@${botUsername.replace(/^@/, "")}`
    : (botLabel ?? agentName);
  const instructions =
    provider === "telegram"
      ? [
          "Open the bot's private chat.",
          "Tap Start.",
          "Send “Help me test this”.",
        ]
      : provider === "github"
        ? [
            "Open an installed issue or pull request.",
            `Mention ${botMention} in a comment.`,
            "Add another comment to continue the same task.",
          ]
        : provider === "microsoft-teams"
          ? [
              "Open an installed channel and start a new post.",
              `Mention ${botMention} in the post.`,
              "Reply once beneath the post.",
            ]
          : [
              "Open a channel and invite the bot if needed.",
              `Mention ${botMention} in a new channel message.`,
              `Reply once in ${agentName}'s thread.`,
            ];
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-bold">
          Try {agentName} in {providerNames[provider]}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Complete this real conversation to finish setup.
        </p>
      </div>
      <ol className="list-decimal space-y-2 pl-5 text-sm">
        {instructions.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ol>
      {providerUrl && (
        <Button
          variant="outline"
          onClick={() =>
            window.open(providerUrl, "_blank", "noopener,noreferrer")
          }
        >
          Open {providerNames[provider]} <ExternalLink />
        </Button>
      )}
      <Button disabled={pending} onClick={onTest}>
        {pending && <Loader2 className="h-4 w-4 animate-spin" />}I've sent the
        test message
      </Button>
    </div>
  );
}
