import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

let instanceHome: string | undefined;
let temporaryDirectory: string | undefined;
let savedTemporaryDirectory: string | undefined;

type CleanupTask = {
  retryMs: number;
  runDuringDrain: boolean;
  run(signal: AbortSignal): Promise<unknown>;
  hasPending(): Promise<boolean>;
};

function registerCleanupTask(cleanup: typeof import("./temporary-directory-cleanup.js")) {
  let task: CleanupTask | undefined;
  let stopped = false;
  const worker = cleanup.registerTemporaryDirectoryCleanupWork({
    register(_queue: string, definition: CleanupTask) {
      task = definition;
      return { wake: () => { if (!stopped) void definition.run(new AbortController().signal); } };
    },
  } as never);
  return {
    run: () => task!.run(new AbortController().signal),
    hasPending: () => task!.hasPending(),
    stop: () => { stopped = true; },
    wake: worker.wake,
  };
}

afterEach(async () => {
  vi.doUnmock("../home-paths.js");
  vi.doUnmock("node:fs/promises");
  vi.resetModules();
  vi.unstubAllEnvs();
  if (instanceHome) await rm(instanceHome, { recursive: true, force: true });
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
  if (savedTemporaryDirectory) await rm(savedTemporaryDirectory, { recursive: true, force: true });
  instanceHome = undefined;
  temporaryDirectory = undefined;
  savedTemporaryDirectory = undefined;
});

it("reconstructs persisted temporary-directory cleanup after a server restart", async () => {
  instanceHome = await mkdtemp(path.join(os.tmpdir(), "paperclip-cleanup-home-"));
  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "paperclip-ai-cleanup-"));
  vi.stubEnv("PAPERCLIP_HOME", instanceHome);

  const instanceRoot = path.join(instanceHome, "instances", "default");
  await mkdir(instanceRoot, { recursive: true });
  const ledger = path.join(instanceRoot, "pending-temporary-directory-cleanup.json");
  await writeFile(ledger, JSON.stringify([temporaryDirectory]), { mode: 0o600 });

  vi.doMock("../home-paths.js", () => ({
    resolvePaperclipInstanceRoot: () => instanceRoot,
  }));
  vi.resetModules();
  const cleanup = await import("./temporary-directory-cleanup.js");
  await cleanup.retryTemporaryDirectoryCleanupNow();

  expect(JSON.parse(await readFile(ledger, "utf8"))).toEqual([]);
  await expect(stat(temporaryDirectory)).rejects.toMatchObject({ code: "ENOENT" });
});

async function prepareCleanupModules(failFirstRemoval: () => boolean, failLedgerWrite: () => boolean = () => false) {
  const instanceRoot = path.join(instanceHome!, "instances", "default");
  await mkdir(instanceRoot, { recursive: true });
  const ledger = path.join(instanceRoot, "pending-temporary-directory-cleanup.json");
  vi.stubEnv("PAPERCLIP_HOME", instanceHome!);
  vi.doMock("../home-paths.js", () => ({ resolvePaperclipInstanceRoot: () => instanceRoot }));
  vi.doMock("node:fs/promises", async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    return {
      ...actual,
      writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
        if (typeof args[0] === "string" && args[0].startsWith(`${ledger}.`) && failLedgerWrite())
          throw Object.assign(new Error("fixture ledger write lock"), { code: "EBUSY" });
        return actual.writeFile(...args);
      },
      rm: async (...args: Parameters<typeof actual.rm>) => {
        if (args[0] === temporaryDirectory && failFirstRemoval())
          throw Object.assign(new Error("fixture lock"), { code: "EBUSY" });
        return actual.rm(...args);
      },
    };
  });
  vi.resetModules();
  return {
    ledger,
    cleanup: await import("./temporary-directory-cleanup.js"),
  };
}

async function prepareCleanupModulesWithLedgerReadFailure(failFirstRead: () => boolean, failFirstRemoval: () => boolean) {
  const instanceRoot = path.join(instanceHome!, "instances", "default");
  await mkdir(instanceRoot, { recursive: true });
  const ledger = path.join(instanceRoot, "pending-temporary-directory-cleanup.json");
  vi.stubEnv("PAPERCLIP_HOME", instanceHome!);
  vi.doMock("../home-paths.js", () => ({ resolvePaperclipInstanceRoot: () => instanceRoot }));
  vi.doMock("node:fs/promises", async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    return {
      ...actual,
      readFile: async (...args: Parameters<typeof actual.readFile>) => {
        if (args[0] === ledger && failFirstRead())
          throw Object.assign(new Error("fixture ledger lock"), { code: "EBUSY" });
        return actual.readFile(...args);
      },
      rm: async (...args: Parameters<typeof actual.rm>) => {
        if (args[0] === temporaryDirectory && failFirstRemoval())
          throw Object.assign(new Error("fixture directory lock"), { code: "EBUSY" });
        return actual.rm(...args);
      },
    };
  });
  vi.resetModules();
  return { ledger, cleanup: await import("./temporary-directory-cleanup.js") };
}

it("persists a failed removal and lets a fresh worker retry it", async () => {
  instanceHome = await mkdtemp(path.join(os.tmpdir(), "paperclip-cleanup-home-"));
  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "paperclip-ai-cleanup-"));
  let fail = true;
  const fixture = await prepareCleanupModules(() => {
    if (!fail) return false;
    fail = false;
    return true;
  });

  await fixture.cleanup.queueTemporaryDirectoryCleanup(temporaryDirectory);
  expect(JSON.parse(await readFile(fixture.ledger, "utf8"))).toEqual([temporaryDirectory]);
  await expect(stat(temporaryDirectory)).resolves.toBeDefined();

  vi.doUnmock("node:fs/promises");
  vi.resetModules();
  const freshCleanup = await import("./temporary-directory-cleanup.js");
  const worker = registerCleanupTask(freshCleanup);
  expect(await worker.hasPending()).toBe(true);
  await worker.run();
  await expect(stat(temporaryDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  expect(JSON.parse(await readFile(fixture.ledger, "utf8"))).toEqual([]);
});

it("retries ledger read failures without losing cleanup work and keeps the sleep probe blocked", async () => {
  instanceHome = await mkdtemp(path.join(os.tmpdir(), "paperclip-cleanup-home-"));
  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "paperclip-ai-cleanup-"));
  savedTemporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "paperclip-ai-cleanup-saved-"));
  let failRead = true;
  let failRemoval = true;
  const fixture = await prepareCleanupModulesWithLedgerReadFailure(
    () => { if (!failRead) return false; failRead = false; return true; },
    () => { if (!failRemoval) return false; failRemoval = false; return true; },
  );
  await writeFile(fixture.ledger, JSON.stringify([savedTemporaryDirectory]), { mode: 0o600 });
  const idle = await import("./idle-local-work.js");
  idle.markIdleIngressTracked();
  idle.markIdleStartupComplete({ scheduledBackups: false });

  await expect(fixture.cleanup.queueTemporaryDirectoryCleanup(temporaryDirectory)).rejects.toMatchObject({ code: "EBUSY" });
  expect(JSON.parse(await readFile(fixture.ledger, "utf8"))).toEqual([savedTemporaryDirectory]);
  expect(await idle.readIdleLocalWork()).toBe("unknown");
  await expect(fixture.cleanup.retryTemporaryDirectoryCleanupNow()).rejects.toThrow("Temporary directory cleanup failed");
  expect(await idle.readIdleLocalWork()).toBe("present");
  expect(JSON.parse(await readFile(fixture.ledger, "utf8"))).toEqual([temporaryDirectory]);

  await fixture.cleanup.retryTemporaryDirectoryCleanupNow();
  expect(await idle.readIdleLocalWork()).toBe("none");
  expect(JSON.parse(await readFile(fixture.ledger, "utf8"))).toEqual([]);
  await expect(stat(temporaryDirectory)).rejects.toMatchObject({ code: "ENOENT" });
});

it("keeps late cleanup work owned after worker shutdown until the final sweep", async () => {
  instanceHome = await mkdtemp(path.join(os.tmpdir(), "paperclip-cleanup-home-"));
  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "paperclip-ai-cleanup-"));
  let fail = false;
  const fixture = await prepareCleanupModules(() => {
    if (!fail) return false;
    fail = false;
    return true;
  });
  const worker = registerCleanupTask(fixture.cleanup);
  worker.stop();

  fail = true;
  await fixture.cleanup.queueTemporaryDirectoryCleanup(temporaryDirectory);
  expect(JSON.parse(await readFile(fixture.ledger, "utf8"))).toEqual([temporaryDirectory]);
  await expect(stat(temporaryDirectory)).resolves.toBeDefined();
  worker.wake();
  await expect(stat(temporaryDirectory)).resolves.toBeDefined();

  await fixture.cleanup.retryTemporaryDirectoryCleanupNow();
  await expect(stat(temporaryDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  expect(JSON.parse(await readFile(fixture.ledger, "utf8"))).toEqual([]);
});

it("handles concurrent requests for the same temporary directory", async () => {
  instanceHome = await mkdtemp(path.join(os.tmpdir(), "paperclip-cleanup-home-"));
  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "paperclip-ai-cleanup-"));
  const fixture = await prepareCleanupModules(() => false);

  await Promise.all([
    fixture.cleanup.queueTemporaryDirectoryCleanup(temporaryDirectory),
    fixture.cleanup.queueTemporaryDirectoryCleanup(temporaryDirectory),
  ]);

  await expect(stat(temporaryDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  expect(JSON.parse(await readFile(fixture.ledger, "utf8"))).toEqual([]);
});

it("retries a failed ledger save once per sweep without spinning on the same path", async () => {
  instanceHome = await mkdtemp(path.join(os.tmpdir(), "paperclip-cleanup-home-"));
  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "paperclip-ai-cleanup-"));
  let failRemoval = true;
  let failWrite = false;
  const fixture = await prepareCleanupModules(
    () => { if (!failRemoval) return false; failRemoval = false; return true; },
    () => failWrite,
  );
  await fixture.cleanup.queueTemporaryDirectoryCleanup(temporaryDirectory);
  failWrite = true;

  await expect(fixture.cleanup.retryTemporaryDirectoryCleanupNow()).rejects.toThrow("Temporary directory cleanup failed");
  await expect(stat(temporaryDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  expect(JSON.parse(await readFile(fixture.ledger, "utf8"))).toEqual([temporaryDirectory]);

  failWrite = false;
  await fixture.cleanup.retryTemporaryDirectoryCleanupNow();
  expect(JSON.parse(await readFile(fixture.ledger, "utf8"))).toEqual([]);
});
