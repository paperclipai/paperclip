import {
  raceLoginRunnerExit,
  type LoginRunnerDisposable,
  type LoginRunnerLifecycleOptions,
  type LoginRunnerOutcome,
  type LoginRunnerResult,
} from "@paperclipai/adapter-utils";
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
 * directly; a caller injects a concrete driver. A production driver binds `start`
 * to the shared login pseudo-terminal (PTY) transport, binds `readFile` to a
 * descriptor-bound credential read, and binds `dispose` to the transport dispose.
 *
 * The `start` shape matches the shared login pseudo-terminal transport start
 * method, so the driver runs the login command on a real pseudo-terminal. The
 * login command
 * needs a pseudo-terminal: pipe stdio emits no login prompt. The runner never
 * calls `stop` or `write` on the driver; the device-login flow needs no delayed
 * input, and the service owns the sandbox delete. The runner disposes the driver
 * one time on every terminal state.
 */
export interface SandboxLoginDriver extends LoginRunnerDisposable {
  /**
   * Starts `command` on a pseudo-terminal and streams the terminal output to
   * `onData` in memory, in order, as the pseudo-terminal emits it. Resolves with
   * the command exit code when the command ends. A driver must not persist the raw
   * output to any durable log.
   */
  start(command: string, onData: (chunk: string) => void): Promise<{ exitCode: number | null }>;
  /**
   * Reads the credential bytes with one descriptor-bound read. The read is
   * separate from the pseudo-terminal session; the session has no file-read
   * method. A driver runs one fixed, server-controlled operation that opens the
   * verified session home and the credential file with no symlink follow, checks
   * the opened descriptor, and reads only from that same descriptor.
   */
  readFile(path: string): Promise<Buffer>;
}

/** Receives the parsed prompt one time in memory. The caller displays it. */
export type DeviceLoginPromptSink = (prompt: DeviceLoginPrompt) => void;

/** The device-login runner outcome. It is a fixed, non-secret status. */
export type DeviceLoginOutcome = LoginRunnerOutcome;

/** The runner result. It never carries a URL, a code, or a token byte. */
export type DeviceLoginResult = LoginRunnerResult;

export interface RunDeviceLoginOptions extends LoginRunnerLifecycleOptions {
  /** The login command. Defaults to {@link CODEX_DEVICE_LOGIN_COMMAND}. */
  command?: string;
  /** Parses the prompt from the login output. Defaults to
   *  {@link parseDeviceLoginPrompt}. */
  parsePrompt?: (output: string) => DeviceLoginPrompt | null;
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
  const parsePrompt = options.parsePrompt ?? parseDeviceLoginPrompt;
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
    const prompt = parsePrompt(buffer);
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

    const started = driver.start(command, onStdout);
    const raced = await raceLoginRunnerExit(started, timeoutMs, signal);

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
