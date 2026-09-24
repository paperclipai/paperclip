import { useEffect, useState, type ComponentProps, type ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { addons } from "storybook/preview-api";
import { expect, userEvent, within } from "storybook/test";
import { CONNECTABLE_APP_DEFINITIONS, type ToolCatalogEntry } from "@paperclipai/shared";
import { ConnectionSetupFlow, OAuthConnectStateScreen } from "@/features/connections/ConnectionSetupFlow";
import { ConnectorCard } from "@/pages/apps/Browse";
import { AppLogo } from "@/pages/apps/AppLogo";
import { ActionsSection } from "@/pages/apps/app-detail/PermissionsPanel";
import { RoutineTriggerWizard, defaultTriggerDraft } from "@/components/routine-triggers/TriggerWizard";
import { RoutineTriggerCard } from "@/components/RoutineTriggerCard";
import { TriggersSection } from "@/components/routine-sections/editable-sections.production";
import { RoutineDetailContext, type RoutineDetailContextValue } from "@/components/routine-sections/context";
import { Button } from "@/components/ui/button";
import { useNavigate } from "@/lib/router";
import { WebhookReview, webhook, baseRoutine } from "../fixtures/routineWebhooks";

const fireflies = CONNECTABLE_APP_DEFINITIONS.find((app) => app.slug === "fireflies")!;
const demoSecret = "storybook-only-signing-secret";
const demoUrl = "https://acme.paperclip.example/api/routine-triggers/public/0123456789abcdef01234567/fire";
const noop = () => {};
function Frame({ children }: { children: ReactNode }) {
  return <div className="mx-auto max-w-5xl space-y-6 p-6 text-foreground"><p className="text-xs text-muted-foreground">PR #13890 · Production components with simulated data. No provider requests or real credentials.</p>{children}</div>;
}
const meta = {
  title: "PR reviews/Fireflies and app webhooks",
  parameters: { layout: "fullscreen", docs: { description: { component: "Coverage of PR #13890: Fireflies catalog/artwork and shared connection flow, preserved action permissions, generic webhook wizard and saved settings, and both advanced trigger editors. All network mutations are simulated. Use the toolbar to switch theme or viewport. Legacy stories only demonstrate resuming existing configurations; new webhooks use Another app or script." } } },
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
  return <Frame><ActionsSection connectionId="storybook-fireflies" appName="Fireflies" readOnly={entries.filter((e) => e.isReadOnly)} canChange={entries.filter((e) => e.isWrite)} quarantined={[]} enabledIds={enabled} askFirstIds={ask} disabled={false} refreshPending={false} canConfigure onSetPermission={(id, next) => { setEnabled((s) => { const n = new Set(s); if (next === "allowed") n.add(id); else n.delete(id); return n; }); setAsk((s) => { const n = new Set(s); if (next === "ask") n.add(id); else n.delete(id); return n; }); }} onReviewQuarantined={noop} onRefreshActions={noop} /></Frame>;
}
export const RetainedPermissions: Story = { name: "08 · Permissions — retained Allowed, Ask first, Off", render: () => <Permissions /> };

type WizardProps = Partial<ComponentProps<typeof RoutineTriggerWizard>>;
function Wizard({ initialDraft = { ...defaultTriggerDraft, kind: "webhook", signingMode: "app_webhook" }, webhookSecret = demoSecret, ...props }: WizardProps) {
  const [saved, setSaved] = useState<typeof initialDraft | null>(null);
  const [finished, setFinished] = useState(false);
  const [secret, setSecret] = useState(webhookSecret);
  const [draft, setDraft] = useState(initialDraft);
  return <Frame>{finished ? <p role="status">Setup finished in this preview. No real trigger was created.</p> : saved ? <div className="space-y-4"><p>Trigger setup saved. The secret is not stored in the draft.</p><Button onClick={() => { setSaved(null); setSecret(""); }}>Resume setup</Button></div> : <RoutineTriggerWizard routineTitle="Review a completed meeting" routineId="fireflies-storybook" initialDraft={draft} webhookUrl={demoUrl} webhookSecret={secret} onCreateWebhook={async () => {}} onRotateKey={async () => setSecret(`${demoSecret}-rotated`)} onSaveExit={(next) => { setDraft(next); setSaved(next); }} onFinish={() => setFinished(true)} {...props} />}</Frame>;
}
const wizard = (step: number, props: WizardProps = {}): Story => ({ render: () => <Wizard initialDraft={{ ...defaultTriggerDraft, kind: "webhook", signingMode: "app_webhook", step, availableStep: step, created: step > 0 }} {...props} /> });
export const ChooseWebhook = { ...wizard(0), name: "09 · Another app — choose trigger and HTTPS requirement" };
export const ConnectApp = { ...wizard(1), name: "10 · Another app — URL, signing secret, bearer alternative" };
export const CheckWaiting = { ...wizard(2), name: "11 · Check connection — waiting" };
export const CheckReceived = { ...wizard(2, { checkResult: "received" }), name: "12 · Check connection — authenticated test receipt" };
export const CheckRejected = { ...wizard(2, { checkResult: "rejected" }), name: "13 · Check connection — invalid signature" };
export const CheckNoEvent = { ...wizard(2, { checkResult: "no_event" }), name: "14 · Check connection — nothing received" };
export const PrivateUrl = { ...wizard(1, { webhookUrl: demoUrl.replace("https://acme.paperclip.example", "http://localhost:3104") }), name: "15 · Public HTTPS setup warning" };
export const ResumeHiddenSecret = { ...wizard(1, { webhookSecret: "" }), name: "16 · Resume draft — hidden secret and rotation" };
export const LegacyBearer = { ...wizard(1, { initialDraft: { ...defaultTriggerDraft, kind: "webhook", signingMode: "bearer", step: 1, availableStep: 1, created: true } }), name: "17 · Resume existing bearer webhook" };
export const LegacySigned = { ...wizard(1, { initialDraft: { ...defaultTriggerDraft, kind: "webhook", signingMode: "fireflies_hmac", step: 1, availableStep: 1, created: true } }), name: "18 · Resume existing signed webhook" };
export const SaveResume: Story = { ...ConnectApp, name: "19 · Save and resume walkthrough", play: async ({ canvasElement }) => { const c = within(canvasElement); await userEvent.click(await c.findByRole("button", { name: "Save & exit" })); await userEvent.click(c.getByRole("button", { name: "Resume setup" })); await expect(c.getByText(/The key is hidden after leaving setup/)).toBeVisible(); } };
const openSettings: Story["play"] = async ({ canvasElement }) => { await userEvent.click(await within(canvasElement).findByRole("button", { name: "Edit webhook" })); };
export const SavedSettings: Story = { name: "20 · Saved webhook settings", render: () => <WebhookReview signingMode="app_webhook" state="configured" />, play: openSettings };
export const RotateSecret: Story = { ...SavedSettings, name: "21 · Rotated webhook secret and agent instructions", play: async (ctx) => { await openSettings!(ctx); await userEvent.click(within(ctx.canvasElement).getByRole("button", { name: "Replace key" })); await userEvent.click(within(within(document.body).getByRole("dialog")).getByRole("button", { name: "Replace key" })); await expect(await within(ctx.canvasElement).findByRole("button", { name: "Copy Secret key" })).toBeVisible(); } };
export const DeliveryFailure: Story = { ...SavedSettings, name: "22 · Saved webhook — rejected delivery", render: () => <WebhookReview signingMode="app_webhook" state="failure" /> };
export const AdvancedCard: Story = { name: "23 · Advanced trigger card — app_webhook", render: () => <Frame><RoutineTriggerCard trigger={webhook("app_webhook")} onSave={noop} onRotate={noop} onDelete={noop} /></Frame> };
function AdvancedCreate() {
  const [newTrigger, setNewTrigger] = useState({ kind: "webhook", signingMode: "app_webhook", replayWindowSec: "300", cronExpression: "" });
  const mutation = { mutate: noop, isPending: false };
  const context = { routine: { ...baseRoutine, triggers: [] }, newTrigger, setNewTrigger, createTrigger: mutation, updateTrigger: mutation, deleteTrigger: mutation, rotateTrigger: mutation, secretMessage: null, setSecretMessage: noop, copySecretValue: noop } as unknown as RoutineDetailContextValue;
  return <Frame><RoutineDetailContext.Provider value={context}><TriggersSection /></RoutineDetailContext.Provider></Frame>;
}
export const AdvancedCreateTrigger: Story = { name: "24 · Advanced trigger creation — shared signing mode", render: () => <AdvancedCreate />, play: async ({ canvasElement }) => { const c = within(canvasElement); await userEvent.click(await c.findByRole("button", { name: "New trigger" })); await expect(c.getByText(/Accept a bearer token or an HMAC-SHA256/)).toBeVisible(); await expect(c.queryByText("Replay window (seconds)")).not.toBeInTheDocument(); } };
export const MobileSetup = { ...ConnectApp, name: "25 · Mobile — app setup", globals: { viewport: { value: "mobile", isRotated: false } } };
export const LightSetup = { ...ConnectApp, name: "26 · Light theme — app setup", globals: { theme: "light" } };
