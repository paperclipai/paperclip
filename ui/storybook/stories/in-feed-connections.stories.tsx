import { useMemo, useEffect, useState } from "react";
import { addons } from "storybook/preview-api";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { expect, userEvent, within, waitFor } from "storybook/test";
import { CONNECTABLE_APP_DEFINITIONS, type ConnectionIntentInteraction, type ToolConnection } from "@paperclipai/shared";
import { ConnectionIntentInteractionBody } from "@/features/connections/ConnectionIntentInteractionBody";
import { ConnectionSetupFlow, ConnectionSetupCompletionScreen, AccessStep, OAuthConnectStateScreen, type OAuthConnectPhase } from "@/features/connections/ConnectionSetupFlow";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { TaskChatComposer } from "@/components/task-chat/TaskChatComposer";
import { useNavigate } from "@/lib/router";
import {
  pendingConnectionIntentInteraction as pending,
  authorizingConnectionIntentInteraction as authorizing,
  retryConnectionIntentInteraction as retry,
  connectedConnectionIntentInteraction as connected,
  declinedConnectionIntentInteraction as declined,
  expiredConnectionIntentInteraction as expired,
  supersededConnectionIntentInteraction as superseded,
} from "@/fixtures/issueThreadInteractionFixtures";

const notion = CONNECTABLE_APP_DEFINITIONS.find((app) => app.slug === "notion")!;
const connection = {
  id: "11111111-1111-4111-8111-111111111119", companyId: pending.companyId,
  applicationId: "11111111-1111-4111-8111-111111111118", name: "My Notion workspace",
  uid: "notion/storybook", transport: "mcp_remote", authKind: "oauth", status: "active",
  enabled: true, healthStatus: "ok", credentialPolicy: "per_user",
  config: { sourceTemplateKey: "notion" }, transportConfig: { sourceTemplateKey: "notion" },
  connectionKind: "managed", connectionPurpose: "tool", ownership: "customer", credentialSource: "paperclip_vault",
  credentialSecretRefs: [], healthCheckedAt: null, lastError: null,
  createdByAgentId: null, createdByUserId: "user-board", createdAt: new Date("2026-09-07"), updatedAt: new Date("2026-09-07"),
} satisfies ToolConnection;

type Scenario = { checking?: boolean; count?: number; loading?: boolean; loadError?: boolean; completeError?: boolean; submitting?: boolean; denied?: boolean };
const meta: Meta = {
  title: "Connections/In-task connections",
  parameters: { layout: "padded" },
  afterEach: ({ id }) => { document.body.dataset.inFeedStoryReady = id; },
  beforeEach: ({ parameters }) => {
    delete document.body.dataset.inFeedStoryReady;
    delete document.body.dataset.inFeedStoryError;
    const channel = addons.getChannel();
    const reportPlayError = (error: unknown) => { document.body.dataset.inFeedStoryError = JSON.stringify(error); };
    channel.on("playFunctionThrewException", reportPlayError);
    channel.on("unhandledErrorsWhilePlaying", reportPlayError);
    const original = window.fetch;
    const scenario = (parameters.connectionScenario ?? {}) as Scenario;
    let current = structuredClone(pending);
    window.fetch = async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, window.location.origin);
      if (url.pathname.endsWith("/tools/gallery")) return Response.json({
        apps: CONNECTABLE_APP_DEFINITIONS.filter((app) => ["notion", "github", "posthog", "zapier"].includes(app.slug)),
        capabilities: { canCreateOrganizationGrant: true, canSetCompanyInstall: true },
      });
      if (url.pathname.endsWith("/agents")) return Response.json([{ id: pending.payload.requestingAgentId, companyId: pending.companyId, name: pending.payload.requestingAgentName, status: "active", adapterType: "paperclip_runner", role: "researcher" }]);
      if (url.pathname.startsWith("/api/connection-intents/")) {
        if (url.pathname.endsWith("setup-options")) {
          if (scenario.loading) return new Promise<Response>(() => {});
          if (scenario.loadError) return Response.json({ error: "Connection options are temporarily unavailable. Try again." }, { status: 503 });
          return Response.json({ version: 1, interaction: current, requestedAgentId: pending.payload.requestingAgentId,
            service: { service: "notion", name: "Notion", state: "available", methods: [] },
            existingConnections: Array.from({ length: scenario.count ?? 0 }, (_, i) => ({ ...connection, id: `${connection.id.slice(0, -1)}${i}`, name: i ? "Team Notion workspace" : connection.name })),
          });
        }
        if (scenario.submitting) return new Promise<Response>(() => {});
        if (scenario.completeError || scenario.denied) return Response.json({ error: scenario.denied ? "You no longer have permission to share this connection." : "Connection has no permitted tools. Review action permissions and try again." }, { status: scenario.denied ? 403 : 409 });
        if (url.pathname.endsWith("decline")) current = { ...declined, id: pending.id };
        else if (url.pathname.endsWith("complete")) current = { ...connected, id: pending.id };
        else if (url.pathname.endsWith("phase")) current = { ...current, payload: { ...current.payload, phase: "needs_retry" } };
        return Response.json(current);
      }
      // Stories never navigate to authorization or call a real provider.
      if (init?.method && !["GET", "HEAD"].includes(init.method.toUpperCase()) && url.pathname.includes("/tools/")) {
        if (scenario.checking) return new Promise<Response>(() => {});
        return Response.json({ error: "Fixture connection could not be verified. Correct the setup and try again." }, { status: 422 });
      }
      return original(input, init);
    };
    return () => { window.fetch = original; channel.off("playFunctionThrewException", reportPlayError); channel.off("unhandledErrorsWhilePlaying", reportPlayError); };
  },
};
export default meta;
type Story = StoryObj<typeof meta>;

function Card({ interaction = pending, otherUser = false }: { interaction?: ConnectionIntentInteraction; otherUser?: boolean }) {
  const { data } = useQuery({ queryKey: ["issues", "interactions", interaction.id], initialData: [interaction], enabled: false, queryFn: async () => [interaction] });
  return <ConnectionIntentInteractionBody interaction={data[0]!} currentUserId={otherUser ? "another-user" : pending.addresseeUserId} addresseeLabel="Alex" />;
}
function Host({ children }: { children: React.ReactNode }) {
  const client = useMemo(() => new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false }, mutations: { retry: false } } }), []);
  return <QueryClientProvider client={client}><div className="mx-auto max-w-3xl space-y-4">{children}</div></QueryClientProvider>;
}
const card = (interaction = pending, scenario: Scenario = {}): Story => ({ parameters: { connectionScenario: scenario }, render: () => <Host><Card interaction={interaction} /></Host> });
const openDialog: Story["play"] = async ({ canvasElement }) => {
  await userEvent.click(await within(canvasElement).findByRole("button", { name: /^Connect/ }));
  await expect(within(document.body).getByRole("dialog")).toBeVisible();
};
const setup = (scenario: Scenario): Story => ({ ...card(pending, scenario), play: openDialog });
const reuse: Story["play"] = async (context) => {
  await openDialog!(context);
  await userEvent.click(await within(document.body).findByRole("button", { name: /My Notion workspace/ }));
};

export const NewConnection = card();
export const EligibleReuse = card(pending, { count: 1 });
export const Authorizing = card(authorizing);
export const RetryRequired = card(retry);
export const Connected = card(connected);
export const Declined = card(declined);
export const Expired = card(expired);
export const Superseded = card(superseded);
export const WaitingForAnotherUser: Story = { render: () => <Host><Card otherUser /></Host> };
export const SetupLoading = setup({ loading: true });
export const SetupLoadFailure = setup({ loadError: true });
export const SetupNoExistingConnections = setup({ count: 0 });
export const SetupOneConnection = setup({ count: 1 });
export const SetupMultipleConnections = setup({ count: 2 });
export const Submitting: Story = { ...setup({ count: 1, submitting: true }), play: reuse };
export const ResolutionError: Story = { ...setup({ count: 1, completeError: true }), play: reuse };
export const PermissionDenied: Story = { ...setup({ count: 1, denied: true }), play: reuse };
export const ReuseAndReturnFocus: Story = { ...setup({ count: 1 }), play: async (context) => {
  await reuse!(context);
  await expect(within(document.body).queryByRole("dialog")).not.toBeInTheDocument();
  await waitFor(() => expect(within(context.canvasElement).getByTestId("connection-intent-focus-target")).toHaveFocus());
}};
export const CloseAndReopen: Story = { ...setup({ count: 1 }), play: async (context) => {
  await openDialog!(context);
  await userEvent.keyboard("{Escape}");
  await openDialog!(context);
}};

const oauth = (phase: OAuthConnectPhase, error?: string, fallback = false): Story => ({ render: () => <Host><OAuthConnectStateScreen entry={notion} phase={phase} error={error} authorizationHost="mcp.notion.com" onRetry={() => {}} onBack={() => {}} onCancel={() => {}} authorizationUrl={fallback ? "#offline-authorization" : undefined} onOpenAuthorization={fallback ? () => {} : undefined} /></Host> });
export const OAuthEntry = oauth("entry");
export const OAuthStarting = oauth("starting");
export const OAuthWindowOpen = oauth("redirecting");
export const OAuthPopupBlocked = oauth("error", "The sign-in window could not open. Continue in a new tab.", true);
export const OAuthWindowClosed = oauth("error", "The sign-in window closed. Try again when you are ready.");
export const OAuthCallbackFailure = oauth("error", "Authorization did not finish. Your connection is saved; try again.");
export const OAuthRetry = oauth("error", "The provider is temporarily unavailable. Try again.");
export const OAuthCompleted = card(connected);

function FlowHost({ service, stage, dialog, extra }: { service?: string; stage: string; dialog: boolean; extra: string }) {
  const navigate = useNavigate();
  const [ready, setReady] = useState(false);
  useEffect(() => {
    navigate(`/apps/connect?${service ? `source=${service}&` : ""}stage=${stage}${extra}`, { replace: true });
    setReady(true);
  }, [navigate, service, stage, extra]);
  if (!ready) return null;
  const body = <ConnectionSetupFlow host={dialog ? "dialog" : "page"} serviceSlug={service} requestedAgentId={dialog ? pending.payload.requestingAgentId : undefined} onCancel={() => {}} />;
  return <Host>{dialog ? <Dialog open><DialogContent className="!max-w-(--pct-90) max-h-(--sz-85vh) w-full overflow-y-auto sm:max-w-5xl"><DialogTitle>Connect an app</DialogTitle>{body}</DialogContent></Dialog> : body}</Host>;
}
const flow = (service: string | undefined, stage: string, dialog = false, extra = ""): Story => ({ render: () => <FlowHost service={service} stage={stage} dialog={dialog} extra={extra} /> });
export const ProviderSelectionPage = flow(undefined, "gallery");
export const ProviderSelectionDialog = flow(undefined, "gallery", true);
export const RequestingAgentAccess = flow("notion", "access", true);
export const PersonalIdentity = flow("notion", "access", true);
export const OrganizationIdentity = flow("notion", "access");
export const GitHubAccessPage = flow("github", "access");
export const GitHubAccessDialog = flow("github", "access", true);
const chooseApiKey = async () => {
  await userEvent.click(await within(document.body).findByRole("radio", { name: "Use a personal API key" }));
  await expect(within(document.body).getByLabelText("Your PostHog key")).toBeVisible();
};
export const ApiKeyFieldsPage: Story = { ...flow("posthog", "setup"), play: chooseApiKey };
export const ApiKeyFieldsDialog: Story = { ...flow("posthog", "setup", true), play: chooseApiKey };
const customSetup: Story["play"] = async () => {
  const body = within(document.body);
  await userEvent.type(await body.findByPlaceholderText("https://example.com/actions"), "https://mcp.example.invalid/mcp");
  await userEvent.click(body.getByRole("button", { name: "Continue" }));
  await userEvent.click(await body.findByRole("button", { name: "Save and continue" }));
  await expect(body.getByRole("button", { name: /Check link/i })).toBeVisible();
};
export const CustomMcpPage: Story = { ...flow(undefined, "gallery", false, "&byo=1"), play: customSetup };
export const CustomMcpDialog: Story = { ...flow(undefined, "gallery", true), play: customSetup };
export const MissingLogo = card({ ...pending, payload: { ...pending.payload, serviceName: "Research archive", serviceLogoUrl: null } });
export const LongNames = card({ ...pending, payload: { ...pending.payload, serviceName: "International product research and customer feedback archive", requestingAgentName: "Customer insights and market intelligence researcher" } });
export const NarrowCard: Story = { ...card(), globals: { viewport: { value: "mobile1", isRotated: false } } };
export const NarrowSetup: Story = { ...setup({ count: 2 }), globals: { viewport: { value: "mobile1", isRotated: false } } };
export const ScrollableConnections = setup({ count: 12 });
export const LongError = oauth("error", "This workspace requires an administrator to enable integrations before you can connect your identity. Ask your workspace administrator to enable access, then return to this task and try connecting again. Your task and previous setup choices remain available.");

function Feed({ multiple = false, resolved = false, progress = false }: { multiple?: boolean; resolved?: boolean; progress?: boolean }) {
  return <Host><p>Find our launch notes and summarize the decisions.</p><Card interaction={resolved ? connected : pending} />{multiple ? <Card interaction={{ ...pending, id: "github-request", payload: { ...pending.payload, serviceSlug: "github", serviceName: "GitHub" } }} /> : null}{progress ? <p>I can organize the release checklist while you connect Notion.</p> : null}{resolved ? <p>I found the launch notes. The team approved the staged rollout and assigned the support handoff.</p> : null}<TaskChatComposer onAdd={() => {}} workMode="standard" /></Host>;
}
export const PendingWithComposer: Story = { render: () => <Feed />, play: async ({ canvasElement }) => {
  const input = within(canvasElement).getByRole("textbox");
  await userEvent.type(input, "While I connect, organize the checklist.");
  await expect(input).toHaveTextContent("While I connect");
}};
export const IndependentProgress: Story = { render: () => <Feed progress /> };
export const MultipleRequests: Story = { render: () => <Feed multiple /> };
export const ConnectedAndResumed: Story = { render: () => <Feed resolved /> };
export const HistoricalCards: Story = { render: () => <Host><Card interaction={connected} /><Card interaction={declined} /><Card interaction={expired} /></Host> };

function IdentityHost({ kind = "agent", unavailable = false, loading = false }: { kind?: "agent" | "user" | "organization"; unavailable?: boolean; loading?: boolean }) {
  const [identity, setIdentity] = useState(kind);
  const [selected, setSelected] = useState(new Set([pending.payload.requestingAgentId]));
  return <Host><AccessStep companyId={pending.companyId} authKind="oauth" grantKind={identity} setGrantKind={setIdentity}
    grantKinds={["user", "agent", "organization"]} installChoice="specific" setInstallChoice={() => {}}
    installAgentIds={selected} setInstallAgentIds={setSelected} lockedAgentId={pending.payload.requestingAgentId}
    capabilities={{ canCreateOrganizationGrant: !unavailable, canSetCompanyInstall: !unavailable, organizationGrantReason: "Ask an administrator to enable shared identities." }}
    identityLoading={loading} submitLabel="Continue" onBack={() => {}} onContinue={() => {}} /></Host>;
}
export const DedicatedAgentIdentity: Story = { render: () => <IdentityHost /> };
export const UnavailableIdentity: Story = { render: () => <IdentityHost kind="user" unavailable /> };
export const IdentityLoading: Story = { render: () => <IdentityHost kind="user" loading /> };
const completion = (dialog: boolean): Story => ({ render: () => {
  const body = <ConnectionSetupCompletionScreen appName="Notion" logoUrl={notion.branding.logoUrl} summary={[{ label: "Identity", value: "Your personal identity" }, { label: "Available to", value: "Researcher" }, { label: "Actions", value: "Read pages" }]} onDone={() => {}} />;
  return <Host>{dialog ? <Dialog open><DialogContent><DialogTitle className="sr-only">Connection complete</DialogTitle>{body}</DialogContent></Dialog> : body}</Host>;
}});
export const SetupCompletionPage = completion(false);
export const SetupCompletionDialog = completion(true);
export const ValidationError: Story = { ...flow("posthog", "setup", true), play: async () => {
  await chooseApiKey();
  const dialog = within(document.body);
  const connect = await dialog.findByRole("button", { name: "Connect" });
  await expect(connect).toBeDisabled();
  await userEvent.type(dialog.getByLabelText("Your PostHog key"), "fixture-invalid-key");
  await userEvent.click(connect);
  await expect(await dialog.findByText(/Fixture connection could not be verified/)).toBeVisible();
}};
export const OAuthNewTabFallback: Story = { ...oauth("error", "The sign-in window could not open. Continue in a new tab.", true), play: async ({canvasElement}) => {
  await userEvent.click(within(canvasElement).getByRole("link", { name: "Open sign-in in a new tab" }));
}};

export const CheckingConnection: Story = { ...CustomMcpDialog, parameters: { connectionScenario: { checking: true } }, play: async (context) => {
  await customSetup!(context);
  await userEvent.click(within(document.body).getByRole("button", { name: /Check link/i }));
}};
export const SetupFailure: Story = { ...CustomMcpDialog, play: async (context) => {
  await customSetup!(context);
  await userEvent.click(within(document.body).getByRole("button", { name: /Check link/i }));
  await expect(await within(document.body).findByText(/Fixture connection could not be verified/)).toBeVisible();
}};
export const SetupFailureRetry: Story = { ...SetupFailure, play: async (context) => {
  await SetupFailure.play!(context);
  await userEvent.click(within(document.body).getByRole("button", { name: /Check link/i }));
  await expect(await within(document.body).findByText(/Fixture connection could not be verified/)).toBeVisible();
}};
