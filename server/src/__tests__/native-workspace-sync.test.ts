import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  directorySnapshotSha256,
  serializeDirectorySnapshot,
} from "@paperclipai/adapter-utils/workspace-restore-merge";

import {
  classifyNativeWorkspaceInbound,
  nativeWorkspaceSyncInternals,
  readNativeWorkspaceSyncReference,
} from "../services/native-runtime/native-workspace-sync.js";

const digest = "a".repeat(64);

describe("native workspace sync durable metadata", () => {
  const originalPaperclipHome = process.env.PAPERCLIP_HOME;
  const originalPaperclipInstanceId = process.env.PAPERCLIP_INSTANCE_ID;
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    if (originalPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = originalPaperclipHome;
    if (originalPaperclipInstanceId === undefined)
      delete process.env.PAPERCLIP_INSTANCE_ID;
    else process.env.PAPERCLIP_INSTANCE_ID = originalPaperclipInstanceId;
    await Promise.all(
      cleanupDirs.splice(0).map((directory) =>
        rm(directory, { recursive: true, force: true }),
      ),
    );
  });

  it("classifies fresh, warm, replacement, and same-run recovery inputs", () => {
    expect(
      classifyNativeWorkspaceInbound({
        kind: "new_run",
        acquisition: "created",
        hasPriorStamp: false,
      }),
    ).toBe("host_current");
    expect(
      classifyNativeWorkspaceInbound({
        kind: "new_run",
        acquisition: "resumed",
        hasPriorStamp: true,
      }),
    ).toBe("adopt_remote");
    expect(
      classifyNativeWorkspaceInbound({
        kind: "new_run",
        acquisition: "resumed",
        hasPriorStamp: false,
      }),
    ).toBe("host_current");
    expect(
      classifyNativeWorkspaceInbound({
        kind: "new_run",
        acquisition: "replacement",
        hasPriorStamp: true,
      }),
    ).toBe("host_current");
    expect(
      classifyNativeWorkspaceInbound({
        kind: "existing_run",
        restartRecovery: true,
        sameProviderLease: true,
      }),
    ).toBe("adopt_remote");
    expect(
      classifyNativeWorkspaceInbound({
        kind: "existing_run",
        restartRecovery: true,
        sameProviderLease: false,
      }),
    ).toBe("durable_seed");
    expect(() =>
      classifyNativeWorkspaceInbound({
        kind: "existing_run",
        restartRecovery: false,
        sameProviderLease: true,
      }),
    ).toThrow("native_workspace_sync_unexpected_existing_descriptor");
  });

  it("reads backward-compatible references and the resource disposition", () => {
    const base = {
      schema: "paperclip.native-workspace-sync/v1",
      state: "prepared",
      descriptorSha256: digest,
      baselineSha256: digest,
      finalHostSha256: null,
      workspaceId: "workspace-1",
      leaseId: "lease-1",
      providerLeaseId: "sandbox-1",
      remoteCwd: "/workspace",
    };

    expect(readNativeWorkspaceSyncReference(base)).toEqual({
      ...base,
      resourceDisposition: null,
    });
    expect(
      readNativeWorkspaceSyncReference({
        ...base,
        resourceDisposition: "keep_running",
      }),
    ).toEqual({ ...base, resourceDisposition: "keep_running" });
    expect(
      readNativeWorkspaceSyncReference({
        ...base,
        resourceDisposition: "delete_everything",
      }),
    ).toBeNull();
  });

  it("rejects traversal before constructing a durable state path", () => {
    expect(() =>
      nativeWorkspaceSyncInternals.descriptorPath("../run", digest),
    ).toThrow("native_workspace_sync_invalid_run_id");
    expect(() =>
      nativeWorkspaceSyncInternals.descriptorPath("run-1", "../descriptor"),
    ).toThrow("native_workspace_sync_descriptor_digest_invalid");
  });

  it("writes one immutable descriptor when the same state is replayed", async () => {
    const paperclipHome = await mkdtemp(
      path.join(os.tmpdir(), "paperclip-native-workspace-sync-"),
    );
    cleanupDirs.push(paperclipHome);
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = "descriptor-test";
    const baseline = {
      exclude: [".paperclip-runtime"],
      entries: new Map([
        ["continuity.txt", { kind: "file" as const, mode: 0o644, hash: digest }],
      ]),
    };
    const descriptor = {
      schema: "paperclip.native-workspace-sync/v1" as const,
      binding: {
        runId: "run-idempotent",
        companyId: "company-1",
        workspaceId: "workspace-1",
        leaseId: "lease-1",
        providerLeaseId: "sandbox-1",
        localCwd: path.join(paperclipHome, "workspace"),
        remoteCwd: "/workspace",
      },
      state: "prepared" as const,
      baselineSha256: directorySnapshotSha256(baseline),
      baseline: serializeDirectorySnapshot(baseline),
      gitSnapshot: null,
      seed: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      finalizedAt: null,
      finalHostSha256: null,
      resourceDisposition: "keep_running" as const,
    };

    const first = await nativeWorkspaceSyncInternals.writeDescriptor(
      descriptor,
    );
    const second = await nativeWorkspaceSyncInternals.writeDescriptor(
      descriptor,
    );

    expect(second).toEqual(first);
    const files = await readdir(
      path.dirname(
        nativeWorkspaceSyncInternals.descriptorPath(
          descriptor.binding.runId,
          first.descriptorSha256,
        ),
      ),
    );
    expect(files.filter((file) => file.endsWith(".json"))).toEqual([
      `descriptor.${first.descriptorSha256}.json`,
    ]);
    await expect(
      nativeWorkspaceSyncInternals.readDescriptor({
        runId: descriptor.binding.runId,
        reference: first,
      }),
    ).resolves.toMatchObject({ descriptor });
  });
});
