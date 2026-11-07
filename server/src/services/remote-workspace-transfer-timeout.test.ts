import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import { captureRemoteWorkspaceArchive, restoreRemoteWorkspaceDirectory, type RemoteWorkspaceTarget } from "./remote-workspace-transport.js";

const roots: string[] = [];
const captured: Array<Awaited<ReturnType<typeof captureRemoteWorkspaceArchive>>> = [];

afterEach(async () => {
  if (vi.isFakeTimers()) vi.clearAllTimers();
  vi.useRealTimers();
  await Promise.all(captured.splice(0).map(archive => archive.cleanup()));
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

it.each(["download", "upload"] as const)("preserves a valid large archive when %s takes six minutes", async direction => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-transfer-deadline-"));
  roots.push(root);
  const byteSize = 768 * 1024 ** 2;
  const zero = Buffer.alloc(1024 ** 2);
  const hash = createHash("sha256");
  for (let count = 0; count < 768; count += 1) hash.update(zero);
  const sha256 = hash.digest("hex");
  const source = path.join(root, "saved.pcws");
  if (direction === "upload") {
    await fs.writeFile(source, "");
    await fs.truncate(source, byteSize);
  }

  let announce!: () => void;
  const started = new Promise<void>(resolve => { announce = resolve; });
  let commands = 0;
  let usedTimeout = 0;
  const execute: CommandManagedRuntimeRunner["execute"] = async () => ({
    stdout: direction === "download" && commands++ === 1
      ? JSON.stringify({ manifestDigest: "a".repeat(64), sha256, byteSize, entries: 1, layout: "captured" }) : "",
    stderr: "", exitCode: 0, timedOut: false, signal: null, pid: process.pid, startedAt: new Date().toISOString(),
  });
  const transfer: NonNullable<CommandManagedRuntimeRunner["syncOut"]> = async (operations, options) => {
    usedTimeout = options?.minimumTimeoutMs ?? 300_000;
    await new Promise<void>((resolve, reject) => {
      const failure = setTimeout(() => {
        clearTimeout(delivery);
        reject(new Error("Daytona archive stream timed out"));
      }, usedTimeout);
      const delivery = setTimeout(() => { clearTimeout(failure); resolve(); }, 360_000);
      announce();
    });
    for (const operation of operations) {
      for (const file of operation.files) {
        if (direction === "download") {
          await fs.writeFile(file.targetPath, "", { flag: "wx" });
          await fs.truncate(file.targetPath, byteSize);
        } else {
          expect((await fs.stat(file.sourcePath)).size).toBe(byteSize);
        }
      }
    }
    return { operations: operations.map(operation => ({ operationId: operation.operationId,
      filesTransferred: operation.files.length, bytesTransferred: byteSize })) };
  };
  const remote: RemoteWorkspaceTarget = {
    kind: "remote", transport: "sandbox", remoteCwd: root, runner: { execute, syncIn: transfer, syncOut: transfer },
  };
  vi.useFakeTimers();
  const pending = direction === "download"
    ? captureRemoteWorkspaceArchive({ target: remote, remoteCwd: root, operationId: randomUUID() }).then(value => {
      captured.push(value);
      return value;
    })
    : restoreRemoteWorkspaceDirectory({ target: remote, remoteCwd: path.join(root, "restored"), archivePath: source,
      manifestDigest: "a".repeat(64), restorationIdentity: "b".repeat(64) });
  const settled = pending.then(value => ({ value }), error => ({ error }));
  await Promise.race([started, settled.then(outcome => {
    if ("error" in outcome) throw outcome.error;
    throw new Error("The archive transfer did not wait for its data");
  })]);
  await vi.advanceTimersByTimeAsync(360_000);
  const outcome = await settled;
  if ("error" in outcome) throw outcome.error;
  expect(usedTimeout).toBeGreaterThan(360_000);
  expect(usedTimeout).toBeLessThanOrEqual(30 * 60_000);
  if (direction === "download") {
    const archive = outcome.value as Awaited<ReturnType<typeof captureRemoteWorkspaceArchive>>;
    expect(archive.sha256).toBe(sha256);
    expect(archive.byteSize).toBe(byteSize);
    expect((await fs.stat(archive.archivePath)).size).toBe(byteSize);
  }
}, 30_000);

it.each([
  { byteSize: 1024, timeoutMs: undefined },
  { byteSize: 64 * 1024 ** 3, timeoutMs: 30 * 60_000 },
])("keeps the archive deadline bounded for $byteSize bytes", async ({ byteSize, timeoutMs }) => {
  const transfer = vi.fn<NonNullable<CommandManagedRuntimeRunner["syncOut"]>>(async () => {
    throw new Error("Transfer stopped at the budget probe");
  });
  const remote: RemoteWorkspaceTarget = { kind: "remote", transport: "sandbox", remoteCwd: "/work",
    runner: {
      execute: async () => ({ stdout: JSON.stringify({ layout: "captured", manifestDigest: "a".repeat(64),
        sha256: "b".repeat(64), byteSize, entries: 1 }), stderr: "", exitCode: 0, timedOut: false,
        signal: null, pid: process.pid, startedAt: new Date().toISOString() }),
      syncIn: transfer, syncOut: transfer,
    } };
  await expect(captureRemoteWorkspaceArchive({ target: remote, remoteCwd: "/work", operationId: randomUUID() })).rejects.toThrow();
  expect(transfer).toHaveBeenCalledOnce();
  expect(transfer.mock.calls[0]?.[1]?.minimumTimeoutMs).toBe(timeoutMs);
  if (timeoutMs === undefined) expect(transfer.mock.calls[0]).toHaveLength(1);
});
