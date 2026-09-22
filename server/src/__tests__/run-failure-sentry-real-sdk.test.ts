import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";

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
    };
    const second = {
      ...first,
      taskId: "33333333-3333-4333-8333-333333333333",
      runId: "44444444-4444-4444-8444-444444444444",
      errorMessage: "second run timed out",
      errorCode: "timeout",
      agentAdapter: "other-adapter",
      runStatus: "timed_out" as const,
    };
    captureRunFailure(first);
    await Promise.resolve();
    captureException(new Error("unrelated database error"));
    captureRunFailure(second);
    captureException(new Error("unrelated filesystem error"));
    await Sentry.flush(2000);

    expect(events).toHaveLength(4);
    const captured = (message: string) => events.find((event) =>
      (event.exception as { values: Array<{ value: string }> }).values[0]?.value === message,
    );
    for (const run of [first, second]) {
      expect(captured(run.errorMessage)).toMatchObject({
        tags: { run_id: run.runId, task_id: run.taskId, error_code: run.errorCode,
          agent_adapter: run.agentAdapter, run_status: run.runStatus },
        contexts: { run_failure: { runId: run.runId, taskId: run.taskId,
          errorMessage: run.errorMessage, errorCode: run.errorCode, agentAdapter: run.agentAdapter } },
        fingerprint: [run.errorCode, run.agentAdapter],
      });
    }
    for (const message of ["unrelated database error", "unrelated filesystem error"]) {
      const event = captured(message);
      expect(event).toBeDefined();
      expect(event).not.toHaveProperty("contexts.run_failure");
      expect(event).not.toHaveProperty("fingerprint");
      for (const tag of ["run_id", "task_id", "error_code", "agent_adapter", "run_status"]) {
        expect(event).not.toHaveProperty(`tags.${tag}`);
      }
    }
  });
});
