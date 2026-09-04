import { fork } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockLoggerError = vi.hoisted(() => vi.fn());
const mockLoggerFatal = vi.hoisted(() => vi.fn());
const mockCaptureException = vi.hoisted(() => vi.fn());
const mockShutdownSentry = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("../middleware/logger.js", () => ({
  logger: {
    error: mockLoggerError,
    fatal: mockLoggerFatal,
  },
}));

vi.mock("../sentry.js", () => ({
  captureException: mockCaptureException,
  shutdownSentry: mockShutdownSentry,
}));

const {
  handlePostgresNullSocketGuardException,
  isGuardEnabled,
  isPostgresNullSocketWriteCrash,
  registerPostgresNullSocketGuard,
} = await import("../postgres-null-socket-guard.js");

const FIXTURE_PATH = fileURLToPath(new URL("./postgres-null-socket-guard.test-fixture.ts", import.meta.url));

interface ChildRunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  messages: Array<Record<string, unknown>>;
}

function runFixture(scenario: string): Promise<ChildRunResult> {
  return new Promise((resolve, reject) => {
    const child = fork(FIXTURE_PATH, [scenario], {
      // `tsx` is a devDependency of the server package only, so the child's
      // module resolution for `--import tsx` needs a cwd under server/ to
      // find it — the repo root has no top-level `tsx` package.
      cwd: dirname(dirname(dirname(FIXTURE_PATH))),
      execArgv: ["--import", "tsx"],
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });

    let stdout = "";
    let stderr = "";
    const messages: Array<Record<string, unknown>> = [];

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("message", (message) => {
      messages.push(message as Record<string, unknown>);
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      resolve({ code, signal, stdout, stderr, messages });
    });
  });
}

function messageTypes(result: ChildRunResult): string[] {
  return result.messages.map((message) => String(message.type));
}

/**
 * Builds a `TypeError` whose stack carries a `nextWrite` frame in
 * `postgres/src/connection.js`, matching the real crash signature. The path
 * prefix before `postgres/src/connection.js` stands in for any install
 * layout (a package-store path in this repository, a plain
 * `node_modules/postgres` path elsewhere).
 */
function makeDriverCrashError(message: string): Error {
  const error = new TypeError(message);
  error.stack =
    `TypeError: ${message}\n` +
    "    at Immediate.nextWrite (/app/node_modules/.pnpm/postgres@3.4.9/node_modules/postgres/src/connection.js:255:20)\n" +
    "    at processImmediate (node:internal/timers:483:21)";
  return error;
}

describe("isPostgresNullSocketWriteCrash", () => {
  it("matches the older V8 message spelling with the driver frame", () => {
    const error = makeDriverCrashError("Cannot read property 'write' of null");
    expect(isPostgresNullSocketWriteCrash(error)).toBe(true);
  });

  it("matches the newer V8 message spelling with the driver frame", () => {
    const error = makeDriverCrashError("Cannot read properties of null (reading 'write')");
    expect(isPostgresNullSocketWriteCrash(error)).toBe(true);
  });

  it("does not match an unrelated TypeError with a different message", () => {
    const error = makeDriverCrashError("Cannot read properties of null (reading 'foo')");
    expect(isPostgresNullSocketWriteCrash(error)).toBe(false);
  });

  it("does not match the right message from an unrelated frame", () => {
    const error = new TypeError("Cannot read properties of null (reading 'write')");
    error.stack =
      "TypeError: Cannot read properties of null (reading 'write')\n" +
      "    at Object.<anonymous> (/app/server/src/services/unrelated.js:12:5)";
    expect(isPostgresNullSocketWriteCrash(error)).toBe(false);
  });

  it("does not match a non-TypeError with the same message and frame", () => {
    const error = new Error("Cannot read properties of null (reading 'write')");
    error.stack =
      "Error: Cannot read properties of null (reading 'write')\n" +
      "    at Immediate.nextWrite (/app/node_modules/postgres/src/connection.js:255:20)";
    expect(isPostgresNullSocketWriteCrash(error)).toBe(false);
  });
});

describe("isGuardEnabled", () => {
  it("defaults to enabled when the variable is unset", () => {
    expect(isGuardEnabled({})).toBe(true);
  });

  it("stays enabled for \"true\" and \"1\"", () => {
    expect(isGuardEnabled({ POSTGRES_NULL_SOCKET_GUARD_ENABLED: "true" })).toBe(true);
    expect(isGuardEnabled({ POSTGRES_NULL_SOCKET_GUARD_ENABLED: "1" })).toBe(true);
  });

  it("disables for \"false\" and \"0\"", () => {
    expect(isGuardEnabled({ POSTGRES_NULL_SOCKET_GUARD_ENABLED: "false" })).toBe(false);
    expect(isGuardEnabled({ POSTGRES_NULL_SOCKET_GUARD_ENABLED: "0" })).toBe(false);
  });

  it("throws on an unrecognized value", () => {
    expect(() => isGuardEnabled({ POSTGRES_NULL_SOCKET_GUARD_ENABLED: "maybe" })).toThrow(
      /must be "true" or "false"/,
    );
  });
});

describe("registerPostgresNullSocketGuard", () => {
  afterEach(() => {
    process.off("uncaughtException", handlePostgresNullSocketGuardException);
  });

  it("registers a listener by default", () => {
    const before = process.listenerCount("uncaughtException");
    registerPostgresNullSocketGuard({});
    expect(process.listenerCount("uncaughtException")).toBe(before + 1);
  });

  it("registers no listener when an operator disables it", () => {
    const before = process.listenerCount("uncaughtException");
    registerPostgresNullSocketGuard({ POSTGRES_NULL_SOCKET_GUARD_ENABLED: "false" });
    expect(process.listenerCount("uncaughtException")).toBe(before);
  });

  it("adds one listener however many times it runs", () => {
    const before = process.listenerCount("uncaughtException");
    registerPostgresNullSocketGuard({});
    registerPostgresNullSocketGuard({});
    expect(process.listenerCount("uncaughtException")).toBe(before + 1);
  });
});

describe("handlePostgresNullSocketGuardException", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockLoggerError.mockReset();
    mockLoggerFatal.mockReset();
    mockCaptureException.mockReset();
    mockShutdownSentry.mockReset();
    mockShutdownSentry.mockImplementation(async () => {});
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as unknown as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it("logs a stable marker and the error name, and does not exit, on a matching crash", async () => {
    const error = makeDriverCrashError("Cannot read properties of null (reading 'write')");

    await handlePostgresNullSocketGuardException(error);

    expect(exitSpy).not.toHaveBeenCalled();
    expect(mockLoggerError).toHaveBeenCalledTimes(1);
    const [fields] = mockLoggerError.mock.calls[0] as [Record<string, unknown>];
    expect(fields).toMatchObject({
      marker: "postgres_null_socket_write_guard_neutralized",
      errorName: "TypeError",
    });
  });

  it("never logs the query text, the message, or the stack for a matching crash", async () => {
    const secret = "select * from accounts where token = 'hunter2-secret-token'";
    const error = makeDriverCrashError(`Cannot read properties of null (reading 'write') — ${secret}`);
    // The classifier only matches the exact V8 message, so force a match by
    // constructing the error the classifier itself would accept, then
    // verify no field of the log call carries anything beyond the marker
    // and the fixed error name.
    error.message = "Cannot read properties of null (reading 'write')";

    await handlePostgresNullSocketGuardException(error);

    const [fields] = mockLoggerError.mock.calls[0] as [Record<string, unknown>];
    expect(Object.keys(fields).sort()).toEqual(["errorName", "marker"]);
    for (const value of Object.values(fields)) {
      expect(String(value)).not.toContain(secret);
    }
  });

  it("never reports a matching crash to Sentry — the process survives on its own", async () => {
    const error = makeDriverCrashError("Cannot read properties of null (reading 'write')");

    await handlePostgresNullSocketGuardException(error);

    expect(mockCaptureException).not.toHaveBeenCalled();
    expect(mockShutdownSentry).not.toHaveBeenCalled();
  });

  it("logs, reports to Sentry, flushes, and exits non-zero for a non-matching error", async () => {
    const error = new RangeError("some unrelated fatal condition");

    await handlePostgresNullSocketGuardException(error);

    expect(mockLoggerError).not.toHaveBeenCalled();
    expect(mockLoggerFatal).toHaveBeenCalledTimes(1);
    expect(mockCaptureException).toHaveBeenCalledWith(error);
    expect(mockShutdownSentry).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("waits for the Sentry client to flush before it exits", async () => {
    const error = new RangeError("some unrelated fatal condition");
    let shutdownResolved = false;
    mockShutdownSentry.mockImplementation(async () => {
      await Promise.resolve();
      shutdownResolved = true;
    });
    exitSpy.mockImplementation((() => {
      expect(shutdownResolved).toBe(true);
      return undefined;
    }) as unknown as never);

    await handlePostgresNullSocketGuardException(error);

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("exits non-zero for a non-Error thrown value", async () => {
    await handlePostgresNullSocketGuardException("a thrown string");

    expect(mockCaptureException).toHaveBeenCalledWith(expect.any(Error));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe("the driver crash sequence, reproduced against a fake wire server", () => {
  it("without the guard: the process ends and never reaches recovery", async () => {
    const result = await runFixture("unguarded-crash");

    expect(messageTypes(result)).toContain("transaction-rejected");
    expect(messageTypes(result)).not.toContain("still-alive");
    expect(messageTypes(result)).not.toContain("survived");
    expect(result.code).not.toBe(0);
  }, 20_000);

  // Finding, not a defect in this guard: the driver never resets the
  // crashed connection's own write-scheduling state on the throw path this
  // guard neutralizes (see the module comment in
  // postgres-null-socket-guard.test-fixture.ts). A later query on that
  // exact same connection can never send another byte and times out
  // instead of failing fast. A single-connection pool (`max: 1`) has no
  // other connection to fall back to, so this is the worst case.
  it("with the guard: the transaction rejects, the process survives, but the same crashed connection does not recover", async () => {
    const result = await runFixture("guarded-crash-same-connection");

    expect(messageTypes(result)).toContain("transaction-rejected");
    expect(messageTypes(result)).toContain("still-alive");
    expect(messageTypes(result)).not.toContain("recovery-ok");
    expect(messageTypes(result)).toContain("recovery-failed");
    expect(messageTypes(result)).toContain("survived");
    expect(result.code).toBe(0);
    expect(result.stdout + result.stderr).toContain("postgres_null_socket_write_guard_neutralized");
  }, 20_000);

  // The realistic production shape: a pool with more than one connection.
  // The crash never touches the pool's other connections — each is its own
  // closure — so a later query routed to a different connection succeeds.
  it("with the guard: a pool with another connection keeps serving queries", async () => {
    const result = await runFixture("guarded-crash-pool");

    expect(messageTypes(result)).toContain("transaction-rejected");
    expect(messageTypes(result)).toContain("recovery-ok");
    expect(messageTypes(result)).toContain("survived");
    expect(result.code).toBe(0);
  }, 20_000);

  it("a non-matching uncaught exception still ends the process and reports its cause", async () => {
    const result = await runFixture("unrelated-crash");

    expect(messageTypes(result)).not.toContain("unexpected-survival");
    expect(result.code).toBe(1);
    // The logger writes the fatal record to standard output; Node's own
    // default handler would have used standard error, but the guard
    // replaces that handler for every uncaught exception, so this is the
    // only place the message and the stack can appear.
    expect(result.stdout).toContain("an unrelated failure the guard must not swallow");
    expect(result.stdout).toContain("at Immediate");
  }, 20_000);
});
