// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CONNECTABLE_APP_DEFINITIONS } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "@/lib/queryKeys";
import { AppsConnect } from "./AppsConnect";

const listGalleryMock = vi.hoisted(() => vi.fn());
const listApplicationsMock = vi.hoisted(() => vi.fn());
const listConnectionsMock = vi.hoisted(() => vi.fn());
const connectAppMock = vi.hoisted(() => vi.fn());
const startOAuthMock = vi.hoisted(() => vi.fn());
const finishAppMock = vi.hoisted(() => vi.fn());
const putConnectionInstallsMock = vi.hoisted(() => vi.fn());
const listAgentsMock = vi.hoisted(() => vi.fn());
const mockNavigate = vi.hoisted(() => vi.fn());
const navigateTopLevelMock = vi.hoisted(() => vi.fn());
const mockSearch = vi.hoisted(() => ({ value: "" }));
const mockParams = vi.hoisted(() => ({ appKey: undefined as string | undefined }));

const ZAPIER = CONNECTABLE_APP_DEFINITIONS.find((app) => app.slug === "zapier")!;
const NOTION = CONNECTABLE_APP_DEFINITIONS.find((app) => app.slug === "notion")!;
const POSTHOG = CONNECTABLE_APP_DEFINITIONS.find((app) => app.slug === "posthog")!;
const GOOGLE_SHEETS = CONNECTABLE_APP_DEFINITIONS.find((app) => app.slug === "google-sheets")!;

vi.mock("@/api/tools", () => ({
  toolsApi: {
    listGallery: (companyId: string) => listGalleryMock(companyId),
    listApplications: (companyId: string) => listApplicationsMock(companyId),
    listConnections: (companyId: string) => listConnectionsMock(companyId),
    connectApp: (companyId: string, input: unknown) => connectAppMock(companyId, input),
    startOAuth: (connectionId: string) => startOAuthMock(connectionId),
    finishApp: (companyId: string, connectionId: string, input: unknown) =>
      finishAppMock(companyId, connectionId, input),
    putConnectionInstalls: (connectionId: string, installs: unknown) =>
      putConnectionInstallsMock(connectionId, installs),
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

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

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
}

describe("AppsConnect — Connect with a link (M4 frame)", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    mockSearch.value = "";
    mockParams.appKey = undefined;
    container = document.createElement("div");
    document.body.appendChild(container);
    listGalleryMock.mockResolvedValue({
      apps: [
        ZAPIER,
      ],
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

  afterEach(() => {
    document.body.removeChild(container);
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  async function render(queryClient?: QueryClient) {
    const root = createRoot(container);
    const client = queryClient ?? new QueryClient({ defaultOptions: { queries: { retry: false } } });
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

  it("an unrecognized URL routes to a frame with the URL, defaulted Name, and a Yes/No toggle", async () => {
    await render();
    await gotoLinkFrame(container, "https://www.example.com/actions");

    expect(container.textContent).toContain("Connect with a link");
    expect(container.textContent).toContain("https://www.example.com/actions");
    expect(container.textContent).toContain("Does it need a key?");
    expect(buttonByText("No")).toBeTruthy();
    expect(buttonByText("Yes")).toBeTruthy();

    // Name is auto-filled from the host with www. stripped.
    const nameInput = Array.from(container.querySelectorAll<HTMLInputElement>("input")).find(
      (i) => i.getAttribute("placeholder") === "My app",
    );
    expect(nameInput?.value).toBe("example.com");
  });

  it("opens the selected app directly on its setup route", async () => {
    mockParams.appKey = "zapier";
    await render();

    expect(container.textContent).toContain("Connect Zapier");
    expect(container.textContent).not.toContain("Pick the app you want your agents to use.");
  });

  it("requires a PostHog method and submits the selected project scope", async () => {
    mockParams.appKey = "posthog";
    listGalleryMock.mockResolvedValueOnce({ apps: [POSTHOG] });
    await render();

    expect(container.textContent).toContain("How do you want to connect?");
    expect(buttonByText("Sign in with PostHog")?.getAttribute("aria-pressed")).toBe("false");
    expect(buttonByText("Use a personal API key")?.getAttribute("aria-pressed")).toBe("false");
    expect(buttonByText("Connect")?.disabled).toBe(true);

    await act(async () => {
      buttonByText("Use a personal API key")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    const projectInput = container.querySelector<HTMLInputElement>('input[placeholder="12345"]');
    const keyInput = container.querySelector<HTMLInputElement>('input[type="password"]');
    expect(projectInput).toBeTruthy();
    expect(keyInput).toBeTruthy();
    await act(async () => {
      setInputValue(projectInput!, "12345");
      setInputValue(keyInput!, "phx_test-key");
    });
    await flushReact();
    await act(async () => {
      buttonByText("Connect")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(connectAppMock).toHaveBeenCalledWith("company-1", {
      galleryKey: "posthog",
      connectionMethodKey: "mcp-api-key",
      name: "PostHog",
      credentialValues: { "credentials.authorization": "phx_test-key" },
      configValues: {
        projectId: "12345",
        readOnly: true,
        features: "insights,error_tracking,flags,experiments",
        mode: "tools",
      },
      applicationId: undefined,
    });
  });

  it("auto-starts the allowlisted Notion source deep link and opens provider sign-in", async () => {
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

    expect(connectAppMock).toHaveBeenCalledTimes(1);
    expect(connectAppMock).toHaveBeenCalledWith("company-1", {
      galleryKey: "notion",
      name: "Notion",
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

    expect(container.textContent).toContain("Connect Notion");
    expect(container.textContent).toContain("Preparing secure sign-in");
    expect(container.textContent).toContain("Preparing…");
    expect(connectAppMock).toHaveBeenCalledTimes(1);
  });

  it("resumes an existing Notion OAuth connection instead of creating another draft", async () => {
    mockSearch.value = "source=notion";
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

    expect(connectAppMock).not.toHaveBeenCalled();
    expect(startOAuthMock).toHaveBeenCalledWith("conn-existing");
    expect(navigateTopLevelMock).toHaveBeenCalledWith(
      "https://mcp.notion.com/authorize?state=existing",
    );
  });

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

    expect(startOAuthMock).not.toHaveBeenCalledWith("conn-existing");
    expect(connectAppMock).toHaveBeenCalledWith("company-1", {
      galleryKey: "notion",
      name: "Notion",
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
        status: "draft",
        config: { sourceTemplateKey: "notion" },
        transportConfig: {},
      }],
    });
    await flushReact();
    await flushReact();

    expect(connectAppMock).not.toHaveBeenCalled();
    expect(startOAuthMock).toHaveBeenCalledWith("conn-refreshed");
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
    expect(startOAuthMock).toHaveBeenCalledWith("conn-after-retry");
    expect(navigateTopLevelMock).toHaveBeenCalledWith(
      "https://mcp.notion.com/authorize?state=resumed",
    );
  });

  it("restores the Notion lookup error when retrying still fails", async () => {
    mockSearch.value = "source=notion";
    listGalleryMock.mockResolvedValueOnce({ apps: [NOTION] });
    listApplicationsMock.mockRejectedValue(new Error("Lookup unavailable"));

    await render();

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
      connection: { id: "conn-prepared" },
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

    expect(container.textContent).toContain("Provider unavailable");
    await act(async () => {
      buttonByText("Try again")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(connectAppMock).toHaveBeenCalledTimes(1);
    expect(startOAuthMock).toHaveBeenCalledTimes(2);
    expect(startOAuthMock).toHaveBeenLastCalledWith("conn-prepared");
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

    expect(container.textContent).toContain("Response lost");
    await act(async () => {
      buttonByText("Try again")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    await flushReact();

    expect(connectAppMock).toHaveBeenCalledTimes(1);
    expect(startOAuthMock).toHaveBeenCalledWith("conn-response-lost");
    expect(navigateTopLevelMock).toHaveBeenCalledWith(
      "https://mcp.notion.com/authorize?state=recovered",
    );
  });

  it("keeps non-allowlisted OAuth apps blocked", async () => {
    const slack = CONNECTABLE_APP_DEFINITIONS.find((app) => app.slug === "slack")!;
    mockParams.appKey = "slack";
    listGalleryMock.mockResolvedValueOnce({ apps: [slack] });

    await render();

    expect(connectAppMock).not.toHaveBeenCalled();
    expect(mockNavigate).toHaveBeenCalledWith("/apps/connect", { replace: true });
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

    expect(connectAppMock).toHaveBeenCalledTimes(1);
    const [, input] = connectAppMock.mock.calls[0];
    expect(input).toMatchObject({ link: "https://www.example.com/actions", name: "example.com" });
    expect(input.credentialValues).toBeUndefined();
  });

  it("choosing Yes reveals one masked key field plus the lock reassurance", async () => {
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
    expect(container.textContent).toContain("Your key is stored securely.");

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

    await act(async () => {
      buttonByText("Continue")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(container.textContent).toContain("Connect with a link");
    expect(container.textContent).toContain(zapierUrl);
    expect(nameInputFrom(container)?.value).toBe("Zapier");
    expect(container.querySelector('input[type="password"]')).toBeNull();

    await act(async () => {
      buttonByText("Check link")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(connectAppMock).toHaveBeenCalledTimes(1);
    expect(connectAppMock.mock.calls[0]?.[1]).toMatchObject({ link: zapierUrl, name: "Zapier" });
    expect(connectAppMock.mock.calls[0]?.[1].credentialValues).toBeUndefined();
  });

  it("keeps Zapier visible and uses the compact agent multi-selector throughout its wizard", async () => {
    mockSearch.value = "byo=1&source=zapier";
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
        canMakeChanges: [],
      },
      catalog: [],
      suggestedDefaults: {},
    });
    await render();

    expect(container.textContent).toContain("Step 1 of 4");
    expect(container.textContent).toContain("Connect Zapier");
    expect(container.textContent).toContain("Add MCP URL");
    expect(container.querySelector('img[src="https://example.com/zapier.png"]')).toBeTruthy();
    expect(container.textContent).not.toContain("Pick the app you want your agents to use.");
    expect(container.textContent).not.toContain("More ways to connect");

    const linkInput = container.querySelector<HTMLInputElement>(
      'input[placeholder^="https://mcp.zapier.com"]',
    );
    const zapierUrl = "https://mcp.zapier.com/api/v1/connect?token=secret-token";
    await act(async () => setInputValue(linkInput!, zapierUrl));
    await flushReact();

    await act(async () => {
      buttonByText("Check link")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(connectAppMock).toHaveBeenCalledTimes(1);
    expect(connectAppMock.mock.calls[0]?.[1]).toMatchObject({ link: zapierUrl, name: "Zapier" });
    expect(container.textContent).toContain("Step 2 of 4");
    expect(container.querySelector('img[src="https://example.com/zapier.png"]')).toBeTruthy();

    await act(async () => {
      buttonByText("Continue with 1 action on")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(container.textContent).toContain("Step 3 of 4");
    expect(container.querySelector('img[src="https://example.com/zapier.png"]')).toBeTruthy();

    await act(async () => {
      buttonContaining("Only specific agents")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(container.textContent).toContain("Select agents");
    expect(container.textContent).not.toContain("Ada");
    expect(container.textContent).not.toContain("Grace");

    await act(async () => {
      buttonByText("Select agents")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(document.body.textContent).toContain("Ada");
    expect(document.body.textContent).toContain("Grace");

    const adaCheckbox = document.body.querySelector<HTMLElement>('[aria-label="Allow Ada"]');
    await act(async () => {
      adaCheckbox?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    await act(async () => {
      buttonByText("Done")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(container.textContent).toContain("1 agent selected");
    expect(container.textContent).not.toContain("Grace");

    await act(async () => {
      buttonByText("Continue to install")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(container.textContent).toContain("Step 4 of 4");
    expect(container.textContent).toContain("Install Zapier tools?");
    expect(container.textContent).toContain("Not yet");

    await act(async () => {
      buttonContaining("Specific agents")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(container.textContent).toContain("1 agent selected");
    await act(async () => {
      buttonByText("Finish setup")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(finishAppMock).toHaveBeenCalledWith("company-1", "conn-1", {
      enabledCatalogEntryIds: ["action-1"],
      askFirstCatalogEntryIds: [],
      access: { agentIds: ["agent-1"] },
    });
    expect(putConnectionInstallsMock).toHaveBeenCalledWith("conn-1", [
      { targetType: "agent", targetId: "agent-1" },
    ]);
  });

  // PAP-10922: "Run your own" / "Paste a config" moved from the sidebar to rows
  // under "Connect with a link" on the gallery step.
  it("offers 'Run your own' and 'Paste a config' rows that route into the Advanced door", async () => {
    await render();

    expect(container.textContent).toContain("More ways to connect");

    const buttonContaining = (text: string) =>
      Array.from(container.querySelectorAll("button")).find((b) =>
        b.textContent?.includes(text),
      );

    await act(async () => {
      buttonContaining("Run your own")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(mockNavigate).toHaveBeenCalledWith("/apps/advanced");

    await act(async () => {
      buttonContaining("Paste a config")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(mockNavigate).toHaveBeenCalledWith("/apps/advanced/paste-config");
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

    expect(container.textContent).toContain("Connect with a link");
    expect(container.textContent).toContain("https://www.example.com/actions");
    const nameInput = Array.from(container.querySelectorAll<HTMLInputElement>("input")).find(
      (i) => i.getAttribute("placeholder") === "My app",
    );
    expect(nameInput?.value).toBe("Bla");

    await act(async () => {
      buttonByText("Check link")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(connectAppMock).toHaveBeenCalledTimes(1);
    const [, input] = connectAppMock.mock.calls[0];
    expect(input).toMatchObject({
      link: "https://www.example.com/actions",
      name: "Bla",
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

  // PAP-11283: the gallery step exposes a Name field (default = app name) so a
  // connection can be named at create time, matching the link flow.
  function nameInputFrom(root: HTMLDivElement): HTMLInputElement | undefined {
    return Array.from(root.querySelectorAll<HTMLInputElement>("input")).find(
      (i) => i.getAttribute("placeholder") === "My app",
    );
  }

  it("gallery key step defaults the Name field to the app name", async () => {
    await render();

    await act(async () => {
      buttonContaining("Zapier")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(container.textContent).toContain("Connect Zapier");
    expect(nameInputFrom(container)?.value).toBe("Zapier");
    expect(mockNavigate).toHaveBeenCalledWith("/apps/connect?byo=1&appKey=zapier&stage=setup");
  });

  it("returns from an app key step to the BYO gallery", async () => {
    mockSearch.value = "byo=1";
    mockParams.appKey = "zapier";
    await render();

    await act(async () => {
      buttonByText("Back")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(mockNavigate).toHaveBeenCalledWith("/apps/connect?byo=1");
  });

  it("leaving the default name connects with the app name", async () => {
    await render();

    await act(async () => {
      buttonContaining("Zapier")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    const keyField = container.querySelector<HTMLInputElement>("input[type=password]");
    await act(async () => setInputValue(keyField!, "secret-key"));
    await flushReact();
    await act(async () => {
      buttonByText("Connect")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(connectAppMock).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith("/apps/connect?byo=1&appKey=zapier&stage=actions");
    const [, input] = connectAppMock.mock.calls[0];
    expect(input).toMatchObject({ galleryKey: "zapier", name: "Zapier" });
  });

  it("a custom name in the gallery step is sent to the connect mutation", async () => {
    await render();

    await act(async () => {
      buttonContaining("Zapier")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    await act(async () => setInputValue(nameInputFrom(container)!, "Zapier (stdio smoke)"));
    const keyField = container.querySelector<HTMLInputElement>("input[type=password]");
    await act(async () => setInputValue(keyField!, "secret-key"));
    await flushReact();
    await act(async () => {
      buttonByText("Connect")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(connectAppMock).toHaveBeenCalledTimes(1);
    const [, input] = connectAppMock.mock.calls[0];
    expect(input).toMatchObject({ galleryKey: "zapier", name: "Zapier (stdio smoke)" });
  });

  it("a custom name on the Google Sheets step is sent to the connect mutation", async () => {
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

    // Default is the app name.
    expect(nameInputFrom(container)?.value).toBe("Google Sheets");
    await act(async () => setInputValue(nameInputFrom(container)!, "Google Sheets (stdio smoke)"));
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
      name: "Google Sheets (stdio smoke)",
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
