import { useEffect, useState, type ComponentProps, type ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { addons } from "storybook/preview-api";
import { expect, userEvent, within } from "storybook/test";
import { CONNECTABLE_APP_DEFINITIONS, type ToolCatalogEntry } from "@paperclipai/shared";
import { ConnectionSetupFlow, OAuthConnectStateScreen } from "@/features/connections/ConnectionSetupFlow";
import { ConnectorCard } from "@/pages/apps/Browse";
import { AppLogo } from "@/pages/apps/AppLogo";
import { ActionsSection } from "@/pages/apps/app-detail/PermissionsPanel";
import type { RoutineTrigger } from "@paperclipai/shared";
import { RoutineWebhookDialog } from "@/components/routine-page/RoutineWebhookDialog";
import { Button } from "@/components/ui/button";
import { useNavigate } from "@/lib/router";
import { WebhookReview, webhook } from "../../fixtures/routineWebhooks";

const fireflies = CONNECTABLE_APP_DEFINITIONS.find((app) => app.slug === "fireflies")!;
const demoSecret = "storybook-only-signing-secret";
const demoUrl = "https://acme.paperclip.example/api/routine-triggers/public/0123456789abcdef01234567/fire";
const noop = () => {};
function Frame({ children }: { children: ReactNode }) {
  return <div className="mx-auto max-w-5xl space-y-6 p-6 text-foreground"><p className="text-xs text-muted-foreground">PR #13890 · Production components with simulated data. No provider requests or real credentials.</p>{children}</div>;
}
const meta = {
  id: "pr-reviews-fireflies-and-app-webhooks",
  title: "Apps, channels, and extensions/Connection setup/PR reviews/Fireflies and app webhooks",
  parameters: { layout: "fullscreen", docs: { description: { component: "Coverage of PR #13890: Fireflies catalog/artwork and shared connection flow, preserved action permissions, and the routine webhook dialog that replaced the generic webhook wizard and advanced trigger editors: choosing a sender, the new key and agent instructions, test events, test mode, Replace key, and saved webhooks on the routine page. All network mutations are simulated. Use the toolbar to switch theme or viewport. The bearer and Fireflies-signed stories only show existing configurations; new webhooks use Another app or script." } },
    paperclip: {
      "capabilities": [
        "connection-setup/credentials",
        "routines/triggers"
      ],
      "implementation": "production",
      "boundary": "fixtures"
    },
  },
  afterEach: ({ id }) => { document.body.dataset.firefliesStoryReady = id; },
  beforeEach: () => {
    delete document.body.dataset.firefliesStoryReady;
    delete document.body.dataset.firefliesStoryError;
    const channel = addons.getChannel();
    const reportError = (error: unknown) => { document.body.dataset.firefliesStoryError = JSON.stringify(error); };
    channel.on("playFunctionThrewException", reportError);
    channel.on("unhandledErrorsWhilePlaying", reportError);
    const original = window.fetch;
    window.fetch = async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, window.location.origin);
      if (url.pathname.endsWith("/tools/gallery")) return Response.json({ apps: [fireflies], capabilities: { canCreateOrganizationGrant: true, canSetCompanyInstall: true } });
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      if (url.pathname.startsWith("/api/") && !["GET", "HEAD"].includes(method.toUpperCase())) return Response.json({ error: "Storybook preview: no provider request was sent." }, { status: 422 });
      return original(input, init);
    };
    return () => { window.fetch = original; channel.off("playFunctionThrewException", reportError); channel.off("unhandledErrorsWhilePlaying", reportError); };
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

function Catalog() {
  const [message, setMessage] = useState("");
  return <Frame><ConnectorCard row={{ key: "fireflies", slug: "fireflies", brandKey: "fireflies", name: fireflies.name, description: fireflies.description, logoUrl: fireflies.branding?.logoUrl, entry: fireflies, applications: [], connections: [], chatEndpoints: [] }} userProfileById={new Map()} chatConnectorsEnabled={false} onRequestRemove={noop} onNavigate={() => setMessage("Open the Access story to walk through the connection flow.")} /><p role="status" className="text-sm text-muted-foreground">{message}</p></Frame>;
}
function Flow({ stage }: { stage: "access" | "setup" }) {
  const navigate = useNavigate();
  const [ready, setReady] = useState(false);
  useEffect(() => { navigate(`/apps/connect?source=fireflies&stage=${stage}`, { replace: true }); setReady(true); }, [navigate, stage]);
  return ready ? <Frame><ConnectionSetupFlow serviceSlug="fireflies" onCancel={noop} /></Frame> : null;
}
export const CatalogEntry: Story = { name: "01 · Fireflies catalog", render: () => <Catalog /> };
export const Artwork: Story = { name: "02 · Artwork — dark", render: () => <Frame><div className="flex items-center gap-6">{[24, 36, 48].map((size) => <AppLogo key={size} name="Fireflies" brandKey="fireflies" logoUrl={fireflies.branding?.logoUrl} size={size} />)}</div></Frame>, globals: { theme: "dark" } };
export const LightArtwork: Story = { ...Artwork, name: "02b · Artwork — light", globals: { theme: "light" } };
export const Access: Story = { name: "03 · Connect — Access", render: () => <Flow stage="access" /> };
export const Connect: Story = { name: "04 · Connect — OAuth and API key choices", render: () => <Flow stage="setup" /> };
export const ApiKey: Story = { ...Connect, name: "05 · Connect — API key", play: async ({ canvasElement }) => { const c = within(canvasElement); await userEvent.click(await c.findByRole("radio", { name: "Use an API key" })); await expect(c.getByLabelText("Your Fireflies key")).toBeVisible(); } };
export const OAuthWaiting: Story = { name: "06 · OAuth handoff", render: () => <Frame><OAuthConnectStateScreen entry={fireflies} phase="redirecting" authorizationHost="api.fireflies.ai" onRetry={noop} onBack={noop} onCancel={noop} /></Frame> };
export const OAuthRetry: Story = { name: "07 · OAuth reconnect / retry", render: () => <Frame><OAuthConnectStateScreen entry={fireflies} phase="error" resuming error="Authorization did not finish. Your connection is saved; try again." onRetry={noop} onBack={noop} onCancel={noop} /></Frame> };

function Permissions() {
  const [enabled, setEnabled] = useState(new Set(["transcripts", "summary"]));
  const [ask, setAsk] = useState(new Set(["share"]));
  const entries = [["transcripts", "List meeting transcripts", false], ["summary", "Get meeting summary and action items", false], ["transcript", "Get full transcript", false], ["share", "Share a meeting", true], ["revoke", "Revoke meeting access", true]].map(([id, title, write]) => ({ id, toolName: id, title, description: title, connectionId: "storybook-fireflies", entryKind: "tool", status: "active", isReadOnly: !write, isWrite: write, isDestructive: id === "revoke", riskLevel: write ? "medium" : "low" } as ToolCatalogEntry));
  return <Frame><ActionsSection connectionId="storybook-fireflies" appName="Fireflies" readOnly={entries.filter((e) => e.isReadOnly)} canChange={entries.filter((e) => e.isWrite)} quarantined={[]} enabledIds={enabled} askFirstIds={ask} disabled={false} refreshPending={false} canConfigure onSetPermission={(ids, next) => { setEnabled((s) => { const n = new Set(s); for (const id of ids) { if (next === "allowed") n.add(id); else n.delete(id); } return n; }); setAsk((s) => { const n = new Set(s); for (const id of ids) { if (next === "ask") n.add(id); else n.delete(id); } return n; }); }} onReviewQuarantined={noop} onRefreshActions={noop} /></Frame>;
}
export const RetainedPermissions: Story = { name: "08 · Permissions — retained Allowed, Ask first, Off", render: () => <Permissions /> };

const receivedAt = new Date().toISOString();
function meetingWebhook(overrides: Partial<RoutineTrigger> = {}): RoutineTrigger {
  return { ...webhook("app_webhook", 1, demoUrl), label: "Transcript ready", ...overrides };
}
const justCreated = meetingWebhook({ setupPending: true, lastWebhookDelivery: null, lastFiredAt: null, lastResult: null });
type DialogProps = Partial<ComponentProps<typeof RoutineWebhookDialog>>;
/** The shipped webhook dialog with every action kept in local state; nothing is created or sent. */
function WebhookDialog({ trigger: initialTrigger = null, secret: initialSecret = null, testing: initialTesting = false, ...props }: DialogProps) {
  const [open, setOpen] = useState(true);
  const [trigger, setTrigger] = useState<RoutineTrigger | null>(initialTrigger);
  const [secret, setSecret] = useState<string | null>(initialSecret);
  const [testing, setTesting] = useState(initialTesting);
  const update = (change: Partial<RoutineTrigger>) => setTrigger((current) => (current ? { ...current, ...change } : current));
  return <Frame>
    {open ? null : <div className="space-y-4"><p role="status">Dialog closed in this preview. No webhook was saved.</p><Button onClick={() => setOpen(true)}>Open again</Button></div>}
    <RoutineWebhookDialog
      open={open}
      onOpenChange={(next) => { if (!next) { if (trigger?.setupPending) update({ setupPending: false }); setTesting(false); setSecret(null); } setOpen(next); }}
      routineTitle="Review a completed meeting"
      trigger={trigger}
      secret={secret}
      testing={testing}
      onCreate={(sender) => { setTrigger({ ...justCreated, signingMode: sender === "github" ? "github_hmac" : "app_webhook" }); setSecret(demoSecret); }}
      onReplaceKey={() => setSecret(`${demoSecret}-rotated`)}
      onSetPaused={(paused) => update({ enabled: !paused })}
      onRemove={() => { setTrigger(null); setOpen(false); }}
      onStartTest={() => { setTesting(true); update({ setupPending: true }); }}
      onFinishTest={() => { setTesting(false); update({ setupPending: false }); }}
      {...props}
    />
  </Frame>;
}
const dialog = (props: DialogProps = {}): Story => ({ render: () => <WebhookDialog {...props} /> });
export const ChooseWebhook = { ...dialog(), name: "09 · Add webhook — choose what’s sending it" };
export const ConnectApp = { ...dialog({ trigger: justCreated, secret: demoSecret }), name: "10 · Created — URL, secret key and agent instructions" };
export const CheckWaiting = { ...dialog({ trigger: meetingWebhook({ setupPending: true }), testing: true }), name: "11 · Test mode — waiting for a test event" };
export const CheckReceived = { ...dialog({ trigger: { ...justCreated, lastWebhookDelivery: { status: "received", receivedAt, test: true } }, secret: demoSecret }), name: "12 · Test event received" };
export const CheckRejected = { ...dialog({ trigger: { ...justCreated, lastWebhookDelivery: { status: "rejected", receivedAt, test: true } }, secret: demoSecret }), name: "13 · Test event rejected — key didn’t match" };
export const CheckNoEvent = { ...dialog({ trigger: meetingWebhook({ lastWebhookDelivery: null, lastFiredAt: null, lastResult: null }) }), name: "14 · Ready — no events yet" };
export const PrivateUrl = { ...dialog({ trigger: { ...justCreated, webhookUrl: demoUrl.replace("https://acme.paperclip.example", "http://localhost:3104") }, secret: demoSecret }), name: "15 · Public HTTPS setup warning" };
export const ResumeHiddenSecret: Story = { ...dialog({ trigger: meetingWebhook() }), name: "16 · Saved webhook — hidden key and Replace key", play: async () => { const c = within(document.body); await userEvent.click(await c.findByRole("button", { name: "Replace key" })); await expect(await c.findByRole("button", { name: "Copy Secret key" })).toBeVisible(); } };
export const LegacyBearer = { ...dialog({ trigger: meetingWebhook({ signingMode: "bearer" }), secret: demoSecret }), name: "17 · Existing bearer webhook — new key as header value" };
export const LegacySigned = { ...dialog({ trigger: meetingWebhook({ signingMode: "fireflies_hmac" }), secret: demoSecret }), name: "18 · Existing Fireflies-signed webhook" };
export const SaveResume: Story = { ...ChooseWebhook, name: "19 · Create walkthrough", play: async () => { const c = within(document.body); await userEvent.click(await c.findByRole("button", { name: "Create webhook" })); await expect(await c.findByRole("button", { name: "Copy Secret key" })).toBeVisible(); await expect(c.getByText("Waiting for a test event")).toBeVisible(); await userEvent.click(c.getByRole("button", { name: "Finish without testing" })); await expect(await c.findByText(/No webhook was saved/)).toBeVisible(); } };
const openSettings: Story["play"] = async () => { await userEvent.click(await within(document.body).findByRole("button", { name: "Open Webhook · Deployment completed" })); };
export const SavedSettings: Story = { name: "20 · Saved webhook opened from the routine page", render: () => <WebhookReview signingMode="app_webhook" state="configured" />, play: openSettings };
export const RotateSecret: Story = { ...SavedSettings, name: "21 · Replaced key and agent instructions", play: async (ctx) => { await openSettings!(ctx); const c = within(document.body); await userEvent.click(await c.findByRole("button", { name: "Replace key" })); await expect(await c.findByRole("button", { name: "Copy Secret key" })).toBeVisible(); await expect(c.getByRole("region", { name: "Agent instructions" })).toBeVisible(); } };
export const DeliveryFailure: Story = { ...SavedSettings, name: "22 · Saved webhook — rejected delivery", render: () => <WebhookReview signingMode="app_webhook" state="failure" />, play: async (ctx) => { await openSettings!(ctx); await expect(await within(document.body).findByText("The last event was rejected")).toBeVisible(); } };
export const AdvancedCard: Story = { ...dialog({ trigger: meetingWebhook() }), name: "23 · Test a live webhook without starting the routine", play: async () => { const c = within(document.body); await userEvent.click(await c.findByRole("button", { name: "Test webhook" })); await expect(await c.findByRole("button", { name: "Finish testing" })).toBeVisible(); await userEvent.click(c.getByRole("button", { name: "Finish testing" })); await expect(await c.findByRole("button", { name: "Test webhook" })).toBeVisible(); } };
export const AdvancedCreateTrigger: Story = { name: "24 · Add a webhook from the routine’s Edit dialog", render: () => <WebhookReview signingMode="app_webhook" state="setup" />, play: async () => { const c = within(document.body); await userEvent.click(await c.findByRole("button", { name: "Edit routine" })); await userEvent.click(await c.findByRole("button", { name: "Add webhook" })); await expect(await c.findByRole("radiogroup", { name: "What’s sending the webhook?" })).toBeVisible(); } };
export const MobileSetup = { ...ConnectApp, name: "25 · Mobile — app setup", globals: { viewport: { value: "mobile", isRotated: false } } };
export const LightSetup = { ...ConnectApp, name: "26 · Light theme — app setup", globals: { theme: "light" } };
