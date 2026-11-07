import { execFileSync, spawn, type ChildProcessByStdio } from "node:child_process";
import { constants } from "node:os";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import type { RunnerProcessHandle, RunnerProcessLaunchSpec, RunnerProcessResult } from "../../src/control-plane/durable-prp-control-plane.js";

const limit = 16 * 1024;
const wrapper = fileURLToPath(new URL("./private-host-control.py", import.meta.url));
const failure = () => new Error("private_host_control_fixture_failed");
type Reply = { id: string; status: string };

function bounded<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([promise, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(failure()), milliseconds);
  })]).finally(() => clearTimeout(timer));
}

export function createPrivateHostControlFixture() {
  let child: ChildProcessByStdio<Writable, Readable, null> | undefined;
  let nativePid: number | undefined;
  let nativeIdentity: string | undefined;
  let result: RunnerProcessResult | undefined;
  let confirmed = false;
  let closing = false;
  let poisoned = false;
  let buffer = Buffer.alloc(0);
  let pending: { id: string; resolve(reply: Reply): void; reject(error: Error): void } | undefined;
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  void ready.catch(() => {});
  let completion: Promise<RunnerProcessResult> | undefined;
  let serial: Promise<unknown> = Promise.resolve();

  const fail = () => {
    poisoned = true;
    rejectReady(failure());
    pending?.reject(failure());
    pending = undefined;
  };
  const killGroup = () => {
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* already exited */ }
    } else if (child?.pid && nativePid && nativeIdentity) {
      // A dead wrapper does not release its native child's group. Recheck the
      // original native generation before signaling; never bless a reused PID.
      try {
        execFileSync("python3", [wrapper, "--cleanup", String(nativePid), String(child.pid), nativeIdentity], { timeout: 2_000, stdio: "ignore" });
      } catch { /* absent or ownership unproven; completion still rejects */ }
    }
  };

  return {
    launch(spec: RunnerProcessLaunchSpec): RunnerProcessHandle {
      if (child || closing || process.platform === "win32" || spec.nativeRunner?.connection?.mode !== "listen" || spec.args.includes("--host-control-fd")) throw failure();
      child = spawn("python3", [wrapper, spec.command, ...spec.args], {
        cwd: spec.cwd, env: spec.environment, detached: true, stdio: ["pipe", "pipe", "ignore"],
      });
      // OS-level discard also prevents descendants retaining a diagnostic pipe.
      child.stdin.on("error", fail);
      child.stdout.on("error", fail);
      child.stdout.on("data", (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        let newline: number;
        while ((newline = buffer.indexOf(10)) >= 0) {
          if (newline + 1 > limit) { fail(); return; }
          const line = buffer.subarray(0, newline);
          buffer = buffer.subarray(newline + 1);
          try {
            const value: unknown = JSON.parse(line.toString("utf8"));
            if (!value || typeof value !== "object" || Array.isArray(value)) throw failure();
            const record = value as Record<string, unknown>;
            if (record.fixture === "started" && Object.keys(record).length === 3 && nativePid === undefined && Number.isSafeInteger(record.pid) && Number(record.pid) > 0 &&
              typeof record.identity === "string" && /^\d+:\d+(?::\d+)?$/.test(record.identity) && record.identity.startsWith(`${child!.pid}:`)) {
              nativePid = Number(record.pid); nativeIdentity = record.identity; resolveReady();
            } else if (record.fixture === "exited" && Object.keys(record).length === 3 && nativePid !== undefined && result === undefined &&
              (record.code === null || Number.isSafeInteger(record.code) && Number(record.code) >= 0) &&
              (record.signal === null || typeof record.signal === "string" && Object.hasOwn(constants.signals, record.signal)) &&
              (record.code === null) !== (record.signal === null)) {
              result = { code: record.code as number | null, signal: record.signal as NodeJS.Signals | null, stdout: "", stderr: "" };
            } else if (pending && Object.keys(record).length === 2 && record.id === pending.id &&
              typeof record.status === "string" && ["parked", "claimed", "retired", "conflict"].includes(record.status)) {
              pending.resolve({ id: pending.id, status: record.status }); pending = undefined;
            } else throw failure();
          } catch { fail(); return; }
        }
        if (buffer.length > limit) fail();
      });
      completion = new Promise((resolve, reject) => {
        child!.once("error", () => { fail(); reject(failure()); });
        child!.once("close", () => {
          fail();
          if (result && !buffer.length) { confirmed = true; resolve(result); }
          else reject(failure());
        });
      });
      void completion.catch(() => {});
      return {
        child: {
          get pid() { return nativePid; },
          get exitCode() { return confirmed ? result?.code ?? null : null; },
          get signalCode() { return confirmed ? result?.signal ?? null : null; },
          kill(signal = "SIGTERM") {
            if (signal === "SIGKILL" || signal === 9) killGroup();
            else {
              closing = true;
              child!.stdin.end();
              if (nativePid !== undefined) child!.kill("SIGTERM");
            }
            return !confirmed;
          },
        },
        completion, processGroupId: child.pid, startedAt: new Date().toISOString(),
        isExitConfirmed: () => confirmed, restart: null,
      };
    },
    request(frame: Record<string, unknown>): Promise<Reply> {
      const operation = serial.then(async () => {
        if (!child || closing || poisoned || typeof frame.id !== "string" || !frame.id) throw failure();
        const id = frame.id;
        let wire: string;
        try { wire = `${JSON.stringify(frame)}\n`; } catch { throw failure(); }
        if (Buffer.byteLength(wire) > limit) throw failure();
        await bounded(ready, 10_000);
        if (closing || poisoned) throw failure();
        return bounded(new Promise<Reply>((resolve, reject) => {
          pending = { id, resolve, reject };
          child!.stdin.write(wire, (error) => { if (error) fail(); });
        }), 12_000).catch(() => { fail(); throw failure(); });
      });
      serial = operation.catch(() => {});
      return operation;
    },
    async close(): Promise<void> {
      closing = true;
      if (!child || !completion) return;
      child.stdin.end();
      if (nativePid !== undefined && !confirmed) child.kill("SIGTERM");
      try { await bounded(completion, 15_000); }
      catch { killGroup(); throw failure(); }
    },
  };
}
