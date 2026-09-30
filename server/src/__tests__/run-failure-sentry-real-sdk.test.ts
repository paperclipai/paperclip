import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import { collectRunFailureDiagnostics, sanitizeRunFailureDiagnostics } from "../services/run-failure-diagnostics.js";
import type { heartbeatRuns } from "@paperclipai/db";

// Sentry is an optional peer. When installed, exercise the real SDK with an
// in-memory transport, including its context behavior without an OTel manager.
const sentryPackage = (() => {
  try {
    const require = createRequire(import.meta.url);
    return require("@sentry/node") as {
      init(options: Record<string, unknown>): unknown;
      captureException(error: unknown, context?: unknown): string;
      withScope(callback: (scope: unknown) => void): void;
      httpIntegration(options: { breadcrumbs: boolean }): { name: string };
      onUnhandledRejectionIntegration(options: { mode: string }): { name: string };
      flush(timeout?: number): Promise<boolean>;
      close(timeout?: number): Promise<boolean>;
    };
  } catch {
    return null;
  }
})();

if (process.env.PAPERCLIP_REQUIRE_SENTRY_TEST_SDK === "1" && !sentryPackage) {
  throw new Error("The Sentry SDK contract job requires the audited optional peer");
}

afterEach(async () => {
  await sentryPackage?.close(2000);
  vi.unstubAllEnvs();
  vi.doUnmock("@sentry/node");
  vi.doUnmock("../peer-version-check.js");
  vi.resetModules();
});

describe.skipIf(!sentryPackage)("run failure context with the real Sentry SDK", () => {
  it("keeps unconfirmed Stop context off unrelated events and drops arbitrary error fields", async () => {
    const Sentry = sentryPackage!;
    const events: Array<Record<string, unknown>> = [];
    vi.stubEnv("SENTRY_DSN_BACKEND", "https://public@example.invalid/1");
    vi.doMock("../peer-version-check.js", () => ({ checkExactPeerVersions: () => ({ ok: true }) }));
    vi.doMock("@sentry/node", () => ({
      ...Sentry,
      init: (options: Record<string, unknown>) => Sentry.init({
        ...options,
        transport: () => ({ send: async () => ({}), flush: async () => true }),
        beforeSend: (event: Record<string, unknown>) => { events.push(event); return event; },
      }),
    }));
    vi.resetModules();
    const { sentryReady, captureException } = await import("../sentry.js");
    const { AdapterStopTimeoutError } = await import("../services/adapter-stop-timeout.js");
    await sentryReady;
    const timeout = Object.assign(new AdapterStopTimeoutError(60_000, {
      runId: "11111111-1111-4111-8111-111111111111", adapterType: "cursor",
      runtimeMode: "legacy", abortRequested: true,
    }), {
      cause: new Error("private-provider-cause"),
      providerResponse: { headers: "private-provider-headers", body: "private-provider-body" },
    });
    captureException(timeout);
    await Promise.resolve();
    captureException(new Error("unrelated stop diagnostic fixture"));
    await Sentry.flush(2000);
    expect(events).toHaveLength(2);
    const captured = (message: string) => events.find((event) =>
      (event.exception as { values: Array<{ value: string }> }).values.some((entry) => entry.value === message),
    );
    expect(captured(timeout.message)).toMatchObject({
      tags: { error_code: "adapter_stop_unconfirmed" }, fingerprint: ["{{ default }}"],
      contexts: { adapter_stop: {
        runId: "11111111-1111-4111-8111-111111111111", adapterType: "cursor",
        runtimeMode: "legacy", abortRequested: true, timeoutMs: 60_000,
      } },
    });
    expect(JSON.stringify(events)).not.toContain("private-provider-");
    const unrelated = captured("unrelated stop diagnostic fixture");
    expect(unrelated).toBeDefined();
    expect(unrelated).not.toHaveProperty("contexts.adapter_stop");
    expect(unrelated).not.toHaveProperty("tags.error_code");
    expect(unrelated).not.toHaveProperty("fingerprint");
  });

  it("keeps each run's identity and fingerprint off unrelated errors", async () => {
    const Sentry = sentryPackage!;
    const events: Array<Record<string, unknown>> = [];
    vi.stubEnv("SENTRY_DSN_BACKEND", "https://public@example.invalid/1");
    vi.doMock("../peer-version-check.js", () => ({
      checkExactPeerVersions: () => ({ ok: true }),
    }));
    vi.doMock("@sentry/node", () => ({
      ...Sentry,
      init: (options: Record<string, unknown>) => Sentry.init({
        ...options,
        transport: () => ({ send: async () => ({}), flush: async () => true }),
        beforeSend: (event: Record<string, unknown>) => {
          events.push(event);
          return event;
        },
      }),
    }));
    vi.resetModules();
    const { sentryReady, captureRunFailure, captureException } = await import("../sentry.js");
    await sentryReady;

    const first = {
      taskId: "11111111-1111-4111-8111-111111111111",
      runId: "22222222-2222-4222-8222-222222222222",
      errorMessage: "first run failed",
      errorCode: "adapter_failed",
      agentAdapter: "fixture-adapter",
      runStatus: "failed" as const,
      exitCode: 1,
      signal: null,
    };
    const second = {
      ...first,
      taskId: "33333333-3333-4333-8333-333333333333",
      runId: "44444444-4444-4444-8444-444444444444",
      errorMessage: "second run timed out",
      errorCode: "timeout",
      agentAdapter: "other-adapter",
      runStatus: "timed_out" as const,
      exitCode: null,
      signal: "SIGKILL",
    };
    const original = Object.assign(new Error(first.errorMessage, { cause: Object.assign(new Error("upstream connection reset"), {
      code: "ECONNRESET", requestId: "request-123", status: 503,
      stack: "Error: upstream connection reset\n    at socketRead (/app/provider.js:19:7)",
      response: { body: "private-response" },
    }) }), { stack: "Error: first run failed\n    at originalAdapter (/app/adapter.js:42:7)", request: { headers: "private-headers" } });
    const diagnostics = sanitizeRunFailureDiagnostics(collectRunFailureDiagnostics({
      runtimeMode: "legacy", resultJson: { terminalSessionFailure: {
        category: "service", title: "Provider failed", details: "d".repeat(9000),
      } },
    } as unknown as typeof heartbeatRuns.$inferSelect, { error: original, phase: "execute" }));
    captureRunFailure({ ...first, diagnostics });
    await Promise.resolve();
    captureException(new Error("unrelated database error"));
    captureRunFailure(second);
    captureRunFailure({
      ...first,
      errorMessage: "malformed process metadata",
      exitCode: NaN,
      signal: "private-signal-payload",
    });
    captureException(new Error("unrelated filesystem error"));
    await Sentry.flush(2000);

    expect(events).toHaveLength(5);
    const captured = (message: string) => events.find((event) =>
      (event.exception as { values: Array<{ value: string }> }).values.some((value) => value.value === message),
    );
    for (const run of [first, second]) {
      expect(captured(run.errorMessage)).toMatchObject({
        tags: { run_id: run.runId, task_id: run.taskId, error_code: run.errorCode,
          agent_adapter: run.agentAdapter, run_status: run.runStatus },
        contexts: { run_failure: { runId: run.runId, taskId: run.taskId,
          errorMessage: run.errorMessage, errorCode: run.errorCode, agentAdapter: run.agentAdapter,
          exitCode: run.exitCode, signal: run.signal } },
        fingerprint: [run.errorCode, run.agentAdapter],
      });
    }
    expect(captured("malformed process metadata")).toMatchObject({
      contexts: { run_failure: { exitCode: null, signal: "unknown" } },
      fingerprint: [first.errorCode, first.agentAdapter],
    });
    expect(JSON.stringify(events)).not.toContain("private-signal-payload");
    const firstCapture = captured(first.errorMessage)!;
    const exceptions = (firstCapture.exception as { values: Array<Record<string, unknown>> }).values;
    expect(exceptions).toHaveLength(2);
    expect(JSON.stringify(exceptions)).toContain("originalAdapter");
    expect(JSON.stringify(exceptions)).toContain("socketRead");
    expect(JSON.stringify(exceptions)).not.toContain("captureRunFailure");
    expect(JSON.stringify(captured(second.errorMessage)?.exception)).not.toContain("captureRunFailure");
    expect(firstCapture).toMatchObject({ contexts: {
      provider_failure: { category: "service", details: "d".repeat(9000) },
      run_exception_1: { code: "ECONNRESET", requestId: "request-123", status: 503 },
    } });
    expect(JSON.stringify(events)).not.toContain("private-");
    for (const message of ["unrelated database error", "unrelated filesystem error"]) {
      const event = captured(message);
      expect(event).toBeDefined();
      expect(event).not.toHaveProperty("contexts.run_failure");
      for (const context of ["run_execution", "adapter_failure", "provider_failure", "run_exception_0", "run_exception_1"]) {
        expect(event).not.toHaveProperty(`contexts.${context}`);
      }
      expect(event).not.toHaveProperty("fingerprint");
      for (const tag of ["run_id", "task_id", "error_code", "agent_adapter", "run_status"]) {
        expect(event).not.toHaveProperty(`tags.${tag}`);
      }
    }
  });
});
