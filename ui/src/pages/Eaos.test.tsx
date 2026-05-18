// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// React 19 only exports `act` from `react` when the development bundle is
// loaded — i.e. when `process.env.NODE_ENV !== "production"`. Some QA
// environments pin NODE_ENV to "production" before vitest starts, which
// causes `import { act } from "react"` to resolve to `undefined`. Force a
// non-production NODE_ENV *before* any React import is evaluated. This
// uses `vi.hoisted` so it runs ahead of the hoisted ESM imports below.
vi.hoisted(() => {
  if (process.env.NODE_ENV === "production") {
    process.env.NODE_ENV = "test";
  }
});

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { Eaos } from "./Eaos";

const breadcrumbState = vi.hoisted(() => ({ setBreadcrumbs: vi.fn() }));

const sandboxState = vi.hoisted(() => ({
  listProviders: vi.fn(),
  listLeases: vi.fn(),
  getLease: vi.fn(),
}));

const heartbeatsState = vi.hoisted(() => ({
  liveRunsForCompany: vi.fn(),
}));

const workspacesState = vi.hoisted(() => ({
  list: vi.fn(),
}));

const approvalsState = vi.hoisted(() => ({
  list: vi.fn(),
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => breadcrumbState,
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    selectedCompany: { id: "company-1", name: "Paperclip", issuePrefix: "LET", status: "active" },
  }),
}));

vi.mock("@/api/sandbox", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/sandbox")>();
  return {
    ...actual,
    sandboxApi: sandboxState,
  };
});

vi.mock("@/api/heartbeats", () => ({
  heartbeatsApi: heartbeatsState,
}));

vi.mock("@/api/execution-workspaces", () => ({
  executionWorkspacesApi: workspacesState,
}));

vi.mock("@/api/approvals", () => ({
  approvalsApi: approvalsState,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function newQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

describe("EAOS Sandbox & runtime dashboard", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    breadcrumbState.setBreadcrumbs.mockReset();
    sandboxState.listProviders.mockReset();
    sandboxState.listLeases.mockReset();
    sandboxState.getLease.mockReset();
    heartbeatsState.liveRunsForCompany.mockReset();
    workspacesState.list.mockReset();
    approvalsState.list.mockReset();
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
  });

  it("renders read-only / preview / no-live-execution chips on the safety banner", async () => {
    sandboxState.listProviders.mockResolvedValue({
      previewOnly: true,
      generatedAt: "2026-05-17T00:00:00.000Z",
      providers: [{ provider: "docker", kind: "builtin", enabled: false, previewOnly: true }],
    });
    sandboxState.listLeases.mockResolvedValue({
      previewOnly: true,
      generatedAt: "2026-05-17T00:00:00.000Z",
      count: 0,
      leases: [],
    });
    heartbeatsState.liveRunsForCompany.mockResolvedValue([]);
    workspacesState.list.mockResolvedValue([]);
    approvalsState.list.mockResolvedValue([]);

    const root = createRoot(container);
    await act(async () => {
      root.render(
        <MemoryRouter>
          <QueryClientProvider client={newQueryClient()}>
            <Eaos />
          </QueryClientProvider>
        </MemoryRouter>,
      );
    });
    await flush();

    expect(container.textContent).toContain("Sandbox & runtime");
    expect(container.textContent).toContain("Read-only");
    expect(container.textContent).toContain("Preview");
    expect(container.textContent).toContain("No live sandbox execution");
    // LET-352: ADR banner must surface the buy-vs-build link and the
    // "no real container isolation yet" disclaimer.
    expect(container.textContent).toContain(
      "Preview — no real container isolation yet. See ADR LET-328 for the buy-vs-build decision.",
    );
    expect(container.textContent).toContain("Stub — no real container isolation");
    const adrLink = container.querySelector('a[href="/issues/LET-328"]');
    expect(adrLink).not.toBeNull();
    // LET-372: breadcrumbs put Sandbox / Runtime under the EAOS shell crumb.
    expect(breadcrumbState.setBreadcrumbs).toHaveBeenCalledWith([
      { label: "Paperclip", href: "/dashboard" },
      { label: "EAOS", href: "/eaos" },
      { label: "Sandbox / Runtime" },
    ]);

    await act(async () => root.unmount());
  });

  it("renders lease rows with backend-backed source chip and lifecycle label", async () => {
    sandboxState.listProviders.mockResolvedValue({
      previewOnly: true,
      generatedAt: "2026-05-17T00:00:00.000Z",
      providers: [],
    });
    sandboxState.listLeases.mockResolvedValue({
      previewOnly: true,
      generatedAt: "2026-05-17T00:00:00.000Z",
      count: 1,
      leases: [
        {
          id: "lease-aaaaaaaaaaaaaaaa",
          companyId: "company-1",
          environmentId: "env-bbbbbbbbbbbb",
          executionWorkspaceId: null,
          issueId: null,
          heartbeatRunId: "run-cccccccccccc",
          status: "active",
          leasePolicy: "ephemeral",
          provider: "docker",
          providerLeaseId: "p1",
          kind: null,
          sandboxState: "running",
          capabilities: null,
          quotas: null,
          network: { mode: "deny-by-default", egressAllowlist: [], dnsAllowlist: [], allowInboundPorts: [] },
          egressPreview: {
            mode: "deny-by-default",
            allowLoopback: false,
            egressAllowlistCount: 0,
            dnsAllowlistCount: 0,
            allowInboundPortCount: 0,
            truth: "preview",
          },
          policyHash: null,
          artifacts: { present: true, count: 2 },
          truth: "backend-backed",
          providerEnabled: true,
          failureReason: null,
          cleanupStatus: "success",
          acquiredAt: "2026-05-17T00:00:00.000Z",
          lastUsedAt: "2026-05-17T00:00:00.000Z",
          expiresAt: null,
          releasedAt: null,
          createdAt: "2026-05-17T00:00:00.000Z",
          updatedAt: "2026-05-17T00:00:00.000Z",
        },
      ],
    });
    heartbeatsState.liveRunsForCompany.mockResolvedValue([]);
    workspacesState.list.mockResolvedValue([]);
    approvalsState.list.mockResolvedValue([]);

    const root = createRoot(container);
    await act(async () => {
      root.render(
        <MemoryRouter>
          <QueryClientProvider client={newQueryClient()}>
            <Eaos />
          </QueryClientProvider>
        </MemoryRouter>,
      );
    });
    await flush();
    await flush();

    expect(container.textContent).toContain("Running");
    expect(container.textContent).toContain("Backend-backed");
    expect(container.textContent).toContain("Cleanup complete");
    expect(container.textContent).toContain("Sandbox lease artifacts");
    // Provider chip should appear and be preview-only even when flag enabled.
    expect(container.textContent).toContain("docker");
    expect(container.textContent).toContain("Preview");

    await act(async () => root.unmount());
  });

  it("treats backend failure as Partial / Unknown — never green", async () => {
    sandboxState.listProviders.mockRejectedValue(new Error("boom"));
    sandboxState.listLeases.mockRejectedValue(new Error("boom"));
    heartbeatsState.liveRunsForCompany.mockResolvedValue([]);
    workspacesState.list.mockResolvedValue([]);
    approvalsState.list.mockResolvedValue([]);

    const root = createRoot(container);
    await act(async () => {
      root.render(
        <MemoryRouter>
          <QueryClientProvider client={newQueryClient()}>
            <Eaos />
          </QueryClientProvider>
        </MemoryRouter>,
      );
    });
    await flush();
    await flush();

    expect(container.textContent).toContain("Unable to load");
    expect(container.textContent).toContain("Unknown");

    await act(async () => root.unmount());
  });

  it("renders empty-state messaging without faking green when company has no leases or runs", async () => {
    sandboxState.listProviders.mockResolvedValue({ previewOnly: true, generatedAt: "2026-05-17T00:00:00.000Z", providers: [] });
    sandboxState.listLeases.mockResolvedValue({ previewOnly: true, generatedAt: "2026-05-17T00:00:00.000Z", count: 0, leases: [] });
    heartbeatsState.liveRunsForCompany.mockResolvedValue([]);
    workspacesState.list.mockResolvedValue([]);
    approvalsState.list.mockResolvedValue([]);

    const root = createRoot(container);
    await act(async () => {
      root.render(
        <MemoryRouter>
          <QueryClientProvider client={newQueryClient()}>
            <Eaos />
          </QueryClientProvider>
        </MemoryRouter>,
      );
    });
    await flush();
    await flush();

    expect(container.textContent).toContain("No rows. Backend returned an empty list.");
    expect(container.textContent).toContain("No artifacts reported");

    await act(async () => root.unmount());
  });
});
