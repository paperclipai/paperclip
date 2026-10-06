// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { McpConnector } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectorsTab } from "./ConnectorsTab";

const listMock = vi.hoisted(() => vi.fn());
const createMock = vi.hoisted(() => vi.fn());
const createConnectionMock = vi.hoisted(() => vi.fn());
const listConnectionsMock = vi.hoisted(() => vi.fn());
const checkConnectionHealthMock = vi.hoisted(() => vi.fn());
const updateConnectionMock = vi.hoisted(() => vi.fn());
const refreshCatalogMock = vi.hoisted(() => vi.fn());
const archiveConnectionMock = vi.hoisted(() => vi.fn());
const pushToastMock = vi.hoisted(() => vi.fn());

vi.mock("@/api/mcp-connectors", () => ({
  mcpConnectorsApi: {
    list: (companyId: string) => listMock(companyId),
    create: (companyId: string, input: { name: string }) => createMock(companyId, input),
    reenroll: vi.fn(),
    revoke: vi.fn(),
  },
}));

vi.mock("@/api/tools", () => ({
  toolsApi: {
    listConnections: (...args: unknown[]) => listConnectionsMock(...args),
    createConnection: (...args: unknown[]) => createConnectionMock(...args),
    checkConnectionHealth: (...args: unknown[]) => checkConnectionHealthMock(...args),
    refreshCatalog: (...args: unknown[]) => refreshCatalogMock(...args),
    updateConnection: (...args: unknown[]) => updateConnectionMock(...args),
    archiveConnection: (...args: unknown[]) => archiveConnectionMock(...args),
  },
}));

vi.mock("@/context/ToastContext", () => ({
  useToast: () => ({ pushToast: pushToastMock }),
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
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  }
}

function connector(overrides: Partial<McpConnector> = {}): McpConnector {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    companyId: "company-1",
    name: "Homelab",
    status: "active",
    online: true,
    version: "0.1.0",
    upstreams: ["unifi"],
    lastSeenAt: new Date().toISOString(),
    lastConnectedAt: new Date().toISOString(),
    enrollmentExpiresAt: null,
    credentialRotatedAt: null,
    revokedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("ConnectorsTab", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    listConnectionsMock.mockResolvedValue({ connections: [] });
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  async function render() {
    root = createRoot(container);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <ConnectorsTab companyId="company-1" />
        </QueryClientProvider>,
      );
    });
    await flushReact();
  }

  it("shows connector status, version and published upstream names", async () => {
    listMock.mockResolvedValue({
      connectors: [
        connector(),
        connector({ id: "22222222-2222-4222-8222-222222222222", name: "Office", online: false, upstreams: ["nas"] }),
        connector({ id: "33333333-3333-4333-8333-333333333333", name: "Old", status: "revoked", online: false }),
      ],
    });
    await render();
    expect(container.textContent).toContain("Homelab");
    expect(container.textContent).toContain("online");
    expect(container.textContent).toContain("v0.1.0");
    expect(container.textContent).toContain("unifi");
    expect(container.textContent).toContain("offline");
    expect(container.textContent).toContain("revoked");
  });

  it("offers discovered servers for import and marks existing connections", async () => {
    listMock.mockResolvedValue({ connectors: [connector({ upstreams: ["unifi", "grafana"] })] });
    listConnectionsMock.mockResolvedValue({ connections: [
      { transport: "connector", status: "active", config: { connectorId: connector().id, upstream: "unifi" } },
    ] });
    await render();
    expect(container.textContent).toContain("Already imported");
    const importButton = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Import grafana"))!;
    expect(importButton).toBeDefined();
    expect(container.textContent).not.toContain("Import unifi");
    await act(() => importButton.click());
    await flushReact();
    expect(document.querySelector<HTMLInputElement>("#connector-connection-name")?.value).toBe("Homelab grafana");
  });

  it("does not offer import from an offline connector", async () => {
    listMock.mockResolvedValue({ connectors: [connector({ online: false, upstreams: ["unifi"] })] });
    await render();
    const importButton = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Import unifi"))!;
    expect(importButton.disabled).toBe(true);
  });

  it("matches imports by connector and upstream, including transport config", async () => {
    listMock.mockResolvedValue({ connectors: [connector({ upstreams: ["unifi", "grafana"] })] });
    listConnectionsMock.mockResolvedValue({ connections: [
      { transport: "connector", status: "active", transportConfig: { connectorId: connector().id, upstream: "unifi" } },
      { transport: "connector", status: "active", config: { connectorId: "other-connector", upstream: "grafana" } },
      { transport: "connector", status: "archived", config: { connectorId: connector().id, upstream: "grafana" } },
    ] });
    await render();
    expect(container.textContent).not.toContain("Import unifi");
    expect(container.textContent).toContain("Import grafana");
  });

  it("shows the enrollment token once after creating a connector", async () => {
    listMock.mockResolvedValue({ connectors: [] });
    createMock.mockResolvedValue({
      connector: connector({ status: "pending", online: false, upstreams: [], version: null }),
      enrollmentToken: "pcmce_11111111-1111-4111-8111-111111111111.token",
      enrollmentExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    await render();
    const input = container.querySelector<HTMLInputElement>("#connector-name")!;
    await act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "Homelab");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(() => {
      container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await flushReact();
    expect(createMock).toHaveBeenCalledWith("company-1", { name: "Homelab" });
    expect(container.textContent).toContain("PAPERCLIP_MCP_CONNECTOR_ENROLLMENT_TOKEN=pcmce_");
    const done = [...container.querySelectorAll("button")].find((button) => button.textContent === "Done")!;
    await act(() => done.click());
    await flushReact();
    expect(container.textContent).not.toContain("pcmce_");
  });

  it("activates connection before refreshing catalog so action access is created", async () => {
    const callOrder: string[] = [];
    listMock.mockResolvedValue({ connectors: [connector({ upstreams: ["unifi"] })] });
    createConnectionMock.mockImplementation(async () => {
      callOrder.push("createConnection");
      return { id: "conn-123" };
    });
    checkConnectionHealthMock.mockImplementation(async () => {
      callOrder.push("checkConnectionHealth");
      return { status: "ok" };
    });
    updateConnectionMock.mockImplementation(async () => {
      callOrder.push("updateConnection");
      return { id: "conn-123", status: "active" };
    });
    refreshCatalogMock.mockImplementation(async () => {
      callOrder.push("refreshCatalog");
      return { discoveredCount: 5, quarantinedCount: 0 };
    });

    await render();
    const addBtn = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Add connection"))!;
    await act(() => addBtn.click());
    await flushReact();

    const submitBtn = [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Connect and discover actions"))!;
    expect(submitBtn).toBeDefined();
    await act(() => submitBtn.click());
    await flushReact();

    expect(callOrder).toEqual([
      "createConnection",
      "checkConnectionHealth",
      "updateConnection",
      "refreshCatalog",
    ]);
  });

  it("reuses draft connection on retry after health check failure without duplicate creation", async () => {
    listMock.mockResolvedValue({ connectors: [connector({ upstreams: ["unifi"] })] });
    createConnectionMock.mockResolvedValue({ id: "conn-456" });
    checkConnectionHealthMock
      .mockRejectedValueOnce(new Error("Upstream unreachable"))
      .mockResolvedValueOnce({ status: "ok" });
    updateConnectionMock.mockResolvedValue({ id: "conn-456", status: "active" });
    refreshCatalogMock.mockResolvedValue({ discoveredCount: 2, quarantinedCount: 0 });

    await render();
    const addBtn = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Add connection"))!;
    await act(() => addBtn.click());
    await flushReact();

    const submitBtn = [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Connect and discover actions"))!;
    await act(() => submitBtn.click());
    await flushReact();

    expect(createConnectionMock).toHaveBeenCalledTimes(1);
    expect(checkConnectionHealthMock).toHaveBeenCalledTimes(1);

    // Retry should update the existing draft connection instead of calling createConnection again
    await act(() => submitBtn.click());
    await flushReact();

    expect(createConnectionMock).toHaveBeenCalledTimes(1);
    expect(updateConnectionMock).toHaveBeenCalled();
    expect(refreshCatalogMock).toHaveBeenCalledWith("conn-456");
  });

  it("archives draft connection when dialog is closed after failure", async () => {
    listMock.mockResolvedValue({ connectors: [connector({ upstreams: ["unifi"] })] });
    createConnectionMock.mockResolvedValue({ id: "conn-456" });
    checkConnectionHealthMock.mockRejectedValue(new Error("Upstream unreachable"));
    archiveConnectionMock.mockResolvedValue({ id: "conn-456", status: "archived" });

    await render();
    const addBtn = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Add connection"))!;
    await act(() => addBtn.click());
    await flushReact();

    const submitBtn = [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Connect and discover actions"))!;
    await act(() => submitBtn.click());
    await flushReact();

    const cancelBtn = [...document.querySelectorAll("button")].find((b) => b.textContent === "Cancel")!;
    await act(() => cancelBtn.click());
    await flushReact();

    expect(archiveConnectionMock).toHaveBeenCalledWith("conn-456");
  });

  it("archives the connection without activating it when the dialog closes during creation", async () => {
    listMock.mockResolvedValue({ connectors: [connector({ upstreams: ["unifi"] })] });
    let resolveCreate: (value: { id: string }) => void = () => undefined;
    createConnectionMock.mockImplementation(
      () => new Promise<{ id: string }>((resolve) => { resolveCreate = resolve; }),
    );
    archiveConnectionMock.mockResolvedValue({ id: "conn-789", status: "archived" });

    await render();
    const addBtn = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Add connection"))!;
    await act(() => addBtn.click());
    await flushReact();

    const submitBtn = [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Connect and discover actions"))!;
    await act(() => submitBtn.click());
    await flushReact();
    expect(createConnectionMock).toHaveBeenCalledTimes(1);

    const cancelBtn = [...document.querySelectorAll("button")].find((b) => b.textContent === "Cancel")!;
    await act(() => cancelBtn.click());
    await flushReact();
    expect(archiveConnectionMock).not.toHaveBeenCalled();

    await act(async () => resolveCreate({ id: "conn-789" }));
    await flushReact();

    expect(archiveConnectionMock).toHaveBeenCalledWith("conn-789");
    expect(checkConnectionHealthMock).not.toHaveBeenCalled();
    expect(updateConnectionMock).not.toHaveBeenCalled();
    expect(refreshCatalogMock).not.toHaveBeenCalled();
  });

  it("deactivates the connection again when catalog refresh fails after activation", async () => {
    listMock.mockResolvedValue({ connectors: [connector({ upstreams: ["unifi"] })] });
    createConnectionMock.mockResolvedValue({ id: "conn-321" });
    checkConnectionHealthMock.mockResolvedValue({ status: "ok" });
    updateConnectionMock.mockResolvedValue({ id: "conn-321" });
    refreshCatalogMock.mockRejectedValue(new Error("Discovery failed"));

    await render();
    const addBtn = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Add connection"))!;
    await act(() => addBtn.click());
    await flushReact();

    const submitBtn = [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Connect and discover actions"))!;
    await act(() => submitBtn.click());
    await flushReact();

    expect(updateConnectionMock.mock.calls).toEqual([
      ["conn-321", { status: "active", enabled: true }],
      ["conn-321", { status: "draft", enabled: false }],
    ]);
    expect(pushToastMock).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Could not add connection", body: expect.stringContaining("Discovery failed"), tone: "error" }),
    );
  });

  it("surfaces a failed cleanup after cancelling and lets the operator retry removal", async () => {
    listMock.mockResolvedValue({ connectors: [connector({ upstreams: ["unifi"] })] });
    createConnectionMock.mockResolvedValue({ id: "conn-654" });
    checkConnectionHealthMock.mockResolvedValue({ status: "ok" });
    let resolveActivate: (value: { id: string }) => void = () => undefined;
    updateConnectionMock
      .mockImplementationOnce(() => new Promise<{ id: string }>((resolve) => { resolveActivate = resolve; }))
      .mockResolvedValue({ id: "conn-654" });
    archiveConnectionMock
      .mockRejectedValueOnce(new Error("Archive failed."))
      .mockResolvedValue({ id: "conn-654", status: "archived" });

    await render();
    const addBtn = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Add connection"))!;
    await act(() => addBtn.click());
    await flushReact();

    const submitBtn = [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Connect and discover actions"))!;
    await act(() => submitBtn.click());
    await flushReact();

    const cancelBtn = [...document.querySelectorAll("button")].find((b) => b.textContent === "Cancel")!;
    await act(() => cancelBtn.click());
    await flushReact();

    await act(async () => resolveActivate({ id: "conn-654" }));
    await flushReact();

    expect(refreshCatalogMock).not.toHaveBeenCalled();
    expect(archiveConnectionMock).toHaveBeenCalledWith("conn-654");
    expect(updateConnectionMock).toHaveBeenLastCalledWith("conn-654", { status: "draft", enabled: false });
    const toast = pushToastMock.mock.calls.map(([input]) => input).find((input) => input.title === "Could not remove cancelled connection");
    expect(toast).toMatchObject({ tone: "error", action: { label: "Retry removal" } });
    expect(toast.body).toContain("It has been disabled");

    await act(async () => toast.action.onClick());
    await flushReact();
    expect(archiveConnectionMock).toHaveBeenCalledTimes(2);
  });
});
