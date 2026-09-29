import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunFailureEvent } from "../sentry.js";

/**
 * Tests for `captureRunFailure`, the Sentry report for a terminal run
 * failure. `@sentry/node` is an optional runtime dependency and is not
 * installed in this test environment, so each test mocks a fake copy of the
 * package the same way `sentry.test.ts` does, then imports a fresh copy of
 * `../sentry.js` with a backend DSN set. That opens the gate and lets the
 * fake package's `captureException` spy records the real call
 * shape.
 */

const DSN_ENV = "SENTRY_DSN";
const FRONTEND_DSN_ENV = "SENTRY_DSN_FRONTEND";
const BACKEND_DSN_ENV = "SENTRY_DSN_BACKEND";
const originalDsn = process.env[DSN_ENV];
const originalFrontendDsn = process.env[FRONTEND_DSN_ENV];
const originalBackendDsn = process.env[BACKEND_DSN_ENV];

function baseEvent(overrides: Partial<RunFailureEvent> = {}): RunFailureEvent {
  return {
    taskId: "11111111-1111-1111-1111-111111111111",
    runId: "22222222-2222-2222-2222-222222222222",
    errorMessage: "the provider process exited with code 1",
    errorCode: "process_lost",
    agentAdapter: "claude-code",
    runStatus: "failed",
    ...overrides,
  };
}

interface CaptureContext {
  tags: Record<string, string>;
  contexts: Record<string, Record<string, unknown>>;
  fingerprint: string[];
}

/** Mirrors `sentry.test.ts`'s `mockSentryPackage`. */
function mockSentryPackage() {
  const init = vi.fn();
  const captureException = vi.fn((_error: unknown, _context?: CaptureContext) => "event-id");
  const close = vi.fn(async () => true);
  const httpIntegration = vi.fn((options: unknown) => ({ name: "Http", ...(options as object) }));
  const onUnhandledRejectionIntegration = vi.fn((options: unknown) => ({
    name: "OnUnhandledRejection",
    ...(options as object),
  }));

  vi.doMock("@sentry/node", () => ({
    init,
    captureException,
    close,
    httpIntegration,
    onUnhandledRejectionIntegration,
  }));
  vi.doMock("../peer-version-check.js", () => ({
    checkExactPeerVersions: () => ({ ok: true }),
  }));

  return { init, captureException, close };
}

async function importFreshSentryWithGateOpen() {
  process.env[BACKEND_DSN_ENV] = "https://public@sentry.example.com/1";
  const mocks = mockSentryPackage();
  vi.resetModules();
  const sentryModule = await import("../sentry.js");
  await sentryModule.sentryReady;
  return { sentryModule, ...mocks };
}

beforeEach(() => {
  delete process.env[DSN_ENV];
  delete process.env[FRONTEND_DSN_ENV];
  delete process.env[BACKEND_DSN_ENV];
});

afterEach(() => {
  if (originalDsn === undefined) delete process.env[DSN_ENV];
  else process.env[DSN_ENV] = originalDsn;
  if (originalFrontendDsn === undefined) delete process.env[FRONTEND_DSN_ENV];
  else process.env[FRONTEND_DSN_ENV] = originalFrontendDsn;
  if (originalBackendDsn === undefined) delete process.env[BACKEND_DSN_ENV];
  else process.env[BACKEND_DSN_ENV] = originalBackendDsn;
  vi.restoreAllMocks();
  vi.doUnmock("@sentry/node");
  vi.doUnmock("../peer-version-check.js");
});

describe("captureRunFailure", () => {
  it("sets the fingerprint [errorCode, agentAdapter] in that order", async () => {
    const { sentryModule, captureException } = await importFreshSentryWithGateOpen();

    sentryModule.captureRunFailure(baseEvent({ errorCode: "timeout", agentAdapter: "codex" }));

    expect(captureException.mock.calls[0]![1]?.fingerprint).toEqual(["timeout", "codex"]);
  });

  it("keeps the error message out of the fingerprint for two runs with the same code and adapter but different messages", async () => {
    const { sentryModule, captureException } = await importFreshSentryWithGateOpen();

    sentryModule.captureRunFailure(
      baseEvent({ errorMessage: "message one", errorCode: "timeout", agentAdapter: "codex" }),
    );
    sentryModule.captureRunFailure(
      baseEvent({ errorMessage: "message two", errorCode: "timeout", agentAdapter: "codex" }),
    );

    expect(captureException.mock.calls[0]![1]?.fingerprint).toEqual(["timeout", "codex"]);
    expect(captureException.mock.calls[1]![1]?.fingerprint).toEqual(["timeout", "codex"]);
  });

  it("sets the fingerprint element \"unknown\" when the error code is absent", async () => {
    const { sentryModule, captureException } = await importFreshSentryWithGateOpen();

    sentryModule.captureRunFailure(baseEvent({ errorCode: null }));

    expect(captureException.mock.calls[0]![1]?.fingerprint).toEqual(["unknown", "claude-code"]);
  });

  it("keeps missing process exit evidence null on the run_failure context", async () => {
    const { sentryModule, captureException } = await importFreshSentryWithGateOpen();
    const event = baseEvent();

    sentryModule.captureRunFailure(event);

    expect(captureException.mock.calls[0]![1]?.contexts.run_failure).toEqual({
      taskId: event.taskId,
      runId: event.runId,
      errorMessage: event.errorMessage,
      errorCode: event.errorCode,
      agentAdapter: event.agentAdapter,
      exitCode: null,
      signal: null,
    });
  });

  it.each([
    { exitCode: 1, signal: null },
    { exitCode: 0, signal: null },
    { exitCode: -1, signal: null },
    { exitCode: -2147483648, signal: null },
    { exitCode: 2147483647, signal: null },
    { exitCode: null, signal: "SIGTERM" },
    { exitCode: null, signal: "SIGKILL" },
  ])("retains process exit evidence without changing grouping: %j", async (processExit) => {
    const { sentryModule, captureException } = await importFreshSentryWithGateOpen();
    const event = baseEvent({ ...processExit, errorMessage: "Adapter failed", errorCode: "adapter_failed" });

    sentryModule.captureRunFailure(event);

    const [error, context] = captureException.mock.calls[0]!;
    expect((error as Error).message).toBe("Adapter failed");
    expect(context?.contexts.run_failure).toMatchObject(processExit);
    expect(context?.fingerprint).toEqual(["adapter_failed", event.agentAdapter]);
    expect(context?.tags).not.toHaveProperty("exitCode");
    expect(context?.tags).not.toHaveProperty("signal");
  });

  it.each([
    ["private-exit-payload", "SIGTERM private-signal-payload"],
    ["1", "constructor"],
    [true, "__proto__"],
    [1.5, "SIGCUSTOM"],
    [NaN, ""],
    [Infinity, 9],
    [2147483648, { private: "signal-payload" }],
    [-2147483649, ["SIGTERM"]],
  ])("rejects malformed process exit fields (%j, %j)", async (exitCode, signal) => {
    const { sentryModule, captureException } = await importFreshSentryWithGateOpen();

    sentryModule.captureRunFailure({ ...baseEvent(), exitCode, signal } as RunFailureEvent);

    expect(captureException.mock.calls[0]![1]?.contexts.run_failure).toMatchObject({
      exitCode: null,
      signal: "unknown",
    });
    expect(JSON.stringify(captureException.mock.calls)).not.toContain("private-");
  });

  it("does not set an instance key on the run_failure context", async () => {
    const { sentryModule, captureException } = await importFreshSentryWithGateOpen();

    sentryModule.captureRunFailure(baseEvent());

    const context = captureException.mock.calls[0]![1]?.contexts.run_failure;
    expect(context).not.toHaveProperty("instance");
  });

  it("sets run_id, task_id, error_code, agent_adapter, and run_status as tags", async () => {
    const { sentryModule, captureException } = await importFreshSentryWithGateOpen();
    const event = baseEvent();

    sentryModule.captureRunFailure(event);

    expect(captureException.mock.calls[0]![1]?.tags).toEqual({
      run_id: event.runId,
      task_id: event.taskId,
      error_code: event.errorCode,
      agent_adapter: event.agentAdapter,
      run_status: event.runStatus,
    });
  });

  it("captures the redacted error message as the exception message", async () => {
    const { sentryModule, captureException } = await importFreshSentryWithGateOpen();
    const event = baseEvent({ errorMessage: "boom" });

    sentryModule.captureRunFailure(event);

    expect(captureException).toHaveBeenCalledTimes(1);
    const [received] = captureException.mock.calls[0]!;
    expect(received).toBeInstanceOf(Error);
    expect((received as Error).message).toBe("boom");
  });

  it("uses sanitized original stacks and causes instead of the reporting stack", async () => {
    const { sentryModule, captureException } = await importFreshSentryWithGateOpen();
    sentryModule.captureRunFailure(baseEvent({ diagnostics: {
      execution: { runtimeMode: "native", failurePhase: "setup" },
      adapter: {}, provider: {}, truncatedFields: [],
      exceptions: [
        { name: "TypeError", message: "setup failed", stack: "TypeError: setup failed\n    at originalSetup (/app/setup.js:42:7)" },
        { name: "Error", message: "connection reset", stack: "Error: connection reset\n    at socketRead (/app/network.js:9:4)", code: "ECONNRESET", requestId: "req-123" },
      ],
    } }));
    const [error, context] = captureException.mock.calls[0]!;
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ name: "TypeError", message: "setup failed", cause: { message: "connection reset" } });
    expect((error as Error).stack).toContain("originalSetup");
    expect((error as Error).stack).not.toContain("captureRunFailure");
    expect(context?.contexts.run_exception_1).toMatchObject({ code: "ECONNRESET", requestId: "req-123" });
    expect(context?.contexts.run_execution).toMatchObject({ failurePhase: "setup" });
  });

  it("does not invent a reporter stack for a saved result with no original exception", async () => {
    const { sentryModule, captureException } = await importFreshSentryWithGateOpen();
    sentryModule.captureRunFailure(baseEvent());
    expect((captureException.mock.calls[0]![0] as Error).stack).toBeUndefined();
  });

  it("does not throw and captures nothing when the gate is closed", async () => {
    vi.resetModules();
    const sentryModule = await import("../sentry.js");
    await sentryModule.sentryReady;

    expect(() => sentryModule.captureRunFailure(baseEvent())).not.toThrow();
  });

  it("does not throw when the client throws", async () => {
    const { sentryModule, captureException } = await importFreshSentryWithGateOpen();
    captureException.mockImplementation(() => {
      throw new Error("sentry client is down");
    });

    expect(() => sentryModule.captureRunFailure(baseEvent())).not.toThrow();
  });
});
