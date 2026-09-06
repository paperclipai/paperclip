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
  discord: "Discord",
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

export function isChatEndpointRepairing(
  endpoint: Pick<
    ChatEndpoint,
    "provider" | "status" | "providerAccountId" | "botExternalId"
  > | null,
  resumeEndpointId: string | null,
  reconnectRequested: boolean,
): boolean {
  if (!resumeEndpointId || !endpoint) return false;
  const recoveringStatus =
    endpoint.status === "attention" || endpoint.status === "revoked";
  // A secret-only GitHub draft affected by setup trouble has no App identity
  // or reusable App credentials. It must remain first-time setup, where App ID
  // and private key are required, rather than offering a misleading reconnect.
  if (
    endpoint.provider === "github" &&
    recoveringStatus &&
    !endpoint.providerAccountId &&
    !endpoint.botExternalId
  ) {
    return false;
  }
  return (
    recoveringStatus ||
    (reconnectRequested &&
      (endpoint.status === "active" || endpoint.status === "paused"))
  );
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
  const reconnectRequested = params.get("reconnect") === "1";
  const [purpose, setPurpose] = useState<"choice" | "chat">(
    params.get("purpose") === "chat" ? "chat" : "choice",
  );
  const [agentId, setAgentId] = useState(preselectedAgent);
  const [endpoint, setEndpoint] = useState<ChatEndpoint | null>(null);
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [generatedWebhookSecret, setGeneratedWebhookSecret] = useState("");

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
  const githubVerificationQuery = useQuery({
    queryKey: ["chat-endpoint-github-webhook-verification", endpoint?.id],
    queryFn: () => chatEndpointsApi.get(endpoint!.id),
    enabled: Boolean(
      provider === "github" &&
      endpoint?.id &&
      endpoint.setup?.webhookSecretConfigured &&
      !endpoint.setup.webhookVerifiedAt,
    ),
    refetchInterval: 1_500,
  });
  useEffect(() => {
    if (!githubVerificationQuery.data) return;
    setEndpoint(githubVerificationQuery.data);
  }, [githubVerificationQuery.data]);
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
  const generateSetupSecret = useMutation({
    mutationFn: () => chatEndpointsApi.generateSetupSecret(endpoint!.id),
    onSuccess: ({ webhookSecret }) => {
      setGeneratedWebhookSecret(webhookSecret);
      setEndpoint((current) =>
        current
          ? {
              ...current,
              setup: {
                ...current.setup,
                step: current.setup?.step ?? "provider_setup",
                webhookSecretConfigured: true,
                webhookVerifiedAt: null,
              },
            }
          : current,
      );
    },
    onError: (error) =>
      pushToast({
        title: "Couldn't generate webhook secret",
        body: error instanceof Error ? error.message : "Try again.",
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

  const repairing = isChatEndpointRepairing(
    endpoint,
    resumeEndpointId,
    reconnectRequested,
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
            generatedWebhookSecret={generatedWebhookSecret}
            generatingSetupSecret={generateSetupSecret.isPending}
            onGenerateSetupSecret={() => generateSetupSecret.mutate()}
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
  generatedWebhookSecret,
  generatingSetupSecret,
  onGenerateSetupSecret,
  onAction,
}: {
  provider: ChatProvider;
  agentName: string;
  endpoint: ChatEndpoint;
  credentials: Record<string, string>;
  setCredentials: (next: Record<string, string>) => void;
  repairing: boolean;
  pending: boolean;
  generatedWebhookSecret: string;
  generatingSetupSecret: boolean;
  onGenerateSetupSecret: () => void;
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
  app_home:
    home_tab_enabled: false
    messages_tab_enabled: true
    messages_tab_read_only_enabled: false
  bot_user:
    display_name: ${JSON.stringify(slackBotName)}
  slash_commands:
    - command: ${JSON.stringify(slackCommand)}
      description: Start or manage work with ${JSON.stringify(agentName)}
      usage_hint: ${JSON.stringify("status | new | close | <task>")}
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
      - reactions:read
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
      - channel_left
      - group_left
      - reaction_added
      - reaction_removed
      - channel_archive
      - group_archive
      - channel_unarchive
      - group_unarchive
      - channel_deleted
      - channel_rename
      - group_rename
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
  if (provider === "discord") {
    const applicationId = credentials.applicationId?.trim() ?? "";
    const guildId = credentials.guildId?.trim() ?? "";
    const installUrl = applicationId
      ? `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(applicationId)}&permissions=309237763136&scope=bot${guildId ? `&guild_id=${encodeURIComponent(guildId)}&disable_guild_select=true` : ""}`
      : null;
    return (
      <div className="space-y-5">
        <div>
          <h1 className="text-xl font-bold">Connect {agentName} to Discord</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {repairing
              ? "Reconnect verifies this same Discord application and server installation. It does not add or remove the bot from the server. Leave fields blank to reuse saved credentials."
              : "Create one dedicated Discord application and bot for this Paperclip agent."}
          </p>
        </div>
        <ol className="list-decimal space-y-2 pl-5 text-sm">
          <li>
            In Discord Developer Portal, create an application. Copy its
            Application ID from General Information.
          </li>
          <li>
            Open Bot, create the bot, enable Message Content Intent, then reset
            and copy its token.
          </li>
          <li>
            Enable Developer Mode in Discord, right-click the target server, and
            copy its Server ID.
          </li>
          <li>
            Enter those values below, then use the generated install link to add
            the bot to that server.
          </li>
        </ol>
        <Button
          variant="outline"
          onClick={() =>
            openProviderSetup("https://discord.com/developers/applications")
          }
        >
          Open Discord Developer Portal <ExternalLink />
        </Button>
        {field("applicationId", "Application ID", "text")}
        {field("guildId", "Server ID", "text")}
        {field("botToken", "Bot token")}
        {installUrl && (
          <Button asChild variant="outline">
            <a href={installUrl} target="_blank" rel="noreferrer">
              Install bot in this server <ExternalLink />
            </a>
          </Button>
        )}
        <p className="text-sm text-muted-foreground">
          The install link grants only View Channels, Send Messages, Create
          Public Threads, Send Messages in Threads, Read Message History, Add
          Reactions, Embed Links, and Attach Files. Paperclip still requires
          each discovered channel to be enabled in Access.
        </p>
        <Button
          disabled={
            (!repairing &&
              (!credentials.applicationId ||
                !credentials.guildId ||
                !credentials.botToken)) ||
            pending
          }
          onClick={() =>
            onAction(repairing ? "reconnect" : "configure", credentials)
          }
        >
          {pending && <Loader2 className="h-4 w-4 animate-spin" />}
          {repairing ? "Reconnect Discord bot" : "Connect Discord bot"}
        </Button>
      </div>
    );
  }
  if (provider === "telegram")
    return (
      <div className="space-y-5">
        <div>
          <h1 className="text-xl font-bold">Create {agentName} in Telegram</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {repairing
              ? "Reconnect verifies this same BotFather bot and automatically refreshes its Paperclip webhook and command menu. It does not recreate the bot or change its chat memberships. Leave the token blank to reuse the saved credential."
              : "Create a bot with BotFather, then paste the token it gives you."}
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
        </ol>
        <p className="rounded-md border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
          Paperclip works with Telegram&apos;s default bot privacy mode and
          registers its command menu automatically. In a group, ordinary
          mentions are not delivered to bots: start or continue work with{" "}
          <code>/task@bot_username &lt;request&gt;</code>, or reply directly to
          a message from the bot.
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
            (!repairing && !credentials.botToken) ||
            !endpoint.setup?.webhookUrl ||
            pending
          }
          onClick={() =>
            onAction(repairing ? "reconnect" : "configure", credentials)
          }
        >
          {pending && <Loader2 className="h-4 w-4 animate-spin" />}
          {repairing ? "Reconnect bot" : "Connect bot"}
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
            {repairing
              ? "Reconnect verifies this same Microsoft app, tenant, and bot identity. It does not upload or reinstall the Teams app. Leave fields blank to reuse saved credentials."
              : "Use your own Microsoft app credentials for this bot."}
          </p>
        </div>
        <p className="rounded-md border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
          This setup requires a Microsoft 365 work or school organization where
          you can register an Entra app, create an Azure Bot, and upload or
          install a Teams app. Personal or free Teams accounts at teams.live.com
          cannot complete this setup. This release supports Microsoft 365
          commercial cloud tenants only; GCC, GCC High, DoD, and Microsoft 365
          operated by 21Vianet are not supported yet.
        </p>
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
        <section className="space-y-3 rounded-lg border border-border p-4">
          <div>
            <h2 className="text-sm font-semibold">
              Microsoft portal field map
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Use these exact portal sections and reuse the same Application ID
              in all three places.
            </p>
          </div>
          <ol className="list-decimal space-y-3 pl-5 text-sm">
            <li>
              <strong>Microsoft Entra admin center · App registrations</strong>:
              select <strong>New registration</strong>, choose{" "}
              <strong>
                Accounts in this organizational directory only (Single tenant)
              </strong>
              , then select <strong>Register</strong>. Copy{" "}
              <strong>Application (client) ID</strong> and{" "}
              <strong>Directory (tenant) ID</strong>. Under{" "}
              <strong>Certificates &amp; secrets · Client secrets</strong>,
              select <strong>New client secret</strong> and copy its{" "}
              <strong>Value</strong>, not its Secret ID.
            </li>
            <li>
              <strong>Azure · Create Azure Bot</strong>: set{" "}
              <strong>Microsoft App ID</strong> to{" "}
              <strong>Single Tenant</strong>, set <strong>Creation type</strong>{" "}
              to <strong>Use existing app registration</strong>, and enter the
              Application ID and Tenant ID above. After creation, open{" "}
              <strong>Settings · Configuration</strong> and paste the Paperclip{" "}
              <strong>Messaging endpoint</strong>; then open{" "}
              <strong>Settings · Channels</strong> and enable{" "}
              <strong>Microsoft Teams</strong>.
            </li>
            <li>
              <strong>Teams Developer Portal · Apps</strong>: select{" "}
              <strong>New app</strong>. Under{" "}
              <strong>Configure · App features · Bot</strong>, add an existing
              bot using the same Application ID; enable{" "}
              <strong>Personal</strong>, <strong>Team</strong>, and{" "}
              <strong>Group chat</strong> scopes plus file support. Under{" "}
              <strong>Configure · Permissions</strong>, add the two RSC{" "}
              <strong>Application</strong> permissions shown below. Complete the
              required app details and icons, then download the app package.
            </li>
            <li>
              <strong>Microsoft Teams · Apps · Manage your apps</strong>: select{" "}
              <strong>Upload an app · Upload a custom app</strong>, choose the
              downloaded package, and install it in each intended personal,
              group-chat, or team scope. If upload is unavailable, a Teams
              administrator must enable or approve custom apps.
            </li>
          </ol>
        </section>
        <label className="grid gap-2 text-sm font-medium">
          Required Teams app manifest block
          <Textarea
            className="min-h-80 font-mono text-xs"
            readOnly
            value={teamsManifestSettings}
          />
        </label>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={!credentials.clientId?.trim()}
            onClick={() => {
              void navigator.clipboard
                .writeText(teamsManifestSettings)
                .then(() => setManifestCopied(true));
            }}
          >
            {manifestCopied
              ? "Manifest settings copied"
              : "Copy manifest settings"}
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">
          Enter the Application / Client ID above before copying so the block
          contains the real bot identity. This block contains the
          Paperclip-specific fields to verify in Developer Portal or merge into
          a complete Teams app manifest. It is not a complete app package;
          Developer Portal supplies the remaining required metadata and packages
          the manifest with your app icons.
        </p>
        <p className="text-sm text-muted-foreground">
          Paperclip does not use Teams single sign-on in this release, so this
          connection does not require a <code>webApplicationInfo</code> manifest
          entry, an Entra Application ID URI, or delegated Microsoft Graph
          permissions. Do not add them solely for Paperclip.
        </p>
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
            (!repairing &&
              (!credentials.clientId ||
                !credentials.tenantId ||
                !credentials.clientSecret)) ||
            !endpoint.setup?.messagingEndpoint ||
            pending
          }
          onClick={() =>
            onAction(repairing ? "reconnect" : "configure", credentials)
          }
        >
          {pending && <Loader2 className="h-4 w-4 animate-spin" />}
          {repairing
            ? "Reconnect Microsoft app"
            : "Verify Microsoft credentials"}
        </Button>
      </div>
    );
  if (provider === "github")
    return (
      <div className="space-y-5">
        <div>
          <h1 className="text-xl font-bold">Create or connect a GitHub App</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {repairing
              ? "Reconnect verifies this same GitHub App and installation. It does not reinstall the App or change repository access. Leave App ID and private key blank to reuse saved credentials."
              : "Configure its webhook and permissions, then verify the App with Paperclip."}
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
            webhook URL and the Paperclip-generated webhook secret below, and
            keep <strong>Enable SSL verification</strong> selected.
          </li>
          <li>
            Under Repository permissions, set <strong>Issues</strong> and{" "}
            <strong>Pull requests</strong> to <strong>Read &amp; write</strong>.
            Leave every other permission at its default; Metadata remains
            read-only.
          </li>
          <li>
            Subscribe to <strong>Issue comment</strong> (
            <code>issue_comment</code>),{" "}
            <strong>Pull request review comment</strong> (
            <code>pull_request_review_comment</code>). GitHub sends{" "}
            <code>installation</code> and <code>installation_repositories</code>{" "}
            to every GitHub App automatically; they are not selectable here.
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
              repairing
                ? "https://github.com/settings/apps"
                : (endpoint.setup?.authorizationUrl ??
                    "https://github.com/settings/apps/new"),
              "_blank",
              "noopener,noreferrer",
            )
          }
        >
          {repairing ? "Open GitHub App settings" : "Open new GitHub App form"}{" "}
          <ExternalLink />
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
        <div className="grid gap-2">
          <p className="text-sm font-medium">Webhook secret</p>
          {generatedWebhookSecret ? (
            <>
              <Input
                aria-label="Generated webhook secret"
                className="font-mono text-xs"
                readOnly
                value={generatedWebhookSecret}
              />
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() =>
                    navigator.clipboard.writeText(generatedWebhookSecret)
                  }
                >
                  Copy webhook secret
                </Button>
              </div>
              <p className="text-sm text-muted-foreground">
                Copy this value now. Paperclip will not show it again.
              </p>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              {endpoint.setup?.webhookSecretConfigured
                ? "A webhook secret is configured and cannot be shown again."
                : "Generate the secret in Paperclip, then paste it into the GitHub App."}
            </p>
          )}
          <div>
            <Button
              type="button"
              variant="outline"
              disabled={generatingSetupSecret}
              onClick={onGenerateSetupSecret}
            >
              {generatingSetupSecret && (
                <Loader2 className="h-4 w-4 animate-spin" />
              )}
              {endpoint.setup?.webhookSecretConfigured
                ? "Regenerate webhook secret"
                : "Generate webhook secret"}
            </Button>
          </div>
          {endpoint.setup?.webhookSecretConfigured && (
            <p className="text-sm text-muted-foreground">
              {endpoint.providerAccountId || endpoint.botExternalId
                ? "Regenerating immediately invalidates GitHub webhook signatures until you replace the secret in the GitHub App settings."
                : "Generating another secret replaces the previous value. Paste the newest value into GitHub before continuing."}
            </p>
          )}
          {endpoint.setup?.webhookSecretConfigured && (
            <p
              className={`text-sm ${endpoint.setup.webhookVerifiedAt ? "text-foreground" : "text-muted-foreground"}`}
            >
              {endpoint.setup.webhookVerifiedAt
                ? "GitHub has verified this webhook."
                : "Waiting for GitHub to deliver its signed webhook ping…"}
            </p>
          )}
        </div>
        {!endpoint.setup?.webhookUrl && (
          <p className="text-sm text-destructive">
            Configure a public HTTPS URL for this Paperclip instance before
            connecting GitHub.
          </p>
        )}
        <Button
          disabled={
            (!repairing && (!credentials.appId || !credentials.privateKey)) ||
            !endpoint.setup?.webhookSecretConfigured ||
            !endpoint.setup?.webhookVerifiedAt ||
            !endpoint.setup?.webhookUrl ||
            generatingSetupSecret ||
            pending
          }
          onClick={() =>
            onAction(repairing ? "reconnect" : "configure", credentials)
          }
        >
          {pending && <Loader2 className="h-4 w-4 animate-spin" />}
          {repairing ? "Reconnect and verify" : "Connect and verify"}
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
        {endpointValue("Slack command", slackCommand)}
        <div className="rounded-lg border border-border p-3 text-sm">
          <p className="font-medium">Use the registered command</p>
          <p className="mt-1 text-muted-foreground">
            Start work with <code>{slackCommand} investigate this</code>. In a
            direct message, use <code>{slackCommand} status</code>,{" "}
            <code>{slackCommand} new</code>, or{" "}
            <code>{slackCommand} close</code>. Slack&apos;s bare{" "}
            <code>/status</code> command is not a Paperclip control.
          </p>
        </div>
        <ol className="list-decimal space-y-2 pl-5 text-sm">
          <li>
            Return to <strong>App Manifest</strong> in Slack and click{" "}
            <strong>Save Changes</strong>. The copied manifest already contains
            the event, interaction, and slash-command URLs. Slack verifies the
            Events URL when you save; Paperclip records Interactivity and slash
            command health only after each signed callback is observed.
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
          {repairing
            ? "Reconnect verifies or replaces credentials for this same Slack app. It does not reinstall the app or change its workspace or channel membership. Leave credentials blank to reuse the saved values."
            : "Bring your own Slack app. The manifest requests the scopes Paperclip needs; credentials remain write-only."}
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
          (!repairing &&
            (!credentials.botToken || !credentials.signingSecret)) ||
          !endpoint.setup?.webhookUrl ||
          pending
        }
        onClick={() =>
          onAction(repairing ? "reconnect" : "configure", credentials)
        }
      >
        {pending && <Loader2 className="h-4 w-4 animate-spin" />}
        {repairing ? "Reconnect Slack app" : "Connect Slack app"}
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
  const providerBotUsername = botUsername?.replace(/^@/, "");
  const normalizedBotUsername =
    provider === "github"
      ? providerBotUsername?.replace(/\[bot\]$/i, "")
      : providerBotUsername;
  const botMention = normalizedBotUsername
    ? `@${normalizedBotUsername}`
    : (botLabel ?? agentName);
  const instructions =
    provider === "discord"
      ? [
          "Open a text channel where the bot is installed.",
          `Mention ${botMention} in a new root message.`,
          `Reply once inside ${agentName}'s new Discord thread.`,
        ]
      : provider === "telegram"
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
