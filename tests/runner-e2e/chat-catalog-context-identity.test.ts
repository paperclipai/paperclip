import { afterEach, expect, it, vi } from "vitest";
import type { ChatCatalogCase, ChatCatalogContext } from "./chat-catalog-contract.js";
const fixture = vi.hoisted(() => ({ implementation: undefined as unknown as ChatCatalogCase }));
vi.mock("./chat-catalog-registry.js", () => ({ findChatCatalogCase: () => ({}), loadChatCatalogImplementation: async () => fixture.implementation }));
vi.mock("./chat-catalog-fingerprint.js", () => ({ chatCatalogCaseFingerprint: () => ({}), normalizedChatCatalogExecution: () => ({}) }));
vi.mock("./chat-query-bindings.js", () => ({ resolveChatCatalogQuery: async () => ({ renderedQuery: "Canonical query", bindings: [] }) }));
vi.mock("./chat-query-attachments.js", () => ({ chatQueryWithAttachments: (query: string) => query, resolveChatQueryAttachments: async () => [], verifyChatQueryAttachments: async () => true }));
vi.mock("./chat-native-stop-boundary.js", () => ({ prepareNativeStopCanonicalBoundary: async () => {} }));
vi.mock("./chat-flow.js", () => ({ sendChatMessage: async () => {}, collectChatRunEvidence: async () => ({}) }));
import { runChatCatalogFlow } from "./chat-catalog-flow.js";
afterEach(() => vi.useRealTimers());
it("preserves actual setup/act/cleanup context identity and one original clock across elapsed setup", async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const custody = new WeakMap<ChatCatalogContext, object>(); const resource = {}; const contexts: ChatCatalogContext[] = [];
  fixture.implementation = {
    scenarioId: "companies.switch-company", sourceFiles: [], oracleVersion: "test", attemptTimeoutMs: 300_000,
    turnTimeoutMs: 120_000, expectedRunCount: 1, setupPolicy: { readiness: "preserve-scenario", funding: "preserve-scenario", invariantCheckIds: [] },
    setup: async ctx => { custody.set(ctx, resource); contexts.push(ctx); expect(ctx.observationDeadlineAt).toBe(270_000); vi.setSystemTime(30_000); return {}; },
    act: async ctx => { contexts.push(ctx); expect(custody.get(ctx)).toBe(resource); expect(ctx.observationDeadlineAt).toBe(270_000); throw new Error("stop after identity proof"); },
    observe: async () => ({}), grade: () => ({ passed: true, checks: [{ id: "test", passed: true, detail: "test" }] }),
    verifySetup: undefined, verifyResult: async () => {},
    cleanup: async ctx => { contexts.push(ctx); expect(custody.get(ctx)).toBe(resource); },
  };
  const context = {
    scenario: { id: "companies.switch-company", query: "Canonical query" }, refreshIssue: async () => {}, issue: () => ({ id: "chat" }), allRuns: async () => [],
    input: { execution: { task: { turnTimeoutMs: 0 } }, fixtures: { company: { id: "company" }, agent: { id: "lead" } },
      page: { evaluate: async () => [], locator: () => ({ count: async () => 0 }) }, evidence: async () => {}, api: { baseURL: "https://fixture.test", get: async (path: string) => path.endsWith("/budgets/overview") ? { policies: [] } : path === "/api/agents/lead" ? { adapterConfig: { timeoutSec: 0 } } : [] } },
  } as unknown as ChatCatalogContext;
  await expect(runChatCatalogFlow(context)).rejects.toThrow("stop after identity proof");
  expect(contexts).toHaveLength(3); expect(contexts.every(ctx => ctx === context)).toBe(true);
  expect(Date.now()).toBe(30_000);
});
