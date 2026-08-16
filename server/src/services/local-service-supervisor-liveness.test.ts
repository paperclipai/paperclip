import { afterEach, describe, expect, it, vi } from "vitest";
import {
  hasExactLocalServiceProcessIdentity,
  isPidAlive,
  isProcessGroupAlive,
  type LocalServiceRegistryRecord,
} from "./local-service-supervisor.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("local service liveness probes", () => {
  it("treats EPERM as proof that a pid exists", () => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("not permitted"), { code: "EPERM" });
    });

    expect(isPidAlive(4242)).toBe(true);
  });

  it("treats EPERM as proof that a process group exists", () => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("not permitted"), { code: "EPERM" });
    });

    expect(isProcessGroupAlive(4242)).toBe(true);
  });

  it("requires command, cwd, start time, and process-group identity before destructive recovery", async () => {
    const record: LocalServiceRegistryRecord = {
      version: 1,
      serviceKey: "service-key",
      profileKind: "workspace-runtime",
      serviceName: "paperclip-dev",
      command: "pnpm dev",
      cwd: "/workspace/paperclip",
      envFingerprint: "fingerprint",
      port: null,
      url: null,
      pid: 4242,
      processGroupId: 4242,
      provider: "local_process",
      runtimeServiceId: "runtime-service-id",
      reuseKey: "reuse-key",
      startedAt: "2026-08-16T12:00:00.000Z",
      processStartedAt: "2026-08-16T12:00:00.000Z",
      lastSeenAt: "2026-08-16T12:01:00.000Z",
      metadata: null,
    };
    const exactIdentity = {
      isAlive: () => true,
      readCommand: async () => "/bin/sh -c pnpm dev",
      readCwd: async () => "/workspace/paperclip",
      readStartedAt: async () => "2026-08-16T12:00:00.000Z",
      readGroupId: async () => 4242,
      isInWorkspace: async () => true,
    };

    await expect(hasExactLocalServiceProcessIdentity(record, exactIdentity)).resolves.toBe(true);
    await expect(hasExactLocalServiceProcessIdentity(record, {
      ...exactIdentity,
      readCommand: async () => "unrelated-command",
    })).resolves.toBe(false);
    await expect(hasExactLocalServiceProcessIdentity(record, {
      ...exactIdentity,
      readCwd: async () => null,
    })).resolves.toBe(false);
    await expect(hasExactLocalServiceProcessIdentity(record, {
      ...exactIdentity,
      readStartedAt: async () => "2026-08-16T12:05:00.000Z",
    })).resolves.toBe(false);
    await expect(hasExactLocalServiceProcessIdentity({
      ...record,
      processStartedAt: null,
    }, exactIdentity)).resolves.toBe(false);
    await expect(hasExactLocalServiceProcessIdentity(record, {
      ...exactIdentity,
      readGroupId: async () => 9999,
    })).resolves.toBe(false);
  });
});
