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
  finishApp: vi.fn(),
}));
const mockNavigate = vi.hoisted(() => vi.fn());
vi.mock("@/api/tools", () => ({ toolsApi: toolsApiMock }));
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
      connectionKind: "managed",
      transport: "remote_http",
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
    suggestedDefaults: { access: "all_agents", askFirstRiskLevels: ["write", "destructive"] },
    ...overrides,
  };
}

describe("PasteConfigTab — discoverability copy (PAP-11091)", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
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
          <MemoryRouter>
            <PasteConfigTab companyId="company-1" />
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
    return root;
  }

  it("shows a hint linking back to the Connect-an-app link flow", async () => {
    await render();

    expect(container.textContent).toContain("Just a URL?");
    const link = Array.from(container.querySelectorAll("a")).find((a) =>
      a.textContent?.includes("Connect with a link"),
    );
    expect(link).toBeTruthy();
    expect(link?.getAttribute("href")).toBe("/apps/connect");
  });
});

describe("PasteConfigTab — activation handoff (PAP-11092)", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
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
            transport: "remote_http",
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

  it("collects imported headers as secret replacement fields before checking actions", async () => {
    await pasteAndCheck(
      {
        drafts: [
          {
            name: "secure-demo",
            transport: "remote_http",
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
