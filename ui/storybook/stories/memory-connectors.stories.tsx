import { useEffect, useMemo, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { getConnectableAppDefinition, MEMORY_CONNECTOR_IDS, INSTANCE_FEATURE_KEYS, instanceExperimentalSettingsSchema, type MemoryConnectorId } from "@paperclipai/shared";
import { queryKeys } from "@/lib/queryKeys";
import { ConnectionSetupCompletionScreen, ConnectionSetupFlow, OAuthConnectStateScreen } from "@/features/connections/ConnectionSetupFlow";
import { ConnectorCard } from "@/pages/apps/Browse";
import { InstanceExperimentalSettings } from "@/pages/InstanceExperimentalSettings";
import { Button } from "@/components/ui/button";

const COMPANY = "company-storybook";
const apps = MEMORY_CONNECTOR_IDS.map(slug => getConnectableAppDefinition(slug)!);

type Scenario = "catalog" | "setup" | "disabled" | "settings" | "rejected" | "waiting" | "oauth-error" | "complete";
function MemoryReview({ provider = "mem0", scenario = "catalog" }: { provider?: MemoryConnectorId; scenario?: Scenario }) {
  const [selection, setSelection] = useState<MemoryConnectorId | null>(scenario === "catalog" || scenario === "settings" ? null : provider);
  const [completed, setCompleted] = useState(scenario === "complete");
  const [ready, setReady] = useState(false);
  const [failure, setFailure] = useState(scenario === "rejected");
  const [signIn, setSignIn] = useState<{ complete: () => void } | null>(null);
  const [identity, setIdentity] = useState("Just me");
  const [availableTo, setAvailableTo] = useState("Any agent");
  const client = useMemo(() => {
    const q = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false, refetchOnMount: false } } });
    q.setQueryData(queryKeys.instance.experimentalSettings, { ...instanceExperimentalSettingsSchema.parse({}), enableMemoryConnectors: scenario !== "disabled" });
    q.setQueryData(queryKeys.apps.gallery(COMPANY), { apps, capabilities: { canSetCompanyInstall: true, companyInstallReason: null } });
    q.setQueryData(queryKeys.health, { status: "ok", deploymentMode: "local_trusted", hiddenSettings: INSTANCE_FEATURE_KEYS.filter(k => k !== "enableMemoryConnectors").map(k => `instance.experimental.${k}`) });
    return q;
  }, [scenario]);

  useEffect(() => {
    const original = window.fetch;
    const fixture: typeof window.fetch = async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.origin);
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      // The OAuth flow waits for fresh identity reads (isFetchedAfterMount).
      // Let these queries actually fetch instead of relying on seeded cache data.
      if (url.pathname === `/api/companies/${COMPANY}/tools/applications`) return Response.json({ applications: [] });
      if (url.pathname === `/api/companies/${COMPANY}/tools/connections`) return Response.json({ connections: [] });
      if (url.pathname === "/api/instance/settings/experimental" && method === "PATCH") {
        const settings = { ...client.getQueryData<object>(queryKeys.instance.experimentalSettings), ...JSON.parse(String(init?.body ?? "{}")) };
        client.setQueryData(queryKeys.instance.experimentalSettings, settings);
        return Response.json(settings);
      }
      if (url.pathname === `/api/companies/${COMPANY}/tools/apps/connect`) {
        if (failure) return Response.json({ error: "The provider rejected this connection. Check your credentials or account access, then try again." }, { status: 422 });
        const body = JSON.parse(String(init?.body ?? "{}"));
        const app = getConnectableAppDefinition(body.galleryKey)!;
        setIdentity(body.grantKind === "user" ? "Just me" : "Any human in the organization");
        if (app.methods[0]?.auth === "oauth") {
          // Keep the production mutation mounted while the reviewer walks the
          // simulated provider handoff. No popup, token, or provider request.
          await new Promise<void>((resolve) => setSignIn({ complete: resolve }));
        }
        // Return the post-auth discovery fixture after the simulated handoff.
        return Response.json({ connectionId: "memory-review", application: { id: "memory-review-app", name: app.name },
          connection: { id: "memory-review", name: app.name, config: { sourceTemplateKey: app.slug }, status: "active" },
          catalog: [], actions: { readOnly: [{ catalogEntryId: "recall", toolName: "recall", riskLevel: "read" }], canMakeChanges: [{ catalogEntryId: "remember", toolName: "remember", riskLevel: "write" }] }, suggestedDefaults: {}, auth: null });
      }
      if (url.pathname === `/api/companies/${COMPANY}/tools/apps/memory-review/finish`) {
        const body = JSON.parse(String(init?.body ?? "{}"));
        setAvailableTo(body.access === "all_agents" ? "Any agent" : `${body.access?.agentIds?.length ?? 0} selected agents`);
        return Response.json({ connectionId: "memory-review", installs: [] });
      }
      if (url.pathname.startsWith("/api/tool-connections/memory-review/")) return Response.json({ connectionId: "memory-review", installs: [] });
      if (url.pathname.startsWith(`/api/companies/${COMPANY}/tools/apps/`)) return Response.json({ oauth: { metadataFound: true, registrationAdvertised: true }, endpointReachable: true });
      return original(input, init);
    };
    window.fetch = fixture;
    setReady(true);
    return () => { if (window.fetch === fixture) window.fetch = original; };
  }, [client, failure]);
  const app = selection ? getConnectableAppDefinition(selection)! : null;
  return <QueryClientProvider client={client}>
    <div className="min-h-screen bg-background text-foreground">
      <p role="note" className="border-b border-border bg-muted p-4 text-sm">Storybook simulation · Production catalog, setup, and experimental controls. Use fake credentials. Sign-in and tool discovery are simulated; no provider calls or secret storage.</p>
      {scenario === "settings" ? <InstanceExperimentalSettings /> : <div className="mx-auto max-w-4xl space-y-4 p-6">
        {completed && app ? <ConnectionSetupCompletionScreen appName={app.name} logoUrl={app.branding.logoUrl} darkLogoUrl={app.branding.darkLogoUrl} summary={[{ label: "Identity", value: identity }, { label: "Available to", value: availableTo }, { label: "Actions", value: "All tools allowed" }]} onDone={() => { setCompleted(false); setSelection(null); }} />
          : (scenario === "waiting" || scenario === "oauth-error") && app ? <OAuthConnectStateScreen entry={app} resuming={false} phase={scenario === "oauth-error" ? "error" : "redirecting"} error={scenario === "oauth-error" ? "The provider did not authorize this connection. Check your account access and try again." : null} onRetry={() => setSelection(null)} onBack={() => setSelection(null)} onCancel={() => setSelection(null)} />
          : selection && ready ? <>
            <div hidden={Boolean(signIn)}><ConnectionSetupFlow key={selection} serviceSlug={selection} onComplete={() => setCompleted(true)} onCancel={() => setSelection(null)} /></div>
            {signIn && app ? <div className="space-y-4">
              <p role="note" className="text-sm text-muted-foreground">Storybook sign-in simulation. Continue to simulate provider approval and return to Paperclip.</p>
              <OAuthConnectStateScreen entry={app} phase="entry" onRetry={() => { signIn.complete(); setSignIn(null); }} onBack={() => { setSignIn(null); setSelection(null); }} onCancel={() => { setSignIn(null); setSelection(null); }} />
            </div> : null}
          </>
          : <div role="list" className="space-y-3">{apps.map(entry => <ConnectorCard key={entry.slug} row={{ key: entry.slug, slug: entry.slug, name: entry.name, description: entry.description, brandKey: entry.slug, logoUrl: entry.branding.logoUrl, darkLogoUrl: entry.branding.darkLogoUrl, entry, applications: [], connections: [], chatEndpoints: [] }} userProfileById={new Map()} chatConnectorsEnabled={false} onNavigate={() => setSelection(entry.slug as MemoryConnectorId)} onRequestRemove={() => {}} />)}</div>}
        {selection && !completed && scenario !== "disabled" && <div className="flex items-center gap-3 border-t border-border pt-4"><Button size="sm" variant="ghost" onClick={() => setSelection(null)}>Catalog</Button><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={failure} onChange={event => setFailure(event.target.checked)} />Simulate rejected credentials</label></div>}
      </div>}
    </div>
  </QueryClientProvider>;
}
const meta = { title: "Apps/Connections/Memory", component: MemoryReview, parameters: { layout: "fullscreen" } } satisfies Meta<typeof MemoryReview>;
export default meta;
type Story = StoryObj<typeof meta>;
export const CatalogAndSetup: Story = { args: { scenario: "catalog" } };
export const ExperimentalToggle: Story = { args: { scenario: "settings" } };
export const DisabledSetup: Story = { args: { scenario: "disabled" } };
export const Mem0: Story = { args: { scenario: "setup", provider: "mem0" } };
export const Zep: Story = { args: { scenario: "setup", provider: "zep" } };
export const Supermemory: Story = { args: { scenario: "setup", provider: "supermemory" } };
export const Cognee: Story = { args: { scenario: "setup", provider: "cognee" } };
export const Honcho: Story = { args: { scenario: "setup", provider: "honcho" } };
export const RejectedCredentials: Story = { args: { scenario: "rejected" } };
export const WaitingForSignIn: Story = { args: { scenario: "waiting", provider: "zep" } };
export const NarrowSetup: Story = { args: { scenario: "setup", provider: "cognee" }, globals: { viewport: { value: "mobile1", isRotated: false } } };

// Drive the real access step so the credential designs are visible immediately.
// No internal component state is patched and all network replies remain fixtures.
const showCredentialFields: Story["play"] = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  // Access renders before the selected provider finishes initializing. Clicking
  // its disabled button at that point silently does nothing in userEvent.
  const continueButton = await canvas.findByRole("button", { name: "Save and continue" });
  await waitFor(() => expect(continueButton).toBeEnabled());
  await userEvent.click(continueButton);
  await expect(await canvas.findByRole("button", { name: "Connect" })).toBeVisible();
};
export const Mem0ApiKey: Story = { args: { scenario: "setup", provider: "mem0" }, play: showCredentialFields };
export const CogneeApiKeyAndTenant: Story = { args: { scenario: "setup", provider: "cognee" }, play: showCredentialFields };
export const HonchoApiKey: Story = { args: { scenario: "setup", provider: "honcho" }, play: showCredentialFields };
export const RejectedMem0ApiKey: Story = {
  args: { scenario: "rejected", provider: "mem0" },
  play: async (context) => {
    await showCredentialFields(context);
    const canvas = within(context.canvasElement);
    await userEvent.type(canvas.getByLabelText("Your Mem0 key"), "storybook-invalid-key");
    await userEvent.click(canvas.getByRole("button", { name: "Connect" }));
    await expect(await canvas.findByText(/The provider rejected this connection/)).toBeVisible();
  },
};
export const ZepSignInFailed: Story = { args: { scenario: "oauth-error", provider: "zep" } };
export const SupermemorySignInFailed: Story = { args: { scenario: "oauth-error", provider: "supermemory" } };
export const ConnectedAllToolsAllowed: Story = { args: { scenario: "complete", provider: "mem0" } };
export const NarrowCogneeCredentials: Story = { args: { scenario: "setup", provider: "cognee" }, play: showCredentialFields, globals: { viewport: { value: "mobile1", isRotated: false } } };

const walkOAuthSetup: Story["play"] = async ({ canvasElement, args }) => {
  const canvas = within(canvasElement);
  const providerName = getConnectableAppDefinition(args.provider ?? "zep")!.name;
  const continueButton = await canvas.findByRole("button", { name: `Continue to ${providerName}` });
  await waitFor(() => expect(continueButton).toBeEnabled());
  await userEvent.click(continueButton);
  await expect(await canvas.findByText(/Storybook sign-in simulation/)).toBeVisible();
  await userEvent.click(canvas.getByRole("button", { name: `Continue to ${providerName}` }));
  await expect(await canvas.findByRole("heading", { name: `${providerName} is ready.` })).toBeVisible();
  await expect(canvas.getByText("All tools allowed")).toBeVisible();
};
export const ZepCompleteWalkthrough: Story = { args: { scenario: "setup", provider: "zep" }, play: walkOAuthSetup };
export const SupermemoryCompleteWalkthrough: Story = { args: { scenario: "setup", provider: "supermemory" }, play: walkOAuthSetup };
