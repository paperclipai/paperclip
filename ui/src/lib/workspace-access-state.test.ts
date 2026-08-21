import type { WorkspaceOperation, WorkspaceRuntimeService } from "@paperclipai/shared";
import { describe, expect, it } from "vitest";
import {
  describeWorkspaceReadinessCause,
  resolveWorkspaceAccessState,
} from "./workspace-access-state";

function runtimeService(overrides: Partial<WorkspaceRuntimeService> = {}): WorkspaceRuntimeService {
  return {
    id: "runtime-1",
    companyId: "company-1",
    projectId: "project-1",
    projectWorkspaceId: null,
    executionWorkspaceId: "ews-1",
    issueId: null,
    scopeType: "execution_workspace",
    scopeId: "ews-1",
    serviceName: "paperclip-dev",
    status: "running",
    lifecycle: "shared",
    reuseKey: null,
    command: "pnpm dev:once",
    cwd: "/srv/worktree",
    port: 42013,
    url: "https://workspace.example.ts.net:42013/",
    provider: "local_process",
    providerRef: null,
    ownerAgentId: null,
    startedByRunId: null,
    lastUsedAt: new Date("2026-08-19T00:00:00.000Z"),
    startedAt: new Date("2026-08-19T00:00:00.000Z"),
    stoppedAt: null,
    stopPolicy: null,
    healthStatus: "healthy",
    createdAt: new Date("2026-08-19T00:00:00.000Z"),
    updatedAt: new Date("2026-08-19T00:00:00.000Z"),
    ...overrides,
  };
}

function operation(overrides: Partial<WorkspaceOperation> = {}): WorkspaceOperation {
  return {
    id: "op-1",
    companyId: "company-1",
    executionWorkspaceId: "ews-1",
    heartbeatRunId: null,
    issueId: null,
    phase: "workspace_seed",
    command: null,
    cwd: null,
    status: "succeeded",
    exitCode: 0,
    logStore: null,
    logRef: null,
    logBytes: null,
    logSha256: null,
    logCompressed: false,
    stdoutExcerpt: null,
    stderrExcerpt: null,
    metadata: null,
    startedAt: new Date("2026-08-19T00:00:00.000Z"),
    finishedAt: new Date("2026-08-19T00:01:00.000Z"),
    createdAt: new Date("2026-08-19T00:00:00.000Z"),
    updatedAt: new Date("2026-08-19T00:01:00.000Z"),
    ...overrides,
  };
}

describe("resolveWorkspaceAccessState", () => {
  it("is ready with a password-independent open action when a healthy runtime publishes a URL", () => {
    const access = resolveWorkspaceAccessState({
      runtimeServices: [runtimeService()],
      operations: [operation()],
    });
    expect(access).toMatchObject({
      state: "ready",
      action: { kind: "open", label: "Open workspace" },
      handoffAvailable: true,
    });
    expect(access.description).toContain("without a password");
  });

  it("shows a repair-in-progress state with the current phase and no action", () => {
    const access = resolveWorkspaceAccessState({
      runtimeServices: [runtimeService()],
      operations: [
        operation({ phase: "workspace_repair", status: "running", metadata: { repairPhase: "full_reseed" } }),
      ],
    });
    expect(access.state).toBe("repairing");
    expect(access.description).toContain("full_reseed");
    expect(access.description).toContain("preserved");
    expect(access.action.kind).toBe("wait");
  });

  it("shows a failed repair with the failing phase and points at the log", () => {
    const access = resolveWorkspaceAccessState({
      runtimeServices: [],
      operations: [
        operation({ phase: "workspace_repair", status: "failed", metadata: { repairPhase: "readiness_validation" } }),
      ],
    });
    expect(access).toMatchObject({ state: "failed", action: { kind: "view_logs" } });
    expect(access.title).toBe("Repair failed");
    expect(access.description).toContain("readiness_validation");
    expect(access.description).toContain("backup");
  });

  it("returns to ready after a failed repair when a newer healthy runtime is serving", () => {
    const access = resolveWorkspaceAccessState({
      runtimeServices: [runtimeService({ startedAt: new Date("2026-08-19T00:03:00.000Z") })],
      operations: [
        operation({
          phase: "workspace_repair",
          status: "failed",
          metadata: { repairPhase: "managed_restart" },
          finishedAt: new Date("2026-08-19T00:02:00.000Z"),
        }),
      ],
    });

    expect(access).toMatchObject({
      state: "ready",
      action: { kind: "open", label: "Open workspace" },
      secondaryNotice: {
        title: "Repair failed",
        action: { kind: "view_logs", label: "View repair log" },
      },
    });
    expect(access.secondaryNotice?.description).toContain("managed_restart");
    expect(access.secondaryNotice?.description).toContain("backup");
  });

  it("returns to ready when a serving runtime has subsequently reported ready", () => {
    const access = resolveWorkspaceAccessState({
      runtimeServices: [runtimeService({ startedAt: new Date("2026-08-19T00:01:00.000Z") })],
      operations: [
        operation({
          phase: "workspace_repair",
          status: "failed",
          metadata: { repairPhase: "managed_restart" },
          finishedAt: new Date("2026-08-19T00:02:00.000Z"),
        }),
      ],
      handoffFailure: {
        reason: "workspace_not_ready",
        readiness: {
          state: "ready",
          databaseReady: true,
          cloneDataReady: true,
          authHandoffReady: true,
          authHandoffUserId: null,
          seedState: "verified",
          seedPhase: "complete",
          seedMode: "full",
          instanceId: "instance-a",
          executionWorkspaceId: "ews-1",
          companyId: "company-1",
          failurePhase: null,
        },
      },
    });

    expect(access).toMatchObject({ state: "ready", action: { kind: "open" } });
    expect(access.secondaryNotice?.action.kind).toBe("view_logs");
  });

  it("keeps a newer failed repair primary even when an older runtime is healthy", () => {
    const access = resolveWorkspaceAccessState({
      runtimeServices: [runtimeService({ startedAt: new Date("2026-08-19T00:01:00.000Z") })],
      operations: [
        operation({
          phase: "workspace_repair",
          status: "failed",
          finishedAt: new Date("2026-08-19T00:02:00.000Z"),
        }),
      ],
    });

    expect(access).toMatchObject({ state: "failed", action: { kind: "view_logs" } });
    expect(access.secondaryNotice).toBeUndefined();
  });

  it("shows provisioning while the clone is restoring", () => {
    const access = resolveWorkspaceAccessState({
      runtimeServices: [],
      operations: [operation({ status: "running" })],
    });
    expect(access).toMatchObject({ state: "provisioning", action: { kind: "wait" } });
    expect(access.title).toBe("Provisioning database");
  });

  it("offers a repair when provisioning failed, naming the seed phase", () => {
    const access = resolveWorkspaceAccessState({
      runtimeServices: [],
      operations: [operation({ status: "failed", metadata: { seedFailurePhase: "restore" } })],
    });
    expect(access).toMatchObject({ state: "failed", action: { kind: "repair", label: "Repair workspace" } });
    expect(access.description).toContain("restore");
  });

  it("returns to ready after a failed seed when a later repair succeeded and a healthy runtime is serving", () => {
    const access = resolveWorkspaceAccessState({
      runtimeServices: [runtimeService({ startedAt: new Date("2026-08-20T00:18:00.000Z") })],
      operations: [
        operation({
          id: "repair-1",
          phase: "workspace_repair",
          status: "succeeded",
          startedAt: new Date("2026-08-20T00:10:00.000Z"),
          finishedAt: new Date("2026-08-20T00:17:31.000Z"),
        }),
        operation({
          id: "seed-1",
          phase: "workspace_seed",
          status: "failed",
          metadata: { seedFailurePhase: "manifest_verification" },
          startedAt: new Date("2026-08-20T00:02:00.000Z"),
          finishedAt: new Date("2026-08-20T00:04:37.000Z"),
        }),
      ],
    });

    expect(access).toMatchObject({
      state: "ready",
      action: { kind: "open", label: "Open workspace" },
      secondaryNotice: {
        title: "Database provisioning failed",
        action: { kind: "view_logs", label: "View provisioning log" },
      },
    });
    expect(access.secondaryNotice?.description).toContain("manifest_verification");
    expect(access.secondaryNotice?.description).toContain("later became usable");
  });

  it("does not offer repair for a stale failed seed after a later successful repair", () => {
    const access = resolveWorkspaceAccessState({
      runtimeServices: [],
      operations: [
        operation({
          id: "repair-1",
          phase: "workspace_repair",
          status: "succeeded",
          finishedAt: new Date("2026-08-20T00:17:31.000Z"),
        }),
        operation({
          id: "seed-1",
          phase: "workspace_seed",
          status: "failed",
          finishedAt: new Date("2026-08-20T00:04:37.000Z"),
        }),
      ],
    });

    expect(access).toMatchObject({
      state: "provisioning",
      action: { kind: "start", label: "Start workspace" },
    });
  });

  it("returns to ready when a healthy runtime proves a failed seed is stale", () => {
    const access = resolveWorkspaceAccessState({
      runtimeServices: [runtimeService()],
      operations: [operation({ status: "failed" })],
    });

    expect(access).toMatchObject({
      state: "ready",
      action: { kind: "open", label: "Open workspace" },
      secondaryNotice: {
        title: "Database provisioning failed",
        action: { kind: "view_logs" },
      },
    });
  });

  it("shows validating, not degraded, while a fresh clone is still being confirmed", () => {
    const access = resolveWorkspaceAccessState({
      runtimeServices: [runtimeService()],
      operations: [operation()],
      handoffFailure: {
        reason: "workspace_not_ready",
        detail: "clone_data_missing",
        readiness: {
          state: "validating",
          databaseReady: true,
          cloneDataReady: false,
          authHandoffReady: true,
          authHandoffUserId: null,
          seedState: "unknown",
          seedPhase: "legacy_complete_marker",
          seedMode: null,
          instanceId: "instance-a",
          executionWorkspaceId: "ews-1",
          companyId: "company-1",
          failurePhase: "clone_data_missing",
        },
      },
    });
    expect(access).toMatchObject({ state: "validating", action: { kind: "wait" } });
    expect(access.description).toContain("restored no company or issue rows");
  });

  it("degrades a verified clone whose database regressed and offers one repair", () => {
    const access = resolveWorkspaceAccessState({
      runtimeServices: [runtimeService()],
      operations: [operation()],
      handoffFailure: {
        reason: "workspace_not_ready",
        detail: "database_unreachable",
        readiness: {
          state: "degraded",
          databaseReady: false,
          cloneDataReady: false,
          authHandoffReady: false,
          authHandoffUserId: null,
          seedState: "verified",
          seedPhase: "complete",
          seedMode: "minimal",
          instanceId: "instance-a",
          executionWorkspaceId: "ews-1",
          companyId: "company-1",
          failurePhase: "database_unreachable",
        },
      },
    });
    expect(access).toMatchObject({ state: "degraded", action: { kind: "repair" } });
    expect(access.description).toContain("isolated database is not answering");
  });

  it("labels the credential path accurately when no handoff is configured", () => {
    const access = resolveWorkspaceAccessState({
      runtimeServices: [runtimeService()],
      operations: [operation()],
      handoffFailure: { reason: "handoff_not_configured" },
    });
    expect(access).toMatchObject({
      state: "ready",
      action: { kind: "open" },
      handoffAvailable: false,
    });
    expect(access.description).toContain("snapshot-local credentials");
  });

  it("offers start when nothing is running", () => {
    expect(
      resolveWorkspaceAccessState({ runtimeServices: [], operations: [] }),
    ).toMatchObject({ state: "provisioning", action: { kind: "start", label: "Start workspace" } });

    expect(
      resolveWorkspaceAccessState({
        runtimeServices: [],
        operations: [],
        handoffFailure: { reason: "runtime_not_running" },
      }),
    ).toMatchObject({ state: "provisioning", action: { kind: "start" } });
  });

  it("refuses to call an unhealthy running runtime ready", () => {
    const access = resolveWorkspaceAccessState({
      runtimeServices: [runtimeService({ healthStatus: "unhealthy" })],
      operations: [operation()],
    });
    expect(access).toMatchObject({ state: "degraded", action: { kind: "repair" } });
  });

  it("treats a running service with no URL as not yet serving", () => {
    const access = resolveWorkspaceAccessState({
      runtimeServices: [runtimeService({ url: null })],
      operations: [operation()],
    });
    expect(access.state).not.toBe("ready");
  });

  it("handles missing operations and services without throwing", () => {
    expect(resolveWorkspaceAccessState({ runtimeServices: null, operations: undefined }).state)
      .toBe("provisioning");
  });
});

describe("describeWorkspaceReadinessCause", () => {
  it("prefers the recorded readiness phase over the generic reason", () => {
    expect(
      describeWorkspaceReadinessCause({
        reason: "workspace_not_ready",
        readiness: {
          state: "degraded",
          databaseReady: true,
          cloneDataReady: true,
          authHandoffReady: false,
          authHandoffUserId: null,
          seedState: "verified",
          seedPhase: "complete",
          seedMode: "minimal",
          instanceId: "i",
          executionWorkspaceId: "e",
          companyId: "company-1",
          failurePhase: "cloned_membership_missing",
        },
      }),
    ).toBe("No cloned user has an active company membership.");
  });

  it("falls back to the reason and finally to null", () => {
    expect(describeWorkspaceReadinessCause({ reason: "runtime_not_running" }))
      .toContain("No healthy runtime service");
    expect(describeWorkspaceReadinessCause({ reason: "something_new" })).toBeNull();
    expect(describeWorkspaceReadinessCause(null)).toBeNull();
  });
});
