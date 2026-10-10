import { captureEnvironmentAcquisitionDiagnostic } from "../services/environment-acquisition-diagnostics.js";
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildHeartbeatRunStopMetadata, mergeHeartbeatRunStopMetadata } from "../services/heartbeat-stop-metadata.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { collectRunFailureDiagnostics, sanitizeRunFailureDiagnostics } from "../services/run-failure-diagnostics.js";
import type { heartbeatRuns } from "@paperclipai/db";
import {
  preserveWorkspaceRestoreErrorDiagnostic,
  withWorkspaceRestoreDiagnostics,
  withWorkspaceRestoreStep,
  withWorkspaceRestoreGitCommand,
} from "@paperclipai/adapter-utils/workspace-restore-diagnostics";
import { createWorkspaceRestoreTeardown } from "@paperclipai/adapter-utils/workspace-restore-teardown";

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
  vi.doUnmock("@paperclipai/adapter-utils/execution-target");
  vi.resetModules();
});

describe.skipIf(!sentryPackage)("run failure context with the real Sentry SDK", () => {
  it("captures an early OpenCode timeout without inventing a deadline or exporting provider output", async () => {
    const Sentry = sentryPackage!;
    const events: Array<Record<string, unknown>> = [];
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-sentry-"));
    const restore = vi.fn(async () => {});
    const stop = vi.fn(async () => {});
    const processResult = {
      exitCode: null, signal: null, timedOut: true, pid: null,
      startedAt: "2020-01-01T00:00:00.000Z", durationMs: 100,
      stdout: "private-timeout-output-canary",
      stderr: "<html>504 Gateway Time-out private-timeout-credential-canary</html>",
    };
    const runProcess = vi.fn(async () => processResult);
    vi.stubEnv("XDG_CONFIG_HOME", root);
    vi.stubEnv("SENTRY_DSN_BACKEND", "https://public@example.invalid/1");
    vi.doMock("../peer-version-check.js", () => ({ checkExactPeerVersions: () => ({ ok: true }) }));
    vi.doMock("@sentry/node", () => ({ ...Sentry,
      init: (options: Record<string, unknown>) => Sentry.init({ ...options,
        transport: () => ({ send: async (envelope: [unknown, Array<[{ type: string }, Record<string, unknown>]>]) => {
          for (const [header, payload] of envelope[1]) if (header.type === "event") events.push(payload);
          return {};
        }, flush: async () => true }),
      }),
    }));
    // Only external execution/setup seams are replaced. The real adapter owns
    // the message/policy, and the real finalization/collector/SDK send the event.
    vi.doMock("@paperclipai/adapter-utils/execution-target", async (importOriginal) => ({
      ...await importOriginal<typeof import("@paperclipai/adapter-utils/execution-target")>(),
      ensureAdapterExecutionTargetRuntimeCommandInstalled: vi.fn(),
      ensureAdapterExecutionTargetCommandResolvable: vi.fn(),
      prepareAdapterExecutionTargetRuntime: vi.fn(async () => ({
        runtimeRootDir: "/workspace/runtime", workspaceRemoteDir: "/workspace",
        assetDirs: {}, restoreWorkspace: restore,
      })),
      readAdapterExecutionTargetHomeDir: vi.fn(async () => "/home/fixture"),
      startAdapterExecutionTargetPaperclipBridge: vi.fn(async () => ({ env: {}, stop })),
      runAdapterExecutionTargetProcess: runProcess,
    }));
    vi.resetModules();
    try {
      const { execute } = await import("@paperclipai/adapter-opencode-local/server");
      const { sentryReady, captureRunFailure, captureException } = await import("../sentry.js");
      await sentryReady;
      const result = await execute({
        runId: "22222222-2222-4222-8222-222222222222",
        agent: { id: "agent-fixture", companyId: "company-fixture", name: "Fixture", adapterType: "opencode_local", adapterConfig: {} },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: { command: "opencode", model: "openai/fixture", cwd: root, timeoutSec: 0,
          env: { OPENCODE_ALLOW_ALL_MODELS: "1" } },
        context: {}, onLog: async () => {},
        executionTarget: { kind: "remote", transport: "sandbox", remoteCwd: "/workspace" },
      });
      expect(result).toMatchObject({ timedOut: true, exitCode: null, signal: null });
      expect(runProcess).toHaveBeenCalledTimes(1);
      expect(restore).toHaveBeenCalledTimes(1);
      expect(stop).toHaveBeenCalledTimes(1);
      const resultJson = mergeHeartbeatRunStopMetadata(result.resultJson,
        buildHeartbeatRunStopMetadata({ adapterType: "opencode_local", adapterConfig: { timeoutSec: 0 }, outcome: "timed_out" }));
      const diagnostics = sanitizeRunFailureDiagnostics(collectRunFailureDiagnostics({
        errorCode: "timeout", resultJson,
        startedAt: new Date("2020-01-01T00:00:00.000Z"), finishedAt: new Date("2020-01-01T00:00:00.100Z"),
      } as typeof heartbeatRuns.$inferSelect, { phase: "execute" }));
      captureRunFailure({ taskId: "11111111-1111-4111-8111-111111111111", runId: "22222222-2222-4222-8222-222222222222",
        errorMessage: result.errorMessage!, errorCode: "timeout", agentAdapter: "opencode_local",
        runStatus: "timed_out", exitCode: result.exitCode, signal: result.signal, diagnostics });
      captureException(new Error("Unrelated timeout fixture"));
      await Sentry.flush(2000);
      expect(events).toHaveLength(2);
      const event = events.find(entry => (entry.tags as Record<string, unknown>)?.error_code === "timeout");
      expect(event).toMatchObject({ exception: { values: [{ value: "OpenCode execution timed out" }] },
        contexts: { run_execution: { durationMs: 100, effectiveTimeoutSec: 14400,
          timeoutSource: "sandbox_default", timeoutConfigured: false, timeoutFired: true, stopReason: "timeout" } } });
      expect(JSON.stringify(events)).not.toMatch(/private-timeout-|<html>|504|Timed out after/);
      expect(events.find(entry => entry !== event)).not.toHaveProperty("contexts.run_execution");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("sends only owned acquisition observations and isolates unrelated captures", async () => {
    const Sentry = sentryPackage!;
    const events: Array<Record<string, unknown>> = [];
    vi.stubEnv("SENTRY_DSN_BACKEND", "https://public@example.invalid/1");
    vi.doMock("../peer-version-check.js", () => ({ checkExactPeerVersions: () => ({ ok: true }) }));
    vi.doMock("@sentry/node", () => ({ ...Sentry,
      init: (options: Record<string, unknown>) => Sentry.init({ ...options,
        transport: () => ({ send: async (envelope: [unknown, Array<[{ type: string }, Record<string, unknown>]>]) => {
          for (const [header, payload] of envelope[1]) if (header.type === "event") events.push(payload);
          return {};
        }, flush: async () => true }),
      }),
    }));
    vi.resetModules();
    const { sentryReady, captureRunFailure, captureException } = await import("../sentry.js");
    await sentryReady;
    const scope = { companyId: "company-fixture", environmentId: "environment-fixture",
      runId: "22222222-2222-4222-8222-222222222222" };
    // The acquire boundary and real worker wire are covered separately. This
    // narrow SDK job imports only the dependency-free private-marker projection.
    const error = Object.freeze(Object.assign(new Error("Acquisition failed"), {
      data: { raw: "private-acquire-payload" }, path: "private-acquire-path", response: { token: "private-acquire-token" },
    }));
    captureEnvironmentAcquisitionDiagnostic(error, scope, { phase: "workspace", elapsedMs: 100, budgetMs: 2_000 });
    const diagnostics = sanitizeRunFailureDiagnostics(collectRunFailureDiagnostics({
      id: scope.runId, companyId: scope.companyId, errorCode: "setup_failed", resultJson: null,
    } as typeof heartbeatRuns.$inferSelect, { error: new Error("Cleanup confirmed", { cause: error }), phase: "setup" }));
    captureRunFailure({ taskId: "11111111-1111-4111-8111-111111111111", runId: scope.runId,
      errorMessage: "Acquisition failed", errorCode: "setup_failed", agentAdapter: "fixture-adapter",
      runStatus: "failed", exitCode: null, signal: null, diagnostics });
    captureException(new Error("Unrelated acquisition fixture"));
    await Sentry.flush(2000);
    expect(events).toHaveLength(2);
    const event = events.find(entry => (entry.tags as Record<string, unknown>)?.error_code === "setup_failed");
    expect(event).toMatchObject({ contexts: { run_execution: {
      environmentAcquisitionPhase: "workspace", environmentAcquisitionElapsedMs: 100, environmentAcquisitionBudgetMs: 2_000,
    } } });
    expect(JSON.stringify(events)).not.toContain("private-acquire-");
    expect(events.find(entry => entry !== event)).not.toHaveProperty("contexts.run_execution");
  });

  it("sends base-ref observations through the real scrubber and transport without private payloads", async () => {
    const Sentry = sentryPackage!;
    const events: Array<Record<string, unknown>> = [];
    vi.stubEnv("SENTRY_DSN_BACKEND", "https://public@example.invalid/1");
    vi.doMock("../peer-version-check.js", () => ({ checkExactPeerVersions: () => ({ ok: true }) }));
    vi.doMock("@sentry/node", () => ({ ...Sentry,
      init: (options: Record<string, unknown>) => Sentry.init({ ...options,
        transport: () => ({
          send: async (envelope: [unknown, Array<[{ type: string }, Record<string, unknown>]>]) => {
            for (const [header, payload] of envelope[1]) if (header.type === "event") events.push(payload);
            return {};
          }, flush: async () => true,
        }),
      }),
    }));
    vi.resetModules();
    const { sentryReady, captureRunFailure, captureException } = await import("../sentry.js");
    await sentryReady;
    const diagnostics = sanitizeRunFailureDiagnostics(collectRunFailureDiagnostics({ errorCode: "configuration_incomplete", resultJson: {
      configurationIncomplete: { reason: "workspace_base_ref_unresolved", requestedRef: "private-base-ref",
        fetchError: "private-base-stderr", baseRefDiagnostic: { schemaVersion: 1, remoteLookup: "resolved", authLookup: "failed",
          fetch: "failed", fetchExitCode: 128, fetchFailureKind: "dns_failure", refResolution: "failed", refExitCode: 128,
          repoUrl: "https://private-base.example.invalid", credential: "private-base-token", stderr: "private-base-output",
        },
      },
    } } as unknown as typeof heartbeatRuns.$inferSelect, {}));
    captureRunFailure({ taskId: "11111111-1111-4111-8111-111111111111", runId: "22222222-2222-4222-8222-222222222222",
      errorMessage: "Configured workspace base ref could not be resolved.", errorCode: "configuration_incomplete",
      agentAdapter: "fixture-adapter", runStatus: "failed", exitCode: null, signal: null, diagnostics,
    });
    captureException(new Error("Unrelated base-ref fixture"));
    await Sentry.flush(2000);
    expect(events).toHaveLength(2);
    const event = events.find(entry => (entry.tags as Record<string, unknown>)?.error_code === "configuration_incomplete");
    expect(event).toMatchObject({ contexts: { run_execution: { workspaceBaseRefRemoteLookup: "resolved", workspaceBaseRefAuthLookup: "failed",
      workspaceBaseRefFetch: "failed", workspaceBaseRefFetchExitCode: 128, workspaceBaseRefFetchFailureKind: "dns_failure",
      workspaceBaseRefRefResolution: "failed", workspaceBaseRefRefExitCode: 128,
    } } });
    expect(JSON.stringify(events)).not.toContain("private-base-");
    const unrelated = events.find(entry => entry !== event);
    expect(unrelated).not.toHaveProperty("contexts.run_execution");
    expect(unrelated).not.toHaveProperty("contexts.run_failure");
    expect(unrelated).not.toHaveProperty("tags.error_code");
  });

  it("sends only bounded process-loss evidence without leaking it into another capture", async () => {
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
    const { sentryReady, captureRunFailure, captureException } = await import("../sentry.js");
    await sentryReady;
    const diagnostics = sanitizeRunFailureDiagnostics(collectRunFailureDiagnostics({
      errorCode: "process_lost", resultJson: { processLossDiagnostic: {
        pidRecorded: true, groupRecorded: false, localCheck: "not_observed_alive", retryEligible: true,
        runPredatesObserver: true, observerUptimeMs: 30_000, lastOutputAgeMs: 120_000,
        pid: "private-process-identity", path: "/private-process-path", prompt: "private-process-prompt",
      } },
    } as unknown as typeof heartbeatRuns.$inferSelect, {}));
    captureRunFailure({
      taskId: "11111111-1111-4111-8111-111111111111", runId: "22222222-2222-4222-8222-222222222222",
      errorMessage: "Process lost -- server may have restarted", errorCode: "process_lost",
      agentAdapter: "fixture-adapter", runStatus: "failed", exitCode: null, signal: null, diagnostics,
    });
    captureException(new Error("unrelated process-loss fixture"));
    await Sentry.flush(2000);
    expect(events).toHaveLength(2);
    const failure = events.find(event => (event.tags as Record<string, unknown>)?.error_code === "process_lost");
    expect(failure).toMatchObject({ contexts: { run_execution: {
      processLossPidRecorded: true, processLossGroupRecorded: false, processLossLocalCheck: "not_observed_alive",
      processLossRetryEligible: true, processLossRunPredatesObserver: true,
      processLossObserverUptimeMs: 30_000, processLossLastOutputAgeMs: 120_000,
    } } });
    expect(JSON.stringify(events)).not.toContain("private-process-");
    const unrelated = events.find(event => event !== failure);
    expect(unrelated).not.toHaveProperty("contexts.run_execution");
    expect(unrelated).not.toHaveProperty("contexts.run_failure");
  });

  it("keeps portfolio diagnostics bounded and isolated from unrelated captures", async () => {
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
    const { CloudPortfolioError } = await import("../services/cloud-portfolio-error.js");
    await sentryReady;
    const failure = new CloudPortfolioError("upstream", {
      phase: "fetch", elapsedMs: 270, upstreamStatus: null,
    }, new TypeError("private-portfolio-message", { cause: { code: "ECONNRESET", token: "private-portfolio-token" } }));
    Object.assign(failure, {
      cause: new Error("private-portfolio-cause"),
      request: { url: "https://private-portfolio.invalid", headers: { cookie: "private-portfolio-cookie" } },
    });
    Object.defineProperty(failure, "diagnostics", { value: { extra: "private-portfolio-replacement" } });
    captureException(failure);
    captureException(new Error("unrelated portfolio fixture"));
    await Sentry.flush(2000);
    expect(events).toHaveLength(2);
    const captured = events.find((event) => (event.exception as { values: Array<{ value: string }> }).values.some((entry) => entry.value === failure.message));
    expect(captured).toMatchObject({
      tags: { error_code: "cloud_portfolio_failure" }, fingerprint: ["{{ default }}"],
      contexts: { cloud_portfolio: { phase: "fetch", elapsedMs: 270, upstreamStatus: null, networkCode: "ECONNRESET" } },
    });
    expect((captured!.exception as { values: unknown[] }).values).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain("private-portfolio-");
    const unrelated = events.find((event) => event !== captured)!;
    expect(unrelated).not.toHaveProperty("contexts.cloud_portfolio");
    expect(unrelated).not.toHaveProperty("tags.error_code");
    expect(unrelated).not.toHaveProperty("fingerprint");
  });

  it.each([
    { phase: "workspace_restore", phaseElapsedMs: 60_123, expectedPhase: "workspace_restore", expectedElapsedMs: 60_123 },
    { phase: "private-provider-phase", phaseElapsedMs: 100, expectedPhase: "unknown", expectedElapsedMs: null },
    { phase: "workspace_restore", phaseElapsedMs: Infinity, expectedPhase: "workspace_restore", expectedElapsedMs: null },
  ])("keeps bounded unconfirmed Stop context off unrelated events ($expectedPhase)", async ({ phase, phaseElapsedMs, expectedPhase, expectedElapsedMs }) => {
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
      phase, phaseElapsedMs,
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
        phase: expectedPhase, phaseElapsedMs: expectedElapsedMs,
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
    }) }), { stack: "Error: first run failed\n    at originalAdapter (/app/adapter.js:42:7)", request: { headers: "private-headers" },
      code: "ERR_WORKSPACE_RESTORE_LOCK_TIMEOUT", workspaceRestoreLock: {
        operation: "agent_directory_release", ownerState: "alive", ownerSameProcess: true, ownerPredatesProcess: true,
        knownLocalHolder: false, ownerAgeMs: 120_000, waitMs: 30_001, path: "/private-lock-path",
      } });
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
      run_execution: { restoreLockOperation: "agent_directory_release", restoreLockOwnerState: "alive", restoreLockOwnerSameProcess: true,
        restoreLockOwnerPredatesProcess: true, restoreLockKnownLocalHolder: false,
        restoreLockOwnerAgeMs: 120_000, restoreLockWaitMs: 30_001 },
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

  it("reports the failing restore step without exposing the wrapped Git error", async () => {
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
    const { sentryReady, captureRunFailure, captureException } = await import("../sentry.js");
    await sentryReady;

    const source = Object.assign(new Error("private-restore-Git command failed in /private-restore-workspace", {
      cause: new Error("private-restore-provider cause"),
    }), {
      code: 1, statusCode: 503, stdout: "a".repeat(40) + "\nprivate-restore-file contents", stderr: "private-restore-Git output",
      command: "private-restore-command", path: "/private-restore-workspace", response: { body: "private-restore-response" },
    });
    const wrapper = new Error("private-restore-Git wrapper");
    expect(wrapper).not.toHaveProperty("cause");
    const logs: string[] = [];
    const restore = createWorkspaceRestoreTeardown({
      stagedRuntime: {
        restoreWorkspace: (onProgress) => withWorkspaceRestoreDiagnostics("workspace", () =>
          withWorkspaceRestoreStep("directory_merge", () =>
            withWorkspaceRestoreStep("git_integration", async () => {
              try { await withWorkspaceRestoreGitCommand("merge_tree", async () => { throw source; }); }
              catch (error) { throw preserveWorkspaceRestoreErrorDiagnostic(wrapper, error); }
            })), onProgress),
      },
      onLog: async (_stream, line) => { logs.push(line); },
      startMessage: "Restoring workspace\n",
      failurePrefix: "Workspace restore failed",
    });
    const outcome = await restore();
    expect(outcome).toEqual({
      ok: false, code: "restore_failed",
      diagnostic: { phase: "workspace", step: "git_integration", errorCode: "unknown", httpStatus: 503, exitCode: 1,
        gitCommand: "merge_tree", gitFailureKind: "merge_conflict" },
    });
    if (outcome.ok) throw new Error("Expected the restore fixture to fail");
    expect(JSON.stringify({ outcome, logs })).not.toContain("private-restore-");
    const diagnostics = sanitizeRunFailureDiagnostics(collectRunFailureDiagnostics({
      resultJson: {
        workspaceRestoreFailure: outcome.code,
        workspaceRestoreDiagnostic: {
          ...outcome.diagnostic,
          message: "private-restore-persisted message", cause: source, command: "private-restore-persisted command",
        },
      },
    } as unknown as typeof heartbeatRuns.$inferSelect, {}));
    captureRunFailure({
      taskId: "11111111-1111-4111-8111-111111111111", runId: "22222222-2222-4222-8222-222222222222",
      errorMessage: "Workspace restore failed. Workspace files need recovery.",
      errorCode: "workspace_restore_failed", agentAdapter: "fixture-adapter", runStatus: "failed",
      exitCode: 1, signal: null, diagnostics,
    });
    captureException(new Error("unrelated restore diagnostic fixture"));
    await Sentry.flush(2000);

    expect(events).toHaveLength(2);
    const restoreEvent = events.find((event) => (event.tags as Record<string, unknown>)?.error_code === "workspace_restore_failed");
    expect(restoreEvent).toMatchObject({ contexts: { run_execution: {
      workspaceRestoreFailure: "restore_failed", workspaceRestorePhase: "workspace",
      workspaceRestoreStep: "git_integration", workspaceRestoreErrorCode: "unknown",
      workspaceRestoreHttpStatus: 503, workspaceRestoreExitCode: 1,
      workspaceRestoreGitCommand: "merge_tree", workspaceRestoreGitFailureKind: "merge_conflict",
    } } });
    expect((restoreEvent?.exception as { values: unknown[] }).values).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain("private-restore-");
    const unrelated = events.find((event) => event !== restoreEvent);
    expect(unrelated).not.toHaveProperty("contexts.run_execution");
    expect(unrelated).not.toHaveProperty("contexts.run_failure");
    expect(unrelated).not.toHaveProperty("tags.error_code");
  });
  it("sends only validated transfer and RPC evidence, isolated from unrelated captures", async () => {
    const Sentry = sentryPackage!;
    const events: Array<Record<string, unknown>> = [];
    vi.stubEnv("SENTRY_DSN_BACKEND", "https://public@example.invalid/1");
    vi.doMock("../peer-version-check.js", () => ({ checkExactPeerVersions: () => ({ ok: true }) }));
    vi.doMock("@sentry/node", () => ({ ...Sentry,
      init: (options: Record<string, unknown>) => Sentry.init({ ...options,
        transport: () => ({ send: async () => ({}), flush: async () => true }),
        beforeSend: (event: Record<string, unknown>) => { events.push(event); return event; },
      }),
    }));
    vi.resetModules();
    const { sentryReady, captureRunFailure, captureException } = await import("../sentry.js");
    await sentryReady;
    for (const known of [true, false]) {
      const error = Object.freeze(new Error("private-transfer-message"));
      // Worker/typed-host propagation has its own real RPC round-trip test.
      // This narrow contract exercises the host receipt through the real Sentry
      // transport without requiring plugin builds or dependency lifecycle scripts.
      const evidence = {
        transferStep: known ? "archive_create" : "private-transfer-path",
        transferFailureKind: known ? "command_failed" : "private-transfer-command",
        rpcCode: known ? -32002 : -12345,
        cause: { token: "private-transfer-token" }, output: "private-transfer-output",
      };
      const logs: string[] = [];
      const restore = createWorkspaceRestoreTeardown({ stagedRuntime: {
        restoreWorkspace: progress => withWorkspaceRestoreDiagnostics("workspace", () =>
          withWorkspaceRestoreStep("workspace_transfer", async () => { throw preserveWorkspaceRestoreErrorDiagnostic(error, { exitCode: 2 }, evidence); }), progress),
      }, onLog: async (_stream, line) => { logs.push(line); }, startMessage: "Restoring workspace\n", failurePrefix: "Workspace restore failed" });
      const outcome = await restore();
      expect(outcome.ok).toBe(false);
      if (outcome.ok) throw new Error("Expected transfer fixture failure");
      expect(outcome.diagnostic?.rpcCode).toBe(known ? -32002 : undefined);
      expect(JSON.stringify({ outcome, logs })).not.toContain("private-transfer-");
      const diagnostics = sanitizeRunFailureDiagnostics(collectRunFailureDiagnostics({ resultJson: {
        workspaceRestoreFailure: outcome.code, workspaceRestoreDiagnostic: { ...outcome.diagnostic,
          message: "private-transfer-persisted", cause: { token: "private-transfer-token" },
        },
      } } as unknown as typeof heartbeatRuns.$inferSelect, {}));
      captureRunFailure({ taskId: "11111111-1111-4111-8111-111111111111", runId: "22222222-2222-4222-8222-222222222222",
        errorMessage: "Workspace restore failed. Workspace files need recovery.", errorCode: "workspace_restore_failed",
        agentAdapter: "fixture-adapter", runStatus: "failed", exitCode: 1, signal: null, diagnostics,
      });
      await Sentry.flush(2000);
      const execution = (events.at(-1)?.contexts as Record<string, Record<string, unknown>>).run_execution;
      expect(execution.workspaceRestoreTransferStep).toBe(known ? "archive_create" : undefined);
      expect(execution.workspaceRestoreTransferFailureKind).toBe(known ? "command_failed" : undefined);
      expect(execution.workspaceRestoreRpcCode).toBe(known ? -32002 : undefined);
      expect(execution.workspaceRestoreExitCode).toBe(2);
    }
    captureException(new Error("Unrelated transfer fixture"));
    await Sentry.flush(2000);
    expect(events).toHaveLength(3);
    expect(events[2]).not.toHaveProperty("contexts.run_execution");
    expect(events[2]).not.toHaveProperty("contexts.run_failure");
    expect(events[2]).not.toHaveProperty("tags.error_code");
    expect(JSON.stringify(events)).not.toContain("private-transfer-");
  });

});
