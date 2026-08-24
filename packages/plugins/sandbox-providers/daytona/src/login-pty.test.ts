import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
  type LoginHomeInspection,
  type LoginPtyLaunchDescriptor,
} from "./login-pty.js";

// The Enter byte the terminal login UI reads to submit the browser code.
const ENTER = "\r";

const HOME = "/tmp/paperclip-adapter-login/11111111-2222-4333-8444-555555555555";
const LOGIN_UID = 1000;

const CLAUDE: LoginPtyLaunchDescriptor = { loginCommandKey: "claude", sessionHome: HOME };
const CODEX: LoginPtyLaunchDescriptor = { loginCommandKey: "codex", sessionHome: HOME };

/** A directory entry in the virtual filesystem. */
type FakeEntry = Omit<LoginHomeInspection, "exists">;

const ABSENT: LoginHomeInspection = {
  exists: false,
  isSymlink: false,
  isDirectory: false,
  mode: "",
  ownerUid: null,
};

/**
 * A fake login-home filesystem. It models one virtual path. `createDirectory`
 * fails when the path exists and otherwise stores `createAs` (a clean 0700
 * directory owned by the login user by default). A test seeds a pre-existing
 * entry, forces a bad created entry, or swaps the entry through `onCreatePty`, so
 * a test drives each rejection and the pre-launch re-check.
 */
function createFakeHomeFs(config?: {
  loginUid?: number;
  seed?: FakeEntry;
  createAs?: FakeEntry;
  createShouldFail?: boolean;
}): DaytonaLoginHomeFs & {
  created: Array<{ path: string; mode: string }>;
  inspectCount: number;
  setEntry: (entry: FakeEntry | null) => void;
} {
  const loginUid = config?.loginUid ?? LOGIN_UID;
  const cleanDir: FakeEntry = {
    isSymlink: false,
    isDirectory: true,
    mode: "700",
    ownerUid: loginUid,
  };
  let entry: FakeEntry | null = config?.seed ?? null;
  const created: Array<{ path: string; mode: string }> = [];
  const state = { inspectCount: 0 };
  return {
    created,
    get inspectCount() {
      return state.inspectCount;
    },
    setEntry(next: FakeEntry | null): void {
      entry = next;
    },
    async loginUserId(): Promise<number> {
      return loginUid;
    },
    async inspect(): Promise<LoginHomeInspection> {
      state.inspectCount += 1;
      return entry ? { exists: true, ...entry } : ABSENT;
    },
    async createDirectory(path: string, mode: string): Promise<void> {
      if (config?.createShouldFail || entry) {
        throw new Error("LOGIN_PTY_HOME_REJECTED");
      }
      created.push({ path, mode });
      entry = config?.createAs ?? cleanDir;
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
 * options, so a test asserts the terminal size and the launch line. `onCreatePty`
 * runs when the session opens the terminal, so a test swaps a symlink in after
 * the directory creation but before the launch input.
 */
function createFakeProcess(onCreatePty?: () => void): DaytonaPtyProcess & {
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
      onCreatePty?.();
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
});

describe("openDaytonaLoginPtySession — session home", () => {
  it("creates the exact UUID directory as a new 0700 directory owned by the login user", async () => {
    const process = createFakeProcess();
    const fs = createFakeHomeFs();

    await openDaytonaLoginPtySession(process, fs, CLAUDE);

    // The provider created the exact directory as a new 0700 directory.
    expect(fs.created).toEqual([{ path: HOME, mode: "700" }]);
    // The terminal opened and the launch line ran.
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

  it("rejects a pre-existing target before it creates the directory", async () => {
    const process = createFakeProcess();
    const fs = createFakeHomeFs({
      seed: { isSymlink: false, isDirectory: true, mode: "700", ownerUid: LOGIN_UID },
    });

    await expect(openDaytonaLoginPtySession(process, fs, CLAUDE)).rejects.toThrow(
      "LOGIN_PTY_HOME_REJECTED",
    );
    // The provider never created the directory and never opened the terminal.
    expect(fs.created).toEqual([]);
    expect(process.createCount).toBe(0);
  });

  it("rejects a pre-existing symlink at the target", async () => {
    const process = createFakeProcess();
    const fs = createFakeHomeFs({
      seed: { isSymlink: true, isDirectory: false, mode: "777", ownerUid: LOGIN_UID },
    });

    await expect(openDaytonaLoginPtySession(process, fs, CLAUDE)).rejects.toThrow(
      "LOGIN_PTY_HOME_REJECTED",
    );
    expect(process.createCount).toBe(0);
  });

  it("rejects a created target that is a symlink", async () => {
    const process = createFakeProcess();
    const fs = createFakeHomeFs({
      createAs: { isSymlink: true, isDirectory: false, mode: "700", ownerUid: LOGIN_UID },
    });

    await expect(openDaytonaLoginPtySession(process, fs, CLAUDE)).rejects.toThrow(
      "LOGIN_PTY_HOME_REJECTED",
    );
    expect(process.createCount).toBe(0);
  });

  it("rejects a created target that is not a directory", async () => {
    const process = createFakeProcess();
    const fs = createFakeHomeFs({
      createAs: { isSymlink: false, isDirectory: false, mode: "700", ownerUid: LOGIN_UID },
    });

    await expect(openDaytonaLoginPtySession(process, fs, CLAUDE)).rejects.toThrow(
      "LOGIN_PTY_HOME_REJECTED",
    );
    expect(process.createCount).toBe(0);
  });

  it("rejects a created directory with a wrong owner", async () => {
    const process = createFakeProcess();
    const fs = createFakeHomeFs({
      createAs: { isSymlink: false, isDirectory: true, mode: "700", ownerUid: LOGIN_UID + 1 },
    });

    await expect(openDaytonaLoginPtySession(process, fs, CLAUDE)).rejects.toThrow(
      "LOGIN_PTY_HOME_REJECTED",
    );
    expect(process.createCount).toBe(0);
  });

  it("rejects a created directory with a wrong mode", async () => {
    const process = createFakeProcess();
    const fs = createFakeHomeFs({
      createAs: { isSymlink: false, isDirectory: true, mode: "755", ownerUid: LOGIN_UID },
    });

    await expect(openDaytonaLoginPtySession(process, fs, CLAUDE)).rejects.toThrow(
      "LOGIN_PTY_HOME_REJECTED",
    );
    expect(process.createCount).toBe(0);
  });

  it("rejects a symlink swapped in after creation, before the launch input", async () => {
    // The directory validates cleanly, then a symlink replaces it while the
    // terminal opens. The no-symlink re-check before the launch input fails.
    const fs = createFakeHomeFs();
    const process = createFakeProcess(() => {
      fs.setEntry({ isSymlink: true, isDirectory: false, mode: "777", ownerUid: LOGIN_UID });
    });

    await expect(openDaytonaLoginPtySession(process, fs, CLAUDE)).rejects.toThrow(
      "LOGIN_PTY_HOME_REJECTED",
    );
    // The terminal opened, but the launch input never ran.
    expect(process.createCount).toBe(1);
    expect(process.handle?.inputs).toEqual([]);
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

describe("openDaytonaLoginPtySession — ancestor symlink", () => {
  it("starts no pseudo-terminal when the home filesystem check fails closed", async () => {
    // A symlinked login-root ancestor makes the descriptor-relative inspection fail
    // closed. The session opener must reject before it opens the terminal, so no
    // pseudo-terminal starts and the login command never runs.
    const process = createFakeProcess();
    let created = false;
    const fs: DaytonaLoginHomeFs = {
      async loginUserId(): Promise<number> {
        return LOGIN_UID;
      },
      async inspect(): Promise<LoginHomeInspection> {
        throw new Error("LOGIN_PTY_HOME_REJECTED");
      },
      async createDirectory(): Promise<void> {
        created = true;
      },
    };

    await expect(openDaytonaLoginPtySession(process, fs, CODEX)).rejects.toThrow(
      "LOGIN_PTY_HOME_REJECTED",
    );
    // The provider never created the directory and never opened the terminal.
    expect(created).toBe(false);
    expect(process.createCount).toBe(0);
  });
});

describe("createDaytonaLoginHomeFs — login-profile preamble", () => {
  // A capturing exec surface. It records each command and returns a fixed result,
  // so a test reads the exact command string the helper runs.
  function createCapturingExec(result: DaytonaExecResult): DaytonaSandboxExec & {
    commands: string[];
  } {
    const commands: string[] = [];
    return {
      commands,
      async executeCommand(command: string): Promise<DaytonaExecResult> {
        commands.push(command);
        // `id -u` resolves the login user id. Return a fixed uid so the caller
        // continues to the node helper command under test.
        if (command.startsWith("id -u")) {
          return { exitCode: 0, result: "1000" };
        }
        return result;
      },
    };
  }

  // The command sources /etc/profile before it runs node. The Daytona image may
  // expose node only through a login profile, so node must run after the profile
  // source. This assertion proves the helper runtime and the login PTY capability
  // stay consistent.
  function expectProfileBeforeNode(command: string | undefined): void {
    expect(command).toBeDefined();
    const profileIndex = command!.indexOf("/etc/profile");
    const nodeIndex = command!.indexOf("node -e");
    expect(profileIndex).toBeGreaterThanOrEqual(0);
    expect(nodeIndex).toBeGreaterThanOrEqual(0);
    expect(profileIndex).toBeLessThan(nodeIndex);
  }

  it("sources the login profiles before it runs the node inspect helper", async () => {
    const exec = createCapturingExec({ exitCode: 0, result: "ABSENT" });
    const fs = createDaytonaLoginHomeFs(exec);
    await fs.inspect(HOME);
    expectProfileBeforeNode(exec.commands.find((command) => command.includes("node -e")));
  });

  it("sources the login profiles before it runs the node create helper", async () => {
    const exec = createCapturingExec({ exitCode: 0, result: "" });
    const fs = createDaytonaLoginHomeFs(exec);
    await fs.createDirectory(HOME, "700");
    expectProfileBeforeNode(exec.commands.find((command) => command.includes("node -e")));
  });
});

// The real login-home filesystem runs a node helper on the sandbox. The helper
// walks the path with `/proc/self/fd`, which is Linux only. A non-Linux host skips
// these tests. The fake exec runs the helper locally, so the descriptor-relative
// walk is tested against a real filesystem. The login sandbox is Linux.
const describeLinux = process.platform === "linux" ? describe : describe.skip;

describeLinux("createDaytonaLoginHomeFs — descriptor-relative walk", () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), "daytona-login-home-"));
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // A local exec surface. It runs the composed command with `/bin/sh -c`, so the
  // real node helper runs against the local filesystem.
  function createLocalExec(): DaytonaSandboxExec {
    return {
      async executeCommand(command: string): Promise<DaytonaExecResult> {
        const result = spawnSync("/bin/sh", ["-c", command], { encoding: "utf8" });
        return { exitCode: result.status ?? undefined, result: result.stdout ?? "" };
      },
    };
  }

  const UUID = "11111111-2222-4333-8444-555555555555";

  it("reports a not-yet-created target as absent", async () => {
    const fs = createDaytonaLoginHomeFs(createLocalExec());
    const home = path.join(root, "absent-root", UUID);
    const inspection = await fs.inspect(home);
    expect(inspection.exists).toBe(false);
  });

  it("creates the login root and the session home relative to a trusted descriptor", async () => {
    const fs = createDaytonaLoginHomeFs(createLocalExec());
    const home = path.join(root, "clean-root", UUID);
    await fs.createDirectory(home, "700");
    const inspection = await fs.inspect(home);
    expect(inspection.exists).toBe(true);
    expect(inspection.isSymlink).toBe(false);
    expect(inspection.isDirectory).toBe(true);
    expect(inspection.mode).toBe("700");
    expect(inspection.ownerUid).toBe(process.getuid ? process.getuid() : inspection.ownerUid);
  });

  it("rejects a pre-existing session home target", async () => {
    const fs = createDaytonaLoginHomeFs(createLocalExec());
    const home = path.join(root, "exists-root", UUID);
    await fs.createDirectory(home, "700");
    // A second create of the same target fails, because the target exists.
    await expect(fs.createDirectory(home, "700")).rejects.toThrow("LOGIN_PTY_HOME_REJECTED");
  });

  it("fails the inspection closed when the login root is a symlink", async () => {
    // Pre-place a symlink at the login-root ancestor. The descriptor-relative walk
    // opens the root with a no-follow open, so the inspection fails closed.
    const fs = createDaytonaLoginHomeFs(createLocalExec());
    const attacker = path.join(root, "inspect-attacker");
    mkdirSync(attacker, { mode: 0o700 });
    const rootLink = path.join(root, "inspect-symlink-root");
    symlinkSync(attacker, rootLink);
    const home = path.join(rootLink, UUID);
    await expect(fs.inspect(home)).rejects.toThrow("LOGIN_PTY_HOME_REJECTED");
  });

  it("fails the creation closed when the login root is a pre-placed symlink", async () => {
    // Pre-place a symlink at the login-root ancestor that points at an attacker
    // tree. The creation opens the root with a no-follow open after the tolerant
    // `mkdir`, so it fails closed and creates no directory in the attacker tree.
    const fs = createDaytonaLoginHomeFs(createLocalExec());
    const attacker = path.join(root, "create-attacker");
    mkdirSync(attacker, { mode: 0o700 });
    const rootLink = path.join(root, "create-symlink-root");
    symlinkSync(attacker, rootLink);
    const home = path.join(rootLink, UUID);
    await expect(fs.createDirectory(home, "700")).rejects.toThrow("LOGIN_PTY_HOME_REJECTED");
    // The creation placed no session home inside the attacker tree.
    expect(existsSync(path.join(attacker, UUID))).toBe(false);
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
