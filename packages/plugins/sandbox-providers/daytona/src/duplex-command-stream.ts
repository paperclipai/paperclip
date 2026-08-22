// The Daytona duplex command stream for the sandbox callback bridge. The bridge
// needs one live bidirectional byte stream: the host writes request frames to the
// process, and the process writes response frames back, on one connection while
// the command runs. This module binds a Daytona pseudo-terminal (PTY) to a small
// session that the duplex transport consumes, so the gateway runs on a real
// terminal, streams its output, and receives host input.
//
// Primitive choice (the first acceptance criterion of the phase): the Daytona SDK
// proves two primitives. The ordinary session primitive (`createSession` plus
// `executeSessionCommand` plus `getSessionCommandLogs`) dispatches a command and
// tails its output, split into separate stdout and stderr streams. It exposes no
// call that writes bytes to a running command's stdin. The PTY primitive
// (`createPty`) exposes `sendInput` for host-to-process bytes and one `onData`
// callback for process-to-host bytes, on one live socket. Only the PTY carries a
// bidirectional stream on one connection, so this module uses the PTY. The
// characterization test in `duplex-command-stream.test.ts` records the evidence.
//
// Clean stream: a PTY echoes its input and translates newlines by default
// (`ICRNL` on input, `ONLCR` on output). The frames are newline-delimited JSON, so
// echo and newline translation corrupt the stream. The launch wrapper runs
// `stty raw -echo` before it starts the gateway, so the terminal becomes an 8-bit
// transparent path with no echo and no newline translation. The wrapper also
// redirects the gateway diagnostics to a file, so a diagnostic line never reaches
// the stdout frame stream. The wrapper starts the gateway with `exec`, so the PTY
// runs the gateway directly and the gateway exit code becomes the PTY exit code.
//
// Dependency boundary: this provider plugin ships standalone (the workspace
// excludes `packages/plugins/sandbox-providers/**`). So the module imports no
// workspace package. It reuses the narrow Daytona PTY surface that
// `setup-token-pty.ts` declares (`DaytonaPtyProcess`, `DaytonaPtyHandle`,
// `DaytonaPtyCreateOptions`), so a caller passes `sandbox.process` with no
// adapter. The narrow surface keeps the module unit-testable with a fake PTY.

import { randomUUID } from "node:crypto";

import type {
  DaytonaPtyCreateOptions,
  DaytonaPtyHandle,
  DaytonaPtyProcess,
} from "./setup-token-pty.js";

export type {
  DaytonaPtyCreateOptions,
  DaytonaPtyHandle,
  DaytonaPtyProcess,
} from "./setup-token-pty.js";

import { sendPtyInputInChunks } from "./pty-chunked-input.js";

/**
 * A live duplex channel session for one command. The session allocates a real
 * pseudo-terminal in raw mode, streams the raw output, accepts host input, and
 * stops the child. The shape matches the worker duplex channel session, so the
 * worker forwards the data and the exit with no adapter.
 */
export interface DuplexChannelSession {
  /** Registers the one data listener. The session streams each raw chunk in order. */
  onData(listener: (chunk: string) => void): void;
  /** Writes raw input bytes to the pseudo-terminal. */
  write(data: string): void;
  /**
   * Resolves when the command ends or the transport closes. A numeric `exitCode`
   * is a real process exit. `transportClosed` is true when the pseudo-terminal
   * socket closed with no exit data, so the caller can tell a real process exit
   * from a reason-less transport close.
   */
  wait(): Promise<{ exitCode: number | null; transportClosed: boolean }>;
  /** Stops the child process. Safe to call more than one time. */
  kill(): void;
  /** Releases the session resources. Safe to call more than one time. */
  close(): Promise<void>;
}

/**
 * Opens a {@link DuplexChannelSession} for `command`. The transport calls it one
 * time. `command` is an argument vector: element 0 is the program and the rest
 * are its arguments. The session quotes each element, so a shell metacharacter in
 * an element cannot inject a shell command.
 */
export type DuplexChannelSessionOpener = (
  command: readonly string[],
) => Promise<DuplexChannelSession>;

/**
 * The typed, closed reason for a duplex channel write failure. The seam reports
 * only this constant, never the raw provider error text. It maps to the host
 * telemetry `write_error` loss reason.
 */
export const DAYTONA_DUPLEX_WRITE_ERROR_REASON = "write_error" as const;

/** The typed reason a rejected host-to-sandbox write reports. */
export type DaytonaDuplexWriteErrorReason = typeof DAYTONA_DUPLEX_WRITE_ERROR_REASON;

/** The options for the Daytona duplex channel session. */
export interface DaytonaDuplexChannelOptions {
  /** The working directory for the duplex channel PTY. Defaults to the sandbox default. */
  cwd?: string;
  /**
   * The absolute sandbox path for the gateway diagnostics. The wrapper redirects
   * the terminal's stderr to this path, so a diagnostic line never reaches the
   * stdout frame stream. Defaults to a per-channel path under `/tmp`.
   */
  diagnosticsPath?: string;
  /**
   * The write-error seam. The session calls it one time when a host-to-sandbox
   * `sendInput` rejects. The session then ends the channel at once. The seam
   * carries only the typed {@link DaytonaDuplexWriteErrorReason}; the raw provider
   * error never reaches it.
   */
  onWriteError?: (reason: DaytonaDuplexWriteErrorReason) => void;
}

// The terminal size for the duplex channel PTY. The channel carries bytes, not a
// visible UI, so a fixed standard size is enough. A fixed size keeps the launch
// deterministic.
const DUPLEX_CHANNEL_PTY_COLS = 120;
const DUPLEX_CHANNEL_PTY_ROWS = 30;

/**
 * The input terminator that submits the launch wrapper line. The terminal reads
 * the carriage return as the Enter key, so the shell runs the wrapper line.
 */
const PTY_COMMAND_TERMINATOR = "\r";

/**
 * Quotes one value for a POSIX shell. The result is one single-quoted word, so
 * the shell reads it as literal text and never expands or splits it. The function
 * closes the quote, adds an escaped single quote, and reopens the quote for each
 * single quote in the value.
 */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/**
 * Builds the launch wrapper input line for the duplex channel. `command` is an
 * argument vector: element 0 is the program and the rest are its arguments.
 *
 * The wrapper does three steps in order:
 *   1. `exec 2>'<diagnosticsPath>'` redirects the shell's stderr to the file. The
 *      later `exec` inherits it, so the gateway diagnostics land in the file and
 *      never on the stdout frame stream.
 *   2. `stty raw -echo` sets the terminal to raw mode with echo off, so the
 *      terminal neither echoes host input as data nor translates newlines.
 *   3. `exec '<program>' '<arg>'...` replaces the shell with the gateway, so the
 *      PTY runs the gateway directly and the gateway exit code becomes the PTY
 *      exit code.
 *
 * The wrapper quotes the diagnostics path and every command argument as a
 * single-quoted shell word. So a shell metacharacter in a path or an argument
 * stays literal text and cannot inject a shell command.
 */
export function buildDuplexChannelLaunchWrapper(
  command: readonly string[],
  diagnosticsPath: string,
): string {
  if (command.length === 0) {
    throw new Error("The duplex channel launch command needs at least one argument.");
  }
  const quotedCommand = command.map(shellQuote).join(" ");
  return (
    `exec 2>${shellQuote(diagnosticsPath)}; stty raw -echo; ` +
    `exec ${quotedCommand}${PTY_COMMAND_TERMINATOR}`
  );
}

/**
 * Opens a Daytona duplex channel PTY session for `command` and returns it as a
 * {@link DuplexChannelSession}. The session allocates a real pseudo-terminal in
 * raw mode, streams the raw output, accepts host input, and stops the child.
 *
 * The function decodes the terminal bytes as a UTF-8 stream, so a multibyte
 * character that splits across two output chunks stays whole. It buffers the
 * output until the transport registers the listener, so no early chunk is lost.
 */
export async function openDaytonaDuplexChannelSession(
  process: DaytonaPtyProcess,
  command: readonly string[],
  options?: DaytonaDuplexChannelOptions,
): Promise<DuplexChannelSession> {
  const decoder = new TextDecoder("utf-8");
  let listener: ((chunk: string) => void) | null = null;
  let buffered = "";

  const diagnosticsPath =
    options?.diagnosticsPath ?? `/tmp/paperclip-duplex-${randomUUID()}.log`;

  const handle = await process.createPty({
    id: `paperclip-duplex-${randomUUID()}`,
    ...(options?.cwd ? { cwd: options.cwd } : {}),
    cols: DUPLEX_CHANNEL_PTY_COLS,
    rows: DUPLEX_CHANNEL_PTY_ROWS,
    onData: (data: Uint8Array): void => {
      // Decode the terminal bytes as a stream, so a split multibyte character
      // stays whole across two chunks. Forward the raw text; the frame codec owns
      // the newline-delimited JSON parsing.
      const text = decoder.decode(data, { stream: true });
      if (text.length === 0) return;
      if (listener) listener(text);
      else buffered += text;
    },
  });

  await handle.waitForConnection();
  // Start the gateway through the raw-mode wrapper. Raw mode with echo off stops
  // the terminal from echoing host input back as data and from translating the
  // frame newlines. The diagnostics redirect keeps the stdout frame stream clean.
  await handle.sendInput(buildDuplexChannelLaunchWrapper(command, diagnosticsPath));

  // Report a host-to-sandbox write failure one time and end the channel at once.
  // The seam carries only the typed reason; the raw provider error never leaves
  // this scope. The channel end propagates the loss up through the exit.
  //
  // `channelTerminated` turns true on the first rejected chunk, before the early
  // return, so a later queued write reads it and sends no chunk. Without the flag
  // a queued write runs after the terminal kill and calls `sendInput` on the
  // closed transport.
  let channelTerminated = false;
  let writeErrorReported = false;
  const endOnWriteError = (): void => {
    channelTerminated = true;
    if (writeErrorReported) return;
    writeErrorReported = true;
    options?.onWriteError?.(DAYTONA_DUPLEX_WRITE_ERROR_REASON);
    void handle.kill().catch(() => undefined);
  };

  // The tail of the write chain. The chunker awaits each chunk, so one write can
  // suspend between its chunks. The chain runs each write after the previous
  // write ends, so the chunks of two writes never interleave on the wire. The
  // chain never rejects, because the chunker maps a rejected send to
  // `endOnWriteError` and returns.
  let writeChain: Promise<void> = Promise.resolve();

  return {
    onData(next: (chunk: string) => void): void {
      listener = next;
      if (buffered.length > 0) {
        const pending = buffered;
        buffered = "";
        next(pending);
      }
    },
    write(data: string): void {
      // Send the input as byte-bounded chunks under the provider message cap. A
      // whole payload in one message can cross the cap and take the channel down,
      // so the chunker slices the payload and sends each chunk in order. The chain
      // runs this write after the previous write ends, so two writes keep their
      // order and never interleave their chunks. A write error must not throw into
      // the transport, so the transport's stream stays the single result path. On
      // a rejected chunk, the chunker ends the channel one time through
      // `endOnWriteError` and sends no later chunk. The raw provider error never
      // reaches a sink.
      //
      // A rejected chunk terminalizes the channel and kills the transport. So this
      // write skips the send when `channelTerminated` is true, and a queued write
      // never calls `sendInput` on the closed transport.
      writeChain = writeChain.then(() => {
        if (channelTerminated) return;
        return sendPtyInputInChunks(
          (chunk) => handle.sendInput(chunk),
          data,
          endOnWriteError,
        );
      });
    },
    async wait(): Promise<{ exitCode: number | null; transportClosed: boolean }> {
      const result = await handle.wait();
      if (typeof result.exitCode === "number") {
        // A numeric exit code is a real process exit. The SDK parses it from the
        // pseudo-terminal WebSocket close reason (for example `{"exitCode":0}`).
        return { exitCode: result.exitCode, transportClosed: false };
      }
      // A non-numeric exit code marks a reason-less transport close: the socket
      // closed with no exit data. It is a transport close, not a process exit.
      return { exitCode: null, transportClosed: true };
    },
    kill(): void {
      void handle.kill().catch(() => undefined);
    },
    async close(): Promise<void> {
      // Stop the child and release the socket. `kill` ends the gateway and `wait`
      // resolves with the exit; `disconnect` releases the PTY socket. Both are
      // safe to call more than one time, so close stays idempotent.
      await handle.kill().catch(() => undefined);
      await handle.disconnect().catch(() => undefined);
    },
  };
}

/**
 * Creates a {@link DuplexChannelSessionOpener} bound to a Daytona `process`. Pass
 * `sandbox.process` from the Daytona SDK. The opener runs the gateway command on a
 * raw pseudo-terminal, streams the output, accepts host input, and stops the child
 * for a terminal state.
 */
export function createDaytonaDuplexChannelSessionOpener(
  process: DaytonaPtyProcess,
  options?: DaytonaDuplexChannelOptions,
): DuplexChannelSessionOpener {
  return (command: readonly string[]) =>
    openDaytonaDuplexChannelSession(process, command, options);
}
