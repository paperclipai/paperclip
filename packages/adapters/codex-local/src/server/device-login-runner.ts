import { parseDeviceLoginPrompt, type DeviceLoginPrompt } from "./device-login-parse.js";

// The device-login runner. It runs the Codex device-login command through an
// injected {@link SandboxLoginDriver}, surfaces the login prompt one time in
// memory, and handles a timeout and a cancellation. The runner always disposes
// the driver.
//
// Security (Control 1 — secret handling): the runner treats every byte of the
// sandbox stream as secret-bearing, untrusted input. It parses the stream in an
// in-memory buffer only. It drops the buffer as soon as it finds the prompt. It
// never forwards the raw text to a log or an artifact, and it never stores the
// raw text on the result. The runner reports only a fixed, non-secret status. It
// passes the prompt one time through the in-memory `onPrompt` callback. It passes
// the credential bytes one time through the in-memory `onCredential` callback.
// The runner keeps the URL, the code, and any token byte out of every log line
// and every thrown error.

/** The default Codex device-login command. */
export const CODEX_DEVICE_LOGIN_COMMAND = "codex login --device-auth";

/**
 * The maximum number of characters the runner keeps for the next chunk. The
 * Codex prompt is small and puts the URL and the code close together. A sandbox
 * can stream a large volume of output before the prompt. So after each parse the
 * runner keeps only the most recent characters up to this limit. The retained
 * buffer cannot grow without a bound across many chunks. The limit is far larger
 * than the prompt, so the trailing window never drops a real prompt that spans a
 * chunk boundary.
 */
const MAX_PARSE_BUFFER_CHARS = 64 * 1024;

/**
 * The sandbox side of the device-login run. The runner never calls Daytona
 * directly; a caller injects a concrete driver. A production driver binds these
 * three methods to a non-persisting Daytona exec path, a file read, and a
 * sandbox delete.
 */
export interface SandboxLoginDriver {
  /**
   * Runs `command` in the sandbox and streams standard output to `onStdout` in
   * memory. Resolves with the command exit code when the command ends. A driver
   * must not persist the raw output to any durable log.
   */
  execStreaming(command: string, onStdout: (chunk: string) => void): Promise<{ exitCode: number | null }>;
  /** Reads the bytes of one file from the sandbox. */
  readFile(path: string): Promise<Buffer>;
  /** Deletes the sandbox and releases its resources. */
  dispose(): Promise<void>;
}

/** Receives the parsed prompt one time in memory. The caller displays it. */
export type DeviceLoginPromptSink = (prompt: DeviceLoginPrompt) => void;

export type DeviceLoginOutcome = "success" | "failure" | "timeout" | "cancelled";

/** The runner result. It never carries a URL, a code, or a token byte. */
export interface DeviceLoginResult {
  outcome: DeviceLoginOutcome;
  exitCode: number | null;
  promptSurfaced: boolean;
}

export interface RunDeviceLoginOptions {
  /** The login command. Defaults to {@link CODEX_DEVICE_LOGIN_COMMAND}. */
  command?: string;
  /** Receives the parsed prompt one time in memory. The caller displays it. */
  onPrompt: DeviceLoginPromptSink;
  /**
   * Receives the sandbox `auth.json` bytes one time in memory on success. The
   * runner reads the bytes with {@link SandboxLoginDriver.readFile} before it
   * disposes the driver. Set together with {@link authPath}.
   */
  onCredential?: (authBytes: Buffer) => void | Promise<void>;
  /** The sandbox path of the credential file to read on success. */
  authPath?: string;
  /** The host-side timeout in milliseconds. */
  timeoutMs: number;
  /** An optional cancellation signal. */
  signal?: AbortSignal;
  /** A non-leaking progress sink. It receives only fixed status lines. */
  log?: (line: string) => void;
}

type RaceResult =
  | { kind: "exit"; exitCode: number | null }
  | { kind: "timeout" }
  | { kind: "cancelled" };

/**
 * Races the streaming exec against the timeout and the cancellation signal. The
 * exec result resolves the race; the timeout and the signal resolve the race
 * with a terminal status. A driver error rejects the race, so the caller can
 * convert it to a fixed, non-secret error. A late exec rejection after the race
 * already settled is consumed here, so it never becomes an unhandled rejection.
 */
function raceExec(
  exec: Promise<{ exitCode: number | null }>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<RaceResult> {
  return new Promise<RaceResult>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
    };
    const finish = (run: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      run();
    };
    const timer = setTimeout(() => finish(() => resolve({ kind: "timeout" })), timeoutMs);
    const onAbort = () => finish(() => resolve({ kind: "cancelled" }));
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    exec.then(
      (value) => finish(() => resolve({ kind: "exit", exitCode: value.exitCode })),
      (error) => finish(() => reject(error)),
    );
  });
}

/**
 * Runs the device-login command through `driver`. Surfaces the prompt one time
 * through `onPrompt`. On success it reads the credential and surfaces the bytes
 * one time through `onCredential`. Returns a fixed status. Always disposes the
 * driver. Never logs the raw stream, and never puts a URL, a code, or a token
 * into a log line, the result, or a thrown error.
 */
export async function runDeviceLogin(
  driver: SandboxLoginDriver,
  options: RunDeviceLoginOptions,
): Promise<DeviceLoginResult> {
  const { onPrompt, onCredential, authPath, timeoutMs, signal } = options;
  const command = options.command ?? CODEX_DEVICE_LOGIN_COMMAND;
  const log = options.log ?? (() => {});

  let promptSurfaced = false;
  // The in-memory parse buffer. The runner drops it as soon as it finds the
  // prompt, so the secret-bearing stream never lives longer than one parse. The
  // runner parses the full buffer, and it includes the whole new chunk. So a
  // prompt at the start of one large chunk still parses. The runner bounds only
  // the buffer that it keeps for the next chunk to {@link MAX_PARSE_BUFFER_CHARS}.
  // The runner keeps the trailing window and drops the oldest characters. The
  // prompt puts the URL and the code close together, so the trailing window
  // always holds a real prompt that spans a chunk boundary.
  let buffer = "";
  const onStdout = (chunk: string): void => {
    if (promptSurfaced) return;
    buffer += chunk;
    const prompt = parseDeviceLoginPrompt(buffer);
    if (prompt) {
      promptSurfaced = true;
      buffer = "";
      onPrompt(prompt);
      return;
    }
    if (buffer.length > MAX_PARSE_BUFFER_CHARS) {
      buffer = buffer.slice(buffer.length - MAX_PARSE_BUFFER_CHARS);
    }
  };

  try {
    if (signal?.aborted) {
      log("[paperclip] Device login cancelled before start.");
      return { outcome: "cancelled", exitCode: null, promptSurfaced };
    }

    const exec = driver.execStreaming(command, onStdout);
    const raced = await raceExec(exec, timeoutMs, signal);

    if (raced.kind === "timeout") {
      log("[paperclip] Device login timed out; disposing the sandbox.");
      return { outcome: "timeout", exitCode: null, promptSurfaced };
    }
    if (raced.kind === "cancelled") {
      log("[paperclip] Device login cancelled; disposing the sandbox.");
      return { outcome: "cancelled", exitCode: null, promptSurfaced };
    }

    const exitCode = raced.exitCode;
    if (exitCode !== 0) {
      log("[paperclip] Device login command ended with a non-zero exit code.");
      return { outcome: "failure", exitCode, promptSurfaced };
    }

    if (onCredential && authPath) {
      const authBytes = await driver.readFile(authPath);
      await onCredential(authBytes);
    }
    log("[paperclip] Device login command ended successfully.");
    return { outcome: "success", exitCode, promptSurfaced };
  } catch {
    // Convert any driver error to a fixed, non-secret error. The original error
    // may embed streamed bytes, so the runner never propagates its message.
    throw new Error("device login failed: the sandbox login command errored.");
  } finally {
    // Always dispose the driver. A dispose error must not leak or mask the
    // result, so the runner swallows it and logs a fixed line.
    try {
      await driver.dispose();
    } catch {
      log("[paperclip] Device login: the sandbox dispose step errored.");
    }
  }
}
