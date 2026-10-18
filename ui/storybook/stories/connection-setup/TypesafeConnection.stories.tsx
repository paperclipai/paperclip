import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, userEvent, within } from "storybook/test";
import {
  CONNECTABLE_APP_DEFINITIONS,
  type Agent,
  type AppDefinition,
  type ConnectToolAppResult,
  type ConnectionGrant,
  type ConnectionGrantsResponse,
  type FinishToolAppResult,
  type ToolApplication,
  type ToolConnection,
  type ToolConnectionCapabilities,
  type ToolConnectionInstallSnapshot,
} from "@paperclipai/shared";
import type { TranscriptEntry } from "@/adapters";
import type { ToolGalleryResponse } from "@/api/tools";
import { queryKeys } from "@/lib/queryKeys";
import { useNavigate } from "@/lib/router";
import { installStateFrom } from "@/lib/tool-installs";
import { Button } from "@/components/ui/button";
import { InlineBanner } from "@/components/InlineBanner";
import { ToastViewport } from "@/components/ToastViewport";
import { RunTranscriptView } from "@/components/transcript/RunTranscriptView";
import { ConnectionSetupFlow } from "@/features/connections/ConnectionSetupFlow";
import { Browse } from "@/pages/apps/Browse";
import { AppLogo } from "@/pages/apps/AppLogo";
import { SetupPanel } from "@/pages/apps/app-detail/SetupPanel";
import { PermissionsPanel } from "@/pages/apps/app-detail/PermissionsPanel";
import { AdvancedPanel } from "@/pages/apps/app-detail/AdvancedPanel";
import { IdentitiesSection } from "@/pages/apps/app-detail/IdentitiesSection";
import { storybookAgents } from "../fixtures/paperclipData";

const COMPANY_ID = "company-storybook";
const CONNECTION_ID = "connection-typesafe";
const EXAMPLE_KEY = "ts_example_key";
const TYPESAFE = CONNECTABLE_APP_DEFINITIONS.find(
  (app) => app.slug === "typesafe",
) as AppDefinition;
const NOTION = CONNECTABLE_APP_DEFINITIONS.find(
  (app) => app.slug === "notion",
) as AppDefinition;
const GITHUB = CONNECTABLE_APP_DEFINITIONS.find(
  (app) => app.slug === "github",
) as AppDefinition;

const AGENT_NAMES = [
  { name: "Support Triage", title: "Customer Support Lead" },
  { name: "Billing Operations", title: "Billing Specialist" },
  { name: "Incident Response", title: "On-call Engineer" },
];
const AGENTS: Agent[] = storybookAgents.slice(0, 3).map((agent, index) => ({
  ...agent,
  ...AGENT_NAMES[index],
}));

type ConnectScenario =
  "success" | "submitting" | "invalid_key" | "provider_unavailable";

const GALLERY: ToolGalleryResponse = {
  apps: [TYPESAFE, NOTION, GITHUB],
  capabilities: {
    canCreateOrganizationGrant: true,
    organizationGrantReason: null,
    canSetCompanyInstall: true,
    companyInstallReason: null,
  },
  credentialSources: {
    vercelConnect: {
      available: false,
      enabled: false,
      authentication: null,
      manageUrl: "https://vercel.com/connect",
      reason: null,
    },
  },
};

function typesafeConnection(): ToolConnection {
  return {
    id: CONNECTION_ID,
    companyId: COMPANY_ID,
    applicationId: "application-typesafe",
    name: "TypeSafe",
    uid: "typesafe-storybook",
    connectionKind: "managed",
    connectionPurpose: "tool",
    ownership: "customer",
    transport: "rest_api",
    authKind: "api_key",
    credentialSource: "paperclip_vault",
    credentialPolicy: "shared",
    status: "active",
    transportConfig: {},
    config: { sourceTemplateKey: "typesafe", model: "jev-latest" },
    credentialSecretRefs: [],
    credentialRefs: [],
    healthStatus: "ok",
    healthMessage: "TypeSafe API key is connected.",
    healthCheckedAt: new Date("2026-09-20T09:12:00.000Z"),
    lastError: null,
    enabled: true,
    createdByAgentId: null,
    createdByUserId: "board-user",
    createdAt: new Date("2026-09-20T09:11:00.000Z"),
    updatedAt: new Date("2026-09-20T09:12:00.000Z"),
  };
}

function typesafeApplication(): ToolApplication {
  return {
    id: "application-typesafe",
    companyId: COMPANY_ID,
    applicationKey: "typesafe",
    name: "TypeSafe",
    description: TYPESAFE.description,
    type: "mcp_http",
    status: "active",
    pluginId: null,
    ownerAgentId: null,
    ownerUserId: "board-user",
    metadata: {},
    archivedAt: null,
    createdAt: new Date("2026-09-20T09:11:00.000Z"),
    updatedAt: new Date("2026-09-20T09:12:00.000Z"),
  };
}

function connectResult(): ConnectToolAppResult {
  return {
    connectionId: CONNECTION_ID,
    application: typesafeApplication(),
    connection: typesafeConnection(),
    catalog: [],
    actions: { readOnly: [], canMakeChanges: [] },
    suggestedDefaults: {},
    auth: null,
  };
}

function finishResult(): FinishToolAppResult {
  return {
    connection: typesafeConnection(),
    profile: {
      id: "profile-typesafe",
      companyId: COMPANY_ID,
      profileKey: "typesafe-storybook",
      name: "TypeSafe",
      description: null,
      status: "active",
      defaultAction: "deny",
      newToolsReviewedAt: null,
      metadata: null,
      createdAt: new Date("2026-09-20T09:12:00.000Z"),
      updatedAt: new Date("2026-09-20T09:12:00.000Z"),
    },
    profileEntries: [],
    profileBindings: [],
    policies: [],
  };
}

function installSnapshot(): ToolConnectionInstallSnapshot {
  return {
    connectionId: CONNECTION_ID,
    installs: [
      {
        id: "install-typesafe-company",
        companyId: COMPANY_ID,
        connectionId: CONNECTION_ID,
        targetType: "company",
        targetId: COMPANY_ID,
        createdByAgentId: null,
        createdByUserId: "board-user",
        createdAt: new Date("2026-09-20T09:12:00.000Z"),
      },
    ],
  };
}

function organizationGrant(): ConnectionGrant {
  return {
    id: "grant-typesafe-organization",
    companyId: COMPANY_ID,
    connectionId: CONNECTION_ID,
    kind: "organization",
    subjectUserId: null,
    providerTenant: null,
    credentialSecretRefs: [],
    status: "active",
    isDefault: true,
    createdByAgentId: null,
    createdByUserId: "board-user",
    revokedAt: null,
    revokedByAgentId: null,
    revokedByUserId: null,
    lastUsedAt: new Date("2026-09-20T09:40:00.000Z"),
    createdAt: new Date("2026-09-20T09:11:00.000Z"),
    updatedAt: new Date("2026-09-20T09:12:00.000Z"),
    delegations: [],
    capabilities: { canRevoke: true, canEditAudience: false },
  };
}

const CAPABILITIES: ToolConnectionCapabilities = {
  canConfigure: true,
  canCreateOrganizationGrant: true,
  canSetCompanyInstall: true,
  canConnectAsCurrentUser: false,
  canManageAgentInstalls: true,
  canViewOtherPersonalIdentities: false,
  editableAgentIds: AGENTS.map((agent) => agent.id),
};

function grantsResponse(grant: ConnectionGrant): ConnectionGrantsResponse {
  return {
    connection: { id: CONNECTION_ID, uid: "typesafe-storybook" },
    grants: [grant],
    capabilities: CAPABILITIES,
    currentUserId: "board-user",
    members: [
      { userId: "board-user", name: "Dotta", email: "dotta@example.com" },
    ],
  };
}

function seededClient(connected: boolean) {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: Infinity,
        gcTime: Infinity,
        retry: false,
        refetchOnMount: false,
      },
      mutations: { retry: false },
    },
  });
  client.setQueryData(queryKeys.apps.gallery(COMPANY_ID), GALLERY);
  client.setQueryData(queryKeys.tools.applications(COMPANY_ID), {
    applications: connected ? [typesafeApplication()] : [],
  });
  client.setQueryData(queryKeys.tools.connections(COMPANY_ID), {
    connections: connected ? [typesafeConnection()] : [],
  });
  client.setQueryData(queryKeys.agents.list(COMPANY_ID), AGENTS);
  client.setQueryData(queryKeys.access.companyUserDirectory(COMPANY_ID), {
    users: [
      {
        principalId: "board-user",
        status: "active",
        user: {
          id: "board-user",
          name: "Dotta",
          email: "dotta@example.com",
          image: null,
        },
      },
    ],
  });
  return client;
}

// Stories never reach Paperclip or TypeSafe; setup writes are answered here.
function installConnectFixtures(scenario: ConnectScenario) {
  const original = window.fetch;
  window.fetch = async (input, init) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
      window.location.origin,
    );
    const method = init?.method?.toUpperCase() ?? "GET";
    if (method === "POST" && url.pathname.endsWith("/tools/apps/connect")) {
      if (scenario === "submitting") return new Promise<Response>(() => {});
      if (scenario === "invalid_key") {
        return Response.json(
          {
            error: "TypeSafe rejected the API key.",
            code: "typesafe_api_key_rejected",
          },
          { status: 422 },
        );
      }
      if (scenario === "provider_unavailable") {
        return Response.json(
          {
            error: "TypeSafe request failed (529)",
            code: "typesafe_request_failed",
          },
          { status: 502 },
        );
      }
      return Response.json(connectResult());
    }
    if (method === "POST" && url.pathname.endsWith("/finish")) {
      return Response.json(finishResult());
    }
    if (method === "PUT" && url.pathname.endsWith("/installs")) {
      return Response.json(installSnapshot());
    }
    return original(input, init);
  };
  return () => {
    window.fetch = original;
  };
}

function SimulatedNotice({ children }: { children: ReactNode }) {
  return (
    <div className="border-b border-border bg-muted/30 px-6 py-3 text-xs text-muted-foreground">
      Simulated · sample data · {children}
    </div>
  );
}

function Host({
  connected = false,
  notice,
  children,
}: {
  connected?: boolean;
  notice: ReactNode;
  children: ReactNode;
}) {
  const client = useMemo(() => seededClient(connected), [connected]);
  return (
    <QueryClientProvider client={client}>
      <div className="min-h-screen bg-background text-foreground">
        <SimulatedNotice>{notice}</SimulatedNotice>
        {children}
        <ToastViewport />
      </div>
    </QueryClientProvider>
  );
}

function BrowseHost() {
  return (
    <Host notice="TypeSafe is listed next to two other catalog apps.">
      <div className="mx-auto max-w-5xl p-6">
        <Browse />
      </div>
    </Host>
  );
}

function SetupFlowHost({ stage }: { stage: "access" | "setup" }) {
  const navigate = useNavigate();
  const [ready, setReady] = useState(false);
  useEffect(() => {
    navigate(`/apps/connect?source=typesafe&stage=${stage}`, { replace: true });
    setReady(true);
  }, [navigate, stage]);
  return (
    <Host notice="the key is checked by a fixture, never by TypeSafe. Nothing is saved.">
      <div className="mx-auto max-w-4xl space-y-6 p-6">
        {ready ? (
          <ConnectionSetupFlow
            host="page"
            serviceSlug="typesafe"
            onCancel={() => undefined}
          />
        ) : null}
      </div>
    </Host>
  );
}

function ConnectedHost() {
  const connection = typesafeConnection();
  const grant = organizationGrant();
  return (
    <Host
      connected
      notice="a connected TypeSafe app. Saving, pausing and removing do nothing here."
    >
      <div className="mx-auto w-screen max-w-3xl p-6">
        <header className="mb-6 flex items-center gap-3">
          <AppLogo
            name={TYPESAFE.name}
            logoUrl={TYPESAFE.branding.logoUrl}
            size={44}
          />
          <div>
            <h1 className="text-2xl font-bold tracking-tight">TypeSafe</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {connection.healthMessage}
            </p>
          </div>
        </header>
        <div className="space-y-8">
          <InlineBanner
            tone="info"
            title="Storybook note · why the actions list is empty"
          >
            TypeSafe has no catalog actions. Agents with access get one native
            tool, <code>typesafe_ask</code>, and a bundled skill instead.
          </InlineBanner>
          <SetupPanel
            connection={connection}
            galleryEntry={TYPESAFE}
            onUpdateConfig={() => undefined}
            configUpdateDisabled={false}
            agentsSummary="All agents"
            permissionsSummary="Allowed for 0 · Ask first for 0 · Off for 0"
            permissionsLoading={false}
            onOpenPermissions={() => undefined}
            identities={
              <IdentitiesSection
                appName="TypeSafe"
                credentialPolicy="shared"
                ownerUserId="board-user"
                connectedUser={{ label: "Dotta", image: null }}
                dedicatedAgent={null}
                grantsQuery={grantsResponse(grant)}
                loading={false}
                error={false}
                onConnectAsMe={() => undefined}
                onConnectOrganization={() => undefined}
                onConnectAgent={() => undefined}
                onReplaceAudience={() => undefined}
                connectPending={false}
                audiencePending={false}
                audienceError={null}
                audienceGrantId={null}
                onOpenAudience={() => undefined}
                onCloseAudience={() => undefined}
              />
            }
          />
          <PermissionsPanel
            connectionId={CONNECTION_ID}
            appName="TypeSafe"
            agents={AGENTS}
            access={{ mode: "all", agentIds: new Set() }}
            install={installStateFrom(installSnapshot().installs)}
            readOnly={[]}
            canChange={[]}
            quarantined={[]}
            enabledIds={new Set()}
            askFirstIds={new Set()}
            pending={false}
            onSaveAccess={() => undefined}
            onSetActionPermission={() => undefined}
            onReviewQuarantined={() => undefined}
            onRefreshActions={() => undefined}
            refreshPending={false}
            capabilities={CAPABILITIES}
          />
          <AdvancedPanel
            connection={connection}
            appName="TypeSafe"
            galleryEntry={TYPESAFE}
            removing={false}
            onRemove={() => undefined}
            onReplaced={() => undefined}
            appToggleDisabled={false}
            onToggleApp={() => undefined}
            identityGrant={grant}
            identityCurrentUserId="board-user"
            identityProviderName="TypeSafe"
            credentialPolicy="shared"
            onReconnectIdentity={() => undefined}
            onRevokeIdentity={() => undefined}
          />
        </div>
      </div>
    </Host>
  );
}

const ASK_REQUEST = {
  state:
    "Help! My payouts have been failing for 3 days and nobody has replied to my last two emails.",
  questions: {
    is_urgent: {
      type: "noul",
      instructions: "Does this convey urgency?",
      criteria: {
        true: "Explicitly time-sensitive",
        false: "No urgency expressed",
      },
    },
    department: {
      type: "choice",
      instructions: "Which team should handle this?",
      criteria: {
        billing: "Payments, invoicing, refunds",
        technical: "Bugs, outages, integrations",
        sales: null,
      },
    },
  },
};

const ASK_RESPONSE = {
  model: "jev-1.13.0",
  answers: {
    is_urgent: { type: "noul", noul: 0.95 },
    department: {
      type: "choice",
      choice: "billing",
      probabilities: { billing: 0.87, technical: 0.13, sales: 0 },
      confidence: 0.8,
    },
  },
  usage: { input_tokens: 318, output_tokens: 34 },
};

const ASK_TRANSCRIPT: TranscriptEntry[] = [
  {
    kind: "assistant",
    ts: "2026-09-20T09:40:02.000Z",
    text: "New support email. I will ask TypeSafe whether it is urgent and which team owns it. My threshold for urgent is 0.8.",
  },
  {
    kind: "tool_call",
    ts: "2026-09-20T09:40:04.000Z",
    name: "typesafe_ask",
    toolUseId: "tool-typesafe-ask",
    input: ASK_REQUEST,
  },
  {
    kind: "tool_result",
    ts: "2026-09-20T09:40:05.000Z",
    toolUseId: "tool-typesafe-ask",
    toolName: "typesafe_ask",
    content: JSON.stringify(ASK_RESPONSE, null, 2),
    isError: false,
  },
  {
    kind: "assistant",
    ts: "2026-09-20T09:40:09.000Z",
    text: "Urgent: yes (0.95, above my 0.8 threshold). Team: billing (confidence 0.8). I am assigning this task to Billing Operations and marking it high priority.",
  },
];

function percent(value: number) {
  return `${Math.round(value * 100)}%`;
}

function AgentUsesItHost() {
  const { is_urgent: urgent, department } = ASK_RESPONSE.answers;
  return (
    <Host
      connected
      notice="this run never happened. The tool call and the answer are fixtures in the documented typesafe_ask shape."
    >
      <div className="mx-auto max-w-3xl space-y-6 p-6">
        <header>
          <h1 className="text-2xl font-bold tracking-tight">
            Route the payouts complaint
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Support Triage · run transcript
          </p>
        </header>
        <RunTranscriptView entries={ASK_TRANSCRIPT} />
        <section className="space-y-3 rounded-lg border border-border p-4">
          <h2 className="text-sm font-semibold">
            Simulated answer, as the agent reads it
          </h2>
          <dl className="divide-y divide-border text-sm">
            <div className="flex flex-wrap justify-between gap-2 py-2">
              <dt className="text-muted-foreground">is_urgent (noul)</dt>
              <dd className="font-medium">
                {percent(urgent.noul)} probability of yes
              </dd>
            </div>
            <div className="flex flex-wrap justify-between gap-2 py-2">
              <dt className="text-muted-foreground">department (choice)</dt>
              <dd className="font-medium">
                {department.choice} · confidence{" "}
                {percent(department.confidence)}
              </dd>
            </div>
            {Object.entries(department.probabilities).map(
              ([option, probability]) => (
                <div
                  key={option}
                  className="flex flex-wrap justify-between gap-2 py-2"
                >
                  <dt className="text-muted-foreground">{option}</dt>
                  <dd>{percent(probability)}</dd>
                </div>
              ),
            )}
          </dl>
          <p className="text-xs text-muted-foreground">
            The state and the questions in this call are sent to TypeSafe. The
            activity log records the model, the question count and token usage
            only.
          </p>
        </section>
      </div>
    </Host>
  );
}

const WALKTHROUGH_STEPS: Array<{ label: string; render: () => ReactNode }> = [
  { label: "Find TypeSafe in Browse", render: () => <BrowseHost /> },
  {
    label: "Choose agent access",
    render: () => <SetupFlowHost stage="access" />,
  },
  { label: "Add the API key", render: () => <SetupFlowHost stage="setup" /> },
  { label: "Connected app", render: () => <ConnectedHost /> },
  { label: "An agent asks TypeSafe", render: () => <AgentUsesItHost /> },
];

function WalkthroughHost() {
  const [index, setIndex] = useState(0);
  const step = WALKTHROUGH_STEPS[index] ?? WALKTHROUGH_STEPS[0]!;
  return (
    <div className="min-h-screen bg-background text-foreground">
      <nav
        aria-label="Walkthrough"
        className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-6 py-3"
      >
        <p className="text-sm font-medium">
          Step {index + 1} of {WALKTHROUGH_STEPS.length} · {step.label}
        </p>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={index === 0}
            onClick={() => setIndex(index - 1)}
          >
            Back
          </Button>
          <Button
            size="sm"
            disabled={index === WALKTHROUGH_STEPS.length - 1}
            onClick={() => setIndex(index + 1)}
          >
            Next
          </Button>
        </div>
      </nav>
      <div key={index}>{step.render()}</div>
    </div>
  );
}

const meta: Meta = {
  title: "Apps/TypeSafe connect flow",
  parameters: { layout: "fullscreen" },
  beforeEach: ({ parameters }) =>
    installConnectFixtures(
      (parameters.typesafeScenario as ConnectScenario | undefined) ?? "success",
    ),
};
export default meta;

type Story = StoryObj;

const storyDescription = (story: string) => ({ docs: { description: { story } } });

const submitKey: Story["play"] = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await userEvent.type(
    await canvas.findByLabelText("Your TypeSafe key"),
    EXAMPLE_KEY,
  );
  await userEvent.click(canvas.getByRole("button", { name: "Connect" }));
};

export const BrowseEntry: Story = {
  name: "1 — Browse entry",
  parameters: storyDescription(
    "Production Browse grid seeded with TypeSafe, Notion and GitHub.",
  ),
  render: () => <BrowseHost />,
};

export const CredentialStep: Story = {
  name: "2 — Credential step",
  parameters: storyDescription(
    "Production ConnectionSetupFlow on its key step, with Advanced opened to show the Model field. The production key step shows the data notice under the key field, from the field's `helperMd`.",
  ),
  render: () => <SetupFlowHost stage="setup" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      await canvas.findByRole("button", { name: "Advanced" }),
    );
    await expect(await canvas.findByDisplayValue("jev-latest")).toBeVisible();
    await expect(
      await canvas.findByText(/is sent to TypeSafe/),
    ).toBeVisible();
  },
};

export const CredentialStepSubmitting: Story = {
  name: "3 — Credential step, checking the key",
  parameters: {
    typesafeScenario: "submitting",
    ...storyDescription(
      "The connect request never resolves, so the production step stays in its Checking… state.",
    ),
  },
  render: () => <SetupFlowHost stage="setup" />,
  play: async (context) => {
    await submitKey!(context);
    const canvas = within(context.canvasElement);
    await expect(
      await canvas.findByRole("button", { name: /Checking/ }),
    ).toBeDisabled();
  },
};

export const InvalidKey: Story = {
  name: "4 — Invalid key and recovery",
  parameters: {
    typesafeScenario: "invalid_key",
    ...storyDescription(
      "The fixture answers 422 `typesafe_api_key_rejected`. The production step shows the message and leaves the key field editable for another try.",
    ),
  },
  render: () => <SetupFlowHost stage="setup" />,
  play: async (context) => {
    await submitKey!(context);
    const canvas = within(context.canvasElement);
    await expect(
      (await canvas.findAllByText("TypeSafe rejected the API key.")).length,
    ).toBeGreaterThan(0);
    await expect(canvas.getByLabelText("Your TypeSafe key")).toBeEnabled();
    await expect(canvas.getByRole("button", { name: "Connect" })).toBeEnabled();
  },
};

export const ProviderUnavailable: Story = {
  name: "5 — TypeSafe unavailable",
  parameters: {
    typesafeScenario: "provider_unavailable",
    ...storyDescription(
      "The fixture answers 502 `typesafe_request_failed`, as the server does when TypeSafe fails for a reason other than the key.",
    ),
  },
  render: () => <SetupFlowHost stage="setup" />,
  play: async (context) => {
    await submitKey!(context);
    const canvas = within(context.canvasElement);
    await expect(
      (await canvas.findAllByText("TypeSafe request failed (529)")).length,
    ).toBeGreaterThan(0);
  },
};

export const AccessStep: Story = {
  name: "6 — Access step",
  parameters: storyDescription(
    "Production ConnectionSetupFlow on its Access step with three seeded agents. In production this step comes before the key step.",
  ),
  render: () => <SetupFlowHost stage="access" />,
};

export const Connected: Story = {
  name: "7 — Connected",
  parameters: storyDescription(
    "Production SetupPanel, IdentitiesSection, PermissionsPanel and AdvancedPanel for a healthy connection. The header and the note about the empty actions list are hand-built: no production component shows a healthy health message, and the production actions list has no TypeSafe-specific empty state.",
  ),
  render: () => <ConnectedHost />,
};

export const AgentUsesIt: Story = {
  name: "8 — An agent asks TypeSafe (simulated)",
  parameters: storyDescription(
    "Simulated run. Production RunTranscriptView renders a fixture `typesafe_ask` call and answer. The answer summary under it is hand-built, because no production component renders TypeSafe answers.",
  ),
  render: () => <AgentUsesItHost />,
};

export const Walkthrough: Story = {
  name: "Start here — clickable walkthrough (simulated)",
  parameters: storyDescription(
    "Next and Back step through Browse, Access, the API key, the connected app and an agent call, in the order production runs them. Every write is answered by a fixture.",
  ),
  render: () => <WalkthroughHost />,
};
