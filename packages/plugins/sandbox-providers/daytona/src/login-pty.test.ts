import { describe, expect, it } from "vitest";
import {
  composeLaunchLine,
  createDaytonaLoginHomeFs,
  createDaytonaLoginPtySessionOpener,
  encodePosixShellArg,
  openDaytonaLoginPtySession,
  type DaytonaExecResult,
  type DaytonaLoginHomeFs,
  type DaytonaPtyCreateOptions,
  type DaytonaPtyHandle,
  type DaytonaPtyProcess,
  type DaytonaSandboxExec,
  type LoginPtyLaunchDescriptor,
} from "./login-pty.js";

// The Enter byte the terminal login UI reads to submit the browser code.
const ENTER = "\r";

const HOME = "/tmp/paperclip-adapter-login/11111111-2222-4333-8444-555555555555";

const CLAUDE: LoginPtyLaunchDescriptor = { loginCommandKey: "claude", sessionHome: HOME };
const CODEX: LoginPtyLaunchDescriptor = { loginCommandKey: "codex", sessionHome: HOME };
const GROK: LoginPtyLaunchDescriptor = { loginCommandKey: "grok", sessionHome: HOME };

/**
 * A fake login-home filesystem. It records each path the caller asks to create
 * and never fails, matching the `mkdir -p` semantics of the real command: a
 * repeat create for the same path succeeds the same as a fresh one.
 */
function createFakeHomeFs(): DaytonaLoginHomeFs & { created: string[] } {
  const created: string[] = [];
  return {
    created,
    async createDirectory(path: string): Promise<void> {
      created.push(path);
    },
  };
}

/**
 * A fake Daytona PTY handle. It records each input write, drives the output
 * stream on demand, and records the kill and the disconnect. The tests use it in
 * place of the real SDK `PtyHandle`, so the session runs with no sandbox.
 */
function createFakePtyHandle(
  onData: (data: Uint8Array) => void | Promise<void>,
  onWaitForConnection?: () => void,
): DaytonaPtyHandle & {
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
    async waitForConnection(): Promise<void> {
      onWaitForConnection?.();
    },
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
 * options, so a test asserts the terminal size and the launch line.
 */
function createFakeProcess(): DaytonaPtyProcess & {
  handle: ReturnType<typeof createFakePtyHandle> | null;
  createOptions: DaytonaPtyCreateOptions | null;
  createCount: number;
} {
  const state: {
    handle: ReturnType<typeof createFakePtyHandle> | null;
    createOptions: DaytonaPtyCreateOptions | null;
    createCount: number;
  } = { handle: null, createOptions: null, createCount: 0 };
  return {
    get handle() {
      return state.handle;
    },
    get createOptions() {
      return state.createOptions;
    },
    get createCount() {
      return state.createCount;
    },
    async createPty(options: DaytonaPtyCreateOptions): Promise<DaytonaPtyHandle> {
      state.createCount += 1;
      state.createOptions = options;
      const handle = createFakePtyHandle(options.onData);
      state.handle = handle;
      return handle;
    },
  };
}

describe("encodePosixShellArg", () => {
  it("wraps a value in single quotes and neutralizes metacharacters", () => {
    expect(encodePosixShellArg("/tmp/x")).toBe("'/tmp/x'");
    // A metacharacter, a space, and a semicolon stay literal inside the quotes.
    expect(encodePosixShellArg("; rm -rf / #")).toBe("'; rm -rf / #'");
    // An embedded single quote closes, escapes, and reopens the quote.
    expect(encodePosixShellArg("a'b")).toBe("'a'\\''b'");
    expect(encodePosixShellArg("$(id)")).toBe("'$(id)'");
  });
});

describe("composeLaunchLine", () => {
  it("composes the Claude line with no CODEX_HOME", () => {
    const line = composeLaunchLine(CLAUDE);
    expect(line).toBe("exec claude setup-token");
    expect(line).not.toContain("CODEX_HOME");
  });

  it("composes the Codex line with exactly one encoded CODEX_HOME", () => {
    const line = composeLaunchLine(CODEX);
    expect(line).toBe(`exec env CODEX_HOME='${HOME}' codex login --device-auth`);
    // Exactly one CODEX_HOME assignment, and the exact approved Codex command.
    expect(line.match(/CODEX_HOME=/g)).toHaveLength(1);
    expect(line.endsWith("codex login --device-auth")).toBe(true);
  });

  it("composes the Grok line with exactly one encoded GROK_HOME", () => {
    const line = composeLaunchLine(GROK);
    expect(line).toBe(`exec env GROK_HOME='${HOME}' grok login --device-auth`);
    // Exactly one GROK_HOME assignment, and the exact approved Grok command.
    expect(line.match(/GROK_HOME=/g)).toHaveLength(1);
    expect(line.endsWith("grok login --device-auth")).toBe(true);
    // The Codex encoded variable never leaks into the Grok line.
    expect(line).not.toContain("CODEX_HOME");
  });

  it("composes the launch line from the closed command map only, and ignores a command string smuggled onto the descriptor", () => {
    // Condition 4: a command string in the request confers no command
    // authority. The module maps the closed key to its own fixed command, so a
    // caller cannot select or override it.
    const tampered = {
      ...GROK,
      command: "rm -rf /",
    } as unknown as LoginPtyLaunchDescriptor;
    const line = composeLaunchLine(tampered);
    expect(line).toBe(`exec env GROK_HOME='${HOME}' grok login --device-auth`);
    expect(line).not.toContain("rm -rf");
  });
});

describe("openDaytonaLoginPtySession — session home", () => {
  it("creates the session home directory", async () => {
    const process = createFakeProcess();
    const fs = createFakeHomeFs();

    await openDaytonaLoginPtySession(process, fs, CLAUDE);

    // The provider created the exact directory and opened the terminal.
    expect(fs.created).toEqual([HOME]);
    expect(process.createCount).toBe(1);
    expect(process.handle?.inputs[0]).toBe("exec claude setup-token" + ENTER);
  });

  it("sends the Codex launch line with the encoded CODEX_HOME", async () => {
    const process = createFakeProcess();
    const fs = createFakeHomeFs();

    await openDaytonaLoginPtySession(process, fs, CODEX);

    expect(process.handle?.inputs[0]).toBe(
      `exec env CODEX_HOME='${HOME}' codex login --device-auth` + ENTER,
    );
    // The Claude line carries no CODEX_HOME; the Codex line carries exactly one.
    expect((process.handle?.inputs[0]?.match(/CODEX_HOME=/g) ?? []).length).toBe(1);
  });

  it("opens the login session when the session home already exists", async () => {
    const process = createFakeProcess();
    const fs = createFakeHomeFs();

    // A second login for the same home hits an existing directory. `mkdir -p`
    // succeeds on an existing directory, so the second session opens the same
    // as the first.
    await openDaytonaLoginPtySession(process, fs, CLAUDE);
    await openDaytonaLoginPtySession(process, fs, CLAUDE);

    expect(fs.created).toEqual([HOME, HOME]);
    expect(process.createCount).toBe(2);
  });

  it("rejects a descriptor with a command key outside the closed set", async () => {
    const process = createFakeProcess();
    const fs = createFakeHomeFs();

    await expect(
      openDaytonaLoginPtySession(process, fs, {
        loginCommandKey: "gemini" as unknown as "claude",
        sessionHome: HOME,
      }),
    ).rejects.toThrow("LOGIN_PTY_DESCRIPTOR_REJECTED");
    // The provider never touched the filesystem or the terminal.
    expect(fs.created).toEqual([]);
    expect(process.createCount).toBe(0);
  });

  it("rejects a descriptor whose session home shape is wrong", async () => {
    const process = createFakeProcess();
    const fs = createFakeHomeFs();

    await expect(
      openDaytonaLoginPtySession(process, fs, {
        loginCommandKey: "codex",
        sessionHome: "/tmp/paperclip-adapter-login/../etc",
      }),
    ).rejects.toThrow("LOGIN_PTY_DESCRIPTOR_REJECTED");
    expect(process.createCount).toBe(0);
  });
});

describe("openDaytonaLoginPtySession — session mechanics", () => {
  it("starts the login command on a pseudo-terminal with a fixed size", async () => {
    const process = createFakeProcess();

    await openDaytonaLoginPtySession(process, createFakeHomeFs(), CLAUDE);

    expect(process.createOptions?.cols).toBe(120);
    expect(process.createOptions?.rows).toBe(30);
    expect(process.handle?.inputs[0]).toBe("exec claude setup-token" + ENTER);
  });

  it("returns incremental terminal output to the listener", async () => {
    const process = createFakeProcess();
    const received: string[] = [];

    const session = await openDaytonaLoginPtySession(process, createFakeHomeFs(), CLAUDE);
    session.onData((chunk) => received.push(chunk));

    process.handle?.emitText("the url below to sign in\n");
    process.handle?.emitText("Paste code here if prompted\n");

    expect(received).toEqual(["the url below to sign in\n", "Paste code here if prompted\n"]);
  });

  it("buffers early output until the listener registers", async () => {
    const process = createFakeProcess();
    const received: string[] = [];

    const session = await openDaytonaLoginPtySession(process, createFakeHomeFs(), CLAUDE);
    process.handle?.emitText("early output ");
    process.handle?.emitText("more output");
    expect(received).toEqual([]);

    session.onData((chunk) => received.push(chunk));
    expect(received).toEqual(["early output more output"]);
  });

  it("delivers the browser code plus the Enter byte to the command", async () => {
    const process = createFakeProcess();

    const session = await openDaytonaLoginPtySession(process, createFakeHomeFs(), CLAUDE);
    session.write("BROWSERCODE" + ENTER);
    // The write runs through the serialized chunk chain, so it lands on a later
    // microtask. Flush the chain before the assertion.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(process.handle?.inputs[1]).toBe("BROWSERCODE" + ENTER);
    expect(process.handle?.inputs[1]?.endsWith(ENTER)).toBe(true);
  });

  it("keeps a multibyte character whole across two output chunks", async () => {
    const process = createFakeProcess();
    const received: string[] = [];

    const session = await openDaytonaLoginPtySession(process, createFakeHomeFs(), CLAUDE);
    session.onData((chunk) => received.push(chunk));

    const euro = new TextEncoder().encode("€");
    process.handle?.emitBytes(euro.subarray(0, 2));
    process.handle?.emitBytes(euro.subarray(2));

    expect(received.join("")).toBe("€");
  });

  it("resolves wait with the command exit code", async () => {
    const process = createFakeProcess();

    const session = await openDaytonaLoginPtySession(process, createFakeHomeFs(), CLAUDE);
    process.handle?.finish(9);

    await expect(session.wait()).resolves.toEqual({ exitCode: 9 });
  });

  it("maps an absent exit code to null", async () => {
    const process = createFakeProcess();

    const session = await openDaytonaLoginPtySession(process, createFakeHomeFs(), CLAUDE);
    process.handle?.finish(undefined);

    await expect(session.wait()).resolves.toEqual({ exitCode: null });
  });

  it("kills the child and closes the session", async () => {
    const process = createFakeProcess();

    const session = await openDaytonaLoginPtySession(process, createFakeHomeFs(), CLAUDE);
    session.kill();
    expect(process.handle?.killed).toBe(1);

    await session.close();
    expect(process.handle?.disconnected).toBe(1);
  });

  it("passes the working directory to the pseudo-terminal", async () => {
    const process = createFakeProcess();

    await openDaytonaLoginPtySession(process, createFakeHomeFs(), CLAUDE, { cwd: "/workspace" });

    expect(process.createOptions?.cwd).toBe("/workspace");
  });
});

describe("createDaytonaLoginHomeFs — login-profile preamble", () => {
  // A capturing exec surface. It records each command and returns a fixed result,
  // so a test reads the exact command string the create runs.
  function createCapturingExec(result: DaytonaExecResult): DaytonaSandboxExec & {
    commands: string[];
  } {
    const commands: string[] = [];
    return {
      commands,
      async executeCommand(command: string): Promise<DaytonaExecResult> {
        commands.push(command);
        return result;
      },
    };
  }

  it("sources the login profiles before it creates the session home directory", async () => {
    // The command sources /etc/profile before it runs `mkdir -p`, so the create
    // command stays consistent with the profile chain the rest of the sandbox
    // exec commands use.
    const exec = createCapturingExec({ exitCode: 0, result: "" });
    const fs = createDaytonaLoginHomeFs(exec);

    await fs.createDirectory(HOME);

    const command = exec.commands.find((entry) => entry.includes("mkdir -p"));
    expect(command).toBeDefined();
    const profileIndex = command!.indexOf("/etc/profile");
    const mkdirIndex = command!.indexOf("mkdir -p");
    expect(profileIndex).toBeGreaterThanOrEqual(0);
    expect(mkdirIndex).toBeGreaterThan(profileIndex);
  });

  it("rejects the session and opens no pseudo-terminal when the create command exits non-zero", async () => {
    // The sandbox `mkdir -p` command fails (for example, a read-only mount).
    // The session must fail closed before it opens a pseudo-terminal.
    const exec = createCapturingExec({ exitCode: 1, result: "" });
    const fs = createDaytonaLoginHomeFs(exec);
    const process = createFakeProcess();

    await expect(openDaytonaLoginPtySession(process, fs, CLAUDE)).rejects.toThrow(
      "LOGIN_PTY_HOME_REJECTED",
    );
    expect(process.createCount).toBe(0);
  });
});

describe("createDaytonaLoginPtySessionOpener", () => {
  it("opens a session for the descriptor on each call", async () => {
    const process = createFakeProcess();
    const opener = createDaytonaLoginPtySessionOpener(process, createFakeHomeFs(), {
      cwd: "/workspace",
    });

    const session = await opener(CLAUDE);

    expect(process.createOptions?.cwd).toBe("/workspace");
    expect(process.handle?.inputs[0]).toBe("exec claude setup-token" + ENTER);
    expect(typeof session.onData).toBe("function");
    expect(typeof session.write).toBe("function");
    expect(typeof session.wait).toBe("function");
    expect(typeof session.kill).toBe("function");
    expect(typeof session.close).toBe("function");
  });
});
