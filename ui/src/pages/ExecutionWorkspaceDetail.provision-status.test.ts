import type { WorkspaceOperation } from "@paperclipai/shared";
import { describe, expect, it } from "vitest";
import { resolveRuntimeProvisionStatus } from "./ExecutionWorkspaceDetail";

function operation(overrides: Partial<WorkspaceOperation> = {}): WorkspaceOperation {
  return {
    id: overrides.id ?? "op-1",
    companyId: "company-1",
    executionWorkspaceId: "ews-1",
    heartbeatRunId: null,
    issueId: null,
    phase: overrides.phase ?? "workspace_seed",
    command: overrides.command ?? "bash ./scripts/provision-worktree-runtime.sh",
    cwd: null,
    status: overrides.status ?? "succeeded",
    exitCode: overrides.exitCode ?? 0,
    logStore: null,
    logRef: null,
    logBytes: null,
    logSha256: null,
    logCompressed: false,
    stdoutExcerpt: null,
    stderrExcerpt: null,
    metadata: null,
    startedAt: overrides.startedAt ?? new Date("2026-08-01T00:00:00.000Z"),
    finishedAt: "finishedAt" in overrides ? overrides.finishedAt! : new Date("2026-08-01T00:01:00.000Z"),
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    updatedAt: new Date("2026-08-01T00:01:00.000Z"),
  };
}

describe("resolveRuntimeProvisionStatus", () => {
  it("reports eager when no runtime provision command is configured", () => {
    expect(resolveRuntimeProvisionStatus({ runtimeProvisionCommand: null, operations: [] })).toEqual({
      kind: "eager",
    });
    expect(resolveRuntimeProvisionStatus({ runtimeProvisionCommand: "   ", operations: undefined })).toEqual({
      kind: "eager",
    });
  });

  it("reports deferred when configured but no provision operation has run", () => {
    expect(
      resolveRuntimeProvisionStatus({
        runtimeProvisionCommand: "bash ./seed.sh",
        operations: [operation({ phase: "workspace_provision" })],
      }),
    ).toEqual({ kind: "deferred" });
  });

  it("reports provisioned with the finished time when the latest op succeeded", () => {
    const finishedAt = new Date("2026-08-01T12:00:00.000Z");
    expect(
      resolveRuntimeProvisionStatus({
        runtimeProvisionCommand: "bash ./seed.sh",
        operations: [operation({ status: "succeeded", finishedAt })],
      }),
    ).toEqual({ kind: "provisioned", at: finishedAt });
  });

  it("continues to recognize custom runtime dependency provisioning", () => {
    expect(
      resolveRuntimeProvisionStatus({
        runtimeProvisionCommand: "pnpm install",
        operations: [operation({ phase: "workspace_runtime_provision" })],
      }),
    ).toMatchObject({ kind: "provisioned" });
  });

  it("reports provisioning while the op is running", () => {
    const startedAt = new Date("2026-08-01T12:00:00.000Z");
    expect(
      resolveRuntimeProvisionStatus({
        runtimeProvisionCommand: "bash ./seed.sh",
        operations: [operation({ status: "running", startedAt, finishedAt: null })],
      }),
    ).toEqual({ kind: "provisioning", at: startedAt });
  });

  it("reports failed with the finished time when the latest op failed", () => {
    const finishedAt = new Date("2026-08-01T12:05:00.000Z");
    expect(
      resolveRuntimeProvisionStatus({
        runtimeProvisionCommand: "bash ./seed.sh",
        operations: [operation({ status: "failed", finishedAt, exitCode: 1 })],
      }),
    ).toEqual({ kind: "failed", at: finishedAt });
  });

  it("uses only the latest runtime provision op (operations are most-recent first)", () => {
    const latest = new Date("2026-08-02T00:00:00.000Z");
    const status = resolveRuntimeProvisionStatus({
      runtimeProvisionCommand: "bash ./seed.sh",
      operations: [
        operation({ id: "op-new", status: "failed", finishedAt: latest, exitCode: 1 }),
        operation({ id: "op-old", status: "succeeded" }),
      ],
    });
    expect(status).toEqual({ kind: "failed", at: latest });
  });
});
