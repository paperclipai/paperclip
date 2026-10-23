// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectToolAppResult, McpJsonImportPreview } from "@paperclipai/shared";
import { PasteConfigTab } from "./PasteConfigTab";

const toolsApiMock = vi.hoisted(() => ({
  importMcpJson: vi.fn(),
  connectApp: vi.fn(),
  startOAuth: vi.fn(),
  finishApp: vi.fn(),
}));
const secretsApiMock = vi.hoisted(() => ({ catalog: vi.fn() }));
const mockNavigate = vi.hoisted(() => vi.fn());
const navigateTopLevelMock = vi.hoisted(() => vi.fn());
vi.mock("@/api/tools", () => ({ toolsApi: toolsApiMock }));
vi.mock("@/api/secrets", () => ({ secretsApi: secretsApiMock }));
vi.mock("@/lib/browserNavigation", () => ({ navigateTopLevel: navigateTopLevelMock }));
// The tab uses `useNavigate` from the app router (PAP-11088 draft hand-off),
// which needs CompanyProvider; stub it so the copy hint renders in isolation.
vi.mock("@/lib/router", () => ({ useNavigate: () => mockNavigate }));

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

function setTextareaValue(textarea: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  setter?.call(textarea, value);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function setSelectValue(select: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")?.set;
  setter?.call(select, value);
  select.dispatchEvent(new Event("input", { bubbles: true }));
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

function buttonStartingWith(text: string): HTMLButtonElement | undefined {
  return Array.from(document.body.querySelectorAll("button")).find(
    (b) => b.textContent?.trim().startsWith(text),
  ) as HTMLButtonElement | undefined;
}

function connectResult(overrides: Partial<ConnectToolAppResult> = {}): ConnectToolAppResult {
  return {
    connectionId: "conn-1",
    application: {
      id: "app-1",
      companyId: "company-1",
      applicationKey: "app-gallery:link:test",
      name: "kv-demo",
      description: null,
      type: "mcp_http",
      status: "draft",
      pluginId: null,
      ownerAgentId: null,
      ownerUserId: null,
      metadata: null,
      archivedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    connection: {
      id: "conn-1",
      companyId: "company-1",
      applicationId: "app-1",
      name: "kv-demo",
      uid: "app-gallery-link-test/kv-demo",
      connectionKind: "managed",
      connectionPurpose: "tool",
      ownership: "customer",
      transport: "mcp_remote",
      authKind: "none",
      credentialSource: "paperclip_vault",
      credentialPolicy: "shared",
      status: "draft",
      enabled: false,
      config: { url: "http://127.0.0.1:8848/mcp" },
      transportConfig: { url: "http://127.0.0.1:8848/mcp" },
      credentialRefs: [],
      credentialSecretRefs: [],
      healthStatus: "ok",
      healthMessage: "ok",
      healthCheckedAt: new Date(),
      lastHealthAt: new Date(),
      lastCatalogRefreshAt: new Date(),
      lastError: null,
      createdByAgentId: null,
      createdByUserId: "board",
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    catalog: [],
    actions: {
      readOnly: [{
        catalogEntryId: "cat-read",
        toolName: "kv_get",
        title: "Get value",
        description: "Read a value.",
        riskLevel: "read",
        isReadOnly: true,
        isWrite: false,
        isDestructive: false,
        status: "active",
      }],
      canMakeChanges: [],
    },
    suggestedDefaults: { access: "all_agents", askFirstRiskLevels: [] },
    ...overrides,
  };
}

const NOTION_CONFIG = '{ "mcpServers": { "notion": { "url": "https://mcp.notion.com/mcp" } } }';

const NOTION_PREVIEW: McpJsonImportPreview = {
  drafts: [{
    name: "notion",
    transport: "mcp_remote",
    status: "draft",
    config: { url: "https://mcp.notion.com/mcp" },
    credentialRefs: [],
    credentialFields: [],
    warnings: [],
  }],
};

function oauthConnectResult(startUrl: string | null = null): ConnectToolAppResult {
  const base = connectResult();
  return {
    ...base,
    application: {
      ...base.application,
      applicationKey: "app-gallery:link:notion-generic-test",
      name: "notion",
      metadata: { source: "link" },
    },
    connection: {
      ...base.connection,
      authKind: "oauth",
      config: { url: "https://mcp.notion.com/mcp", unverifiedServer: true },
      transportConfig: { url: "https://mcp.notion.com/mcp", unverifiedServer: true },
    },
    catalog: [],
    actions: { readOnly: [], canMakeChanges: [] },
    auth: {
      kind: "oauth",
      startUrl,
      resource: "https://mcp.notion.com/mcp",
      registrationSource: "cimd",
    },
  };
}

describe("PasteConfigTab — discoverability copy (PAP-11091)", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    secretsApiMock.catalog.mockResolvedValue([]);
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    document.body.removeChild(container);
    document.body.innerHTML = "";
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  async function render() {
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <PasteConfigTab companyId="company-1" />
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
    return root;
  }

  it("shows a hint linking to the Browse app surface", async () => {
    await render();

    expect(container.textContent).toContain("Just a URL?");
    const link = Array.from(container.querySelectorAll("a")).find((a) =>
      a.textContent?.includes("Browse planned app connections"),
    );
    expect(link).toBeTruthy();
    expect(link?.getAttribute("href")).toBe("/apps");
  });
});

describe("PasteConfigTab — activation handoff (PAP-11092)", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    secretsApiMock.catalog.mockResolvedValue([]);
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    document.body.removeChild(container);
    document.body.innerHTML = "";
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  async function render() {
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <PasteConfigTab companyId="company-1" />
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
    await flushReact();
    return root;
  }

  async function pasteAndCheck(preview: McpJsonImportPreview, snippet: string) {
    toolsApiMock.importMcpJson.mockResolvedValue(preview);
    await render();
    const textarea = container.querySelector("textarea")!;
    await act(async () => setTextareaValue(textarea, snippet));
    await flushReact();
    await act(async () => {
      buttonStartingWith("Check config")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
  }

  it("renders a Continue button for a remote draft that navigates to the prefilled connect wizard", async () => {
    await pasteAndCheck(
      {
        drafts: [
          {
            name: "kv-demo",
            transport: "mcp_remote",
            status: "draft",
            config: { url: "http://127.0.0.1:8848/mcp" },
            credentialRefs: [],
            credentialFields: [],
            warnings: [],
          },
        ],
      },
      '{ "mcpServers": { "kv-demo": { "url": "http://127.0.0.1:8848/mcp" } } }',
    );

    expect(container.textContent).toContain("We found 1 app in that config");
    const checkButton = buttonStartingWith("Check actions");
    expect(checkButton).toBeTruthy();

    toolsApiMock.connectApp.mockResolvedValue(connectResult());
    await act(async () => {
      checkButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(mockNavigate).not.toHaveBeenCalled();
    expect(toolsApiMock.connectApp).toHaveBeenCalledWith("company-1", {
      link: "http://127.0.0.1:8848/mcp",
      name: "kv-demo",
      credentialValues: {},
    });
    expect(container.textContent).toContain("Review actions for kv-demo");
    // The dead-end "Next, you'll add the keys" copy is gone.
    expect(container.textContent).not.toContain("Next, you'll add the keys");
  });

  it("activates imported write actions as allowed by default", async () => {
    await pasteAndCheck(NOTION_PREVIEW, NOTION_CONFIG);
    const result = connectResult();
    result.actions.canMakeChanges = [{
      catalogEntryId: "cat-write",
      toolName: "create_page",
      title: "Create page",
      description: "Create a page.",
      riskLevel: "write",
      isReadOnly: false,
      isWrite: true,
      isDestructive: false,
      status: "active",
    }];
    toolsApiMock.connectApp.mockResolvedValue(result);
    toolsApiMock.finishApp.mockResolvedValue({ connection: result.connection });

    await act(async () => {
      buttonStartingWith("Check actions")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    const activateButton = buttonStartingWith("Activate 2 of 2");
    expect(activateButton).toBeTruthy();
    await act(async () => {
      activateButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(toolsApiMock.finishApp).toHaveBeenCalledWith("company-1", "conn-1", {
      enabledCatalogEntryIds: ["cat-read", "cat-write"],
      askFirstCatalogEntryIds: [],
      access: "all_agents",
    });
  });

  it("collects imported headers as secret replacement fields before checking actions", async () => {
    await pasteAndCheck(
      {
        drafts: [
          {
            name: "secure-demo",
            transport: "mcp_remote",
            status: "draft",
            config: { url: "https://secure.example/mcp" },
            credentialRefs: [],
            credentialFields: [{
              configPath: "headers.Authorization",
              label: "Authorization",
              placement: "header",
              key: "Authorization",
              prefix: null,
              required: true,
            }],
            warnings: ["Header Authorization will be stored as a Paperclip secret before activation."],
          },
        ],
      },
      '{ "mcpServers": { "secure-demo": { "url": "https://secure.example/mcp", "headers": { "Authorization": "Bearer old" } } } }',
    );

    const checkButton = buttonStartingWith("Check actions")!;
    expect(checkButton.disabled).toBe(true);
    const input = container.querySelector('input[type="password"]') as HTMLInputElement;
    await act(async () => setInputValue(input, "Bearer new"));
    await flushReact();

    expect(buttonStartingWith("Check actions")!.disabled).toBe(false);
    toolsApiMock.connectApp.mockResolvedValue(connectResult({
      application: { ...connectResult().application, name: "secure-demo" },
    }));
    await act(async () => {
      buttonStartingWith("Check actions")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(toolsApiMock.connectApp).toHaveBeenCalledWith("company-1", {
      link: "https://secure.example/mcp",
      name: "secure-demo",
      credentialValues: { "headers.Authorization": "Bearer new" },
    });
  });

  it("uses active secret metadata without sending a replacement value", async () => {
    const secretId = "22222222-2222-4222-8222-222222222222";
    secretsApiMock.catalog.mockResolvedValue([
      { id: secretId, name: "Dida API token", key: "integrations/dida365/api-token", status: "active" },
      { id: "33333333-3333-4333-8333-333333333333", name: "Old token", key: "old", status: "disabled" },
    ]);
    await pasteAndCheck(
      {
        drafts: [{
          name: "dida365",
          transport: "mcp_remote",
          status: "draft",
          config: { url: "https://mcp.dida365.com" },
          credentialRefs: [],
          credentialFields: [{
            configPath: "headers.Authorization",
            label: "Authorization",
            placement: "header",
            key: "Authorization",
            prefix: null,
            required: true,
          }],
          warnings: [],
        }],
      },
      '{ "mcpServers": { "dida365": { "url": "https://mcp.dida365.com" } } }',
    );
    await flushReact();

    const select = container.querySelector('select[aria-label="Use existing secret for Authorization"]') as HTMLSelectElement;
    expect(select.textContent).toContain("Dida API token");
    expect(select.textContent).not.toContain("Old token");
    await act(async () => {
      setSelectValue(select, secretId);
    });
    await flushReact();
    expect(buttonStartingWith("Check actions")!.disabled).toBe(false);

    toolsApiMock.connectApp.mockResolvedValue(connectResult());
    await act(async () => {
      buttonStartingWith("Check actions")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    expect(toolsApiMock.connectApp).toHaveBeenCalledWith("company-1", {
      link: "https://mcp.dida365.com/",
      name: "dida365",
      credentialValues: {},
      credentialSecretSelections: {
        "headers.Authorization": { secretId, versionSelector: "latest" },
      },
    });
  });

  it("clears an existing secret selection when a new config is imported", async () => {
    const secretId = "22222222-2222-4222-8222-222222222222";
    secretsApiMock.catalog.mockResolvedValue([
      { id: secretId, name: "Dida API token", key: "integrations/dida365/api-token", status: "active" },
    ]);
    const previewFor = (url: string): McpJsonImportPreview => ({
      drafts: [{
        name: "dida365",
        transport: "mcp_remote",
        status: "draft",
        config: { url },
        credentialRefs: [],
        credentialFields: [{
          configPath: "headers.Authorization",
          label: "Authorization",
          placement: "header",
          key: "Authorization",
          prefix: null,
          required: true,
        }],
        warnings: [],
      }],
    });
    await pasteAndCheck(
      previewFor("https://first.example/mcp"),
      '{ "mcpServers": { "dida365": { "url": "https://first.example/mcp" } } }',
    );
    await flushReact();

    let select = container.querySelector('select[aria-label="Use existing secret for Authorization"]') as HTMLSelectElement;
    await act(async () => setSelectValue(select, secretId));
    await flushReact();

    toolsApiMock.importMcpJson.mockResolvedValue(previewFor("https://second.example/mcp"));
    const textarea = container.querySelector("textarea")!;
    await act(async () => setTextareaValue(
      textarea,
      '{ "mcpServers": { "dida365": { "url": "https://second.example/mcp" } } }',
    ));
    await flushReact();
    await act(async () => {
      buttonStartingWith("Check config")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    select = container.querySelector('select[aria-label="Use existing secret for Authorization"]') as HTMLSelectElement;
    expect(select.value).toBe("");
    expect(buttonStartingWith("Check actions")!.disabled).toBe(true);
  });

  it("surfaces a secret catalog error and lets the operator retry", async () => {
    secretsApiMock.catalog
      .mockRejectedValueOnce(new Error("catalog offline"))
      .mockResolvedValueOnce([]);
    await pasteAndCheck({
      drafts: [{
        name: "dida365",
        transport: "mcp_remote",
        status: "draft",
        config: { url: "https://mcp.dida365.com" },
        credentialRefs: [],
        credentialFields: [{
          configPath: "headers.Authorization",
          label: "Authorization",
          placement: "header",
          key: "Authorization",
          prefix: null,
          required: true,
        }],
        warnings: [],
      }],
    }, '{ "mcpServers": { "dida365": { "url": "https://mcp.dida365.com" } } }');
    await flushReact();

    expect(container.textContent).toContain("Couldn’t load existing secrets");
    const retry = buttonStartingWith("Retry secrets");
    expect(retry).toBeTruthy();
    await act(async () => {
      retry!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(secretsApiMock.catalog).toHaveBeenCalledTimes(2);
    expect(container.textContent).not.toContain("Couldn’t load existing secrets");
  });

  it("starts OAuth for the original generic connection instead of rendering an empty catalog", async () => {
    await pasteAndCheck(NOTION_PREVIEW, NOTION_CONFIG);
    const nameInput = container.querySelector('input[placeholder="notion"]') as HTMLInputElement;
    await act(async () => setInputValue(nameInput, "Notion generic self-test 2026-08-17T20:00:00Z"));
    await flushReact();
    toolsApiMock.connectApp.mockResolvedValue(oauthConnectResult());
    toolsApiMock.startOAuth.mockResolvedValue({
      connectionId: "conn-1",
      provider: "mcp.notion.com",
      authorizationUrl: "https://mcp.notion.com/authorize?state=redacted",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      registrationSource: "cimd",
    });

    await act(async () => {
      buttonStartingWith("Check actions")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    await flushReact();

    expect(toolsApiMock.connectApp).toHaveBeenCalledTimes(1);
    expect(toolsApiMock.connectApp).toHaveBeenCalledWith("company-1", {
      link: "https://mcp.notion.com/mcp",
      name: "Notion generic self-test 2026-08-17T20:00:00Z",
      credentialValues: {},
    });
    expect(toolsApiMock.startOAuth).toHaveBeenCalledWith("conn-1");
    expect(navigateTopLevelMock).toHaveBeenCalledWith(
      "https://mcp.notion.com/authorize?state=redacted",
    );
    expect(container.textContent).toContain("Unverified server");
    expect(container.textContent).toContain("mcp.notion.com");
    expect(container.textContent).not.toContain("Review actions for notion");
  });

  it("uses the background Cloud handoff returned with an imported OAuth connection", async () => {
    const session = "imported_background_session_1234";
    const request = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({
      authorizationUrl: "https://provider.example.test/authorize?state=imported",
    }));
    await pasteAndCheck(NOTION_PREVIEW, NOTION_CONFIG);
    const result = oauthConnectResult("https://my.paperclip.app/connections/confirm?session=legacy");
    result.auth = {
      ...result.auth!,
      handoff: { kind: "paperclip_cloud", session },
    };
    toolsApiMock.connectApp.mockResolvedValue(result);

    await act(async () => {
      buttonStartingWith("Check actions")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    await flushReact();

    expect(request).toHaveBeenCalledWith("/cloud/connections/handoff", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ session }),
    }));
    await vi.waitFor(() => {
      expect(navigateTopLevelMock).toHaveBeenCalledWith(
        "https://provider.example.test/authorize?state=imported",
      );
    });
    expect(navigateTopLevelMock).not.toHaveBeenCalledWith(expect.stringContaining("/connections/confirm"));
  });

  it("rejects an unsafe start URL and retries OAuth on the same connection", async () => {
    await pasteAndCheck(NOTION_PREVIEW, NOTION_CONFIG);
    toolsApiMock.connectApp.mockResolvedValue(oauthConnectResult("javascript:alert(1)"));

    await act(async () => {
      buttonStartingWith("Check actions")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(navigateTopLevelMock).not.toHaveBeenCalled();
    expect(container.textContent).toContain("couldn’t connect");
    expect(container.textContent).not.toContain("javascript:alert(1)");

    toolsApiMock.startOAuth.mockResolvedValue({
      connectionId: "conn-1",
      provider: "mcp.notion.com",
      authorizationUrl: "https://mcp.notion.com/authorize?state=retry-redacted",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      registrationSource: "cimd",
    });
    await act(async () => {
      buttonStartingWith("Try again")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    await flushReact();

    expect(toolsApiMock.connectApp).toHaveBeenCalledTimes(1);
    expect(toolsApiMock.startOAuth).toHaveBeenCalledTimes(1);
    expect(toolsApiMock.startOAuth).toHaveBeenCalledWith("conn-1");
    expect(navigateTopLevelMock).toHaveBeenCalledWith(
      "https://mcp.notion.com/authorize?state=retry-redacted",
    );
  });

  it("backs up to the original connection setup route without creating another draft", async () => {
    await pasteAndCheck(NOTION_PREVIEW, NOTION_CONFIG);
    toolsApiMock.connectApp.mockResolvedValue(oauthConnectResult("javascript:alert(1)"));

    await act(async () => {
      buttonStartingWith("Check actions")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    await act(async () => {
      buttonStartingWith("Back")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(mockNavigate).toHaveBeenCalledWith("/apps/conn-1/permissions");
    expect(toolsApiMock.connectApp).toHaveBeenCalledTimes(1);
    expect(toolsApiMock.startOAuth).not.toHaveBeenCalled();
  });

  it("cancels the OAuth checkpoint to the apps page", async () => {
    await pasteAndCheck(NOTION_PREVIEW, NOTION_CONFIG);
    toolsApiMock.connectApp.mockResolvedValue(oauthConnectResult("javascript:alert(1)"));

    await act(async () => {
      buttonStartingWith("Check actions")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    await act(async () => {
      buttonStartingWith("Cancel")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(mockNavigate).toHaveBeenCalledWith("/apps");
  });

  it("does not offer Continue for a stdio draft (draft-only, no link to hand off)", async () => {
    await pasteAndCheck(
      {
        drafts: [
          {
            name: "github",
            transport: "local_stdio",
            status: "draft",
            config: { importedCommand: "npx -y @modelcontextprotocol/server-github", importedArgs: [] },
            credentialRefs: [{ name: "GITHUB_TOKEN", secretId: "draft-token", placement: "env", key: "GITHUB_TOKEN" }],
            credentialFields: [],
            warnings: ["Imported stdio commands stay draft-only unless mapped to an approved Paperclip template."],
          },
        ],
      },
      '{ "mcpServers": { "github": { "command": "npx -y @modelcontextprotocol/server-github" } } }',
    );

    expect(container.textContent).toContain("We found 1 app in that config");
    expect(buttonStartingWith("Check actions")).toBeFalsy();
    expect(container.textContent).toContain("stay as drafts until an admin");
    expect(container.textContent).toContain("Keys from this config stay draft-only");
    expect(container.textContent).not.toContain("No keys needed for this one.");
  });
});
