import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import {
  HARNESS_MAX_FRAME_BYTES, HARNESS_PROTOCOL_SCHEMA, HarnessProtocolError,
  type HarnessCommand, type HarnessEvent, type HarnessMethod, type HarnessResponse,
  type JsonObject, type RunnerHarnessCapabilities, type RunnerHarnessReleaseIdentity,
} from "./types.js";
import { parseHarnessEvent, parseHarnessFrameText, parseHarnessResponse, serializeHarnessFrame } from "./protocol.js";
import { parseHarnessCapabilities, parseRunnerHarnessReleaseIdentity, sameRunnerHarnessRelease } from "./declaration.js";

export interface HarnessProcessConformanceInput {
  /** Explicit installed executable. This test kit never resolves or installs packages. */
  command: string;
  args?: string[];
  cwd: string;
  /** Only the supplied environment and PATH are inherited by the child. */
  environment?: Record<string, string>;
  identity: RunnerHarnessReleaseIdentity;
  commands: HarnessCommand[];
  requiredEventTypes?: string[];
  initializeParams?: JsonObject;
  requireSnapshot?: boolean;
  /** Total deadline for the fixture, including provider work. Defaults to 30 seconds. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface HarnessProcessConformanceReport {
  schema: "paperclip.harness-process-conformance.v1";
  identity: RunnerHarnessReleaseIdentity;
  capabilities: RunnerHarnessCapabilities;
  commandResults: JsonObject[];
  events: HarnessEvent[];
  snapshot?: JsonObject;
  exitCode: 0;
}

/**
 * Exercise a real installed executable through the public protocol. Caller-owned
 * commands establish the workflow; this report is transport evidence, not a claim
 * that model output or Paperclip business actions were independently verified.
 */
export async function runHarnessProcessConformance(input: HarnessProcessConformanceInput): Promise<HarnessProcessConformanceReport> {
  const identity = parseRunnerHarnessReleaseIdentity(input.identity);
  const timeoutMs = input.timeoutMs ?? 30_000;
  if (!isAbsolute(input.command) || !isAbsolute(input.cwd)
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000
    || (input.requireSnapshot !== undefined && typeof input.requireSnapshot !== "boolean")) {
    throw new HarnessProtocolError("conformance requires absolute paths and a bounded deadline");
  }
  input.signal?.throwIfAborted();
  const child = spawn(input.command, input.args ?? [], { cwd: input.cwd,
    env: { PATH: process.env.PATH, ...input.environment }, detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"] });
  let resolveExit!: (value: number | null) => void;
  const exited = new Promise<number | null>(resolve => { resolveExit = resolve; });
  let didExit = false;
  let fatal: Error | undefined;
  let nextId = 0;
  let expectedSequence = 1;
  let admission: "initializing" | "ready" | "closing" | "closed" = "initializing";
  let admittedCapabilities: RunnerHarnessCapabilities | undefined;
  let retainedBytes = 0;
  let remainder = Buffer.alloc(0);
  const events: HarnessEvent[] = [];
  const pending = new Map<number, { method: HarnessMethod; resolve(value: JsonObject): void; reject(error: Error): void }>();
  const eventWaiters = new Set<() => void>();
  let rejectFailure!: (error: Error) => void;
  const failure = new Promise<never>((_resolve, reject) => { rejectFailure = reject; });
  void failure.catch(() => {});
  const fail = (error: unknown) => {
    fatal ??= error instanceof Error ? error : new Error("Harness conformance failed");
    for (const waiter of pending.values()) waiter.reject(fatal);
    pending.clear();
    rejectFailure(fatal);
  };
  const timer = setTimeout(() => fail(new HarnessProtocolError("harness conformance deadline exceeded", "harness_conformance_timeout")), timeoutMs);
  const abort = () => fail(input.signal?.reason ?? new Error("Harness conformance aborted"));
  input.signal?.addEventListener("abort", abort, { once: true });
  child.on("error", error => { fail(error); resolveExit(null); });
  child.on("close", code => {
    didExit = true;
    resolveExit(code);
    if (pending.size) fail(new HarnessProtocolError("harness exited before replying", "harness_process_lost"));
  });
  // Consume diagnostics to avoid pipe backpressure. Never include provider output
  // in the public report: it may contain credentials supplied by the caller.
  child.stderr.on("data", () => {});
  child.stdin.on("error", fail);
  child.stdout.on("data", (chunk: Buffer) => {
    if (fatal) return;
    try {
      let start = 0;
      for (;;) {
        const newline = chunk.indexOf(10, start);
        if (newline < 0) break;
        if (remainder.length + newline - start > HARNESS_MAX_FRAME_BYTES) throw new HarnessProtocolError("harness conformance frame exceeds byte limit");
        const line = remainder.length ? Buffer.concat([remainder, chunk.subarray(start, newline)]) : chunk.subarray(start, newline);
        remainder = Buffer.alloc(0);
        const value = parseHarnessFrameText(new TextDecoder("utf-8", { fatal: true }).decode(line));
        if (value !== null && typeof value === "object" && "id" in value) {
          const response: HarnessResponse = parseHarnessResponse(value);
          const waiter = pending.get(response.id);
          if (!waiter) throw new HarnessProtocolError("harness replied to an unknown or settled request");
          pending.delete(response.id);
          if (response.ok && waiter.method === "initialize") {
            // Admit before parsing the next frame in this same stdout chunk.
            // The successful response must independently bind the release.
            if (!sameRunnerHarnessRelease(identity, parseRunnerHarnessReleaseIdentity(response.result.identity))) {
              throw new HarnessProtocolError("harness conformance identity mismatch");
            }
            admittedCapabilities = parseHarnessCapabilities(response.result.capabilities);
            admission = "ready";
          }
          if (waiter.method === "close") admission = "closed";
          if (response.ok) waiter.resolve(response.result);
          else waiter.reject(new HarnessProtocolError(response.error.message, response.error.code));
        } else {
          if (admission !== "ready" && admission !== "closing") {
            throw new HarnessProtocolError("harness events require initialized admission and must stop after the close response");
          }
          const event = parseHarnessEvent(value);
          if (event.sequence !== expectedSequence++) throw new HarnessProtocolError("harness event sequence contains a gap or duplicate");
          retainedBytes += line.length;
          if (events.length >= 1024 || retainedBytes > 8 * HARNESS_MAX_FRAME_BYTES) throw new HarnessProtocolError("harness conformance event retention limit exceeded");
          events.push(event);
          for (const wake of eventWaiters) wake();
        }
        start = newline + 1;
      }
      const tail = chunk.subarray(start);
      if (remainder.length + tail.length > HARNESS_MAX_FRAME_BYTES) throw new HarnessProtocolError("harness conformance frame exceeds byte limit");
      remainder = remainder.length ? Buffer.concat([remainder, tail]) : Buffer.from(tail);
    } catch (error) { fail(error); }
  });
  const request = (method: HarnessMethod, params: JsonObject = {}): Promise<JsonObject> => {
    if (fatal) return Promise.reject(fatal);
    const id = ++nextId;
    return Promise.race([failure, new Promise<JsonObject>((resolve, reject) => {
      const frame = serializeHarnessFrame({ schema: HARNESS_PROTOCOL_SCHEMA, id, method, params });
      pending.set(id, { method, resolve, reject });
      if (method === "close") admission = "closing";
      child.stdin.write(frame, error => { if (error) fail(error); });
    })]);
  };
  try {
    await request("initialize", { ...input.initializeParams, identity: identity as unknown as JsonObject });
    if (admittedCapabilities === undefined) throw new HarnessProtocolError("harness initialization did not establish admission");
    const capabilities = admittedCapabilities;
    const commandResults: JsonObject[] = [];
    for (const command of input.commands) commandResults.push(await request("execute", { command: command as unknown as JsonObject }));
    const required = input.requiredEventTypes ?? [];
    const allEventsSeen = () => required.every(type => events.some(event => event.eventType === type));
    if (!allEventsSeen()) await Promise.race([failure, new Promise<void>(resolve => {
      const wake = () => { if (allEventsSeen()) { eventWaiters.delete(wake); resolve(); } };
      eventWaiters.add(wake);
      wake();
    })]);
    const snapshot = capabilities.resume === true || input.requireSnapshot === true ? await request("snapshot") : undefined;
    await request("close", { reason: "conformance_complete" });
    child.stdin.end();
    const exitCode = await Promise.race([failure, exited]);
    if (fatal) throw fatal;
    if (remainder.length) throw new HarnessProtocolError("harness exited with an incomplete frame");
    if (exitCode !== 0) throw new HarnessProtocolError("harness failed to exit successfully after close");
    if (process.platform !== "win32" && child.pid) {
      try {
        process.kill(-child.pid, 0);
        throw new HarnessProtocolError("harness descendants remain after successful parent exit", "harness_cleanup_incomplete");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    return { schema: "paperclip.harness-process-conformance.v1", identity, capabilities,
      commandResults, events, ...(snapshot === undefined ? {} : { snapshot }), exitCode: 0 };
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", abort);
    eventWaiters.clear();
    child.stdin.destroy();
    // Own the entire test process group, including children whose parent already
    // exited. Always release it; cleanup never substitutes for a passing report.
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    };
    kill("SIGTERM");
    if (!didExit) {
      let grace: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([exited, new Promise<void>(resolve => { grace = setTimeout(resolve, 1000); })]);
      clearTimeout(grace);
    }
    kill("SIGKILL");
    child.stdout.destroy(); child.stderr.destroy();
    for (const waiter of pending.values()) waiter.reject(new HarnessProtocolError("harness conformance closed"));
    pending.clear();
  }
}
