// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import type { WorkspaceRuntimeService } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildWorkspaceRuntimeControlItems,
  buildWorkspaceRuntimeControlSections,
  WorkspaceRuntimeQuickControls,
  WorkspaceRuntimeControls,
} from "./WorkspaceRuntimeControls";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

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
  });

  afterEach(() => {
    document.body.innerHTML = "";
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
      root.render(
        <WorkspaceRuntimeControls
          sections={sections}
          onAction={vi.fn()}
        />,
      );
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
      root.render(
        <WorkspaceRuntimeQuickControls
          sections={sections}
          onAction={vi.fn()}
        />,
      );
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
      root.render(
        <WorkspaceRuntimeControls
          sections={sections}
          disabledHint="Add a workspace path first."
          onAction={vi.fn()}
        />,
      );
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
      root.render(
        <WorkspaceRuntimeControls
          sections={sections}
          disabledHint="Add runtime settings first."
          onAction={vi.fn()}
        />,
      );
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
      root.render(
        <WorkspaceRuntimeControls
          sections={sections}
          onAction={vi.fn()}
        />,
      );
    });

    expect(container.textContent).not.toContain("unknown");

    act(() => root.unmount());
  });

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
      root.render(
        <WorkspaceRuntimeControls
          sections={sections}
          square
          onAction={vi.fn()}
        />,
      );
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
      root.render(
        <WorkspaceRuntimeControls
          items={items}
          emptyMessage="No runtime services have been started yet."
          disabledHint="Add runtime settings first."
          onAction={vi.fn()}
        />,
      );
    });

    expect(container.textContent).toContain("Services");
    expect(container.textContent).toContain("Add runtime settings first.");
    expect(Array.from(container.querySelectorAll("button")).map((button) => button.textContent?.trim())).toEqual(["Start"]);

    act(() => root.unmount());
  });
});
