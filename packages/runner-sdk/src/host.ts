import type { Readable, Writable } from "node:stream";
import {
  HARNESS_MAX_FRAME_BYTES, HARNESS_PROTOCOL_SCHEMA, HarnessProtocolError,
  type HarnessCommand, type HarnessEventFact, type HarnessRequest, type HarnessResponse,
  type JsonObject, type RunnerHarnessCapabilities, type RunnerHarnessReleaseIdentity,
} from "./types.js";
import { parseHarnessCommand, parseHarnessEvent, parseHarnessFrameText, parseHarnessRequest, serializeHarnessFrame } from "./protocol.js";
import { parseHarnessCapabilities, parseRunnerHarnessReleaseIdentity, sameRunnerHarnessRelease } from "./declaration.js";
import { jsonObject } from "./validation.js";

/** Methods acknowledge admission; ongoing provider work emits events separately. */
export interface HarnessHostContext {
  readonly signal: AbortSignal;
  /** Await this promise to preserve output backpressure. */
  emit(event: HarnessEventFact): Promise<void>;
}

export interface HarnessHostHandlers {
  identity: RunnerHarnessReleaseIdentity;
  capabilities: RunnerHarnessCapabilities;
  initialize?(params: JsonObject, context: HarnessHostContext): Promise<JsonObject> | JsonObject;
  execute(command: HarnessCommand, context: HarnessHostContext): Promise<JsonObject> | JsonObject;
  snapshot?(params: JsonObject, context: HarnessHostContext): Promise<JsonObject> | JsonObject;
  /** Must dispose owned native work and flush provider persistence. */
  close(params: JsonObject, context: HarnessHostContext): Promise<JsonObject> | JsonObject;
}

export interface HarnessHostOptions {
  input?: Readable;
  output?: Writable;
  /** Diagnostic callback must never write to the protocol output stream. */
  diagnostic?: (message: string) => void;
  /** Bounds queued protocol output; defaults to four frames. */
  maxQueuedOutputBytes?: number;
  /** Cleanup must settle in this time; the Runner still owns physical kill. */
  shutdownTimeoutMs?: number;
}

const INTERRUPTING_COMMANDS = new Set([
  "turn.interrupt", "turn.stop", "run.cancel", "session.close", "session.destroy",
  "runner.shutdown", "runner.suspend",
]);
const CALLBACK_COMMANDS = new Set(["request.resolve", "interaction.receipt", "semantic_tool.result"]);
const EXTERNAL_CALLBACK_ACTIONS = new Set(["tool", "finish", "request_user_input", "consume_input"]);
const MAX_PENDING_REQUESTS = 128;

/**
 * Serve one trusted harness subprocess. EOF revokes admission and drains native
 * work. No polling, process spawning, package resolution or provider code lives
 * in this host. Runner owns persistent command deduplication and PRP authority.
 */
export async function serveHarness(handlers: HarnessHostHandlers, options: HarnessHostOptions = {}): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const diagnostic = options.diagnostic ?? (message => { process.stderr.write(`${message}\n`); });
  const identity = parseRunnerHarnessReleaseIdentity(handlers.identity);
  const capabilities = parseHarnessCapabilities(handlers.capabilities);
  const maxQueuedOutputBytes = options.maxQueuedOutputBytes ?? HARNESS_MAX_FRAME_BYTES * 4;
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? 10_000;
  if (!Number.isSafeInteger(maxQueuedOutputBytes) || maxQueuedOutputBytes < HARNESS_MAX_FRAME_BYTES
    || !Number.isSafeInteger(shutdownTimeoutMs) || shutdownTimeoutMs < 1 || shutdownTimeoutMs > 30_000) {
    throw new HarnessProtocolError("invalid harness host limits");
  }
  let state: "new" | "initializing" | "ready" | "closing" | "closed" = "new";
  let sequence = 0;
  let workGeneration = 0;
  let lastRequestId = 0;
  let queuedOutputBytes = 0;
  let outputQueue = Promise.resolve();
  let outputFailure: Error | undefined;
  const outputWaiters = new Set<(error: Error) => void>();
  let workQueue = Promise.resolve();
  let initialization: Promise<void> = Promise.resolve();
  let closeTask: Promise<JsonObject> | undefined;
  let fatal: Error | undefined;
  const fail = (error: unknown) => {
    fatal ??= asError(error);
    if (!input.destroyed) input.destroy(fatal);
  };
  output.on("error", fail);
  const pending = new Set<Promise<void>>();
  const lifetime = new AbortController();
  // Acknowledged commands can retain their context for ongoing native work.
  // Its signal therefore outlives the response and is revoked by Stop/close.
  let workLifetime = new AbortController();

  const write = (frame: string): Promise<void> => {
    if (outputFailure) throw outputFailure;
    const bytes = Buffer.byteLength(frame);
    if (queuedOutputBytes + bytes > maxQueuedOutputBytes) throw new HarnessProtocolError("harness output backpressure limit exceeded");
    queuedOutputBytes += bytes;
    const previous = outputQueue;
    const task = new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error | null) => {
        if (settled) return;
        settled = true;
        outputWaiters.delete(cancel);
        queuedOutputBytes -= bytes;
        if (error) reject(error); else resolve();
      };
      const cancel = (error: Error) => finish(error);
      outputWaiters.add(cancel);
      void previous.then(() => {
        // A cancelled queued write must never resume after shutdown, even if
        // an earlier stalled stream callback eventually becomes writable.
        if (outputFailure) { finish(outputFailure); return; }
        try { output.write(frame, finish); }
        catch (error) { finish(asError(error)); }
      });
    });
    // Retain the failure for every subsequent write without an unhandled rejection.
    outputQueue = task.catch(fail);
    return task;
  };
  const revokeOutput = (error: Error, destroy: boolean) => {
    outputFailure ??= error;
    for (const cancel of [...outputWaiters]) cancel(outputFailure);
    if (destroy) output.destroy();
  };
  const emit: HarnessHostContext["emit"] = async event => {
    if (state !== "ready") throw new HarnessProtocolError("harness cannot publish events before initialization or after close", "harness_not_active");
    const nextSequence = sequence + 1;
    const frame = parseHarnessEvent({ ...event, schema: HARNESS_PROTOCOL_SCHEMA, sequence: nextSequence });
    const written = write(serializeHarnessFrame(frame));
    sequence = nextSequence;
    await written;
  };
  const context = (controller = workLifetime): HarnessHostContext => ({ signal: controller.signal,
    emit: event => {
      if (controller.signal.aborted) return Promise.reject(new HarnessProtocolError("harness operation was cancelled", "harness_operation_cancelled"));
      return emit(event);
    } });
  const cleanup = (params: JsonObject): Promise<JsonObject> => {
    if (closeTask) return closeTask;
    state = "closing";
    lifetime.abort(new Error("harness ownership revoked"));
    workLifetime.abort(lifetime.signal.reason);
    const disposal = Promise.resolve().then(() => handlers.close(params, context()));
    closeTask = within(disposal, shutdownTimeoutMs).then(value => {
      state = "closed";
      return jsonObject(value, "close result");
    });
    return closeTask;
  };
  const reply = async (id: number, task: () => Promise<JsonObject>): Promise<void> => {
    let response: HarnessResponse;
    try {
      response = { schema: HARNESS_PROTOCOL_SCHEMA, id, ok: true, result: jsonObject(await task(), "handler result") };
    } catch (error) {
      // Provider diagnostics may contain credentials. Only explicit protocol
      // errors are exposed; the integration owns its own sanitized diagnostics.
      diagnostic(error instanceof HarnessProtocolError ? error.message : "Harness handler failed");
      response = { schema: HARNESS_PROTOCOL_SCHEMA, id, ok: false, error: {
        code: error instanceof HarnessProtocolError ? error.code : "harness_handler_failed",
        message: error instanceof HarnessProtocolError ? error.message : "Harness handler failed",
        retryable: false,
      } };
    }
    await write(serializeHarnessFrame(response));
  };

  const dispatch = (request: HarnessRequest): void => {
    if (request.id <= lastRequestId) throw new HarnessProtocolError("harness request ids must increase monotonically");
    lastRequestId = request.id;
    if (pending.size >= MAX_PENDING_REQUESTS) throw new HarnessProtocolError("too many pending harness requests");
    const requestState = state;
    let task: Promise<void>;
    if (request.method === "initialize") {
      if (state !== "new") throw new HarnessProtocolError("harness is already initialized");
      const expected = parseRunnerHarnessReleaseIdentity(request.params.identity);
      if (!sameRunnerHarnessRelease(identity, expected)) throw new HarnessProtocolError("harness release identity does not match admission", "harness_identity_mismatch");
      state = "initializing";
      initialization = Promise.resolve().then(async () => {
        const result = await handlers.initialize?.(request.params, context()) ?? {};
        if (lifetime.signal.aborted) throw new HarnessProtocolError("harness closed during initialization", "harness_not_active");
        state = "ready";
        await write(serializeHarnessFrame({ schema: HARNESS_PROTOCOL_SCHEMA, id: request.id, ok: true,
          result: { ...jsonObject(result, "initialize result"), identity: identity as unknown as JsonObject, capabilities } }));
      });
      task = initialization.catch(async error => {
        fail(error);
        await reply(request.id, async () => { throw error; });
      });
    } else if (request.method === "close") {
      task = reply(request.id, () => cleanup(request.params));
    } else {
      const command = request.method === "execute" ? parseHarnessCommand(request.params.command) : undefined;
      const interrupting = command !== undefined && INTERRUPTING_COMMANDS.has(command.type);
      const externalCallback = command?.type === "external_provider.operation"
        && typeof command.payload.action === "string" && EXTERNAL_CALLBACK_ACTIONS.has(command.payload.action);
      const bypassQueue = interrupting || externalCallback || (command !== undefined && CALLBACK_COMMANDS.has(command.type));
      if (interrupting) {
        workGeneration += 1;
        workLifetime.abort(new Error(`harness ${command.type}`));
        workLifetime = new AbortController();
      }
      const generation = workGeneration;
      const controller = workLifetime;
      const run = async () => {
        if (requestState === "new") throw new HarnessProtocolError("harness requires initialization", "harness_not_initialized");
        await initialization;
        if (state !== "ready") throw new HarnessProtocolError("harness admission is closed", "harness_not_active");
        if (generation !== workGeneration) throw new HarnessProtocolError("queued harness operation was cancelled", "harness_operation_cancelled");
        if (command) return jsonObject(await handlers.execute(command, context(controller)), "execute result");
        if (!handlers.snapshot) throw new HarnessProtocolError("harness does not support snapshot", "capability_unavailable");
        return jsonObject(await handlers.snapshot(request.params, context(controller)), "snapshot result");
      };
      const priorWork = workQueue;
      task = reply(request.id, () => bypassQueue ? run() : priorWork.then(run));
      if (!bypassQueue) workQueue = task;
    }
    pending.add(task);
    void task.catch(fail).finally(() => pending.delete(task));
  };

  let remainder = Buffer.alloc(0);
  try {
    for await (const raw of input) {
      if (fatal) throw fatal;
      const chunk = typeof raw === "string" ? Buffer.from(raw) : Buffer.from(raw as Uint8Array);
      let start = 0;
      for (;;) {
        const end = chunk.indexOf(10, start);
        if (end < 0) break;
        const size = remainder.length + end - start;
        if (size > HARNESS_MAX_FRAME_BYTES) throw new HarnessProtocolError("harness input exceeds frame byte limit");
        const line = remainder.length ? Buffer.concat([remainder, chunk.subarray(start, end)]) : chunk.subarray(start, end);
        remainder = Buffer.alloc(0);
        const decoded = new TextDecoder("utf-8", { fatal: true }).decode(line);
        dispatch(parseHarnessRequest(parseHarnessFrameText(decoded)));
        start = end + 1;
      }
      const tail = chunk.subarray(start);
      if (remainder.length + tail.length > HARNESS_MAX_FRAME_BYTES) throw new HarnessProtocolError("harness input exceeds frame byte limit");
      remainder = remainder.length ? Buffer.concat([remainder, tail]) : Buffer.from(tail);
    }
    if (remainder.length) throw new HarnessProtocolError("harness input ended with an incomplete frame");
  } catch (error) {
    fatal ??= asError(error);
  } finally {
    let drained = false;
    try {
      // Native disposal, pending replies and the final stdout drain share one
      // deadline. A blocked pipe cannot keep ownership alive indefinitely.
      await within((async () => {
        await cleanup({ reason: fatal ? "protocol_failure" : "input_closed" });
        await Promise.allSettled([...pending]);
        await outputQueue;
      })(), shutdownTimeoutMs);
      drained = true;
    } catch (error) { fatal ??= asError(error); }
    finally {
      state = "closed";
      revokeOutput(fatal ?? new HarnessProtocolError("harness output is closed", "harness_not_active"), !drained);
      output.removeListener("error", fail);
    }
  }
  if (fatal) throw fatal;
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error("Harness host failed");
}

async function within<T>(task: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([task, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new HarnessProtocolError("harness cleanup exceeded its deadline", "harness_cleanup_timeout")), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}
