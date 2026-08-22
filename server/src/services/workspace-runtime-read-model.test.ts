import { randomUUID } from "node:crypto";
import { workspaceRuntimeServices } from "@paperclipai/db";
import { describe, expect, it } from "vitest";
import { selectConfiguredRuntimeServiceRows } from "./workspace-runtime-read-model.js";

type WorkspaceRuntimeServiceRow = typeof workspaceRuntimeServices.$inferSelect;

function runtimeServiceRow(
  overrides: Partial<WorkspaceRuntimeServiceRow> = {},
): WorkspaceRuntimeServiceRow {
  const now = new Date("2026-07-31T10:00:00.000Z");
  return {
    id: randomUUID(),
    companyId: randomUUID(),
    projectId: randomUUID(),
    projectWorkspaceId: randomUUID(),
    executionWorkspaceId: null,
    issueId: null,
    scopeType: "project_workspace",
    scopeId: null,
    serviceName: "web",
    status: "stopped",
    lifecycle: "shared",
    reuseKey: randomUUID(),
    command: "pnpm dev",
    cwd: "/tmp/paperclip",
    port: null,
    url: null,
    provider: "local_process",
    providerRef: null,
    ownerAgentId: null,
    startedByRunId: null,
    lastUsedAt: now,
    startedAt: now,
    stoppedAt: now,
    stopPolicy: null,
    healthStatus: "unknown",
    exposure: null,
    exposureHandle: null,
    backendUrl: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("selectConfiguredRuntimeServiceRows", () => {
  it("excludes stopped project-workspace history when no services remain configured", () => {
    const historicalRows = Array.from({ length: 163 }, (_, index) =>
      runtimeServiceRow({
        serviceName: `historical-service-${index + 1}`,
        command: `pnpm historical:${index + 1}`,
      }),
    );

    expect(selectConfiguredRuntimeServiceRows(historicalRows, null)).toEqual([]);
  });

  it("selects the newest current row for each configured service and annotates its config index", () => {
    const oldWeb = runtimeServiceRow({
      serviceName: "web",
      command: "pnpm dev",
      updatedAt: new Date("2026-07-29T10:00:00.000Z"),
    });
    const currentWeb = runtimeServiceRow({
      serviceName: "web",
      command: "pnpm dev",
      updatedAt: new Date("2026-07-30T10:00:00.000Z"),
    });
    const removedWorker = runtimeServiceRow({
      serviceName: "worker",
      command: "pnpm worker",
      updatedAt: new Date("2026-07-31T10:00:00.000Z"),
    });

    const selected = selectConfiguredRuntimeServiceRows(
      [removedWorker, currentWeb, oldWeb],
      { services: [{ name: "web", command: "pnpm dev" }] },
    );

    expect(selected).toEqual([
      expect.objectContaining({
        id: currentWeb.id,
        serviceName: "web",
        configIndex: 0,
      }),
    ]);
  });

  it("keeps an exposed dev runtime tracked after its bind command is hardened", () => {
    const exposedWeb = runtimeServiceRow({
      serviceName: "paperclip-dev",
      command: "pnpm dev --bind loopback",
      exposure: {
        provider: "tailscale_https",
        state: "ready",
        publicUrl: "https://paperclip-dev.example.ts.net:42012",
        hostname: "paperclip-dev.example.ts.net",
        listeners: [],
        brokerRef: "broker-1",
        lastError: null,
        updatedAt: "2026-08-20T00:00:00.000Z",
      },
    });

    const selected = selectConfiguredRuntimeServiceRows(
      [exposedWeb],
      { services: [{ name: "paperclip-dev", command: "pnpm dev --bind lan" }] },
    );

    expect(selected).toEqual([
      expect.objectContaining({ id: exposedWeb.id, configIndex: 0 }),
    ]);
  });

  it("matches configured services only to rows with the configured reuse scope", () => {
    const staleProjectScopedWorker = runtimeServiceRow({
      serviceName: "worker",
      command: "pnpm worker",
    });
    const executionScopedWorker = runtimeServiceRow({
      executionWorkspaceId: randomUUID(),
      scopeType: "execution_workspace",
      scopeId: randomUUID(),
      serviceName: "worker",
      command: "pnpm worker",
    });

    const selected = selectConfiguredRuntimeServiceRows(
      [staleProjectScopedWorker, executionScopedWorker],
      {
        services: [
          {
            name: "worker",
            command: "pnpm worker",
            reuseScope: "execution_workspace",
          },
        ],
      },
    );

    expect(selected).toEqual([
      expect.objectContaining({
        id: executionScopedWorker.id,
        configIndex: 0,
      }),
    ]);
  });
});
