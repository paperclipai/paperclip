import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { execute } from "@paperclipai/hermes-paperclip-adapter/gateway/server";
import { legacyExecutionNeedsReconciliation } from "../services/legacy-execution-recovery.js";
import { readTransientRecoveryContractFromRun } from "../services/heartbeat/retries.js";

const config = { apiBaseUrl: "https://gateway.example.test", apiKey: "gateway-private-key" };

function makeCtx(): AdapterExecutionContext {
  return {
    runId: "pc-run-1",
    agent: { id: "agent-1", companyId: "company-1", name: "Hermes", adapterType: "hermes_gateway", adapterConfig: config },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config,
    context: { issueId: "issue-1", wakeReason: "manual", paperclipWake: { issue: { identifier: "PAP-1", title: "Do the thing" } } },
    onLog: vi.fn(async () => undefined),
    onMeta: vi.fn(async () => undefined),
  };
}

const persisted = (result: AdapterExecutionResult, retry: { scheduledRetryAttempt?: number; scheduledRetryReason?: string } = {}) => ({
  runtimeMode: "legacy" as const, status: "failed" as const, errorCode: result.errorCode ?? "adapter_failed", ...retry,
  resultJson: { ...result.resultJson,
    ...(result.errorFamily ? { errorFamily: result.errorFamily } : {}),
    ...(result.retryNotBefore ? { retryNotBefore: result.retryNotBefore } : {}),
    ...(result.executionRecovery ? { executionRecovery: result.executionRecovery } : {}) },
});

function respondWith(body: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status: 503, headers: { "retry-after": "1" } })));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("hermes_gateway drain admission refusal", () => {
  it("takes the bounded transient retry instead of legacy reconciliation", async () => {
    respondWith({ error: { message: "Gateway is draining existing work; retry shortly.", code: "gateway_draining" } });
    const run = persisted(await execute(makeCtx()));
    expect(readTransientRecoveryContractFromRun(run)?.errorFamily).toBe("transient_upstream");
    expect(legacyExecutionNeedsReconciliation(run)).toBe(false);
    expect(legacyExecutionNeedsReconciliation({ ...run, scheduledRetryAttempt: 1, scheduledRetryReason: "transient_failure" })).toBe(false);
    expect(legacyExecutionNeedsReconciliation({ ...run, scheduledRetryAttempt: 2, scheduledRetryReason: "transient_failure" })).toBe(true);
  });

  it("keeps an unexplained 503 under reconciliation", async () => {
    respondWith({ detail: "upstream unavailable" });
    const run = persisted(await execute(makeCtx()));
    expect(readTransientRecoveryContractFromRun(run)?.errorFamily).toBe("transient_upstream");
    expect(legacyExecutionNeedsReconciliation(run)).toBe(true);
  });
});
