import { describe, expect, it } from "vitest";
import {
  createDaytonaSetupTokenPtySessionOpener,
  openDaytonaSetupTokenPtySession,
  type DaytonaPtyCreateOptions,
  type DaytonaPtyHandle,
  type DaytonaPtyProcess,
} from "./setup-token-pty.js";

// The Enter byte the terminal login UI reads to submit the browser code.
const ENTER = "\r";

/**
 * A fake Daytona PTY handle. It records each input write, drives the output
 * stream on demand, and records the kill and the disconnect. The tests use it in
 * place of the real SDK `PtyHandle`, so the session runs with no sandbox.
 */
function createFakePtyHandle(onData: (data: Uint8Array) => void | Promise<void>): DaytonaPtyHandle & {
  inputs: string[];
  emitText: (text: string) => void;
  emitBytes: (bytes: Uint8Array) => void;
  finish: (exitCode: number | undefined) => void;
  killed: number;
  disconnected: number;
} {
  const encoder = new TextEncoder();
  const inputs: string[] = [];
  let resolveWait: ((value: { exitCode?: number; error?: string }) => void) | null = null;
  const waitPromise = new Promise<{ exitCode?: number; error?: string }>((resolve) => {
    resolveWait = resolve;
  });
  let killed = 0;
  let disconnected = 0;
  return {
    async waitForConnection(): Promise<void> {},
    async sendInput(data: string | Uint8Array): Promise<void> {
      inputs.push(typeof data === "string" ? data : new TextDecoder().decode(data));
    },
    wait(): Promise<{ exitCode?: number; error?: string }> {
      return waitPromise;
    },
    async kill(): Promise<void> {
      killed += 1;
    },
    async disconnect(): Promise<void> {
      disconnected += 1;
    },
    // Test control below. The session never reads these fields.
    emitText(text: string): void {
      onData(encoder.encode(text));
    },
    emitBytes(bytes: Uint8Array): void {
      onData(bytes);
    },
    finish(exitCode: number | undefined): void {
      resolveWait?.({ exitCode });
    },
    get inputs(): string[] {
      return inputs;
    },
    get killed(): number {
      return killed;
    },
    get disconnected(): number {
      return disconnected;
    },
  };
}

/**
 * A fake Daytona process. It opens one fake PTY handle and records the create
 * options, so a test asserts the terminal size and the command start.
 */
function createFakeProcess(): DaytonaPtyProcess & {
  handle: ReturnType<typeof createFakePtyHandle> | null;
  createOptions: DaytonaPtyCreateOptions | null;
} {
  const state: {
    handle: ReturnType<typeof createFakePtyHandle> | null;
    createOptions: DaytonaPtyCreateOptions | null;
  } = { handle: null, createOptions: null };
  return {
    get handle() {
      return state.handle;
    },
    get createOptions() {
      return state.createOptions;
    },
    async createPty(options: DaytonaPtyCreateOptions): Promise<DaytonaPtyHandle> {
      state.createOptions = options;
      const handle = createFakePtyHandle(options.onData);
      state.handle = handle;
      return handle;
    },
  };
}

describe("openDaytonaSetupTokenPtySession", () => {
  it("starts the login command on a pseudo-terminal with a fixed size", async () => {
    const process = createFakeProcess();

    await openDaytonaSetupTokenPtySession(process, "claude setup-token");

    expect(process.createOptions?.cols).toBe(120);
    expect(process.createOptions?.rows).toBe(30);
    // The session replaces the shell with the command through `exec`, so the
    // pseudo-terminal runs the command directly and its exit code is the PTY
    // exit code.
    expect(process.handle?.inputs[0]).toBe("exec claude setup-token" + ENTER);
  });

  it("returns incremental terminal output to the listener", async () => {
    const process = createFakeProcess();
    const received: string[] = [];

    const session = await openDaytonaSetupTokenPtySession(process, "claude setup-token");
    session.onData((chunk) => received.push(chunk));

    process.handle?.emitText("the url below to sign in\n");
    process.handle?.emitText("Paste code here if prompted\n");

    expect(received).toEqual(["the url below to sign in\n", "Paste code here if prompted\n"]);
  });

  it("buffers early output until the listener registers", async () => {
    const process = createFakeProcess();
    const received: string[] = [];

    const session = await openDaytonaSetupTokenPtySession(process, "claude setup-token");
    // Output arrives before the transport registers the listener.
    process.handle?.emitText("early output ");
    process.handle?.emitText("more output");
    expect(received).toEqual([]);

    session.onData((chunk) => received.push(chunk));
    // The session flushes the buffered output in order on registration.
    expect(received).toEqual(["early output more output"]);
  });

  it("delivers the browser code plus the Enter byte to the command", async () => {
    const process = createFakeProcess();

    const session = await openDaytonaSetupTokenPtySession(process, "claude setup-token");
    session.write("BROWSERCODE" + ENTER);

    // The first input is the command start; the second input is the delayed
    // browser code plus the Enter byte.
    expect(process.handle?.inputs[1]).toBe("BROWSERCODE" + ENTER);
    expect(process.handle?.inputs[1]?.endsWith(ENTER)).toBe(true);
  });

  it("keeps a multibyte character whole across two output chunks", async () => {
    const process = createFakeProcess();
    const received: string[] = [];

    const session = await openDaytonaSetupTokenPtySession(process, "claude setup-token");
    session.onData((chunk) => received.push(chunk));

    // The euro sign is three UTF-8 bytes. Split it across two chunks, so the
    // stream decoder must join the bytes.
    const euro = new TextEncoder().encode("€");
    process.handle?.emitBytes(euro.subarray(0, 2));
    process.handle?.emitBytes(euro.subarray(2));

    expect(received.join("")).toBe("€");
  });

  it("resolves wait with the command exit code", async () => {
    const process = createFakeProcess();

    const session = await openDaytonaSetupTokenPtySession(process, "claude setup-token");
    process.handle?.finish(9);

    await expect(session.wait()).resolves.toEqual({ exitCode: 9 });
  });

  it("maps an absent exit code to null", async () => {
    const process = createFakeProcess();

    const session = await openDaytonaSetupTokenPtySession(process, "claude setup-token");
    process.handle?.finish(undefined);

    await expect(session.wait()).resolves.toEqual({ exitCode: null });
  });

  it("kills the child and closes the session", async () => {
    const process = createFakeProcess();

    const session = await openDaytonaSetupTokenPtySession(process, "claude setup-token");
    session.kill();
    expect(process.handle?.killed).toBe(1);

    await session.close();
    expect(process.handle?.disconnected).toBe(1);
  });

  it("passes the working directory to the pseudo-terminal", async () => {
    const process = createFakeProcess();

    await openDaytonaSetupTokenPtySession(process, "claude setup-token", { cwd: "/workspace" });

    expect(process.createOptions?.cwd).toBe("/workspace");
  });
});

describe("createDaytonaSetupTokenPtySessionOpener", () => {
  it("opens a session for the command on each call", async () => {
    const process = createFakeProcess();
    const opener = createDaytonaSetupTokenPtySessionOpener(process, { cwd: "/workspace" });

    const session = await opener("claude setup-token");

    expect(process.createOptions?.cwd).toBe("/workspace");
    expect(process.handle?.inputs[0]).toBe("exec claude setup-token" + ENTER);
    // The opener returns a session the transport can drive.
    expect(typeof session.onData).toBe("function");
    expect(typeof session.write).toBe("function");
    expect(typeof session.wait).toBe("function");
    expect(typeof session.kill).toBe("function");
    expect(typeof session.close).toBe("function");
  });
});
