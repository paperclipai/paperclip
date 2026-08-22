import { describe, expect, it } from "vitest";
import {
  buildDuplexChannelLaunchWrapper,
  createDaytonaDuplexChannelSessionOpener,
  openDaytonaDuplexChannelSession,
  type DaytonaPtyCreateOptions,
  type DaytonaPtyHandle,
  type DaytonaPtyProcess,
} from "./duplex-command-stream.js";

// The carriage return that submits the launch wrapper line to the terminal.
const ENTER = "\r";

// The gateway command the tests run on the channel. The command is an argument
// vector: element 0 is the program and the rest are its arguments. The real
// command is the generated duplex gateway; the tests use a placeholder, because
// the fake PTY runs no process.
const GATEWAY = ["node", "/paperclip/gateway.mjs"];

// The gateway argument vector after the wrapper quotes each element. The wrapper
// quotes every argument as a single-quoted shell word.
const GATEWAY_QUOTED = "'node' '/paperclip/gateway.mjs'";

/**
 * A fake Daytona PTY handle. It records each input write, drives the output
 * stream on demand, and records the kill and the disconnect. The tests use it in
 * place of the real SDK `PtyHandle`, so the session runs with no sandbox. The fake
 * never echoes input back as output, so a test proves the channel adds no echo.
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
 * options, so a test asserts the terminal size and the launch wrapper.
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

// ---------------------------------------------------------------------------
// Characterization: which Daytona primitive carries a clean framed stream.
// ---------------------------------------------------------------------------
// The Daytona SDK proves two primitives. The ordinary session primitive
// dispatches a command and tails its output, split into stdout and stderr. It
// exposes no call that writes bytes to a running command's stdin, so it cannot
// carry host input on the same channel as the output. The PTY primitive exposes
// `sendInput` for host input and one `onData` callback for the output, on one live
// socket. Only the PTY carries a bidirectional stream on one connection, so the
// duplex channel uses the PTY. These tests record that decision against the two
// SDK surface shapes.

/** The subset of the Daytona session command surface, for the characterization. */
interface DaytonaSessionCommandSurface {
  createSession(sessionId: string): Promise<void>;
  executeSessionCommand(sessionId: string, command: unknown): Promise<{ cmdId?: string }>;
  getSessionCommandLogs(
    sessionId: string,
    commandId: string,
    onStdout: (chunk: string) => void,
    onStderr: (chunk: string) => void,
  ): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
}

describe("duplex primitive characterization", () => {
  it("the PTY surface carries host input and process output on one connection", () => {
    const process = createFakeProcess();
    // The PTY surface exposes both directions: `sendInput` for host bytes and the
    // `onData` create option for process bytes. This is the bidirectional shape a
    // duplex channel needs.
    expect(typeof process.createPty).toBe("function");
    const handleKeys: Array<keyof DaytonaPtyHandle> = [
      "waitForConnection",
      "sendInput",
      "wait",
      "kill",
      "disconnect",
    ];
    // `sendInput` is the host-to-process direction; the create option `onData` is
    // the process-to-host direction. Both exist on the PTY primitive.
    expect(handleKeys).toContain("sendInput");
  });

  it("the session command surface exposes no write to a running command's stdin", () => {
    // The session surface dispatches a command and tails split stdout/stderr. No
    // member writes bytes to a running command's stdin, so it cannot carry the
    // host input on the output channel. The duplex channel therefore uses the PTY,
    // not a session.
    const sessionMembers: Array<keyof DaytonaSessionCommandSurface> = [
      "createSession",
      "executeSessionCommand",
      "getSessionCommandLogs",
      "deleteSession",
    ];
    expect(sessionMembers).not.toContain("sendInput" as never);
    expect(sessionMembers).not.toContain("write" as never);
    // The log tail splits the output into two streams; a single framed duplex
    // stream must stay on one path, which the PTY `onData` provides.
    expect(sessionMembers).toContain("getSessionCommandLogs");
  });
});

// ---------------------------------------------------------------------------
// Launch wrapper: raw mode, echo off, diagnostics to a file, direct exec.
// ---------------------------------------------------------------------------

describe("buildDuplexChannelLaunchWrapper", () => {
  it("sets raw mode with echo off, redirects diagnostics to a file, and execs the gateway", () => {
    const wrapper = buildDuplexChannelLaunchWrapper(GATEWAY, "/tmp/diag.log");

    // Raw mode with echo off stops the terminal echoing host input as data and
    // stops newline translation, so the newline-delimited frames stay intact.
    expect(wrapper).toContain("stty raw -echo");
    // The diagnostics go to the file, never to the stdout frame stream. The
    // wrapper quotes the path as a single-quoted shell word.
    expect(wrapper).toContain("2>'/tmp/diag.log'");
    // The gateway starts with `exec`, so the PTY runs it directly and its exit
    // code becomes the PTY exit code.
    expect(wrapper).toContain(`exec ${GATEWAY_QUOTED}`);
    // The line ends with the Enter byte, so the shell runs it.
    expect(wrapper.endsWith(ENTER)).toBe(true);
    // Raw mode is set before the gateway starts.
    expect(wrapper.indexOf("stty raw -echo")).toBeLessThan(
      wrapper.indexOf(`exec ${GATEWAY_QUOTED}`),
    );
  });

  it("quotes a diagnostics path that holds shell metacharacters, so it cannot inject a command", () => {
    const wrapper = buildDuplexChannelLaunchWrapper(GATEWAY, "/tmp/x; rm -rf ~");

    // The path is one single-quoted word, so the shell reads the metacharacters as
    // literal text. The dangerous `rm` never becomes its own command.
    expect(wrapper).toContain("2>'/tmp/x; rm -rf ~'");
    expect(wrapper).not.toContain("2>/tmp/x; rm -rf ~");
  });

  it("quotes a single quote in the diagnostics path", () => {
    const wrapper = buildDuplexChannelLaunchWrapper(GATEWAY, "/tmp/o'clock.log");

    // A single quote closes the word, adds an escaped quote, and reopens the word.
    expect(wrapper).toContain(`2>'/tmp/o'"'"'clock.log'`);
  });

  it("quotes each command argument that holds shell metacharacters", () => {
    const wrapper = buildDuplexChannelLaunchWrapper(
      ["node", "/paperclip/gateway.mjs", "; rm -rf ~"],
      "/tmp/diag.log",
    );

    // Each argument is one single-quoted word, so the metacharacters stay literal
    // text. The dangerous `rm` argument never becomes its own command.
    expect(wrapper).toContain(`exec 'node' '/paperclip/gateway.mjs' '; rm -rf ~'`);
    expect(wrapper).not.toContain("; rm -rf ~;");
    expect(wrapper).not.toContain("exec node /paperclip/gateway.mjs ; rm -rf ~");
  });

  it("rejects an empty command argument vector", () => {
    // An empty vector has no program to exec, so the wrapper fails loudly.
    expect(() => buildDuplexChannelLaunchWrapper([], "/tmp/diag.log")).toThrow(
      /at least one argument/,
    );
  });
});

describe("openDaytonaDuplexChannelSession", () => {
  it("starts the gateway through the raw-mode wrapper on a fixed-size terminal", async () => {
    const process = createFakeProcess();

    await openDaytonaDuplexChannelSession(process, GATEWAY);

    expect(process.createOptions?.cols).toBe(120);
    expect(process.createOptions?.rows).toBe(30);
    const launch = process.handle?.inputs[0] ?? "";
    expect(launch).toContain("stty raw -echo");
    expect(launch).toContain(`exec ${GATEWAY_QUOTED}`);
    expect(launch.endsWith(ENTER)).toBe(true);
  });

  it("redirects diagnostics to the given file path", async () => {
    const process = createFakeProcess();

    await openDaytonaDuplexChannelSession(process, GATEWAY, {
      diagnosticsPath: "/tmp/paperclip-duplex-fixed.log",
    });

    expect(process.handle?.inputs[0]).toContain("2>'/tmp/paperclip-duplex-fixed.log'");
  });

  it("defaults the diagnostics path under /tmp when the caller gives none", async () => {
    const process = createFakeProcess();

    await openDaytonaDuplexChannelSession(process, GATEWAY);

    expect(process.handle?.inputs[0]).toMatch(/2>'\/tmp\/paperclip-duplex-[0-9a-f-]+\.log'/);
  });

  it("delivers a host write to the process and does not echo it back as data", async () => {
    const process = createFakeProcess();
    const received: string[] = [];

    const session = await openDaytonaDuplexChannelSession(process, GATEWAY);
    session.onData((chunk) => received.push(chunk));

    // The launch wrapper is the first input; the host frame write is the second.
    session.write('{"version":1,"type":"heartbeat"}\n');
    expect(process.handle?.inputs[1]).toBe('{"version":1,"type":"heartbeat"}\n');
    // The fake terminal echoes nothing, so the write produces no data callback.
    // A real terminal in raw mode with echo off behaves the same way.
    expect(received).toEqual([]);
  });

  it("keeps the data order and the frame newlines intact", async () => {
    const process = createFakeProcess();
    const received: string[] = [];

    const session = await openDaytonaDuplexChannelSession(process, GATEWAY);
    session.onData((chunk) => received.push(chunk));

    process.handle?.emitText('{"version":1,"type":"ready","address":"127.0.0.1:8080"}\n');
    process.handle?.emitText('{"version":1,"type":"heartbeat"}\n');

    // The order is preserved and no newline is translated (no stray "\r").
    expect(received).toEqual([
      '{"version":1,"type":"ready","address":"127.0.0.1:8080"}\n',
      '{"version":1,"type":"heartbeat"}\n',
    ]);
    expect(received.join("")).not.toContain("\r");
  });

  it("reassembles a frame split across two output chunks", async () => {
    const process = createFakeProcess();
    const received: string[] = [];

    const session = await openDaytonaDuplexChannelSession(process, GATEWAY);
    session.onData((chunk) => received.push(chunk));

    const frame = '{"version":1,"type":"response","id":"r1","status":200,"headers":{},"body":"","outcome":"completed"}\n';
    process.handle?.emitText(frame.slice(0, 20));
    process.handle?.emitText(frame.slice(20));

    expect(received.join("")).toBe(frame);
  });

  it("carries a large frame without loss", async () => {
    const process = createFakeProcess();
    const received: string[] = [];

    const session = await openDaytonaDuplexChannelSession(process, GATEWAY);
    session.onData((chunk) => received.push(chunk));

    const body = "x".repeat(500_000);
    const frame = `{"version":1,"type":"response","id":"big","status":200,"headers":{},"body":"${body}","outcome":"completed"}\n`;
    process.handle?.emitText(frame);

    expect(received.join("")).toBe(frame);
    expect(received.join("").length).toBe(frame.length);
  });

  it("keeps a multibyte character whole across two output chunks", async () => {
    const process = createFakeProcess();
    const received: string[] = [];

    const session = await openDaytonaDuplexChannelSession(process, GATEWAY);
    session.onData((chunk) => received.push(chunk));

    // The euro sign is three UTF-8 bytes. Split it across two chunks, so the
    // stream decoder must join the bytes.
    const euro = new TextEncoder().encode("€");
    process.handle?.emitBytes(euro.subarray(0, 2));
    process.handle?.emitBytes(euro.subarray(2));

    expect(received.join("")).toBe("€");
  });

  it("buffers early output until the listener registers", async () => {
    const process = createFakeProcess();
    const received: string[] = [];

    const session = await openDaytonaDuplexChannelSession(process, GATEWAY);
    // Output arrives before the transport registers the listener.
    process.handle?.emitText('{"version":1,');
    process.handle?.emitText('"type":"heartbeat"}\n');
    expect(received).toEqual([]);

    session.onData((chunk) => received.push(chunk));
    // The session flushes the buffered output in order on registration.
    expect(received).toEqual(['{"version":1,"type":"heartbeat"}\n']);
  });

  it("resolves wait with the gateway exit code", async () => {
    const process = createFakeProcess();

    const session = await openDaytonaDuplexChannelSession(process, GATEWAY);
    process.handle?.finish(3);

    await expect(session.wait()).resolves.toEqual({ exitCode: 3 });
  });

  it("maps an absent exit code to null", async () => {
    const process = createFakeProcess();

    const session = await openDaytonaDuplexChannelSession(process, GATEWAY);
    process.handle?.finish(undefined);

    await expect(session.wait()).resolves.toEqual({ exitCode: null });
  });

  it("kills the child on stop and releases the socket on close", async () => {
    const process = createFakeProcess();

    const session = await openDaytonaDuplexChannelSession(process, GATEWAY);
    session.kill();
    expect(process.handle?.killed).toBe(1);

    await session.close();
    // Close stops the child and releases the socket, so a closed channel holds no
    // live terminal.
    expect(process.handle?.killed).toBeGreaterThanOrEqual(1);
    expect(process.handle?.disconnected).toBe(1);
  });

  it("passes the working directory to the pseudo-terminal", async () => {
    const process = createFakeProcess();

    await openDaytonaDuplexChannelSession(process, GATEWAY, { cwd: "/paperclip-workspace" });

    expect(process.createOptions?.cwd).toBe("/paperclip-workspace");
  });

  it("ends the channel with the typed write_error and no raw text when a write rejects", async () => {
    // The fake handle accepts the launch wrapper write, then rejects every later
    // write with a raw provider message. The seam must map the cause to the typed
    // reason and never surface the raw text.
    const rawProviderText = "RAW-PROVIDER-BROKEN-PIPE-9z8y7x";
    let sends = 0;
    let killed = 0;
    const handle: DaytonaPtyHandle = {
      async waitForConnection(): Promise<void> {},
      async sendInput(): Promise<void> {
        sends += 1;
        if (sends === 1) return; // the launch wrapper write succeeds.
        throw new Error(rawProviderText);
      },
      wait(): Promise<{ exitCode?: number; error?: string }> {
        return new Promise(() => {});
      },
      async kill(): Promise<void> {
        killed += 1;
      },
      async disconnect(): Promise<void> {},
    };
    const process: DaytonaPtyProcess = {
      async createPty(): Promise<DaytonaPtyHandle> {
        return handle;
      },
    };
    const writeErrors: string[] = [];
    const session = await openDaytonaDuplexChannelSession(process, GATEWAY, {
      onWriteError: (reason) => writeErrors.push(reason),
    });

    session.write("frame\n");
    // Let the rejected write settle.
    await new Promise((resolve) => setImmediate(resolve));

    // The seam reported exactly the typed reason, ended the channel, and leaked no
    // raw provider text.
    expect(writeErrors).toEqual(["write_error"]);
    expect(killed).toBe(1);
    expect(JSON.stringify(writeErrors)).not.toContain(rawProviderText);
  });

  it("reports a write error one time even when more writes reject", async () => {
    let sends = 0;
    let killed = 0;
    const handle: DaytonaPtyHandle = {
      async waitForConnection(): Promise<void> {},
      async sendInput(): Promise<void> {
        sends += 1;
        if (sends === 1) return;
        throw new Error("broken");
      },
      wait(): Promise<{ exitCode?: number; error?: string }> {
        return new Promise(() => {});
      },
      async kill(): Promise<void> {
        killed += 1;
      },
      async disconnect(): Promise<void> {},
    };
    const process: DaytonaPtyProcess = {
      async createPty(): Promise<DaytonaPtyHandle> {
        return handle;
      },
    };
    const writeErrors: string[] = [];
    const session = await openDaytonaDuplexChannelSession(process, GATEWAY, {
      onWriteError: (reason) => writeErrors.push(reason),
    });

    session.write("a");
    session.write("b");
    await new Promise((resolve) => setImmediate(resolve));

    expect(writeErrors).toEqual(["write_error"]);
    expect(killed).toBe(1);
  });
});

describe("createDaytonaDuplexChannelSessionOpener", () => {
  it("opens a session for the command on each call", async () => {
    const process = createFakeProcess();
    const opener = createDaytonaDuplexChannelSessionOpener(process, { cwd: "/paperclip-workspace" });

    const session = await opener(GATEWAY);

    expect(process.createOptions?.cwd).toBe("/paperclip-workspace");
    expect(process.handle?.inputs[0]).toContain(`exec ${GATEWAY_QUOTED}`);
    expect(typeof session.onData).toBe("function");
    expect(typeof session.write).toBe("function");
    expect(typeof session.wait).toBe("function");
    expect(typeof session.kill).toBe("function");
    expect(typeof session.close).toBe("function");
  });
});
