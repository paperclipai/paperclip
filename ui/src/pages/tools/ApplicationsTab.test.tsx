// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CompanySecret, ToolApplication, ToolConnection } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../context/ToastContext";
import { ApiError } from "../../api/client";
import { ApplicationsTab } from "./ApplicationsTab";

const mockToolsApi = vi.hoisted(() => ({
  listConnections: vi.fn(),
  listApplications: vi.fn(),
  listCatalog: vi.fn(),
  listStdioTemplates: vi.fn(),
  checkConnectionHealth: vi.fn(),
  refreshCatalog: vi.fn(),
  createConnection: vi.fn(),
  updateConnection: vi.fn(),
  updateApplication: vi.fn(),
  deleteApplication: vi.fn(),
}));

const mockSecretsApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

vi.mock("../../api/tools", () => ({ toolsApi: mockToolsApi }));
vi.mock("../../api/secrets", () => ({ secretsApi: mockSecretsApi }));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

if (!globalThis.PointerEvent) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).PointerEvent = MouseEvent;
}

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

async function typeInputValue(input: HTMLInputElement, value: string) {
  await act(async () => {
    const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    valueSetter?.call(input, value);
    input.dispatchEvent(new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await flushReact();
}

async function typeTextareaValue(textarea: HTMLTextAreaElement, value: string) {
  await act(async () => {
    const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
    valueSetter?.call(textarea, value);
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }));
    textarea.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await flushReact();
}

function makeConnection(overrides: Partial<ToolConnection>): ToolConnection {
  return {
    id: "conn-1",
    companyId: "company-1",
    applicationId: "app-1",
    name: "Production GitHub",
    connectionKind: "managed",
    transport: "remote_http",
    status: "active",
    transportConfig: { url: "https://mcp.github.example.com" },
    config: {},
    credentialSecretRefs: [],
    credentialRefs: [{ name: "Authorization", secretId: "secret-1", version: "latest", placement: "header", key: "Authorization" }],
    healthStatus: "healthy",
    healthMessage: null,
    healthCheckedAt: new Date("2026-06-10T00:00:00Z"),
    lastCatalogRefreshAt: new Date("2026-06-10T00:00:00Z"),
    lastError: null,
    enabled: true,
    createdByAgentId: null,
    createdByUserId: null,
    createdAt: new Date("2026-06-01T00:00:00Z"),
    updatedAt: new Date("2026-06-10T00:00:00Z"),
    ...overrides,
  };
}

function makeApp(overrides: Partial<ToolApplication>): ToolApplication {
  return {
    id: "app-1",
    companyId: "company-1",
    name: "GitHub",
    description: "Issue triage MCP",
    type: "mcp_http",
    status: "active",
    pluginId: null,
    ownerAgentId: null,
    ownerUserId: null,
    metadata: null,
    archivedAt: null,
    createdAt: new Date("2026-06-01T00:00:00Z"),
    updatedAt: new Date("2026-06-01T00:00:00Z"),
    ...overrides,
  };
}

function makeSecret(overrides: Partial<CompanySecret>): CompanySecret {
  return {
    id: "secret-1",
    companyId: "company-1",
    key: "github_token",
    name: "GitHub token",
    provider: "local_encrypted",
    status: "active",
    managedMode: "paperclip_managed",
    externalRef: null,
    providerConfigId: null,
    providerMetadata: null,
    latestVersion: 3,
    description: null,
    lastResolvedAt: null,
    lastRotatedAt: null,
    deletedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    createdAt: new Date("2026-06-01T00:00:00Z"),
    updatedAt: new Date("2026-06-01T00:00:00Z"),
    ...overrides,
  };
}

describe("ApplicationsTab", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot> | null;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = null;
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    mockToolsApi.listApplications.mockResolvedValue({
      applications: [makeApp({}), makeApp({ id: "app-2", name: "Linear", description: null })],
    });
    mockToolsApi.listConnections.mockResolvedValue({ connections: [makeConnection({})] });
    mockToolsApi.listCatalog.mockResolvedValue({
      catalog: [
        { id: "c1", toolName: "create_issue" },
        { id: "c2", toolName: "list_repos" },
      ],
    });
    mockToolsApi.listStdioTemplates.mockResolvedValue({ templates: [] });
    mockSecretsApi.list.mockResolvedValue([makeSecret({})]);
  });

  afterEach(() => {
    if (root) {
      act(() => root!.unmount());
    }
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  async function render() {
    await act(() => {
      root = createRoot(container);
      root.render(
        <QueryClientProvider client={queryClient}>
          <ToastProvider>
            <ApplicationsTab companyId="company-1" />
          </ToastProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();
  }

  it("renders applications as top-level rows and expands to connection actions", async () => {
    await render();

    const text = container.textContent ?? "";
    expect(text).toContain("Applications");
    expect(text).toContain("GitHub");
    expect(text).toContain("MCP HTTP");

    const expand = Array.from(container.querySelectorAll("button")).find(
      (button) => button.getAttribute("aria-label") === "Expand GitHub",
    );
    expect(expand).toBeTruthy();
    await act(() => {
      expand!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    const expandedText = container.textContent ?? "";
    expect(expandedText).toContain("Production GitHub");
    expect(expandedText).toContain("https://mcp.github.example.com");
    expect(expandedText).toContain("remote http");
    expect(expandedText).toContain("Probe");
    expect(expandedText).toContain("Refresh");
    expect(expandedText).toContain("Catalog");
    expect(expandedText).toContain("Disable");
  });

  it("opens the unified add wizard from an application row", async () => {
    await render();

    const expand = Array.from(container.querySelectorAll("button")).find(
      (button) => button.getAttribute("aria-label") === "Expand Linear",
    );
    await act(() => {
      expand!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    const add = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Add connection"),
    );
    expect(add).toBeTruthy();
    await act(() => {
      add!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    const body = document.body.textContent ?? "";
    expect(body).toContain("Add application");
    expect(body).toContain("2 Connection");
    expect(body).toContain("Credential references");
    expect(body).toContain("Free-text secrets are not accepted");
  });

  it("opens the row actions edit dialog and saves application details", async () => {
    mockToolsApi.updateApplication.mockResolvedValue(
      makeApp({ name: "GitHub Enterprise", description: "Internal MCP" }),
    );
    await render();

    const actions = Array.from(container.querySelectorAll("button")).find(
      (button) => button.getAttribute("aria-label") === "Actions for GitHub",
    );
    expect(actions).toBeTruthy();
    await act(() => {
      actions!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      actions!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    const edit = Array.from(document.body.querySelectorAll("[role='menuitem']")).find(
      (item) => item.textContent === "Edit",
    );
    expect(edit).toBeTruthy();
    await act(() => {
      edit!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      edit!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(document.body.textContent ?? "").toContain("Edit application");
    expect(document.body.textContent ?? "").toContain("MCP HTTP");

    const nameInput = document.body.querySelector<HTMLInputElement>("#tool-application-name");
    const descriptionInput = document.body.querySelector<HTMLTextAreaElement>("#tool-application-description");
    expect(nameInput).toBeTruthy();
    expect(descriptionInput).toBeTruthy();

    await typeInputValue(nameInput!, "GitHub Enterprise");
    await typeTextareaValue(descriptionInput!, "Internal MCP");

    const save = Array.from(document.body.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Save changes"),
    );
    expect(save).toBeTruthy();
    await act(() => {
      save!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(mockToolsApi.updateApplication).toHaveBeenCalledWith("app-1", {
      name: "GitHub Enterprise",
      description: "Internal MCP",
    });
  });

  it("keeps duplicate-name conflicts inline in the edit dialog", async () => {
    mockToolsApi.updateApplication.mockRejectedValue(new ApiError("duplicate", 409, { error: "duplicate" }));
    await render();

    const actions = Array.from(container.querySelectorAll("button")).find(
      (button) => button.getAttribute("aria-label") === "Actions for GitHub",
    );
    await act(() => {
      actions!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      actions!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    const edit = Array.from(document.body.querySelectorAll("[role='menuitem']")).find(
      (item) => item.textContent === "Edit",
    );
    await act(() => {
      edit!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      edit!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    const save = Array.from(document.body.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Save changes"),
    );
    await act(() => {
      save!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    await flushReact();

    expect(document.body.textContent ?? "").toContain("Another application already uses that name.");
  });

  it("confirms disabling an application with connection and catalog impact", async () => {
    mockToolsApi.updateApplication.mockResolvedValue(makeApp({ status: "disabled" }));
    await render();

    const actions = Array.from(container.querySelectorAll("button")).find(
      (button) => button.getAttribute("aria-label") === "Actions for GitHub",
    );
    expect(actions).toBeTruthy();
    await act(() => {
      actions!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      actions!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    const disable = Array.from(document.body.querySelectorAll("[role='menuitem']")).find(
      (item) => item.textContent === "Disable",
    );
    expect(disable).toBeTruthy();
    await act(() => {
      disable!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      disable!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    const body = document.body.textContent ?? "";
    expect(body).toContain("Disable application");
    expect(body).toContain("Impact summary");
    expect(body).toContain("1connection affected");
    expect(body).toContain("2catalog tools affected");

    const confirm = Array.from(document.body.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Disable application"),
    );
    expect(confirm).toBeTruthy();
    await act(() => {
      confirm!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(mockToolsApi.updateApplication).toHaveBeenCalledWith("app-1", { status: "disabled" });
  });

  it("reactivates disabled applications directly from the row actions menu", async () => {
    mockToolsApi.listApplications.mockResolvedValue({
      applications: [makeApp({ status: "disabled" }), makeApp({ id: "app-2", name: "Linear", description: null })],
    });
    mockToolsApi.updateApplication.mockResolvedValue(makeApp({ status: "active" }));
    await render();

    const actions = Array.from(container.querySelectorAll("button")).find(
      (button) => button.getAttribute("aria-label") === "Actions for GitHub",
    );
    await act(() => {
      actions!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      actions!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    const reactivate = Array.from(document.body.querySelectorAll("[role='menuitem']")).find(
      (item) => item.textContent === "Reactivate",
    );
    expect(reactivate).toBeTruthy();
    await act(() => {
      reactivate!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      reactivate!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(mockToolsApi.updateApplication).toHaveBeenCalledWith("app-1", { status: "active" });
  });

  it("deletes an application without connections through the row actions menu", async () => {
    mockToolsApi.deleteApplication.mockResolvedValue(makeApp({ id: "app-2", name: "Linear", description: null }));
    await render();

    const actions = Array.from(container.querySelectorAll("button")).find(
      (button) => button.getAttribute("aria-label") === "Actions for Linear",
    );
    expect(actions).toBeTruthy();
    await act(() => {
      actions!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      actions!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    const del = Array.from(document.body.querySelectorAll("[role='menuitem']")).find(
      (item) => item.textContent === "Delete",
    );
    expect(del).toBeTruthy();
    await act(() => {
      del!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      del!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    const body = document.body.textContent ?? "";
    expect(body).toContain("Delete application");
    expect(body).toContain("No connections are attached");

    const confirm = Array.from(document.body.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Delete application"),
    );
    expect(confirm).toBeTruthy();
    await act(() => {
      confirm!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(mockToolsApi.deleteApplication).toHaveBeenCalledWith("app-2");
  });

  it("surfaces the connection guard message inline when delete returns 409", async () => {
    mockToolsApi.deleteApplication.mockRejectedValue(
      new ApiError(
        "This application still has connections. Remove its connections or archive the application instead of deleting it.",
        409,
        { error: "conflict" },
      ),
    );
    await render();

    const actions = Array.from(container.querySelectorAll("button")).find(
      (button) => button.getAttribute("aria-label") === "Actions for GitHub",
    );
    await act(() => {
      actions!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      actions!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    const del = Array.from(document.body.querySelectorAll("[role='menuitem']")).find(
      (item) => item.textContent === "Delete",
    );
    await act(() => {
      del!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      del!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    // GitHub (app-1) has a connection, so the dialog warns before we even submit.
    expect(document.body.textContent ?? "").toContain("delete is blocked while connections exist");

    const confirm = Array.from(document.body.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Delete application"),
    );
    await act(() => {
      confirm!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    await flushReact();

    expect(mockToolsApi.deleteApplication).toHaveBeenCalledWith("app-1");
    expect(document.body.textContent ?? "").toContain(
      "Remove its connections or archive the application instead",
    );
  });
});
