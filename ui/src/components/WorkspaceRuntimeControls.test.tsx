// @vitest-environment jsdom

import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { WorkspaceRuntimeService } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildWorkspaceRuntimeControlItems,
  buildWorkspaceRuntimeControlSections,
  buildWorkspaceServiceControlEntries,
  resolveWorkspaceServiceControlRequests,
  WorkspaceRuntimeQuickControls,
  WorkspaceRuntimeControls,
} from "./WorkspaceRuntimeControls";
import { queryKeys } from "@/lib/queryKeys";

const mockInstanceSettingsApi = vi.hoisted(() => ({
  getExperimental: vi.fn(),
}));

vi.mock("@/api/instanceSettings", () => ({
  instanceSettingsApi: mockInstanceSettingsApi,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function act(callback: () => void) {
  flushSync(callback);
}

/**
 * The command rows read the managed-sandbox-only policy through the shared
 * instance-settings query, so every render needs a query client. Renders here
 * are synchronous and the guard fails closed until the policy resolves, so the
 * cache is primed by default. Pass `null` to render with the policy unresolved.
 */
function withQueryClient(node: ReactNode, experimentalSettings: Record<string, unknown> | null = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (experimentalSettings) {
    queryClient.setQueryData(queryKeys.instance.experimentalSettings, experimentalSettings);
  }
  return <QueryClientProvider client={queryClient}>{node}</QueryClientProvider>;
}

function createRuntimeService(overrides: Partial<WorkspaceRuntimeService> = {}): WorkspaceRuntimeService {
  return {
    id: overrides.id ?? "service-1",
    companyId: overrides.companyId ?? "company-1",
    projectId: overrides.projectId ?? "project-1",
    projectWorkspaceId: overrides.projectWorkspaceId ?? "workspace-1",
    executionWorkspaceId: overrides.executionWorkspaceId ?? null,
    issueId: overrides.issueId ?? null,
    scopeType: overrides.scopeType ?? "project_workspace",
    scopeId: overrides.scopeId ?? "workspace-1",
    serviceName: overrides.serviceName ?? "web",
    status: overrides.status ?? "stopped",
    lifecycle: overrides.lifecycle ?? "shared",
    reuseKey: overrides.reuseKey ?? null,
    command: overrides.command ?? "pnpm dev",
    cwd: overrides.cwd ?? "/repo",
    port: overrides.port ?? null,
    url: overrides.url ?? null,
    provider: overrides.provider ?? "local_process",
    providerRef: overrides.providerRef ?? null,
    ownerAgentId: overrides.ownerAgentId ?? null,
    startedByRunId: overrides.startedByRunId ?? null,
    lastUsedAt: overrides.lastUsedAt ?? new Date("2026-04-12T00:00:00.000Z"),
    startedAt: overrides.startedAt ?? new Date("2026-04-12T00:00:00.000Z"),
    stoppedAt: overrides.stoppedAt ?? null,
    stopPolicy: overrides.stopPolicy ?? null,
    healthStatus: overrides.healthStatus ?? "unknown",
    exposure: overrides.exposure ?? null,
    configIndex: overrides.configIndex ?? null,
    createdAt: overrides.createdAt ?? new Date("2026-04-12T00:00:00.000Z"),
    updatedAt: overrides.updatedAt ?? new Date("2026-04-12T00:00:00.000Z"),
  };
}

describe("buildWorkspaceRuntimeControlSections", () => {
  it("separates service and job commands while matching running services", () => {
    const sections = buildWorkspaceRuntimeControlSections({
      runtimeConfig: {
        commands: [
          { id: "web", name: "web", kind: "service", command: "pnpm dev" },
          { id: "db-migrate", name: "db:migrate", kind: "job", command: "pnpm db:migrate" },
        ],
      },
      runtimeServices: [
        createRuntimeService({ id: "service-web", serviceName: "web", status: "running" }),
      ],
      canStartServices: true,
      canRunJobs: true,
    });

    expect(sections.services).toHaveLength(1);
    expect(sections.jobs).toHaveLength(1);
    expect(sections.services[0]).toMatchObject({
      title: "web",
      statusLabel: "running",
      workspaceCommandId: "web",
      runtimeServiceId: "service-web",
    });
    expect(sections.jobs[0]).toMatchObject({
      title: "db:migrate",
      statusLabel: "run once",
      workspaceCommandId: "db-migrate",
    });
  });

  it("keeps stopped stale runtime services from masking updated inherited commands", () => {
    const sections = buildWorkspaceRuntimeControlSections({
      runtimeConfig: {
        commands: [
          { id: "web", name: "web", kind: "service", command: "pnpm dev:once --tailscale-auth" },
        ],
      },
      runtimeServices: [
        createRuntimeService({
          id: "service-web",
          serviceName: "web",
          status: "stopped",
          command: "pnpm dev",
        }),
      ],
      canStartServices: true,
      canRunJobs: true,
    });

    expect(sections.services).toEqual([
      expect.objectContaining({
        title: "web",
        statusLabel: "stopped",
        command: "pnpm dev:once --tailscale-auth",
        runtimeServiceId: null,
      }),
    ]);
    expect(sections.otherServices).toEqual([]);
  });

  it("surfaces running stale runtime services separately from updated commands", () => {
    const sections = buildWorkspaceRuntimeControlSections({
      runtimeConfig: {
        commands: [
          { id: "web", name: "web", kind: "service", command: "pnpm dev:once --tailscale-auth" },
        ],
      },
      runtimeServices: [
        createRuntimeService({
          id: "service-web",
          serviceName: "web",
          status: "running",
          command: "pnpm dev",
        }),
      ],
      canStartServices: true,
      canRunJobs: true,
    });

    expect(sections.services).toEqual([
      expect.objectContaining({
        title: "web",
        statusLabel: "stopped",
        command: "pnpm dev:once --tailscale-auth",
        runtimeServiceId: null,
      }),
    ]);
    expect(sections.otherServices).toEqual([
      expect.objectContaining({
        title: "web",
        statusLabel: "running",
        command: "pnpm dev",
        runtimeServiceId: "service-web",
        disabledReason: "This runtime service no longer matches a configured workspace command.",
      }),
    ]);
  });

  it("surfaces running stale runtime services separately from updated commands", () => {
    const sections = buildWorkspaceRuntimeControlSections({
      runtimeConfig: {
        commands: [
          { id: "web", name: "web", kind: "service", command: "pnpm dev:once --tailscale-auth" },
        ],
      },
      runtimeServices: [
        createRuntimeService({
          id: "service-web",
          serviceName: "web",
          status: "running",
          command: "pnpm dev",
        }),
      ],
      canStartServices: true,
      canRunJobs: true,
    });

    expect(sections.services).toEqual([
      expect.objectContaining({
        title: "web",
        statusLabel: "stopped",
        command: "pnpm dev:once --tailscale-auth",
        runtimeServiceId: null,
      }),
    ]);
    expect(sections.otherServices).toEqual([
      expect.objectContaining({
        title: "web",
        statusLabel: "running",
        command: "pnpm dev",
        runtimeServiceId: "service-web",
        disabledReason: "This runtime service no longer matches a configured workspace command.",
      }),
    ]);
  });

  it("surfaces running stale runtime services separately from updated commands", () => {
    const sections = buildWorkspaceRuntimeControlSections({
      runtimeConfig: {
        commands: [
          { id: "web", name: "web", kind: "service", command: "pnpm dev:once --tailscale-auth" },
        ],
      },
      runtimeServices: [
        createRuntimeService({
          id: "service-web",
          serviceName: "web",
          status: "running",
          command: "pnpm dev",
        }),
      ],
      canStartServices: true,
      canRunJobs: true,
    });

    expect(sections.services).toEqual([
      expect.objectContaining({
        title: "web",
        statusLabel: "stopped",
        command: "pnpm dev:once --tailscale-auth",
        runtimeServiceId: null,
      }),
    ]);
    expect(sections.otherServices).toEqual([
      expect.objectContaining({
        title: "web",
        statusLabel: "running",
        command: "pnpm dev",
        runtimeServiceId: "service-web",
        disabledReason: "This runtime service no longer matches a configured workspace command.",
      }),
    ]);
  });
});

describe("buildWorkspaceRuntimeControlItems", () => {
  it("keeps the legacy flat export shape for stale importers", () => {
    const items = buildWorkspaceRuntimeControlItems({
      runtimeConfig: {
        commands: [
          { id: "web", name: "web", kind: "service", command: "pnpm dev" },
          { id: "db-migrate", name: "db:migrate", kind: "job", command: "pnpm db:migrate" },
        ],
      },
      runtimeServices: [
        createRuntimeService({ id: "service-web", serviceName: "web", status: "running" }),
      ],
      canStartServices: true,
      canRunJobs: true,
    });

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      title: "web",
      status: "running",
      statusLabel: "running",
      runtimeServiceId: "service-web",
    });
  });
});

describe("WorkspaceRuntimeControls", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({});
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("shows the service working directory when the managed-sandbox-only policy is off", () => {
    const sections = buildWorkspaceRuntimeControlSections({
      runtimeConfig: {
        commands: [{ id: "web", name: "web", kind: "service", command: "pnpm dev", cwd: "." }],
      },
      runtimeServices: [
        createRuntimeService({ id: "service-web", serviceName: "web", status: "running", cwd: "/srv/repo" }),
      ],
      canStartServices: true,
    });

    const root = createRoot(container);
    act(() => {
      root.render(withQueryClient(
        <WorkspaceRuntimeControls sections={sections} onAction={vi.fn()} />,
        {},
      ));
    });

    expect(container.textContent).toContain("/srv/repo");
    expect(container.textContent).toContain("pnpm dev");

    act(() => root.unmount());
  });

  it("keeps the service working directory hidden while the policy is still loading", () => {
    // A cold cache resolves the policy to false on the first render. The guard
    // fails closed so a managed instance never flashes the execution-host path.
    const sections = buildWorkspaceRuntimeControlSections({
      runtimeConfig: {
        commands: [{ id: "web", name: "web", kind: "service", command: "pnpm dev", cwd: "." }],
      },
      runtimeServices: [
        createRuntimeService({ id: "service-web", serviceName: "web", status: "running", cwd: "/srv/repo" }),
      ],
      canStartServices: true,
    });

    const root = createRoot(container);
    act(() => {
      root.render(withQueryClient(
        <WorkspaceRuntimeControls sections={sections} onAction={vi.fn()} />,
        null,
      ));
    });

    expect(container.textContent).not.toContain("/srv/repo");
    expect(container.textContent).toContain("pnpm dev");

    act(() => root.unmount());
  });

  it("drops the service working directory when the managed-sandbox-only policy is on", () => {
    const sections = buildWorkspaceRuntimeControlSections({
      runtimeConfig: {
        commands: [{ id: "web", name: "web", kind: "service", command: "pnpm dev", cwd: "." }],
      },
      runtimeServices: [
        createRuntimeService({
          id: "service-web",
          serviceName: "web",
          status: "running",
          cwd: "/srv/repo",
          url: "http://127.0.0.1:5173",
          port: 5173,
        }),
      ],
      canStartServices: true,
    });

    const root = createRoot(container);
    act(() => {
      root.render(withQueryClient(
        <WorkspaceRuntimeControls sections={sections} onAction={vi.fn()} />,
        { enableManagedSandboxOnly: true },
      ));
    });

    expect(container.textContent).not.toContain("/srv/repo");
    // The URL, the port, and the command describe the service, not the host.
    expect(container.textContent).toContain("http://127.0.0.1:5173");
    expect(container.textContent).toContain("Port 5173");
    expect(container.textContent).toContain("pnpm dev");

    act(() => root.unmount());
  });

  it("renders service and job actions distinctly", () => {
    const sections = buildWorkspaceRuntimeControlSections({
      runtimeConfig: {
        commands: [
          { id: "web", name: "web", kind: "service", command: "pnpm dev" },
          { id: "db-migrate", name: "db:migrate", kind: "job", command: "pnpm db:migrate" },
        ],
      },
      runtimeServices: [
        createRuntimeService({ id: "service-web", serviceName: "web", status: "running" }),
      ],
      canStartServices: true,
      canRunJobs: true,
    });

    const root = createRoot(container);
    act(() => {
      root.render(withQueryClient(
        <WorkspaceRuntimeControls
          sections={sections}
          onAction={vi.fn()}
        />,
      ));
    });

    const buttons = Array.from(container.querySelectorAll("button")).map((button) => button.textContent?.trim());
    expect(buttons).toEqual(["Stop", "Restart", "Run"]);
    expect(container.textContent).toContain("Services");
    expect(container.textContent).toContain("Jobs");

    act(() => root.unmount());
  });

  it("lets quick action buttons inherit the shared button shape tokens", () => {
    const sections = buildWorkspaceRuntimeControlSections({
      runtimeConfig: {
        commands: [
          { id: "web", name: "web", kind: "service", command: "pnpm dev" },
        ],
      },
      runtimeServices: [
        createRuntimeService({ id: "service-web", serviceName: "web", status: "running" }),
      ],
      canStartServices: true,
    });

    const root = createRoot(container);
    act(() => {
      root.render(withQueryClient(
        <WorkspaceRuntimeQuickControls
          sections={sections}
          onAction={vi.fn()}
        />,
      ));
    });

    const buttons = Array.from(container.querySelectorAll("button"));
    expect(buttons).toHaveLength(2);
    for (const button of buttons) {
      expect(button.className).toContain("rounded-md");
      expect(button.className).not.toContain("rounded-none");
      expect(button.className).not.toContain("rounded-xl");
      expect(button.className).not.toContain("shadow-none");
    }

    act(() => root.unmount());
  });

  it("shows disabled actions when local command prerequisites are missing", () => {
    const sections = buildWorkspaceRuntimeControlSections({
      runtimeConfig: {
        commands: [
          { id: "web", name: "web", kind: "service", command: "pnpm dev" },
          { id: "db-migrate", name: "db:migrate", kind: "job", command: "pnpm db:migrate" },
        ],
      },
      runtimeServices: [],
      canStartServices: false,
      canRunJobs: false,
    });

    const root = createRoot(container);
    act(() => {
      root.render(withQueryClient(
        <WorkspaceRuntimeControls
          sections={sections}
          disabledHint="Add a workspace path first."
          onAction={vi.fn()}
        />,
      ));
    });

    const buttons = Array.from(container.querySelectorAll("button"));
    expect(buttons.every((button) => button.hasAttribute("disabled"))).toBe(true);
    expect(container.textContent).toContain("Add a workspace path first.");

    act(() => root.unmount());
  });

  it("hides the disabled hint once services can already run", () => {
    const sections = buildWorkspaceRuntimeControlSections({
      runtimeConfig: {
        commands: [
          { id: "web", name: "web", kind: "service", command: "pnpm dev" },
        ],
      },
      runtimeServices: [
        createRuntimeService({ id: "service-web", serviceName: "web", status: "running" }),
      ],
      canStartServices: true,
    });

    const root = createRoot(container);
    act(() => {
      root.render(withQueryClient(
        <WorkspaceRuntimeControls
          sections={sections}
          disabledHint="Add runtime settings first."
          onAction={vi.fn()}
        />,
      ));
    });

    expect(container.textContent).not.toContain("Add runtime settings first.");

    act(() => root.unmount());
  });

  it("hides the health badge for stopped services", () => {
    const sections = buildWorkspaceRuntimeControlSections({
      runtimeConfig: {
        commands: [
          { id: "web", name: "web", kind: "service", command: "pnpm dev" },
        ],
      },
      runtimeServices: [
        createRuntimeService({ id: "service-web", serviceName: "web", status: "stopped", healthStatus: "unknown" }),
      ],
      canStartServices: true,
    });

    const root = createRoot(container);
    act(() => {
      root.render(withQueryClient(
        <WorkspaceRuntimeControls
          sections={sections}
          onAction={vi.fn()}
        />,
      ));
    });

    expect(container.textContent).not.toContain("unknown");

    act(() => root.unmount());
  });

  it.each([
    ["failed", "external HTTPS health probe did not validate", "HTTPS unavailable", "Check the Tailscale broker and node HTTPS configuration."],
    ["cleanup_pending", "host broker cleanup confirmation timed out", "HTTPS cleanup pending", "Restart the host broker before reusing this port."],
  ] as const)(
    "shows %s exposure state, last error, and remediation on service cards",
    (state, lastError, label, remediation) => {
      const sections = buildWorkspaceRuntimeControlSections({
        runtimeConfig: {
          commands: [
            { id: "web", name: "web", kind: "service", command: "pnpm dev" },
          ],
        },
        runtimeServices: [
          createRuntimeService({
            id: "service-web",
            serviceName: "web",
            status: "stopped",
            exposure: {
              provider: "tailscale_https",
              state,
              publicUrl: null,
              hostname: "paperclip-dev.tail29c1aa.ts.net",
              listeners: [{ purpose: "app", publicPort: 42002, targetPort: 42002 }],
              brokerRef: "service-web",
              lastError,
              updatedAt: "2026-08-12T00:00:00.000Z",
            },
          }),
        ],
        canStartServices: true,
      });

      const root = createRoot(container);
      act(() => {
        root.render(withQueryClient(
          <WorkspaceRuntimeControls
            sections={sections}
            onAction={vi.fn()}
          />,
        ));
      });

      const alert = container.querySelector('[role="alert"]');
      const summary = alert?.firstElementChild;
      expect(alert?.classList.contains("text-destructive")).toBe(true);
      expect(summary?.classList.contains("line-clamp-3")).toBe(true);
      expect(summary?.getAttribute("title")).toBe(lastError);
      expect(alert?.textContent).toContain(label);
      expect(alert?.textContent).toContain(lastError);
      expect(alert?.textContent).toContain(remediation);

      act(() => root.unmount());
    },
  );

  it("can render square plain surfaces for embedded configuration pages", () => {
    const sections = buildWorkspaceRuntimeControlSections({
      runtimeConfig: {
        commands: [
          { id: "web", name: "web", kind: "service", command: "pnpm dev" },
        ],
      },
      runtimeServices: [],
      canStartServices: true,
    });

    const root = createRoot(container);
    act(() => {
      root.render(withQueryClient(
        <WorkspaceRuntimeControls
          sections={sections}
          square
          onAction={vi.fn()}
        />,
      ));
    });

    const summaryPanel = container.querySelector(".border.border-border\\/70");
    const servicePanel = Array.from(container.querySelectorAll(".border.border-border\\/80"))
      .find((element) => element.textContent?.includes("web"));
    const startButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.trim() === "Start");

    expect(summaryPanel?.className).toContain("rounded-none");
    expect(summaryPanel?.className).not.toContain("bg-background/60");
    expect(servicePanel?.className).toContain("rounded-none");
    expect(startButton?.className).toContain("rounded-none");

    act(() => root.unmount());
  });

  it("accepts the legacy items prop without crashing", () => {
    const items = buildWorkspaceRuntimeControlItems({
      runtimeConfig: {
        commands: [
          { id: "web", name: "web", kind: "service", command: "pnpm dev" },
        ],
      },
      runtimeServices: [],
      canStartServices: false,
    });

    const root = createRoot(container);
    act(() => {
      root.render(withQueryClient(
        <WorkspaceRuntimeControls
          items={items}
          emptyMessage="No runtime services have been started yet."
          disabledHint="Add runtime settings first."
          onAction={vi.fn()}
        />,
      ));
    });

    expect(container.textContent).toContain("Services");
    expect(container.textContent).toContain("Add runtime settings first.");
    expect(Array.from(container.querySelectorAll("button")).map((button) => button.textContent?.trim())).toEqual(["Start"]);

    act(() => root.unmount());
  });
});

describe("buildWorkspaceServiceControlEntries", () => {
  const sections = () => buildWorkspaceRuntimeControlSections({
    runtimeConfig: {
      commands: [
        { id: "web", name: "web", kind: "service", command: "pnpm dev" },
        { id: "db-migrate", name: "db:migrate", kind: "job", command: "pnpm db:migrate" },
      ],
    },
    runtimeServices: [
      createRuntimeService({
        id: "service-web",
        serviceName: "web",
        status: "running",
        url: "http://localhost:3100",
        port: 3100,
        healthStatus: "healthy",
      }),
    ],
    canStartServices: true,
    canRunJobs: true,
  });

  it("maps service items to control bar entries and excludes jobs", () => {
    const entries = buildWorkspaceServiceControlEntries({ sections: sections() });

    expect(entries).toEqual([
      expect.objectContaining({
        name: "web",
        state: "running",
        url: "http://localhost:3100",
        port: 3100,
        healthStatus: "healthy",
        failureDetail: null,
      }),
    ]);
  });

  it("overlays transitional states from the pending mutation", () => {
    const built = sections();
    const entries = buildWorkspaceServiceControlEntries({
      sections: built,
      isPending: true,
      pendingRequest: {
        action: "stop",
        workspaceCommandId: built.services[0].workspaceCommandId ?? null,
        runtimeServiceId: built.services[0].runtimeServiceId ?? null,
        serviceIndex: built.services[0].serviceIndex ?? null,
      },
    });

    expect(entries[0].state).toBe("stopping");
  });

  it("overlays every service targeted by a bulk mutation", () => {
    const built = buildWorkspaceRuntimeControlSections({
      runtimeConfig: {
        commands: [
          { id: "web", name: "web", kind: "service", command: "pnpm dev" },
          { id: "api", name: "api", kind: "service", command: "pnpm api" },
        ],
      },
      runtimeServices: [
        createRuntimeService({ id: "service-web", serviceName: "web", status: "running" }),
        createRuntimeService({
          id: "service-api",
          serviceName: "api",
          status: "running",
          command: "pnpm api",
        }),
      ],
      canStartServices: true,
    });
    const pendingRequests = resolveWorkspaceServiceControlRequests(built, "stop", null);

    const entries = buildWorkspaceServiceControlEntries({ sections: built, pendingRequests });

    expect(entries.map((entry) => entry.state)).toEqual(["stopping", "stopping"]);
  });

  it("maps a provisioning runtime service to the provisioning control state", () => {
    const provisioning = createRuntimeService({
      id: "service-web",
      serviceName: "web",
      status: "provisioning",
    });
    const built = buildWorkspaceRuntimeControlSections({
      runtimeConfig: { commands: [{ id: "web", name: "web", kind: "service", command: "pnpm dev" }] },
      runtimeServices: [provisioning],
      canStartServices: true,
    });

    expect(built.services[0]).toMatchObject({ statusLabel: "provisioning", runtimeServiceId: "service-web" });

    const entries = buildWorkspaceServiceControlEntries({ sections: built, runtimeServices: [provisioning] });
    expect(entries[0].state).toBe("provisioning");
  });

  it("surfaces a provisioning stale runtime service in otherServices", () => {
    const provisioning = createRuntimeService({
      id: "service-web",
      serviceName: "web",
      status: "provisioning",
      command: "pnpm dev",
    });
    const built = buildWorkspaceRuntimeControlSections({
      runtimeConfig: {
        commands: [{ id: "web", name: "web", kind: "service", command: "pnpm dev:once --tailscale-auth" }],
      },
      runtimeServices: [provisioning],
      canStartServices: true,
    });

    expect(built.otherServices).toEqual([
      expect.objectContaining({ title: "web", statusLabel: "provisioning", runtimeServiceId: "service-web" }),
    ]);
  });

  it("builds a failure detail line from the stopped runtime service", () => {
    const failed = createRuntimeService({
      id: "service-web",
      serviceName: "web",
      status: "failed",
      stoppedAt: new Date(Date.now() - 60_000),
    });
    const built = buildWorkspaceRuntimeControlSections({
      runtimeConfig: { commands: [{ id: "web", name: "web", kind: "service", command: "pnpm dev" }] },
      runtimeServices: [failed],
      canStartServices: true,
    });
    const entries = buildWorkspaceServiceControlEntries({
      sections: built,
      runtimeServices: [failed],
    });

    expect(entries[0].state).toBe("failed");
    expect(entries[0].failureDetail).toMatch(/^Service failed · /);
  });

  it("surfaces HTTPS failure independently while the backend remains running", () => {
    const running = createRuntimeService({
      status: "running",
      healthStatus: "healthy",
      port: 42000,
      url: null,
      exposure: {
        provider: "tailscale_https",
        state: "failed",
        publicUrl: null,
        hostname: "runner.tail123.ts.net",
        listeners: [{ purpose: "app", publicPort: 42000, targetPort: 42000 }],
        brokerRef: "service-1",
        lastError: "cli_error",
        updatedAt: "2026-08-11T00:00:00.000Z",
      },
    });
    const built = buildWorkspaceRuntimeControlSections({
      runtimeConfig: { commands: [{ id: "web", name: "web", kind: "service", command: "pnpm dev" }] },
      runtimeServices: [running],
      canStartServices: true,
    });
    const [entry] = buildWorkspaceServiceControlEntries({ sections: built, runtimeServices: [running] });

    expect(entry.state).toBe("running");
    expect(entry.exposureState).toBe("failed");
    expect(entry.exposureDetail).toMatch(/^HTTPS unavailable/);
    expect(entry.exposureDetail).not.toContain("cli_error");
  });

  it("carries the verified HTTPS URL into the launch entry, and no HTTP fallback while pending", () => {
    // PAP-17158: the workspace/project/issue launch links are rendered from these
    // entries, so the tailnet HTTPS URL has to survive the mapping intact — and a
    // service whose exposure is not yet verified must offer no URL at all rather
    // than the loopback backend it is really listening on.
    const httpsUrl = "https://paperclip-dev.tail29c1aa.ts.net:42010";
    const buildEntry = (service: ReturnType<typeof createRuntimeService>) => {
      const sections = buildWorkspaceRuntimeControlSections({
        runtimeConfig: { commands: [{ id: "web", name: "web", kind: "service", command: "pnpm dev" }] },
        runtimeServices: [service],
        canStartServices: true,
      });
      return buildWorkspaceServiceControlEntries({ sections, runtimeServices: [service] })[0];
    };

    const ready = buildEntry(createRuntimeService({
      status: "running",
      healthStatus: "healthy",
      port: 42_010,
      url: httpsUrl,
      exposure: {
        provider: "tailscale_https",
        state: "ready",
        publicUrl: httpsUrl,
        hostname: "paperclip-dev.tail29c1aa.ts.net",
        listeners: [
          { purpose: "app", publicPort: 42_010, targetPort: 42_010 },
          { purpose: "vite_hmr", publicPort: 52_010, targetPort: 52_010 },
        ],
        brokerRef: "service-1",
        lastError: null,
        updatedAt: "2026-08-12T00:00:00.000Z",
      },
    }));
    expect(ready.state).toBe("running");
    expect(ready.url).toBe(httpsUrl);
    expect(ready.exposureState).toBe("ready");
    // A ready exposure reports plainly and never as a remediation prompt.
    expect(ready.exposureDetail).toBe("HTTPS ready");
    expect(ready.exposureDetail).not.toMatch(/unavailable|cleanup|Check the/i);

    const pending = buildEntry(createRuntimeService({
      status: "running",
      healthStatus: "healthy",
      port: 42_020,
      url: null,
      exposure: {
        provider: "tailscale_https",
        state: "pending",
        publicUrl: null,
        hostname: "paperclip-dev.tail29c1aa.ts.net",
        listeners: [],
        brokerRef: null,
        lastError: null,
        updatedAt: "2026-08-12T00:00:00.000Z",
      },
    }));
    expect(pending.url ?? null).toBeNull();
    expect(pending.exposureDetail).toBe("Provisioning HTTPS…");
    expect(JSON.stringify(pending)).not.toContain("http://");
  });
});

describe("resolveWorkspaceServiceControlRequests", () => {
  const mixedSections = () => buildWorkspaceRuntimeControlSections({
    runtimeConfig: {
      commands: [
        { id: "web", name: "web", kind: "service", command: "pnpm dev" },
        { id: "api", name: "api", kind: "service", command: "pnpm api" },
      ],
    },
    runtimeServices: [
      createRuntimeService({ id: "service-web", serviceName: "web", status: "running" }),
    ],
    canStartServices: true,
  });

  it("targets a single service by key", () => {
    const built = mixedSections();
    const requests = resolveWorkspaceServiceControlRequests(built, "stop", built.services[0].key);

    expect(requests).toEqual([
      expect.objectContaining({ action: "stop", workspaceCommandId: "web", runtimeServiceId: "service-web" }),
    ]);
  });

  it("stops only active services for the aggregate stop", () => {
    const requests = resolveWorkspaceServiceControlRequests(mixedSections(), "stop", null);

    expect(requests).toEqual([expect.objectContaining({ action: "stop", workspaceCommandId: "web" })]);
  });

  it("starts only inactive services for the aggregate start", () => {
    const requests = resolveWorkspaceServiceControlRequests(mixedSections(), "start", null);

    expect(requests).toEqual([expect.objectContaining({ action: "start", workspaceCommandId: "api" })]);
  });

  it("restarts active services and starts stopped ones for the aggregate restart", () => {
    const requests = resolveWorkspaceServiceControlRequests(mixedSections(), "restart", null);

    expect(requests).toEqual([
      expect.objectContaining({ action: "restart", workspaceCommandId: "web" }),
      expect.objectContaining({ action: "start", workspaceCommandId: "api" }),
    ]);
  });
});
