import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const control = vi.hoisted(() => ({
  collectorEntered: Promise.resolve(), collectorRelease: Promise.resolve(), enter: () => {}, release: () => {}, completeQuery: false, stall: true, savedState: { label: "before cleanup" }, failingRun: "",
}));
beforeEach(() => {
  control.completeQuery = false; control.stall = true; control.savedState = { label: "before cleanup" }; control.failingRun = "";
  control.collectorEntered = new Promise<void>(resolve => { control.enter = resolve; });
  control.collectorRelease = new Promise<void>(resolve => { control.release = resolve; });
});
afterEach(() => vi.useRealTimers());
vi.mock("./sdk-canary-prefixture.js", () => ({ assertSdkCanaryFingerprintMatches: () => {} }));
vi.mock("./chat-catalog-registry.js", () => ({
  findChatCatalogCase: () => ({}),
  loadChatCatalogImplementation: async () => ({ scenarioId: "questions-and-approvals.multi-part-question", attemptTimeoutMs: 300000,
    expectedRunCount: 2, turnTimeoutMs: 300000, setupPolicy: { readiness: "preserve-scenario", funding: "preserve-scenario" }, setup: async () => control.savedState, cleanup: async () => { control.savedState.label = "after cleanup"; }, observe: async () => ({ state: control.savedState }), grade: () => ({ passed: false, checks: [{ id: "not-completed", passed: false, detail: "Pending native continuation" }] }) }),
}));
vi.mock("./chat-catalog-fingerprint.js", () => ({ chatCatalogCaseFingerprint: () => ({}), normalizedChatCatalogExecution: () => ({}) }));
vi.mock("./chat-query-bindings.js", () => ({ resolveChatCatalogQuery: async () => { if (control.completeQuery) return { renderedQuery: "Original request" }; throw new Error("Original attempt failed"); } }));
vi.mock("./chat-rendered-links.js", () => ({ collectConversationLinks: async () => [], collectConversationLinksWithDiagnostics: async () => ({ links: [] }) }));
vi.mock("./chat-catalog-run-policy.js", () => ({ gradeChatCatalogRuns: () => ({ checks: [] }), CHAT_CATALOG_MAX_SUPERSEDED_QUEUED_RUNS: 1,
  chatCatalogProviderRuns: (runs: unknown[]) => runs, chatCatalogSupersededQueuedRuns: () => [], chatCatalogReassignedQueuedRun: () => false }));
vi.mock("./chat-flow.js", () => ({ sendChatMessage: async () => {}, collectChatRunEvidence: async (_api: unknown, run: { id: string }) => { control.enter(); if (control.stall) await control.collectorRelease;
  if (run.id === control.failingRun) throw new Error("GET /api/heartbeat-runs/never-started/log 404"); return { runId: run.id, log: "log" }; } }));
vi.mock("./api.js", () => ({ pollUntil: async ({ load }: { load: () => Promise<unknown> }) => { await load(); throw new Error("Original attempt failed"); } }));
import { runChatCatalogFlow } from "./chat-catalog-flow.js";
it("does not let a stalled failure collector prevent outer retirement of an owned pending native", async () => {
  let retired = false;
  const run = { id: "pending-native", companyId: "company", agentId: "ceo", status: "running", runtimeMode: "native" };
  const context = { scenario: { id: "questions-and-approvals.multi-part-question", query: "Original question-form request" },
    input: { execution: { task: { turnTimeoutMs: 0 } }, fixtures: { company: { id: "company", issuePrefix: "RUN" }, agent: { id: "ceo" } },
      api: { baseURL: "http://127.0.0.1", get: async () => [] }, page: { locator: () => ({ count: async () => 0 }) }, evidence: async () => {} },
    refreshIssue: async () => {}, issue: () => ({ id: "source", companyId: "company" }), allRuns: async () => [run] };
  Object.assign(context.input, { retireFailedAttempt: async () => { retired = true; run.status = "cancelled"; } });
  const attempt = runChatCatalogFlow(context as never).finally(async () => { retired = true; run.status = "cancelled"; });
  const rejected = expect(attempt).rejects.toThrow("Original attempt failed");
  await control.collectorEntered;
  const retiredBeforeCollectorReleased = retired;
  control.release();
  await rejected;
  expect(retired).toBe(true);
  expect(retiredBeforeCollectorReleased).toBe(true);
});

it("bounds failed collection and cannot write evidence after the collector later resolves", async () => {
  vi.useFakeTimers();
  const writes: string[] = [], order: string[] = [];
  const context = { scenario: { id: "questions-and-approvals.multi-part-question", query: "Original request" },
    input: { execution: { task: { turnTimeoutMs: 0 } }, fixtures: { company: { id: "company" }, agent: { id: "ceo" } },
      api: { baseURL: "http://127.0.0.1", get: async () => [] }, page: { locator: () => ({ count: async () => 0 }) }, evidence: async (name: string) => { writes.push(name); },
      retireFailedAttempt: async () => { order.push("retired"); } },
    refreshIssue: async () => {}, issue: () => ({ id: "source", companyId: "company" }), allRuns: async () => [{ id: "pending", companyId: "company", status: "cancelled" }] };
  const attempt = runChatCatalogFlow(context as never);
  const rejected = expect(attempt).rejects.toThrow("Original attempt failed");
  await control.collectorEntered;
  expect(order).toEqual(["retired"]);
  await vi.advanceTimersByTimeAsync(5000);
  await rejected;
  expect(writes).toContain("chat-catalog-evidence-error.json");
  const finishedWrites = [...writes];
  control.release();
  await vi.advanceTimersByTimeAsync(0);
  expect(writes).toEqual(finishedWrites);
});
it("preserves the primary failure when retirement and failure evidence persistence fail", async () => {
  const context = { scenario: { id: "questions-and-approvals.multi-part-question", query: "Original request" },
    input: { execution: { task: { turnTimeoutMs: 0 } }, evidence: async (name: string) => {
      if (name === "chat-catalog-evidence-error.json") throw new Error("Evidence storage failed");
    }, retireFailedAttempt: async () => { throw new Error("Retirement failed"); } } };
  await expect(runChatCatalogFlow(context as never)).rejects.toThrow("Original attempt failed");
});

it("retains completed observation and conversation before scenario cleanup mutates state", async () => {
  control.completeQuery = true; control.stall = false;
  const snapshots: Record<string, any> = {};
  const context = { scenario: { id: "questions-and-approvals.multi-part-question", query: "Original request" },
    input: { execution: { task: { turnTimeoutMs: 0 } }, fixtures: { company: { id: "company", issuePrefix: "RUN" }, agent: { id: "ceo" } },
      api: { baseURL: "http://127.0.0.1", get: async (route: string) => route.endsWith("/budgets/overview") ? { policies: [] } : route.startsWith("/api/agents/") ? { adapterConfig: { timeoutSec: 0 } } : route.endsWith("/interactions") ? [{ id: "question" }] : [] },
      page: { locator: () => ({ count: async () => 0 }) }, evidence: async (name: string, value: unknown) => { snapshots[name] = structuredClone(value); }, retireFailedAttempt: async () => {} },
    refreshIssue: async () => {}, issue: () => ({ id: "source", companyId: "company" }), allRuns: async () => [] };
  await expect(runChatCatalogFlow(context as never)).rejects.toThrow("Original attempt failed");
  expect(snapshots["api-state.json"]).toMatchObject({ issue: { id: "source" }, comments: [], interactions: [{ id: "question" }], observation: { state: { label: "before cleanup" } } });
  expect(control.savedState.label).toBe("after cleanup");
});
it("executes the real outer failure-capture guard without entering a held duplicate API read", async () => {
  const source = await readFile(new URL("./runner.spec.ts", import.meta.url), "utf8");
  const start = source.indexOf("    const captureApiState = async (capturePhase: \"failure\" | \"final\" = \"failure\") => {"), end = source.indexOf("\n\n    page.on", start);
  const body = stripTypeScriptTypes(source.slice(start, end), { mode: "strip" });
  let reads = 0;
  const capture = new Function("catalogFailureCaptureAttempted", "fixtures", "api", body + "; return captureApiState;")(true, { company: { id: "company" } }, { get: async () => { reads++; return new Promise(() => {}); } });
  const primary = new Error("Original attempt failed");
  const caller = (async () => { try { throw primary; } catch (error) { await capture(); throw error; } })();
  await expect(caller).rejects.toBe(primary);
  expect(reads).toBe(0);
  expect(source).toContain("if (!(error instanceof SetupHealthAbort)) await captureApiState();");
});
it("keeps every run's evidence when one never-started run has no log, and saves the ledger before retirement", async () => {
  control.stall = false; control.failingRun = "never-started";
  const snapshots: Record<string, any> = {}, order: string[] = [];
  const runs = [{ id: "lead", companyId: "company", status: "succeeded" }, { id: "never-started", companyId: "company", status: "queued" }];
  const context = { scenario: { id: "questions-and-approvals.multi-part-question", query: "Original request" },
    input: { execution: { task: { turnTimeoutMs: 0 } }, fixtures: { company: { id: "company" }, agent: { id: "ceo" } },
      api: { baseURL: "http://127.0.0.1", get: async (route: string) => { if (route.includes("/never-started/log")) throw new Error("Run log not found"); return []; },
        getRunObservation: async (route: string) => route.includes("/never-started/events") && route.includes("afterSeq=0") ? [{ seq: 1, eventType: "lifecycle" }] : [] },
      page: { locator: () => ({ count: async () => 0 }) },
      evidence: async (name: string, value: unknown) => { order.push(name); snapshots[name] = structuredClone(value); },
      retireFailedAttempt: async () => { order.push("retired"); runs[1]!.status = "cancelled"; throw new Error("cancel timed out"); } },
    refreshIssue: async () => {}, issue: () => ({ id: "source", companyId: "company" }), allRuns: async () => runs };
  await expect(runChatCatalogFlow(context as never)).rejects.toThrow("Original attempt failed");
  expect(order.indexOf("chat-catalog-failure-run-ledger.json")).toBeLessThan(order.indexOf("retired"));
  expect(snapshots["chat-catalog-failure-run-ledger.json"].runs.map((run: { status: string }) => run.status)).toEqual(["succeeded", "queued"]);
  expect(snapshots["chat-catalog-runs.json"]).toEqual([{ runId: "lead", log: "log" }, { runId: "never-started", log: null, events: [{ seq: 1, eventType: "lifecycle" }], logError: "Run log not found" }]);
  expect(snapshots["api-state.json"]).toMatchObject({ retirementError: "cancel timed out" });
  expect(snapshots["api-state.json"].incomplete).toBeUndefined();
});
it("records a separate error for each piece of a failed run's evidence it cannot read", async () => {
  const { failedRunEvidence } = await import("./chat-catalog-flow.js");
  const ok = { get: async () => "log text", getRunObservation: async (route: string) => route.includes("afterSeq=0") ? [{ seq: 1 }] : [] };
  expect(await failedRunEvidence(ok as never, "run")).toEqual({ runId: "run", log: "log text", events: [{ seq: 1 }] });
  const none = { get: async () => { throw new Error("Run log not found"); }, getRunObservation: async () => { throw new Error("events 500"); } };
  expect(await failedRunEvidence(none as never, "run")).toEqual({ runId: "run", log: null, events: [], logError: "Run log not found", eventsError: "events 500" });
});
