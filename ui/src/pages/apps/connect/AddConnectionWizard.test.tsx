// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CONNECTABLE_APP_DEFINITIONS } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AddConnectionWizard } from "./AddConnectionWizard";

const listGalleryMock = vi.hoisted(() => vi.fn());
const connectAppMock = vi.hoisted(() => vi.fn());
const getAppSetupMock = vi.hoisted(() => vi.fn());
const finishAppMock = vi.hoisted(() => vi.fn());
const putConnectionInstallsMock = vi.hoisted(() => vi.fn());
const listAgentsMock = vi.hoisted(() => vi.fn());
const mockNavigate = vi.hoisted(() => vi.fn());
const mockParams = vi.hoisted(() => ({ appKey: undefined as string | undefined }));
const mockSearch = vi.hoisted(() => ({ value: "" }));
const assignMock = vi.hoisted(() => vi.fn());

const GITHUB = CONNECTABLE_APP_DEFINITIONS.find((a) => a.slug === "github")!;
const SLACK = CONNECTABLE_APP_DEFINITIONS.find((a) => a.slug === "slack")!;
const NOTION = CONNECTABLE_APP_DEFINITIONS.find((a) => a.slug === "notion")!;

vi.mock("@/api/tools", () => ({
  toolsApi: {
    listGallery: (companyId: string) => listGalleryMock(companyId),
    connectApp: (companyId: string, input: unknown) => connectAppMock(companyId, input),
    getAppSetup: (companyId: string, connectionId: string) =>
      getAppSetupMock(companyId, connectionId),
    finishApp: (companyId: string, connectionId: string, input: unknown) =>
      finishAppMock(companyId, connectionId, input),
    putConnectionInstalls: (connectionId: string, installs: unknown) =>
      putConnectionInstallsMock(connectionId, installs),
  },
}));

vi.mock("@/api/agents", () => ({
  agentsApi: { list: (companyId: string) => listAgentsMock(companyId) },
}));

vi.mock("@/lib/router", () => ({
  useNavigate: () => mockNavigate,
  useParams: () => mockParams,
  useSearchParams: () => [new URLSearchParams(mockSearch.value), vi.fn()],
}));

vi.mock("../AppsConnect", () => ({
  AppsConnect: () => <div>Custom MCP compatibility wizard</div>,
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1", selectedCompany: { id: "company-1", name: "Paperclip" } }),
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
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function buttonContaining(text: string): HTMLButtonElement | undefined {
  return Array.from(document.body.querySelectorAll("button")).find((b) =>
    b.textContent?.includes(text),
  ) as HTMLButtonElement | undefined;
}

function click(el: Element | undefined) {
  el?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

describe("AddConnectionWizard — grammar orchestrator", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    mockParams.appKey = undefined;
    mockSearch.value = "";
    container = document.createElement("div");
    document.body.appendChild(container);
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...window.location, assign: assignMock },
    });
    listGalleryMock.mockResolvedValue({ apps: [GITHUB, SLACK, NOTION] });
    finishAppMock.mockResolvedValue({});
    putConnectionInstallsMock.mockResolvedValue({ connectionId: "conn-1", installs: [] });
    listAgentsMock.mockResolvedValue([{ id: "agent-1", name: "Ada", title: "CTO", status: "active", icon: "Bot" }]);
  });

  afterEach(() => {
    document.body.removeChild(container);
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  async function render() {
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <AddConnectionWizard />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();
    return root;
  }

  it("preselects an app from the route and opens its Configure step", async () => {
    mockParams.appKey = "github";
    await render();
    // Single-method app → Method step skipped, Configure active with a specific CTA.
    expect(container.textContent).toContain("Configure");
    expect(buttonContaining("Create")).toBeTruthy();
    expect(buttonContaining("Create")?.textContent).toContain(GITHUB.name);
  });

  it("routes byo and reconnect links through the compatibility wizard", async () => {
    mockSearch.value = "byo=1&applicationId=app-1";
    await render();
    expect(container.textContent).toContain("Custom MCP compatibility wizard");
    expect(container.textContent).not.toContain("Choose app");
  });

  it("opens Notion's executable hosted MCP configuration", async () => {
    mockParams.appKey = "notion";
    await render();

    expect(container.textContent).toContain("Register OAuth Connector for Notion");
    expect(container.textContent).toContain("Add this redirect URI to your OAuth app");
    expect(container.textContent).toContain("notion/");
  });

  it("connects an api-key app and advances to the Actions step", async () => {
    mockParams.appKey = "github";
    connectAppMock.mockResolvedValue({
      connectionId: "conn-1",
      application: { id: "app-1", name: GITHUB.name },
      connection: {},
      catalog: [],
      actions: {
        readOnly: [
          { catalogEntryId: "a1", toolName: "list_repos", title: "List repos", description: "", riskLevel: "read" },
        ],
        canMakeChanges: [],
      },
      suggestedDefaults: {},
      auth: null,
    });
    await render();

    // Fill the primary API key.
    const key = container.querySelector<HTMLInputElement>('input[type="password"]');
    await act(async () => setInputValue(key!, "ghp_secret"));
    await flushReact();

    await act(async () => click(buttonContaining("Create")));
    await flushReact();

    expect(connectAppMock).toHaveBeenCalledTimes(1);
    const [companyId, input] = connectAppMock.mock.calls[0];
    expect(companyId).toBe("company-1");
    expect(input).toMatchObject({ galleryKey: "github", methodKey: GITHUB.methods[0]?.key });
    expect(input.credentialValues).toBeTruthy();

    // Non-OAuth → straight to Actions.
    expect(container.textContent).toContain("Choose actions");
    expect(container.textContent).toContain("List repos");
  });

  it("hands an OAuth app to the Authorize step with the provider consent URL", async () => {
    mockParams.appKey = "slack";
    connectAppMock.mockResolvedValue({
      connectionId: "conn-2",
      application: { id: "app-2", name: SLACK.name },
      connection: {},
      catalog: [],
      actions: { readOnly: [], canMakeChanges: [] },
      suggestedDefaults: {},
      auth: { kind: "oauth", startUrl: "https://slack.com/oauth/authorize?x=1" },
    });
    await render();

    await act(async () => click(buttonContaining("Register OAuth Connector")));
    await flushReact();

    expect(connectAppMock).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain(`Authorize ${SLACK.name}`);
    const signIn = buttonContaining("Sign in to");
    expect(signIn).toBeTruthy();
    expect(buttonContaining("I’ve authorized")).toBeFalsy();

    await act(async () => click(signIn));
    expect(assignMock).toHaveBeenCalledWith("https://slack.com/oauth/authorize?x=1");
  });

  it("resumes the OAuth wizard at Actions after the provider callback", async () => {
    mockParams.appKey = "slack";
    mockSearch.value = "oauth=connected&connectionId=conn-2";
    getAppSetupMock.mockResolvedValue({
      connectionId: "conn-2",
      application: { id: "app-2", name: SLACK.name },
      connection: {
        config: {
          sourceTemplateKey: "slack",
          sourceMethodKey: SLACK.methods[0]?.key,
        },
      },
      catalog: [],
      actions: {
        readOnly: [
          { catalogEntryId: "a1", toolName: "search_messages", title: "Search messages", description: "", riskLevel: "read" },
        ],
        canMakeChanges: [],
      },
      suggestedDefaults: {},
      auth: null,
    });

    await render();

    expect(getAppSetupMock).toHaveBeenCalledWith("company-1", "conn-2");
    expect(container.textContent).toContain("Choose actions");
    expect(container.textContent).toContain("Search messages");
    expect(container.textContent).not.toContain(`Authorize ${SLACK.name}`);
  });

  it("finishes: enables an action, keeps default all-agents access, and calls finishApp", async () => {
    mockParams.appKey = "github";
    connectAppMock.mockResolvedValue({
      connectionId: "conn-1",
      application: { id: "app-1", name: GITHUB.name },
      connection: {},
      catalog: [],
      actions: {
        readOnly: [
          { catalogEntryId: "a1", toolName: "list_repos", title: "List repos", description: "", riskLevel: "read" },
        ],
        canMakeChanges: [],
      },
      suggestedDefaults: {},
      auth: null,
    });
    await render();

    const key = container.querySelector<HTMLInputElement>('input[type="password"]');
    await act(async () => setInputValue(key!, "ghp_secret"));
    await flushReact();
    await act(async () => click(buttonContaining("Create")));
    await flushReact();

    // Read-only action defaults ON → continue with 1 action.
    await act(async () => click(buttonContaining("Continue with 1 action")));
    await flushReact();

    expect(container.textContent).toContain("Choose access");
    await act(async () => click(buttonContaining("Finish setup")));
    await flushReact();

    expect(finishAppMock).toHaveBeenCalledTimes(1);
    const [, connectionId, input] = finishAppMock.mock.calls[0];
    expect(connectionId).toBe("conn-1");
    expect(input).toMatchObject({ enabledCatalogEntryIds: ["a1"], access: "all_agents" });
    expect(mockNavigate).toHaveBeenCalledWith("/apps/conn-1");
  });
});
