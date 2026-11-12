import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const control = vi.hoisted(() => ({
  collectorEntered: Promise.resolve(), collectorRelease: Promise.resolve(), enter: () => {}, release: () => {}, completeQuery: false, stall: true, savedState: { label: "before cleanup" },
}));
beforeEach(() => {
  control.completeQuery = false; control.stall = true; control.savedState = { label: "before cleanup" };
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
vi.mock("./chat-rendered-links.js", () => ({ collectConversationLinks: async () => [] }));
vi.mock("./chat-catalog-run-policy.js", () => ({ gradeChatCatalogRuns: () => ({ checks: [] }) }));
vi.mock("./chat-flow.js", () => ({ sendChatMessage: async () => {}, collectChatRunEvidence: async () => { control.enter(); if (control.stall) await control.collectorRelease; return {}; } }));
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
