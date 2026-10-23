import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type PostgresTestProcess = {
  harnessPid: number;
  harnessParentPid: number;
  harnessUid: number | null;
  postgresPid: number | null;
  exitCode: number | null;
  signalCode: string | null;
};

type Failure = {
  error: unknown;
  recentLogs: string[];
  dataDir: string;
  port: number;
  attempt: number;
  phase: "initialise" | "start";
  recordedProcess: PostgresTestProcess;
};

export type DiagnosticCommandReceipt = {
  command: string;
  args: string[];
  stdout: string;
  stderr: string;
  status: "ok" | "incomplete";
  error: string | null;
  failure?: {
    code: string | number | null;
    signal: string | null;
    killed: boolean;
  } | null;
};

export function runDiagnosticCommand(
  command: string,
  args: string[],
): Promise<DiagnosticCommandReceipt> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        encoding: "utf8",
        timeout: 1_000,
        maxBuffer: 1024 * 1024,
        killSignal: "SIGKILL",
        env: { ...process.env, LC_ALL: "C" },
      },
      (error, stdout, stderr) => {
        resolve({
          command,
          args,
          stdout,
          stderr,
          status: error || stderr.trim() ? "incomplete" : "ok",
          error: error?.message ?? null,
          failure: error
            ? {
                code: error.code ?? null,
                signal: error.signal ?? null,
                killed: error.killed ?? false,
              }
            : null,
        });
      },
    );
  });
}

const LIMIT_NAMES = ["shmmni", "shmseg", "shmmax", "shmmin", "shmall"] as const;

function parseSegments(output: string) {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const header =
    lines.find((line) => /^T\s+ID\s+KEY\s/.test(line))?.split(/\s+/) ?? [];
  const required = [
    "ID",
    "OWNER",
    "CREATOR",
    "NATTCH",
    "SEGSZ",
    "CPID",
    "LPID",
  ];
  let complete =
    required.every((name) => header.includes(name)) &&
    lines.includes("Shared Memory:");
  const segments: Array<{
    id: number;
    owner: string;
    creator: string;
    attachments: number;
    bytes: number;
    creatorPid: number;
    lastPid: number;
  }> = [];
  for (const line of lines) {
    if (!/^m\s/.test(line)) continue;
    const columns = line.split(/\s+/);
    const field = (name: string) => columns[header.indexOf(name)];
    const integer = (name: string) =>
      /^\d+$/.test(field(name) ?? "") ? Number(field(name)) : NaN;
    const segment = {
      id: integer("ID"),
      owner: field("OWNER"),
      creator: field("CREATOR"),
      attachments: integer("NATTCH"),
      bytes: integer("SEGSZ"),
      creatorPid: integer("CPID"),
      lastPid: integer("LPID"),
    };
    if (
      columns.length !== header.length ||
      ![
        segment.id,
        segment.attachments,
        segment.bytes,
        segment.creatorPid,
        segment.lastPid,
      ].every(Number.isSafeInteger) ||
      !segment.owner ||
      !segment.creator ||
      /\?|unknown/i.test(`${segment.owner} ${segment.creator}`)
    ) {
      complete = false;
      continue;
    }
    segments.push(segment);
  }
  if (
    lines.some(
      (line) =>
        !/^IPC status from /.test(line) &&
        !/^T\s+ID\s+KEY\s/.test(line) &&
        line !== "Shared Memory:" &&
        !/^m\s/.test(line),
    )
  )
    complete = false;
  return { complete, segments };
}

function parseProcesses(output: string) {
  const processes = new Map<
    number,
    {
      pid: number;
      ppid: number;
      uid: number;
      startedAt: string;
      executable: string;
    }
  >();
  for (const line of output.split(/\r?\n/).filter((line) => line.trim())) {
    const match = line.match(
      /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\d+:\d+:\d+\s+\d+)\s+(.+?)\s*$/,
    );
    if (!match) continue;
    const [, pid, ppid, uid, startedAt, executable] = match;
    processes.set(Number(pid), {
      pid: Number(pid),
      ppid: Number(ppid),
      uid: Number(uid),
      startedAt,
      executable,
    });
  }
  return processes;
}

function writeReceipt(receipt: unknown): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "paperclip-postgres-diagnostics-"),
  );
  const filename = path.join(dir, "receipt.json");
  fs.writeFileSync(filename, `${JSON.stringify(receipt, null, 2)}\n`, {
    mode: 0o600,
  });
  return filename;
}

export function isMacPostgresSharedMemoryFailure(
  platform: string,
  error: unknown,
  logs: string[],
): boolean {
  if (platform !== "darwin") return false;
  const text = [
    error instanceof Error ? error.message : String(error ?? ""),
    ...logs,
  ].join("\n");
  return /could not (?:create|attach|map|allocate|resize) (?:a |anonymous )?shared memory|(?:shmget|shmat)\([^\n]*(?:failed|No space left|Cannot allocate|Invalid argument)/i.test(
    text,
  );
}

export async function captureMacPostgresDiagnostics(
  input: Failure,
  dependencies: {
    platform?: string;
    runCommand?: typeof runDiagnosticCommand;
    save?: (receipt: unknown) => string;
    emit?: (message: string) => void;
  } = {},
): Promise<string | null> {
  if (
    !isMacPostgresSharedMemoryFailure(
      dependencies.platform ?? process.platform,
      input.error,
      input.recentLogs,
    )
  )
    return null;
  const emit = (message: string) => {
    try {
      (dependencies.emit ?? console.warn)(message);
    } catch {
    }
  };
  const run = dependencies.runCommand ?? runDiagnosticCommand;
  try {
    const probes: Array<[string, string[]]> = [
      ["/usr/bin/ipcs", ["-m", "-a"]],
      ["/usr/sbin/sysctl", LIMIT_NAMES.map((name) => `kern.sysv.${name}`)],
      ["/bin/ps", ["-axo", "pid=,ppid=,uid=,lstart=,comm="]],
    ];
    const commands = await Promise.all(
      probes.map(async ([command, args]): Promise<DiagnosticCommandReceipt> => {
        try {
          return await run(command, args);
        } catch (error) {
          return {
            command,
            args,
            stdout: "",
            stderr: "",
            status: "incomplete",
            error: String(error),
          };
        }
      }),
    );
    const [ipc, sysctl, ps] = commands;
    const reasons = commands
      .filter((command) => command.status !== "ok")
      .map((command) => `${command.command}: command incomplete`);
    const parsed = parseSegments(ipc.stdout);
    if (!parsed.complete)
      reasons.push(
        "shared-memory allocation/attachment/owner table could not be fully parsed",
      );
    const limits = Object.fromEntries(
      LIMIT_NAMES.map((name) => {
        const value = sysctl.stdout.match(
          new RegExp(`^kern\\.sysv\\.${name}:\\s*(\\d+)\\s*$`, "m"),
        )?.[1];
        const known =
          value !== undefined && Number.isSafeInteger(Number(value));
        if (!known) reasons.push(`kern.sysv.${name}: limit unknown`);
        return [name, known ? Number(value) : null];
      }),
    );
    const processes = parseProcesses(ps.stdout);
    const recorded = input.recordedProcess;
    const child =
      recorded.postgresPid === null
        ? undefined
        : processes.get(recorded.postgresPid);
    const liveChildVerified =
      recorded.postgresPid !== null &&
      recorded.exitCode === null &&
      recorded.signalCode === null &&
      child?.ppid === recorded.harnessPid &&
      child?.uid === recorded.harnessUid;
    if (recorded.postgresPid === null)
      reasons.push(
        "PostgreSQL child identity was not recorded (for example, initdb failed before start)",
      );
    else if (
      !liveChildVerified &&
      recorded.exitCode === null &&
      recorded.signalCode === null
    )
      reasons.push("recorded PostgreSQL child process state/ownership unknown");
    if (!processes.has(recorded.harnessPid))
      reasons.push("harness process state unknown");
    const segments = parsed.segments.map((segment) => {
      reasons.push(
        `segment ${segment.id}: test ownership unknown; OS owner or creator PID is not lifecycle ownership`,
      );
      for (const pid of new Set([segment.creatorPid, segment.lastPid])) {
        if (pid > 0 && !processes.has(pid))
          reasons.push(
            `segment ${segment.id}: process ${pid} state unknown (absent from snapshot)`,
          );
      }
      return { ...segment, testOwnership: "unknown" };
    });
    const allocationsKnown = ipc.status === "ok" && parsed.complete;
    const allocatedSegments = allocationsKnown ? segments.length : null;
    const relevantPids = new Set([
      recorded.harnessPid,
      recorded.harnessParentPid,
      recorded.postgresPid,
      ...segments.flatMap((segment) => [segment.creatorPid, segment.lastPid]),
    ]);
    const receipt = {
      schema: "paperclip.test-postgres-diagnostics.v1",
      capturedAt: new Date().toISOString(),
      completeness: reasons.length ? "incomplete" : "complete",
      incompleteReasons: reasons,
      originalFailure:
        input.error instanceof Error
          ? {
              name: input.error.name,
              message: input.error.message,
              stack: input.error.stack,
            }
          : { message: String(input.error) },
      recentLogs: input.recentLogs,
      attempt: input.attempt,
      phase: input.phase,
      dataDir: input.dataDir,
      port: input.port,
      recordedProcess: recorded,
      processes: [...processes.values()].filter((entry) =>
        relevantPids.has(entry.pid),
      ),
      allocation: {
        allocatedSegments,
        limits,
        attachments: allocationsKnown
          ? segments.reduce((sum, segment) => sum + segment.attachments, 0)
          : null,
        segmentLimitReached:
          allocatedSegments !== null &&
          sysctl.status === "ok" &&
          limits.shmmni !== null
            ? allocatedSegments >= limits.shmmni
            : null,
      },
      segments,
      commands,
      reproduction: {
        maxRuns: 1,
        command:
          "pnpm exec vitest run --no-file-parallelism --maxWorkers=1 --maxConcurrency=1 --retry=0 <same-test-files>",
        instruction:
          "Run once with the original test files and filters. Keep existing test/hook deadlines. Save the original run and this receipt; a passing reproduction does not erase the failure.",
      },
      note: "Read-only, non-atomic snapshots. No segment or database process was removed. Unknown ownership is not an orphan diagnosis.",
    };
    let location: string;
    try {
      location = (dependencies.save ?? writeReceipt)(receipt);
    } catch (error) {
      receipt.completeness = "incomplete";
      receipt.incompleteReasons.push(
        `receipt persistence failed: ${String(error)}`,
      );
      emit(
        `[embedded-postgres] macOS shared-memory diagnostics receipt (incomplete): ${JSON.stringify(receipt)}`,
      );
      return "incomplete diagnostics; receipt emitted to test output (file write failed)";
    }
    emit(
      `[embedded-postgres] macOS shared-memory diagnostics (${receipt.completeness}): ${location}\n` +
        `One optional serial reproduction (maxRuns=1; unchanged deadlines): ${receipt.reproduction.command}\n` +
        "Preserve the original failure and receipt, including after a successful retry.",
    );
    return `${receipt.completeness} diagnostics: ${location}`;
  } catch (error) {
    emit(
      `[embedded-postgres] macOS shared-memory diagnostics incomplete: ${String(error)}; original failure: ${String(input.error)}; logs: ${input.recentLogs.join("\n")}`,
    );
    return "diagnostics incomplete; collector failure recorded in test output";
  }
}
