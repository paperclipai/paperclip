// The Daytona pseudo-terminal (PTY) session for the Claude `setup-token` login.
// The login command needs a real pseudo-terminal: pipe stdio emits no login
// prompt. The Daytona SDK opens a PTY through `process.createPty`. This module
// binds that PTY to a small session that the setup-token transport consumes, so
// the login runner runs the command on a real terminal, streams the terminal
// output, and delivers the delayed browser code plus the Enter byte.
//
// Dependency boundary: this provider plugin ships standalone (the workspace
// excludes `packages/plugins/sandbox-providers/**`). So the module imports no
// workspace package. It declares the small session shape locally through
// {@link SetupTokenPtySession}. The shape matches the `SetupTokenPtySession`
// interface in `@paperclipai/adapter-utils`, so the transport factory
// `createSetupTokenPtyTransport` accepts the session opener from this module with
// no adapter. The runner drives the transport; the transport drives this session.
//
// SDK boundary: the module holds no Daytona SDK type import. It declares the
// small subset of the SDK PTY surface that it uses through
// {@link DaytonaPtyProcess} and {@link DaytonaPtyHandle}. The SDK `Process` and
// `PtyHandle` satisfy that subset, so a caller passes `sandbox.process` with no
// adapter. The narrow surface keeps the module unit-testable with a fake PTY.
//
// Security (secret handling): the login runner delivers the browser code and the
// Enter byte through {@link DaytonaPtyHandle.sendInput}. The SDK sends the input
// over the PTY socket, so the code never rides a command line and never reaches a
// process argument list. The session forwards the raw terminal bytes with no
// ANSI or OSC 8 handling; the setup-token parser owns that handling.

import { randomUUID } from "node:crypto";

import { sendPtyInputInChunks } from "./pty-chunked-input.js";

/**
 * A live pseudo-terminal session for one setup-token login command. The session
 * allocates a real pseudo-terminal, streams the raw terminal output, accepts
 * delayed input, and stops the child. The shape matches the
 * `SetupTokenPtySession` interface in `@paperclipai/adapter-utils`, so the
 * transport factory there accepts a session opener that returns this session.
 */
export interface SetupTokenPtySession {
  /** Registers the one output listener. The session streams each raw chunk in order. */
  onData(listener: (chunk: string) => void): void;
  /** Writes raw input bytes to the pseudo-terminal. */
  write(data: string): void;
  /** Resolves with the child exit code when the command ends. */
  wait(): Promise<{ exitCode: number | null }>;
  /** Stops the child process. Safe to call more than one time. */
  kill(): void;
  /** Releases the session resources. Safe to call more than one time. */
  close(): Promise<void>;
}

/** Opens a {@link SetupTokenPtySession} for `command`. The transport calls it one time. */
export type SetupTokenPtySessionOpener = (command: string) => Promise<SetupTokenPtySession>;

/**
 * The subset of the Daytona SDK `PtyHandle` that the session uses. The SDK
 * `PtyHandle` satisfies this interface, so a caller passes the real handle with
 * no adapter.
 */
export interface DaytonaPtyHandle {
  /** Resolves when the PTY socket connection is ready for input and output. */
  waitForConnection(): Promise<void>;
  /** Sends raw input bytes to the pseudo-terminal. */
  sendInput(data: string | Uint8Array): Promise<void>;
  /** Resolves with the exit result when the pseudo-terminal process ends. */
  wait(): Promise<{ exitCode?: number; error?: string }>;
  /** Kills the pseudo-terminal process. */
  kill(): Promise<void>;
  /** Closes the PTY socket and releases the resources. */
  disconnect(): Promise<void>;
}

/**
 * The options the session passes to `createPty`. The session sets a fixed
 * terminal size and one output callback. It sets the working directory when the
 * caller provides one.
 */
export interface DaytonaPtyCreateOptions {
  id: string;
  cwd?: string;
  cols: number;
  rows: number;
  onData: (data: Uint8Array) => void | Promise<void>;
}

/**
 * The subset of the Daytona SDK `Process` that the session uses. The SDK
 * `Process` satisfies this interface, so a caller passes `sandbox.process`.
 */
export interface DaytonaPtyProcess {
  createPty(options: DaytonaPtyCreateOptions): Promise<DaytonaPtyHandle>;
}

/** The options for the Daytona setup-token PTY session. */
export interface DaytonaSetupTokenPtyOptions {
  /** The working directory for the login PTY. Defaults to the sandbox default. */
  cwd?: string;
}

// The terminal size for the login PTY. The login UI prints a short prompt, so a
// standard terminal size is enough. A fixed size keeps the output stable.
const SETUP_TOKEN_PTY_COLS = 120;
const SETUP_TOKEN_PTY_ROWS = 30;

/**
 * The input terminator that replaces the interactive shell with the login
 * command. The `exec` builtin replaces the shell process image with the command,
 * so the PTY runs the command directly. When the command ends, the PTY ends with
 * the command exit code, and the delayed input reaches the command, not a shell.
 * The terminal reads the carriage return as the Enter key.
 */
const PTY_COMMAND_TERMINATOR = "\r";

/**
 * Opens a Daytona PTY session for `command` and returns it as a
 * {@link SetupTokenPtySession}. The session allocates a real pseudo-terminal,
 * streams the raw terminal output, delivers delayed input, and stops the child.
 *
 * The function starts the login command with `exec`, so the pseudo-terminal runs
 * the command directly and the command exit code becomes the PTY exit code. The
 * function decodes the terminal bytes as a UTF-8 stream, so a multibyte
 * character that splits across two output chunks stays whole. It buffers the
 * output until the transport registers the listener, so no early chunk is lost.
 */
export async function openDaytonaSetupTokenPtySession(
  process: DaytonaPtyProcess,
  command: string,
  options?: DaytonaSetupTokenPtyOptions,
): Promise<SetupTokenPtySession> {
  const decoder = new TextDecoder("utf-8");
  let listener: ((chunk: string) => void) | null = null;
  let buffered = "";

  const handle = await process.createPty({
    id: `paperclip-setup-token-${randomUUID()}`,
    ...(options?.cwd ? { cwd: options.cwd } : {}),
    cols: SETUP_TOKEN_PTY_COLS,
    rows: SETUP_TOKEN_PTY_ROWS,
    onData: (data: Uint8Array): void => {
      // Decode the terminal bytes as a stream, so a split multibyte character
      // stays whole across two chunks. Forward the raw text; the parser owns the
      // ANSI and OSC 8 handling.
      const text = decoder.decode(data, { stream: true });
      if (text.length === 0) return;
      if (listener) listener(text);
      else buffered += text;
    },
  });

  await handle.waitForConnection();
  // Replace the interactive shell with the login command, so the pseudo-terminal
  // runs the command directly. The runner then writes the delayed browser code
  // to the command, not to a shell.
  await handle.sendInput(`exec ${command}${PTY_COMMAND_TERMINATOR}`);

  // The tail of the write chain. The chunker awaits each chunk, so one write can
  // suspend between its chunks. The chain runs each write after the previous
  // write ends, so the chunks of two writes never interleave on the wire.
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
      // Send the input as byte-bounded chunks under the provider message cap. The
      // login input is short today, so the latent defect never fires, but the same
      // unbounded write goes through the one chunker. The chain runs this write
      // after the previous write ends, so two writes keep their order and never
      // interleave their chunks. A write error must not throw into the runner, so
      // the runner's fixed status stays the single result path.
      writeChain = writeChain.then(() =>
        sendPtyInputInChunks((chunk) => handle.sendInput(chunk), data),
      );
    },
    async wait(): Promise<{ exitCode: number | null }> {
      const result = await handle.wait();
      return { exitCode: typeof result.exitCode === "number" ? result.exitCode : null };
    },
    kill(): void {
      void handle.kill().catch(() => undefined);
    },
    async close(): Promise<void> {
      await handle.disconnect().catch(() => undefined);
    },
  };
}

/**
 * Creates a {@link SetupTokenPtySessionOpener} bound to a Daytona `process`. Pass
 * `sandbox.process` from the Daytona SDK. A later phase wraps the opener with the
 * `createSetupTokenPtyTransport` factory from `@paperclipai/adapter-utils` and
 * hands the transport to the login runner. The opener runs the login command on
 * a real pseudo-terminal, streams the terminal output, delivers the delayed
 * browser code plus the Enter byte, and stops the child for a terminal state.
 */
export function createDaytonaSetupTokenPtySessionOpener(
  process: DaytonaPtyProcess,
  options?: DaytonaSetupTokenPtyOptions,
): SetupTokenPtySessionOpener {
  return (command: string) => openDaytonaSetupTokenPtySession(process, command, options);
}
