// @vitest-environment jsdom

import { flushSync } from "react-dom";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { RuntimeTab } from "./RuntimeTab";

const listRuntimeSlotsMock = vi.hoisted(() => vi.fn());
const getRuntimeHealthMock = vi.hoisted(() => vi.fn());
const listConnectionsMock = vi.hoisted(() => vi.fn());
const stopRuntimeSlotMock = vi.hoisted(() => vi.fn());
const restartRuntimeSlotMock = vi.hoisted(() => vi.fn());

vi.mock("@/api/tools", () => ({
  toolsApi: {
    listRuntimeSlots: (companyId: string) => listRuntimeSlotsMock(companyId),
    getRuntimeHealth: (companyId: string) => getRuntimeHealthMock(companyId),
    listConnections: (companyId: string) => listConnectionsMock(companyId),
    stopRuntimeSlot: (companyId: string, slotId: string) => stopRuntimeSlotMock(companyId, slotId),
    restartRuntimeSlot: (companyId: string, slotId: string) => restartRuntimeSlotMock(companyId, slotId),
  },
}));

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
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
  for (let i = 0; i < 3; i += 1) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  }
}

function slot(overrides: Record<string, unknown> = {}) {
  return {
    id: "slot-1",
    companyId: "company-1",
    applicationId: "app-1",
    connectionId: "conn-1",
    projectWorkspaceId: null,
    executionWorkspaceId: null,
    issueId: null,
    ownerScopeType: "company",
    ownerScopeId: null,
    runtimeKind: "local_stdio",
    slotKey: "gmail-stdio-local",
    status: "running",
    reuseKey: null,
    workspaceScope: null,
    credentialScopeHash: null,
    provider: null,
    providerRef: null,
    processId: 41832,
    commandTemplateKey: "gmail",
    healthStatus: "healthy",
    lastHealthCheckAt: null,
    idleExpiresAt: null,
    startedAt: new Date("2026-06-13T10:00:00Z"),
    stoppedAt: null,
    lastUsedAt: new Date("2026-06-13T12:55:00Z"),
    lastError: null,
    metadata: null,
    createdAt: new Date("2026-06-13T10:00:00Z"),
    updatedAt: new Date("2026-06-13T10:00:00Z"),
    ...overrides,
  };
}

function connection(overrides: Record<string, unknown> = {}) {
  return {
    id: "conn-1",
    companyId: "company-1",
    applicationId: "app-1",
    name: "Gmail",
    connectionKind: "managed",
    transport: "local_stdio",
    status: "active",
    transportConfig: {},
    credentialSecretRefs: [],
    healthStatus: "healthy",
    healthCheckedAt: null,
    lastError: null,
    enabled: true,
    createdByAgentId: null,
    createdByUserId: null,
    createdAt: new Date("2026-06-13T10:00:00Z"),
    updatedAt: new Date("2026-06-13T10:00:00Z"),
    ...overrides,
  };
}

function alert(overrides: Record<string, unknown> = {}) {
  return {
    name: "mcp_runtime_connection_health_degraded",
    severity: "critical",
    status: "ok",
    threshold: "Any degraded connection.",
    observed: "1 degraded connection(s), 0 disabled connection(s).",
    description: "A configured MCP connection is not healthy or has been disabled.",
    firstResponderAction: "Run a connection health check.",
    runbookSection: "runbook#health",
    ...overrides,
  };
}

function health(overrides: Record<string, unknown> = {}) {
  return {
    status: "ok",
    generatedAt: new Date("2026-06-13T13:00:00Z"),
    runbookPath: "docs/runbook.md",
    metrics: {
      averageToolLatencyMsLastHour: 1200,
      p95ToolLatencyMsLastHour: 2400,
      timeoutRateLastHour: 0,
      toolFailuresLastHour: 0,
      toolTimeoutsLastHour: 0,
      capacityDeferralsLastHour: 0,
      activeSlots: 1,
      runningSlots: 1,
    },
    supportMatrix: {},
    alerts: [],
    recommendations: [],
    ...overrides,
  };
}

describe("RuntimeTab", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    listRuntimeSlotsMock.mockResolvedValue({ runtimeSlots: [slot()] });
    getRuntimeHealthMock.mockResolvedValue(health());
    listConnectionsMock.mockResolvedValue({ connections: [connection()] });
    stopRuntimeSlotMock.mockResolvedValue(slot({ status: "stopped" }));
    restartRuntimeSlotMock.mockResolvedValue(slot());
  });

  afterEach(() => {
    flushSync(() => root?.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  async function render() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <TooltipProvider>
            <RuntimeTab companyId="company-1" />
          </TooltipProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();
  }

  it("shows the plain-words summary strip and a Working row linked to the app page", async () => {
    await render();

    expect(container.textContent).toContain("Apps running");
    expect(container.textContent).toContain("1 of 1");
    expect(container.textContent).toContain("about 1.2s");
    expect(container.textContent).toContain("Working");

    const appLink = container.querySelector<HTMLAnchorElement>('a[href="/apps/conn-1"]');
    expect(appLink?.textContent).toContain("Gmail");
    // No ops vocabulary on the primary surface.
    expect(container.textContent).not.toContain("P95 latency");
    expect(container.textContent).not.toContain("local_stdio");
  });

  it("renders a plain needs-attention card for a firing alert and marks the row", async () => {
    getRuntimeHealthMock.mockResolvedValue(
      health({ status: "degraded", alerts: [alert({ status: "firing" })] }),
    );
    listConnectionsMock.mockResolvedValue({ connections: [connection({ healthStatus: "degraded" })] });

    await render();

    // Plain title, not the raw alert name / runbook on the surface.
    expect(container.textContent).toContain("An app needs reconnecting");
    expect(container.textContent).toContain("Needs attention");
    expect(container.textContent).not.toContain("mcp_runtime_connection_health_degraded");
  });

  it("opens a confirm dialog before restarting and only mutates after confirm", async () => {
    await render();

    const restartButton = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.trim() === "Restart",
    );
    expect(restartButton).toBeTruthy();

    await act(async () => {
      restartButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    // Confirm modal copy is present; nothing has been restarted yet.
    expect(document.body.textContent).toContain("Restart Gmail?");
    expect(restartRuntimeSlotMock).not.toHaveBeenCalled();

    const confirmButton = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Restart" && b.closest('[data-slot="dialog-content"]'),
    );
    await act(async () => {
      confirmButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(restartRuntimeSlotMock).toHaveBeenCalledWith("company-1", "slot-1");
  });
});
