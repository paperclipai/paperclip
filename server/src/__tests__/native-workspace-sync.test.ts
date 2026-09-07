import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  directorySnapshotSha256,
  serializeDirectorySnapshot,
} from "@paperclipai/adapter-utils/workspace-restore-merge";

import {
  classifyNativeWorkspaceInbound,
  nativeWorkspaceSyncInternals,
  readNativeWorkspaceSyncReference,
  resumeNativeWorkspaceSync,
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
      cleanupDirs
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
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
    expect(
      classifyNativeWorkspaceInbound({
        kind: "existing_run",
        restartRecovery: false,
        sameRunRecovery: true,
        sameProviderLease: true,
      }),
    ).toBe("adopt_remote");
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
        [
          "continuity.txt",
          { kind: "file" as const, mode: 0o644, hash: digest },
        ],
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

    const first =
      await nativeWorkspaceSyncInternals.writeDescriptor(descriptor);
    const second =
      await nativeWorkspaceSyncInternals.writeDescriptor(descriptor);

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

  it("repairs finalized remote and lease stamps after an interrupted commit", async () => {
    const paperclipHome = await mkdtemp(
      path.join(os.tmpdir(), "paperclip-native-workspace-sync-repair-"),
    );
    cleanupDirs.push(paperclipHome);
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = "descriptor-repair-test";
    const baseline = {
      exclude: [".paperclip-runtime"],
      entries: new Map([
        [
          "continuity.txt",
          { kind: "file" as const, mode: 0o644, hash: digest },
        ],
      ]),
    };
    const finalHostSha256 = "b".repeat(64);
    const descriptor = {
      schema: "paperclip.native-workspace-sync/v1" as const,
      binding: {
        runId: "run-finalized-repair",
        companyId: "company-1",
        workspaceId: "workspace-1",
        leaseId: "lease-1",
        providerLeaseId: "sandbox-1",
        localCwd: path.join(paperclipHome, "workspace"),
        remoteCwd: "/workspace",
      },
      state: "finalized" as const,
      baselineSha256: directorySnapshotSha256(baseline),
      baseline: serializeDirectorySnapshot(baseline),
      gitSnapshot: null,
      seed: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      finalizedAt: "2026-01-01T00:01:00.000Z",
      finalHostSha256,
      resourceDisposition: "keep_running" as const,
    };
    const reference =
      await nativeWorkspaceSyncInternals.writeDescriptor(descriptor);
    const rows = (values: unknown[]) => {
      const query = {
        from: () => query,
        where: () => query,
        for: () => query,
        limit: () => query,
        then: <TResult1 = unknown, TResult2 = never>(
          onfulfilled?:
            ((value: unknown[]) => TResult1 | PromiseLike<TResult1>) | null,
          onrejected?:
            ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
        ) => Promise.resolve(values).then(onfulfilled, onrejected),
      };
      return query;
    };
    let persistedLeaseMetadata: Record<string, unknown> | null = null;
    const db = {
      select: () =>
        rows([{ runnerProfileJson: { nativeWorkspaceSync: reference } }]),
      transaction: async (callback: (tx: unknown) => Promise<unknown>) =>
        callback({
          select: () => rows([{ metadata: { retained: true } }]),
          update: () => ({
            set: (value: { metadata: Record<string, unknown> }) => ({
              where: async () => {
                persistedLeaseMetadata = value.metadata;
              },
            }),
          }),
        }),
    };
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ timedOut: false, exitCode: 1, stdout: "" })
      .mockResolvedValueOnce({ timedOut: false, exitCode: 0, stdout: "" });

    await expect(
      resumeNativeWorkspaceSync({
        db: db as never,
        runId: descriptor.binding.runId,
        target: {
          kind: "remote",
          transport: "sandbox",
          remoteCwd: descriptor.binding.remoteCwd,
          sandboxLeaseAcquisition: {
            providerLeaseId: descriptor.binding.providerLeaseId,
          },
          runner: { execute },
        } as never,
      }),
    ).resolves.toBe(true);

    expect(execute).toHaveBeenCalledTimes(2);
    expect(persistedLeaseMetadata).toMatchObject({
      retained: true,
      nativeWorkspaceSync: {
        schema: "paperclip.native-workspace-stamp/v1",
        workspaceId: descriptor.binding.workspaceId,
        providerLeaseId: descriptor.binding.providerLeaseId,
        remoteCwd: descriptor.binding.remoteCwd,
        hostSha256: finalHostSha256,
        finalizedRunId: descriptor.binding.runId,
      },
    });
  });
});
