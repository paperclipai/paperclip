import { describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import type { EnvironmentLease } from "@paperclipai/shared";
import { isRemoteWorkspaceRestoreDiskFull, RemoteWorkspaceOperationError } from "./remote-workspace-transport.js";
import { retireFullReusableSandbox } from "./full-reusable-sandbox.js";

describe("restore disk-full refusal", () => {
  it.each(["helper", "upload", "extract"])("names a full sandbox disk at the %s stage", stage => {
    const operation = stage === "extract" ? "restore exit=1" : stage === "helper" ? "archive_helper" : "upload";
    expect(isRemoteWorkspaceRestoreDiskFull(new RemoteWorkspaceOperationError(
      `remote_workspace_operation_failed: operation=${operation}; remote_workspace_restore_failed: stage=${stage} reason=sandbox_disk_full`))).toBe(true);
  });

  it("still names it when the transport adds structured fields around the reason", () => {
    expect(isRemoteWorkspaceRestoreDiskFull(new Error(
      "remote_workspace_operation_failed: operation=restore exit=1; remote_workspace_restore_failed: stage=extract code=ENOSPC reason=sandbox_disk_full exit=1"))).toBe(true);
  });

  it.each([
    "remote_workspace_operation_failed: operation=restore exit=1; remote_workspace_restore_failed: stage=inspect_root reason=occupied_root",
    "remote_workspace_operation_failed: operation=prepare exit=1; remote_workspace_prepare_failed: stage=clone reason=sandbox_disk_full",
    "remote_workspace_operation_failed: operation=restore exit=1; remote_workspace_restore_failed: stage=extract reason=sandbox_disk_full_unknown",
  ])("does not name another refusal (%s)", message => {
    expect(isRemoteWorkspaceRestoreDiskFull(new Error(message))).toBe(false);
  });

  it("keeps the restore refusal when the lease write fails", async () => {
    const db = { select: () => { throw new Error("connection terminated"); } } as unknown as Db;
    const lease = { id: "lease", companyId: "company", leasePolicy: "reuse_by_environment", providerLeaseId: "sandbox",
      heartbeatRunId: "run", provider: "daytona", metadata: {} } as unknown as EnvironmentLease;
    await expect(retireFullReusableSandbox(db, lease, "run")).resolves.toBe(false);
  });
});
