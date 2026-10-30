import {
  raceLoginRunnerExit,
  type LoginRunnerDisposable,
  type LoginRunnerLifecycleOptions,
  type LoginRunnerOutcome,
  type LoginRunnerResult,
} from "@paperclipai/adapter-utils";
import {
  parseSetupTokenCredential,
  parseSetupTokenPrompt,
  type SetupTokenPrompt,
} from "./setup-token-parse.js";

// The Claude `setup-token` login runner. It starts `claude setup-token` through
// an injected {@link SetupTokenPtyDriver}, surfaces the sign-in prompt one time
// in memory, accepts one browser code, sends the code to the matched prompt, and
// delivers the minted OAuth token one time. It handles a timeout and a
// cancellation, and it stops the child for every terminal state.
//
// Security (secret handling): the runner treats every byte of the terminal
// stream as secret-bearing, untrusted input. It parses the stream in an in-memory
// buffer only. It drops the prompt buffer as soon as it finds the prompt, and it
// drops the token buffer as soon as it binds the token. It never forwards the raw
// text to a log or an artifact, and it never stores the raw text on the result.
// The runner reports only a fixed, non-secret status. It passes the prompt one
// time through the in-memory `onPrompt` callback. It reads the browser code one
// time through the in-memory `provideCode` callback and writes the code only to
// the child, only after it matches the prompt. It delivers the token one time
// through the in-memory `onCredential` sink. The runner keeps the URL, the code,
// and any token byte out of every log line and every thrown error.
//
// Fail-closed credential delivery. The `onCredential` sink is mandatory and
// awaited. The runner binds the token from the exact success record with
// {@link parseSetupTokenCredential}, then it awaits the sink one time. It sets
// `credentialDelivered` true only after the sink resolves. A missing sink, a
// success stream with no token, and a sink rejection each end the run as a
// failure; the runner never reports success without a resolved sink. The runner
// zeros the token bytes in a `finally` block on every path, so the secret never
// outlives the delivery.

/** The fixed Claude setup-token command. The login flow needs a PTY. */
export const CLAUDE_SETUP_TOKEN_COMMAND = "claude setup-token";

/**
 * The submission terminator for the browser code. The interactive login UI reads
 * the code on a PTY and submits it on a carriage return. The runner writes this
 * terminator as its own write, after the code write and a short settle delay.
 * The live characterization showed that a single write of `code + "\r"` does not
 * submit: the input is an Ink text field with paste handling, so a glued
 * carriage return folds into the pasted text instead of a Return key, and the
 * login stalls at the prompt. Two writes with a settle gap submit on the first
 * Return.
 */
export const CODE_SUBMISSION_TERMINATOR = "\r";

/**
 * The default settle delay in milliseconds between the code write and the
 * terminator write. The delay lets the Ink paste buffer settle, so the terminator
 * arrives as a distinct Return key. A caller can override it; a test sets it to 0.
 */
export const CODE_SUBMIT_SETTLE_MS = 150;

/**
 * The maximum number of characters the runner keeps for the next chunk. The
 * login prompt is small and puts the URL and the prompt line close together. A
 * sandbox can stream a large volume of output before the prompt. So after each
 * parse the runner keeps only the most recent characters up to this limit. The
 * retained buffer cannot grow without a bound across many chunks. The limit is
 * far larger than the prompt, so the trailing window never drops a real prompt
 * that spans a chunk boundary.
 */
export const CLAUDE_SETUP_TOKEN_MAX_BUFFER_CHARS = 64 * 1024;

/**
 * The child side of the setup-token run. The runner never spawns the PTY
 * directly; a caller injects a concrete driver. A production driver binds these
 * methods to a PTY child that runs {@link CLAUDE_SETUP_TOKEN_COMMAND}.
 */
export interface SetupTokenPtyDriver extends LoginRunnerDisposable {
  /**
   * Starts `command` in a PTY and streams the terminal output to `onData` in
   * memory. Resolves with the child exit code when the child ends. A driver must
   * not persist the raw output to any durable log.
   */
  start(command: string, onData: (chunk: string) => void): Promise<{ exitCode: number | null }>;
  /**
   * Writes `input` to the child PTY. The runner writes the browser code plus the
   * submission terminator one time, only after it matches the prompt.
   */
  write(input: string): void;
  /**
   * Stops the child process with a direct child stop. The characterization showed
   * that the child needs `SIGKILL`. The method must be safe to call before start
   * and safe to call more than one time.
   */
  stop(): void;
}

/** Receives the parsed prompt one time in memory. The caller displays it. */
export type SetupTokenPromptSink = (prompt: SetupTokenPrompt) => void;

/**
 * Returns the one browser code the user pastes from the sign-in page. The runner
 * calls it one time, only after it surfaces the prompt. The runner passes an
 * abort signal, so the provider can stop when the runner cancels or times out.
 */
export type SetupTokenCodeProvider = (signal: AbortSignal) => Promise<string>;

/**
 * Receives the credential bytes one time in memory on success. The runner binds
 * the token from the success record, then it awaits this sink one time with the
 * token bytes. The sink is mandatory and it returns a promise; the runner awaits
 * that promise before it reports success. A sink rejection ends the run as a
 * failure. The runner never logs the bytes and never stores them on the result.
 */
export type SetupTokenCredentialSink = (authBytes: Buffer) => Promise<void>;

/** The setup-token runner outcome. It is a fixed, non-secret status. */
export type SetupTokenOutcome = LoginRunnerOutcome;

/**
 * The runner result. It never carries a URL, a code, or a token byte. It extends
 * the base result with the two setup-token status fields.
 */
export interface SetupTokenLoginResult extends LoginRunnerResult {
  codeSubmitted: boolean;
  /** True when the runner bound the token and invoked `onCredential` one time. */
  credentialDelivered: boolean;
}

export interface RunSetupTokenLoginOptions extends LoginRunnerLifecycleOptions {
  /** The login command. Defaults to {@link CLAUDE_SETUP_TOKEN_COMMAND}. */
  command?: string;
  /** Receives the parsed prompt one time in memory. The caller displays it. */
  onPrompt: SetupTokenPromptSink;
  /** Returns the one browser code. The runner writes it to the matched prompt. */
  provideCode: SetupTokenCodeProvider;
  /**
   * The credential sink. The runner awaits it one time with the token bytes and
   * reports success only after it resolves. The sink is mandatory for a
   * successful run: a missing sink ends the run as a failure. The option stays
   * optional so a caller can drive a fail-closed path with no sink.
   */
  onCredential?: SetupTokenCredentialSink;
  /**
   * The settle delay in milliseconds between the code write and the terminator
   * write. Defaults to {@link CODE_SUBMIT_SETTLE_MS}. A test sets it to 0.
   */
  codeSubmitSettleMs?: number;
}

/**
 * Waits `ms` milliseconds, or resolves at once when the signal aborts. The
 * routine lets the Ink paste buffer settle between the code write and the
 * terminator write. It never rejects; a caller checks the signal after it
 * resolves. A zero or negative delay resolves on the next microtask.
 */
function settleDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * Stops the child and releases the driver for a terminal state. The runner calls
 * this on every exit path: a normal exit, a non-zero exit, a timeout, a
 * cancellation, and an error. It first runs a direct child stop, then it disposes
 * the driver. A stop error or a dispose error must not leak or mask the result,
 * so the function swallows each error and logs a fixed line.
 */
async function stopAndDispose(driver: SetupTokenPtyDriver, log: (line: string) => void): Promise<void> {
  try {
    driver.stop();
  } catch {
    log("[paperclip] Setup-token login: the process stop step errored.");
  }
  try {
    await driver.dispose();
  } catch {
    log("[paperclip] Setup-token login: the driver dispose step errored.");
  }
}

/**
 * Runs the setup-token login through `driver`. Surfaces the prompt one time
 * through `onPrompt`. Reads the browser code one time through `provideCode` and
 * writes it to the matched prompt. Binds the minted token from the success
 * record and delivers it one time through `onCredential`. Returns a fixed status.
 * Stops the child and disposes the driver for every terminal state. Never logs
 * the raw stream, and never puts a URL, a code, or a token into a log line, the
 * result, or a thrown error.
 */
export async function runSetupTokenLogin(
  driver: SetupTokenPtyDriver,
  options: RunSetupTokenLoginOptions,
): Promise<SetupTokenLoginResult> {
  const { onPrompt, provideCode, onCredential, timeoutMs, signal } = options;
  const command = options.command ?? CLAUDE_SETUP_TOKEN_COMMAND;
  const codeSubmitSettleMs = options.codeSubmitSettleMs ?? CODE_SUBMIT_SETTLE_MS;
  const log = options.log ?? (() => {});

  // A private controller that fans a timeout or a cancellation into the
  // code-input routine, so a pending `provideCode` stops when the run ends.
  const controller = new AbortController();
  const onExternalAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onExternalAbort, { once: true });
  }

  let promptSurfaced = false;
  let codeSubmitted = false;
  let submitStarted = false;
  // The runner sets this true one time, only after the mandatory sink resolves.
  let credentialDelivered = false;
  // The bound token bytes. The runner binds them from the success record during
  // the stream, holds them in memory only, awaits the sink one time after a
  // clean exit, and zeros them in a `finally` block on every path. A null value
  // means the runner never bound a token.
  let tokenBytes: Buffer | null = null;
  // The code-input routine runs beside the race. It is self-guarding and never
  // rejects, so an unresolved provider cannot become an unhandled rejection.
  let submitPromise: Promise<void> = Promise.resolve();

  // The in-memory prompt buffer. The runner drops it as soon as it finds the
  // prompt, so the secret-bearing stream never lives longer than one parse. The
  // runner parses the full buffer, and it includes the whole new chunk. So a
  // prompt at the start of one large chunk still parses. The runner bounds only
  // the buffer that it keeps for the next chunk to
  // {@link CLAUDE_SETUP_TOKEN_MAX_BUFFER_CHARS}. The runner keeps the trailing
  // window and drops the oldest characters.
  let buffer = "";
  // The in-memory token buffer. The runner accumulates the post-prompt stream
  // here, parses the full buffer before any truncation, and drops it as soon as
  // it binds the token. It bounds the retained window the same way as the prompt
  // buffer, so the secret-bearing stream never grows without a bound.
  let tokenBuffer = "";

  // Reads the browser code and writes it to the matched prompt one time. The
  // routine never throws: it logs a fixed line on a provider error or a write
  // error, so the code never reaches a log or a thrown error.
  const submitCode = async (): Promise<void> => {
    let code: string;
    try {
      code = await provideCode(controller.signal);
    } catch {
      log("[paperclip] Setup-token login: the code input step errored.");
      return;
    }
    if (controller.signal.aborted) return;
    try {
      // Write the code, let the Ink paste buffer settle, then write the Return as
      // its own write. A glued `code + "\r"` burst folds the Return into the
      // pasted text and never submits (live characterization). Two writes with a
      // settle gap submit on the first Return.
      driver.write(code);
      await settleDelay(codeSubmitSettleMs, controller.signal);
      if (controller.signal.aborted) return;
      driver.write(CODE_SUBMISSION_TERMINATOR);
      codeSubmitted = true;
      log("[paperclip] Setup-token login: sent the browser code to the prompt.");
    } catch {
      log("[paperclip] Setup-token login: the code input step errored.");
    }
  };

  // Binds the token from the token buffer one time and holds the bytes in
  // memory. The runner scans only when a caller provides an `onCredential` sink,
  // so it never holds the secret-bearing stream without a need. It drops the
  // token buffer as soon as the parser binds the token. The runner delivers the
  // bytes later, after a clean exit, through {@link deliverCredential}.
  const captureCredential = (): void => {
    if (!onCredential || tokenBytes) return;
    const token = parseSetupTokenCredential(tokenBuffer);
    if (!token) return;
    tokenBytes = Buffer.from(token, "utf8");
    tokenBuffer = "";
  };

  // Awaits the mandatory sink one time with the bound token bytes and reports
  // whether the credential landed. It returns false when the sink is missing,
  // when the runner bound no token, or when the sink rejects. It does not swallow
  // a sink rejection: it maps the rejection to a false result, so the caller ends
  // the run as a failure. It zeros the token bytes in a `finally` block on every
  // path, so the secret never outlives the delivery.
  const deliverCredential = async (): Promise<boolean> => {
    const bytes = tokenBytes;
    tokenBytes = null;
    if (!bytes) return false;
    try {
      if (!onCredential) return false;
      await onCredential(bytes);
      log("[paperclip] Setup-token login: delivered the credential to the sink.");
      return true;
    } catch {
      log("[paperclip] Setup-token login: the credential delivery step errored.");
      return false;
    } finally {
      bytes.fill(0);
    }
  };

  const onData = (chunk: string): void => {
    if (!promptSurfaced) {
      // Parse the full buffer before any truncation. This order finds an early
      // prompt inside one large chunk, so the runner never drops it.
      buffer += chunk;
      const prompt = parseSetupTokenPrompt(buffer);
      if (prompt) {
        promptSurfaced = true;
        buffer = "";
        onPrompt(prompt);
        log("[paperclip] Setup-token login: surfaced the sign-in prompt.");
        if (!submitStarted) {
          submitStarted = true;
          submitPromise = submitCode();
        }
        return;
      }
      if (buffer.length > CLAUDE_SETUP_TOKEN_MAX_BUFFER_CHARS) {
        buffer = buffer.slice(buffer.length - CLAUDE_SETUP_TOKEN_MAX_BUFFER_CHARS);
      }
      return;
    }
    // The prompt already surfaced. Scan the post-prompt stream for the success
    // token. The runner scans only when a caller provides an `onCredential`
    // sink, so it never holds the secret-bearing stream without a need.
    if (!onCredential || tokenBytes) return;
    tokenBuffer += chunk;
    captureCredential();
    if (!tokenBytes && tokenBuffer.length > CLAUDE_SETUP_TOKEN_MAX_BUFFER_CHARS) {
      tokenBuffer = tokenBuffer.slice(tokenBuffer.length - CLAUDE_SETUP_TOKEN_MAX_BUFFER_CHARS);
    }
  };

  const result = (outcome: SetupTokenOutcome, exitCode: number | null): SetupTokenLoginResult => ({
    outcome,
    exitCode,
    promptSurfaced,
    codeSubmitted,
    credentialDelivered,
  });

  try {
    if (signal?.aborted) {
      log("[paperclip] Setup-token login cancelled before start.");
      return result("cancelled", null);
    }

    const start = driver.start(command, onData);
    const raced = await raceLoginRunnerExit(start, timeoutMs, controller.signal);
    // Release a pending code-input routine, then let it settle. The routine is
    // self-guarding, so this await never rejects.
    controller.abort();
    await submitPromise;

    if (raced.kind === "timeout") {
      log("[paperclip] Setup-token login timed out; stopping the process.");
      return result("timeout", null);
    }
    if (raced.kind === "cancelled") {
      log("[paperclip] Setup-token login cancelled; stopping the process.");
      return result("cancelled", null);
    }

    const exitCode = raced.exitCode;
    if (exitCode !== 0) {
      log("[paperclip] Setup-token login command ended with a non-zero exit code.");
      return result("failure", exitCode);
    }

    // The command exited cleanly. Deliver the bound token through the mandatory
    // sink and await it. The runner fails closed: a missing sink, a clean exit
    // with no bound token, and a sink rejection each end the run as a failure. It
    // reports success only after the sink resolves.
    const delivered = await deliverCredential();
    if (!delivered) {
      log("[paperclip] Setup-token login: the credential did not land; treating the run as a failure.");
      return result("failure", exitCode);
    }
    credentialDelivered = true;

    log("[paperclip] Setup-token login command ended successfully.");
    return result("success", exitCode);
  } catch {
    // Convert any driver error to a fixed, non-secret error. The original error
    // may embed streamed bytes, so the runner never propagates its message.
    throw new Error("setup-token login failed: the sandbox login command errored.");
  } finally {
    if (signal) signal.removeEventListener("abort", onExternalAbort);
    // Zero any bound token bytes that the delivery path did not consume, so a
    // timeout, a cancellation, or an error never leaves the secret in memory. The
    // cast restores the type that the closure assignment widens away.
    const leftover = tokenBytes as Buffer | null;
    if (leftover) {
      leftover.fill(0);
      tokenBytes = null;
    }
    // Stop a pending code-input routine, then stop the child and dispose.
    controller.abort();
    await stopAndDispose(driver, log);
  }
}
