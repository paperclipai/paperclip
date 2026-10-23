import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  captureMacPostgresDiagnostics,
  runDiagnosticCommand,
  type DiagnosticCommandReceipt,
} from "./test-postgres-diagnostics.js";

const header =
  "IPC status from <running system> as of Sun Oct 18 12:00:02 UTC 2026\n" +
  "T ID KEY MODE OWNER GROUP CREATOR CGROUP NATTCH SEGSZ CPID LPID ATIME DTIME CTIME\nShared Memory:\n";
const ipc = `${header}m 17 0x00000000 --rw------- alice staff alice staff 2 56 300 300 12:00:01 no-entry 12:00:01\n`;
const limits =
  "kern.sysv.shmmni: 1\nkern.sysv.shmseg: 8\nkern.sysv.shmmax: 4194304\nkern.sysv.shmmin: 1\nkern.sysv.shmall: 1024\n";
const processes =
  " 200 100 501 Sun Oct 18 12:00:00 2026 /usr/local/bin/node\n" +
  " 300 200 501 Sun Oct 18 12:00:01 2026 /path with spaces/postgres\n";
const failure = (): Parameters<typeof captureMacPostgresDiagnostics>[0] => ({
  error: new Error("original startup failure"),
  recentLogs: [
    "FATAL: could not create shared memory segment: No space left on device",
  ],
  dataDir: "/private/test/data",
  port: 12345,
  attempt: 1,
  phase: "start" as const,
  recordedProcess: {
    harnessPid: 200,
    harnessParentPid: 100,
    harnessUid: 501,
    postgresPid: 300,
    exitCode: null,
    signalCode: null,
  },
});

function probes(
  overrides: Record<string, Partial<DiagnosticCommandReceipt>> = {},
) {
  return vi.fn(
    async (
      command: string,
      args: string[],
    ): Promise<DiagnosticCommandReceipt> => ({
      command,
      args,
      stdout: command.endsWith("ipcs")
        ? ipc
        : command.endsWith("sysctl")
          ? limits
          : processes,
      stderr: "",
      status: "ok",
      error: null,
      ...overrides[command],
    }),
  );
}

async function capture(input = failure(), runCommand = probes()) {
  const save = vi.fn((_receipt: unknown) => "/saved/receipt.json");
  const emit = vi.fn();
  const result = await captureMacPostgresDiagnostics(input, {
    platform: "darwin",
    runCommand,
    save,
    emit,
  });
  const receipt = save.mock.calls[0]?.[0] as any;
  return { result, receipt, save, emit, runCommand };
}

describe("macOS embedded PostgreSQL failure diagnostics", () => {
  afterEach(() => vi.restoreAllMocks());

  it.skipIf(process.platform !== "darwin")(
    "runs actual macOS utility probes after a controlled startup failure",
    async () => {
      const input = failure();
      input.error = new Error(
        "controlled startup failure for live utility verification",
      );
      input.recordedProcess = {
        harnessPid: process.pid,
        harnessParentPid: process.ppid,
        harnessUid: process.getuid?.() ?? null,
        postgresPid: null,
        exitCode: null,
        signalCode: null,
      };
      const result = await captureMacPostgresDiagnostics(input);
      expect(result).toMatch(/^incomplete diagnostics: /);
      const filename = result!.slice("incomplete diagnostics: ".length);
      try {
        const raw = fs.readFileSync(filename, "utf8");
        const evidenceDir =
          process.env.PAPERCLIP_TEST_POSTGRES_DIAGNOSTIC_EVIDENCE_DIR;
        if (evidenceDir) {
          fs.mkdirSync(evidenceDir, { recursive: true });
          fs.writeFileSync(
            path.join(evidenceDir, "live-macos-receipt.json"),
            raw,
            { mode: 0o600 },
          );
        }
        const receipt = JSON.parse(raw);
        expect(receipt.originalFailure.message).toContain(
          "controlled startup failure",
        );
        expect(receipt.commands).toHaveLength(3);
        for (const command of receipt.commands) {
          expect(command.status, JSON.stringify(command)).toBe("ok");
        }
        expect(receipt.allocation.allocatedSegments).toBeTypeOf("number");
        expect(receipt.allocation.attachments).toBeTypeOf("number");
        for (const limit of Object.values(receipt.allocation.limits)) {
          expect(limit).toBeTypeOf("number");
        }
        expect(
          receipt.processes.some(
            (entry: { pid: number }) => entry.pid === process.pid,
          ),
        ).toBe(true);
        expect(receipt.incompleteReasons).toContain(
          "PostgreSQL child identity was not recorded (for example, initdb failed before start)",
        );
      } finally {
        fs.rmSync(path.dirname(filename), { recursive: true, force: true });
      }
    },
  );

  it("keeps allocation evidence and the original failure with explicit unknown ownership", async () => {
    const input = failure();
    const { receipt, result, runCommand } = await capture(input);
    expect(result).toBe("incomplete diagnostics: /saved/receipt.json");
    expect(receipt.completeness).toBe("incomplete");
    expect(receipt.incompleteReasons).toEqual([
      "segment 17: test ownership unknown; OS owner or creator PID is not lifecycle ownership",
    ]);
    const originalError = input.error as Error;
    expect(receipt.originalFailure).toEqual({
      name: "Error",
      message: originalError.message,
      stack: originalError.stack,
    });
    expect(receipt.recentLogs).toEqual(input.recentLogs);
    expect(receipt.recordedProcess).toEqual(input.recordedProcess);
    expect(receipt.allocation).toMatchObject({
      allocatedSegments: 1,
      attachments: 2,
      segmentLimitReached: true,
      limits: { shmmni: 1, shmseg: 8 },
    });
    expect(receipt.segments[0]).toMatchObject({
      id: 17,
      attachments: 2,
      creatorPid: 300,
      lastPid: 300,
      testOwnership: "unknown",
    });
    expect(receipt.processes[1].executable).toBe("/path with spaces/postgres");
    expect(receipt.commands).toHaveLength(3);
    expect(runCommand.mock.calls.map(([command]) => command)).toEqual([
      "/usr/bin/ipcs",
      "/usr/sbin/sysctl",
      "/bin/ps",
    ]);
    expect(receipt.reproduction).toMatchObject({ maxRuns: 1 });
    expect(receipt.reproduction.command).toContain(
      "--no-file-parallelism --maxWorkers=1 --maxConcurrency=1 --retry=0",
    );
    expect(receipt.reproduction.command).not.toMatch(
      /Timeout|timeout|ipcrm|kill/,
    );
  });

  it.each(["linux", "win32", "darwin"])(
    "runs no probes for a nonmatching %s failure",
    async (platform) => {
      const runCommand = probes();
      const save = vi.fn();
      const input = failure();
      if (platform === "darwin")
        input.recentLogs = [
          "could not bind IPv4 address: Address already in use",
        ];
      expect(
        await captureMacPostgresDiagnostics(input, {
          platform,
          runCommand,
          save,
        }),
      ).toBeNull();
      expect(runCommand).not.toHaveBeenCalled();
      expect(save).not.toHaveBeenCalled();
    },
  );

  it("also matches a PostgreSQL failure carried by the rejection instead of logs", async () => {
    const input = failure();
    input.error = new Error(
      "shmget(key=1, size=56, 03600) failed: No space left on device",
    );
    input.recentLogs = [];
    expect((await capture(input)).receipt.originalFailure.message).toContain(
      "shmget",
    );
  });

  it.each([
    [
      "/usr/bin/ipcs",
      { stdout: "", status: "incomplete", error: "ENOENT" },
      "command incomplete",
    ],
    [
      "/usr/bin/ipcs",
      { stdout: `${header}m 17 truncated\n` },
      "could not be fully parsed",
    ],
    [
      "/usr/bin/ipcs",
      { stdout: "unexpected format\n" },
      "could not be fully parsed",
    ],
    ["/usr/sbin/sysctl", { stdout: "kern.sysv.shmmni: 1\n" }, "limit unknown"],
    [
      "/bin/ps",
      { stdout: "", status: "incomplete", error: "permission denied" },
      "process state",
    ],
    [
      "/bin/ps",
      { stdout: processes.replace("300 200 501", "300 999 501") },
      "ownership unknown",
    ],
    [
      "/usr/bin/ipcs",
      { stdout: ipc.replace("alice staff alice", "??? staff alice") },
      "could not be fully parsed",
    ],
  ] as const)(
    "marks incomplete evidence from %s without discarding receipts",
    async (command, override, reason) => {
      const { receipt } = await capture(
        failure(),
        probes({ [command]: override }),
      );
      expect(receipt.completeness).toBe("incomplete");
      expect(receipt.incompleteReasons.join(" ")).toContain(reason);
      expect(
        receipt.commands.find(
          (entry: DiagnosticCommandReceipt) => entry.command === command,
        ),
      ).toMatchObject(override);
      expect(receipt.originalFailure.message).toBe("original startup failure");
      if (command.endsWith("ipcs"))
        expect(receipt.allocation.allocatedSegments).toBeNull();
    },
  );

  it("treats unknown ownership and absent segment PIDs as incomplete, even with zero attachments", async () => {
    const { receipt } = await capture(
      failure(),
      probes({
        "/usr/bin/ipcs": {
          stdout: ipc.replace("2 56 300 300", "0 56 999 999"),
        },
      }),
    );
    expect(receipt.allocation.attachments).toBe(0);
    expect(receipt.completeness).toBe("incomplete");
    expect(receipt.incompleteReasons.join(" ")).toContain(
      "test ownership unknown",
    );
    expect(receipt.incompleteReasons.join(" ")).toContain(
      "process 999 state unknown",
    );
  });

  it("does not mistake an absent child handle or a reused PID for known ownership", async () => {
    const input = failure();
    input.recordedProcess.postgresPid = null;
    const absent = await capture(input);
    expect(absent.receipt.completeness).toBe("incomplete");
    expect(absent.receipt.incompleteReasons.join(" ")).toContain(
      "identity was not recorded",
    );
    input.recordedProcess.postgresPid = 300;
    input.recordedProcess.exitCode = 1;
    const exited = await capture(input);
    expect(exited.receipt.completeness).toBe("incomplete");
    expect(exited.receipt.segments[0].testOwnership).toBe("unknown");
  });

  it("does not attribute an old segment to a live child that reused its creator PID", async () => {
    const { receipt } = await capture(
      failure(),
      probes({
        "/usr/bin/ipcs": {
          stdout: ipc.replace(
            "12:00:01 no-entry 12:00:01",
            "11:00:00 no-entry 11:00:00",
          ),
        },
      }),
    );
    expect(receipt.recordedProcess).toMatchObject({
      postgresPid: 300,
      exitCode: null,
      signalCode: null,
    });
    expect(
      receipt.processes.find((entry: { pid: number }) => entry.pid === 300),
    ).toMatchObject({
      ppid: 200,
      uid: 501,
      startedAt: "Sun Oct 18 12:00:01 2026",
    });
    expect(receipt.segments[0]).toMatchObject({
      creatorPid: 300,
      testOwnership: "unknown",
    });
    expect(receipt.completeness).toBe("incomplete");
    expect(receipt.incompleteReasons.join(" ")).toContain(
      "test ownership unknown",
    );
    expect(receipt.allocation).toMatchObject({
      allocatedSegments: 1,
      attachments: 2,
    });
  });

  it("recognizes an empty host without claiming allocation pressure", async () => {
    const { receipt } = await capture(
      failure(),
      probes({ "/usr/bin/ipcs": { stdout: header } }),
    );
    expect(receipt.completeness).toBe("complete");
    expect(receipt.allocation).toMatchObject({
      allocatedSegments: 0,
      attachments: 0,
      segmentLimitReached: false,
    });
  });

  it("preserves successful probes when another probe throws", async () => {
    const regular = probes();
    const runCommand = vi.fn(async (command: string, args: string[]) => {
      if (command.endsWith("ps")) throw new Error("probe unavailable");
      return regular(command, args);
    });
    const { receipt } = await capture(failure(), runCommand);
    expect(receipt.completeness).toBe("incomplete");
    expect(receipt.commands[0].stdout).toBe(ipc);
    expect(receipt.commands[2].error).toContain("probe unavailable");
  });

  it("emits the full incomplete receipt if persistence fails", async () => {
    const emit = vi.fn();
    const result = await captureMacPostgresDiagnostics(failure(), {
      platform: "darwin",
      runCommand: probes(),
      save: () => {
        throw new Error("disk full");
      },
      emit,
    });
    expect(result).toContain("file write failed");
    const receipt = JSON.parse(
      emit.mock.calls[0][0].split("receipt (incomplete): ")[1],
    );
    expect(receipt.completeness).toBe("incomplete");
    expect(receipt.incompleteReasons).toContain(
      "receipt persistence failed: Error: disk full",
    );
    expect(receipt.originalFailure.message).toBe("original startup failure");
    expect(receipt.commands).toHaveLength(3);
  });

  it("does not replace the original failure if reporting also fails", async () => {
    await expect(
      captureMacPostgresDiagnostics(failure(), {
        platform: "darwin",
        runCommand: probes(),
        save: () => {
          throw new Error("disk full");
        },
        emit: () => {
          throw new Error("closed output");
        },
      }),
    ).resolves.toContain("incomplete");
  });

  it("captures real subprocess exit, output and timeout receipts", async () => {
    const ok = await runDiagnosticCommand(process.execPath, [
      "-e",
      "process.stdout.write('probe evidence')",
    ]);
    expect(ok).toMatchObject({ status: "ok", stdout: "probe evidence" });
    const failed = await runDiagnosticCommand(process.execPath, [
      "-e",
      "process.stderr.write('denied'); process.exit(1)",
    ]);
    expect(failed).toMatchObject({ status: "incomplete", stderr: "denied" });
    expect(failed.failure?.code).toBe(1);
    const truncated = await runDiagnosticCommand(process.execPath, [
      "-e",
      "process.stdout.write('x'.repeat(2 * 1024 * 1024))",
    ]);
    expect(truncated.status).toBe("incomplete");
    expect(truncated.error).toContain("maxBuffer");
    expect(truncated.failure?.code).toBe("ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
    expect(truncated.stdout.length).toBeLessThanOrEqual(1024 * 1024);
    const start = Date.now();
    const timedOut = await runDiagnosticCommand(process.execPath, [
      "-e",
      "setInterval(() => {}, 1000)",
    ]);
    expect(timedOut.status).toBe("incomplete");
    expect(timedOut.failure).toMatchObject({ signal: "SIGKILL", killed: true });
    expect(Date.now() - start).toBeLessThan(4_000);
  });
});
