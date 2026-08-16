import { afterEach, describe, expect, it, vi } from "vitest";
import {
  hasExactLocalServiceProcessIdentity,
  isPidAlive,
  isProcessGroupAlive,
  readLocalServiceProcessCommand,
  readLocalServiceProcessCwd,
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

  it("reads exact command and cwd identity on macOS", async () => {
    const runCommand = vi.fn(async (command: string, args: string[]) => {
      if (command === "ps") return "/bin/sh -lc pnpm dev\n";
      expect(command).toBe("lsof");
      expect(args).toEqual(["-a", "-p", "4242", "-d", "cwd", "-Fn"]);
      return "p4242\nfcwd\nn/Users/steve/paperclip\n";
    });

    await expect(readLocalServiceProcessCommand(4242, { platform: "darwin", runCommand }))
      .resolves.toBe("/bin/sh -lc pnpm dev");
    await expect(readLocalServiceProcessCwd(4242, { platform: "darwin", runCommand }))
      .resolves.toBe("/Users/steve/paperclip");
  });

  it("reads Windows command and cwd through fail-closed PowerShell probes", async () => {
    const runCommand = vi.fn(async (_command: string, args: string[]) => {
      const script = args.at(-1) ?? "";
      if (script.includes("Get-CimInstance")) return "sh -lc pnpm dev\r\n";
      expect(script).toContain("NtQueryInformationProcess");
      expect(script).toContain("[PaperclipProcessCwd]::Get(4242)");
      return "C:\\workspace\\paperclip\r\n";
    });

    await expect(readLocalServiceProcessCommand(4242, { platform: "win32", runCommand }))
      .resolves.toBe("sh -lc pnpm dev");
    await expect(readLocalServiceProcessCwd(4242, { platform: "win32", runCommand }))
      .resolves.toBe("C:\\workspace\\paperclip");
    expect(runCommand).toHaveBeenCalledWith(
      "powershell.exe",
      expect.arrayContaining(["-NoProfile", "-NonInteractive"]),
    );
  });

  it("fails closed when platform process inspection is unavailable", async () => {
    const runCommand = vi.fn(async () => {
      throw new Error("inspection denied");
    });

    await expect(readLocalServiceProcessCommand(4242, { platform: "win32", runCommand }))
      .resolves.toBeNull();
    await expect(readLocalServiceProcessCwd(4242, { platform: "darwin", runCommand }))
      .resolves.toBeNull();
    await expect(readLocalServiceProcessCwd(4242, { platform: "win32", runCommand }))
      .resolves.toBeNull();
  });
});
