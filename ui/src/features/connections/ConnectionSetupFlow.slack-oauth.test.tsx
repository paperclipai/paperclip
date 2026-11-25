// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getConnectableAppDefinition, type ToolApplication, type ToolConnection } from "@paperclipai/shared";
import { ConnectionSetupFlow } from "./ConnectionSetupFlow";

const fixture = vi.hoisted(() => ({
  companyId: "company-1",
  search: "",
  params: {} as Record<string, string | undefined>,
  navigate: vi.fn(),
  breadcrumbs: vi.fn(),
  pushToast: vi.fn(),
  listGallery: vi.fn(),
  listApplications: vi.fn(),
  listConnections: vi.fn(),
  connectApp: vi.fn(),
  startOAuth: vi.fn(),
  putConnectionInstalls: vi.fn(),
  listAgents: vi.fn(),
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: fixture.companyId,
    selectedCompany: { id: fixture.companyId, name: "Acme", issuePrefix: "ACM" },
  }),
}));
vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: fixture.breadcrumbs }),
}));
vi.mock("@/context/ToastContext", () => ({
  useToast: () => ({ pushToast: fixture.pushToast }),
}));
vi.mock("@/hooks/useCloudInstance", () => ({
  useCloudInstance: () => false,
}));
vi.mock("@/hooks/useChatConnectorsEnabled", () => ({
  useChatConnectorsEnabled: () => ({ enabled: false }),
  chatProviderVisible: () => true,
}));
vi.mock("@/hooks/useMemoryConnectorsEnabled", () => ({
  useMemoryConnectorsEnabled: () => ({ loaded: true, enabled: false }),
}));
vi.mock("@/hooks/useConnectorAvailability", () => ({
  useConnectorAvailability: () => ({ loaded: true, failed: false, enabled: () => true }),
}));
vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: React.ReactNode }) => <a href={to} {...props}>{children}</a>,
  useNavigate: () => fixture.navigate,
  useParams: () => fixture.params,
  useSearchParams: () => [new URLSearchParams(fixture.search), vi.fn()],
}));
vi.mock("@/api/tools", () => ({
  toolsApi: {
    listGallery: (...args: unknown[]) => fixture.listGallery(...args),
    listApplications: (...args: unknown[]) => fixture.listApplications(...args),
    listConnections: (...args: unknown[]) => fixture.listConnections(...args),
    connectApp: (...args: unknown[]) => fixture.connectApp(...args),
    startOAuth: (...args: unknown[]) => fixture.startOAuth(...args),
    putConnectionInstalls: (...args: unknown[]) => fixture.putConnectionInstalls(...args),
    getConnection: vi.fn(),
    getCloudConnectorEnrollment: vi.fn(),
    startCloudConnectorEnrollment: vi.fn(),
  },
}));
vi.mock("@/api/agents", () => ({
  agentsApi: {
    list: (...args: unknown[]) => fixture.listAgents(...args),
  },
}));
vi.mock("@/api/connection-intents", () => ({
  connectionIntentsApi: {
    setPhase: vi.fn(),
    setupOptions: vi.fn(),
  },
}));
vi.mock("@/pages/apps/AppLogo", () => ({
  AppLogo: () => null,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;

const SLACK = getConnectableAppDefinition("slack")!;

const SLACK_APP = {
  id: "app-slack-1",
  companyId: "company-1",
  applicationKey: "app-gallery:slack",
  name: "Slack",
  status: "draft",
  metadata: { sourceTemplateKey: "slack" },
} as unknown as ToolApplication;

const SLACK_DRAFT = {
  id: "conn-slack-1",
  companyId: "company-1",
  applicationId: "app-slack-1",
  name: "Slack",
  status: "draft",
  enabled: false,
  authKind: "oauth",
  transport: "mcp_remote",
  credentialPolicy: "organization",
  credentialSource: "paperclip_vault",
  hasSavedOAuthClientSecret: true,
  config: {
    sourceTemplateKey: "slack",
    connectionMethodKey: "mcp-oauth",
    oauth: {
      clientId: "slack-client-123",
      clientRegistrationSource: "manual",
    },
  },
  transportConfig: {
    sourceTemplateKey: "slack",
    connectionMethodKey: "mcp-oauth",
  },
} as unknown as ToolConnection;

async function settle() {
  for (let i = 0; i < 8; i += 1) {
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
}

function renderFlow() {
  flushSync(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <ConnectionSetupFlow host="page" />
      </QueryClientProvider>,
    );
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  fixture.companyId = "company-1";
  fixture.search = "";
  fixture.params = {};
  fixture.listGallery.mockResolvedValue({
    apps: [SLACK],
    oauthCallbackUrl: "https://paperclip.example/api/tools/oauth/callback",
    capabilities: { canCreateOrganizationGrant: true, canSetCompanyInstall: true },
  });
  fixture.listApplications.mockResolvedValue({ applications: [SLACK_APP] });
  fixture.listConnections.mockResolvedValue({ connections: [SLACK_DRAFT] });
  fixture.listAgents.mockResolvedValue([]);
  fixture.putConnectionInstalls.mockResolvedValue({});
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(() => {
  flushSync(() => root.unmount());
  queryClient.clear();
  container.remove();
  vi.restoreAllMocks();
});

describe("ConnectionSetupFlow — Slack customer OAuth error surface and guidance", () => {
  it("surfaces OAuth callback permission rejection text in an alert banner on KeyStep", async () => {
    fixture.search = "source=slack&resume=conn-slack-1&oauth=denied&code=oauth_authorization_denied&provider_error=invalid_scope";

    renderFlow();
    await settle();

    const alert = container.querySelector('[role="alert"]');
    expect(alert, "expected OAuth failure banner to be visible on KeyStep").not.toBeNull();
    expect(alert?.textContent).toMatch(/rejected the requested permissions/i);
  });

  it("surfaces Slack MCP disabled callback errors in an alert banner on KeyStep", async () => {
    fixture.search = "source=slack&resume=conn-slack-1&oauth=failed&code=slack_mcp_access_disabled";

    renderFlow();
    await settle();

    const alert = container.querySelector('[role="alert"]');
    expect(alert, "expected Slack MCP disabled error banner to be visible").not.toBeNull();
    expect(alert?.textContent).toMatch(/Slack MCP access is disabled/i);
  });

  it("shows Slack MCP setup prerequisites alongside the customer OAuth client fields", async () => {
    fixture.search = "source=slack";

    renderFlow();
    await settle();

    expect(container.textContent).toContain("User Token Scopes");
    expect(container.textContent).toContain("Model Context Protocol");
  });

  it("shows the OAuth error and fallback sign-in link when the popup is blocked on a customer OAuth app", async () => {
    fixture.search = "source=slack&resume=conn-slack-1";
    vi.spyOn(window, "open").mockReturnValue(null);
    fixture.connectApp.mockResolvedValue({
      connectionId: SLACK_DRAFT.id,
      application: SLACK_APP,
      connection: SLACK_DRAFT,
      catalog: [],
      actions: { readOnly: [], canMakeChanges: [] },
      suggestedDefaults: { access: "all_agents", askFirstRiskLevels: [] },
      auth: {
        kind: "oauth",
        startUrl: "https://slack.com/oauth/v2_user/authorize?client_id=slack-client-123&state=s1",
      },
    });

    renderFlow();
    await settle();

    const submitButton = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Continue to sign in"),
    );
    expect(submitButton).toBeDefined();
    flushSync(() => submitButton!.click());
    await settle();

    const alert = container.querySelector('[role="alert"]');
    expect(alert, "expected popup-blocked OAuth error banner on KeyStep").not.toBeNull();
    expect(alert?.textContent).toMatch(/couldn’t open the sign-in window/i);
    const fallbackLink = container.querySelector('a[href="https://slack.com/oauth/v2_user/authorize?client_id=slack-client-123&state=s1"]');
    expect(fallbackLink?.textContent).toContain("Open sign-in in a new tab");
  });

  it("ignores inherited object property keys in provider_error without crashing the setup screen", async () => {
    for (const inheritedKey of ["__proto__", "constructor", "toString"]) {
      fixture.search = `source=slack&resume=conn-slack-1&oauth=denied&code=oauth_authorization_denied&provider_error=${inheritedKey}`;
      renderFlow();
      await settle();

      const alert = container.querySelector('[role="alert"]');
      expect(alert).not.toBeNull();
      expect(alert?.textContent).toBe("Authorization was cancelled or declined. Your saved connection was not changed.");
    }
  });
});
