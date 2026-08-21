// The setup-token pseudo-terminal transport. It gives the Claude `setup-token`
// login runner a child that runs on a real pseudo-terminal (PTY). The command
// needs a PTY: pipe stdio emits no login prompt. The transport starts the
// command on a PTY, streams the incremental terminal output, delivers delayed
// input, and stops the child for a terminal state.
//
// This module is provider-agnostic and pure. It holds no Node built-in import,
// so the browser-safe root entry can re-export it. A sandbox provider (for
// example the Daytona plugin) opens the concrete pseudo-terminal through a
// {@link SetupTokenPtySessionOpener}. A unit test opens a fake pseudo-terminal
// through the same opener.
//
// Boundary (ANSI and OSC 8): the transport forwards the raw terminal bytes
// unchanged. It runs no ANSI or OSC 8 handling. The setup-token parser owns that
// handling, so the transport keeps every terminal byte intact for the parser.

/**
 * A live pseudo-terminal session for one setup-token login command. A sandbox
 * provider opens it. The session allocates a real pseudo-terminal, streams the
 * raw terminal output, accepts delayed input, and stops the child. The session
 * forwards the raw terminal bytes; it runs no ANSI or OSC 8 handling.
 */
export interface SetupTokenPtySession {
  /**
   * Registers the one output listener. The session streams each raw terminal
   * output chunk to `listener`, in order, as the pseudo-terminal emits it.
   */
  onData(listener: (chunk: string) => void): void;
  /**
   * Writes raw input bytes to the pseudo-terminal. The runner writes the browser
   * code plus the Enter byte here, after the command starts. The session
   * forwards the bytes unchanged, so the code reaches the pseudo-terminal first
   * and the Enter byte reaches it last.
   */
  write(data: string): void;
  /** Resolves with the child exit code when the command ends. */
  wait(): Promise<{ exitCode: number | null }>;
  /**
   * Stops the child process with a direct child stop. The characterization
   * showed that the child needs `SIGKILL`. The method must be safe to call more
   * than one time.
   */
  kill(): void;
  /** Releases the session resources. The method must be safe to call more than one time. */
  close(): Promise<void>;
}

/**
 * Opens a pseudo-terminal session for `command`. A provider binds this to its
 * sandbox. The transport calls it one time, on start.
 */
export type SetupTokenPtySessionOpener = (command: string) => Promise<SetupTokenPtySession>;

/**
 * The child side of the setup-token run, in the shape the login runner needs.
 * The transport starts the command on a pseudo-terminal, streams the terminal
 * output, delivers delayed input, and stops the child for a terminal state.
 *
 * The shape matches the runner `SetupTokenPtyDriver` interface, so the runner
 * accepts the transport with no adapter. The transport never imports the runner,
 * so the runner package keeps its one-way dependency on this package.
 */
export interface SetupTokenPtyTransport {
  /**
   * Opens the pseudo-terminal session for `command` and streams the terminal
   * output to `onData` in order. Resolves with the child exit code when the
   * command ends. The transport calls this one time.
   */
  start(command: string, onData: (chunk: string) => void): Promise<{ exitCode: number | null }>;
  /**
   * Writes `input` to the pseudo-terminal. The runner writes the browser code
   * plus the Enter byte one time, after it matches the prompt. An input that
   * arrives before the session opens waits in a small buffer, and the transport
   * flushes it in order when the session opens.
   */
  write(input: string): void;
  /**
   * Stops the child with a direct child stop. The method is safe to call before
   * start and safe to call more than one time. A stop before the session opens
   * marks the run, and the transport kills the child as soon as the session
   * opens.
   */
  stop(): void;
  /** Releases the transport resources. The method is safe to call more than one time. */
  dispose(): Promise<void>;
}

/**
 * Creates a {@link SetupTokenPtyTransport} over `open`. The transport adapts a
 * pseudo-terminal session into the runner driver shape. It buffers an early
 * input write, it honors an early stop, and it forwards the raw terminal bytes
 * with no ANSI or OSC 8 handling.
 */
export function createSetupTokenPtyTransport(
  open: SetupTokenPtySessionOpener,
): SetupTokenPtyTransport {
  let session: SetupTokenPtySession | null = null;
  let started = false;
  let stopped = false;
  // Input that the runner writes before the session opens. The transport flushes
  // it in order when the session opens. In the normal flow the runner writes
  // only after the first output, so this buffer stays empty.
  const pendingInput: string[] = [];

  const flushPendingInput = (): void => {
    if (!session) return;
    while (pendingInput.length > 0) {
      const next = pendingInput.shift();
      if (next !== undefined) session.write(next);
    }
  };

  return {
    async start(command, onData): Promise<{ exitCode: number | null }> {
      if (started) {
        throw new Error("setup-token PTY transport already started.");
      }
      started = true;
      const opened = await open(command);
      session = opened;
      // Register the output listener before any delayed input, so no output
      // chunk is missed between the open and the first write.
      opened.onData(onData);
      flushPendingInput();
      // A stop that arrived while the session was opening kills the child now.
      if (stopped) opened.kill();
      return opened.wait();
    },
    write(input): void {
      if (session) {
        session.write(input);
        return;
      }
      pendingInput.push(input);
    },
    stop(): void {
      stopped = true;
      session?.kill();
    },
    async dispose(): Promise<void> {
      // Release only a session that opened. A run that stopped before start
      // opens no session, so there is nothing to close.
      if (session) await session.close();
    },
  };
}
