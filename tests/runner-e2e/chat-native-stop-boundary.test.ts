import { expect, it, vi } from "vitest";
import type { ChatCatalogCase, ChatCatalogContext, NativeStopBoundaryReceipt } from "./chat-catalog-contract.js";
import { loadChatCatalogImplementation, type ChatCatalogDescriptor } from "./chat-catalog-registry.js";
import { assertNativeStopCallback, nativeStopPendingReceiptMatches, prepareNativeStopCanonicalBoundary, validNativeStopDeclaration } from "./chat-native-stop-boundary.js";
const receipt: NativeStopBoundaryReceipt = { runId: "11111111-1111-4111-8111-111111111111", issueId: "22222222-2222-4222-8222-222222222222", intentId: "33333333-3333-4333-8333-333333333333", intentRecordedAt: "2026-10-26T12:00:00.000Z" };
const metadata: ChatCatalogDescriptor = { scenarioId: "recovery.post-stop-message", canonicalBoundary: "native-stop-cleanup", authentication: "human-session", sourceFiles: ["runtime-post-stop.ts"], modulePath: "./chat-catalog-domains/runtime-post-stop.js", exportName: "cases", oracleVersion: "control", expectedRunCount: 3, expectedHumanMessageCount: 2, setupHumanMessageCount: 1, turnTimeoutMs: 120000, attemptTimeoutMs: 600000 };
function fixture() {
  const run = { id: receipt.runId, companyId: "company", nativeIssueId: receipt.issueId, agentId: "lead", runtimeMode: "native", status: "running", resultJson: { nativeCancellation: { schema: "paperclip.native-cancellation.v1", companyId: "company", runId: receipt.runId, issueId: receipt.issueId, scope: "run", intentId: receipt.intentId, recordedAt: receipt.intentRecordedAt, dispatchState: "pending", dispatched: false } } };
  const comments: Array<{ id: string; body: string; authorAgentId?: string }> = [{ id: "setup-human", body: "Build the original website after the bounded wait." }], runs = [{ id: receipt.runId }]; let url = "http://fixture/source";
  const ctx = { scenario: { id: metadata.scenarioId, query: "Make the page simpler." }, issue: () => ({ id: receipt.issueId, assigneeAgentId: "lead" }), allRuns: async () => runs,
    input: { fixtures: { company: { id: "company" } }, page: { url: () => url }, evidence: vi.fn(async () => {}), api: { get: async (path: string) => path.startsWith("/api/heartbeat-runs/") ? run : path.endsWith("/comments?order=asc") ? structuredClone(comments) : { id: receipt.issueId, companyId: "company", conversationAgentId: "lead" } } } } as unknown as ChatCatalogContext;
  const implementation = { ...metadata, setup: async () => ({}), observe: async () => ({}), grade: () => ({ passed: false, checks: [] }), verifyResult: async () => {}, beforeCanonicalSend: vi.fn(async () => ({ ...receipt })) } as unknown as ChatCatalogCase;
  return { run, comments, runs, ctx, implementation, move: () => { url += "/other"; }, setup: { humanCommentIds: ["setup-human"], runIds: [receipt.runId] } };
}
it("admits only the exact unchanged human post-stop boundary declaration", () => {
  expect(validNativeStopDeclaration(metadata)).toBe(true);
  for (const patch of [{ scenarioId: "recovery.explain-stall" }, { journeyKind: "browser-boundary" }, { authentication: "local-trusted" }, { expectedHumanMessageCount: 1 }, { setupHumanMessageCount: 0 }, { queryOutcome: "rejected" }, { queryAttachments: [{ stateKey: "file", filename: "brief.md" }] }]) expect(validNativeStopDeclaration({ ...metadata, ...patch } as typeof metadata)).toBe(false);
  expect(() => assertNativeStopCallback({ ...fixture().implementation, beforeCanonicalSend: undefined })).toThrow("callback");
  expect(() => assertNativeStopCallback({ ...fixture().implementation, canonicalBoundary: undefined })).toThrow("callback");
});
it("preflight rejects declaration drift and absent or hidden callbacks before any admission", async () => {
  const f = fixture(), load = (row: ChatCatalogCase, descriptor = metadata) => loadChatCatalogImplementation(descriptor, async () => ({ cases: [row] }));
  await expect(load(f.implementation)).resolves.toBe(f.implementation);
  await expect(load({ ...f.implementation, beforeCanonicalSend: undefined })).rejects.toThrow("callback");
  await expect(load({ ...f.implementation, canonicalBoundary: undefined })).rejects.toThrow("drift");
  await expect(load({ ...f.implementation, canonicalBoundary: undefined }, { ...metadata, canonicalBoundary: undefined })).rejects.toThrow("callback");
});
it("requires actual same-company admitted running setup work and a pending unacknowledged persisted intent", () => {
  const input = () => { const f = fixture(); return { receipt: { ...receipt }, run: f.run, companyId: "company", sourceIssueId: receipt.issueId, assignedAgentId: "lead", setupRunIds: [receipt.runId] }; };
  expect(nativeStopPendingReceiptMatches(input())).toBe(true);
  for (const change of [(v: ReturnType<typeof input>) => { v.run.companyId = "foreign"; }, (v: ReturnType<typeof input>) => { v.run.status = "cancelled"; }, (v: ReturnType<typeof input>) => { v.sourceIssueId = "another-source"; }, (v: ReturnType<typeof input>) => { v.run.agentId = "another-agent"; }, (v: ReturnType<typeof input>) => { v.run.runtimeMode = "legacy"; }, (v: ReturnType<typeof input>) => { v.setupRunIds = []; }, (v: ReturnType<typeof input>) => { v.run.resultJson.nativeCancellation.dispatchState = "acknowledged"; }, (v: ReturnType<typeof input>) => { v.run.resultJson.nativeCancellation.dispatched = true; }, (v: ReturnType<typeof input>) => { v.receipt.intentId = receipt.runId; }, (v: ReturnType<typeof input>) => { v.receipt.intentRecordedAt = "invalid"; }]) { const value = input(); change(value); expect(nativeStopPendingReceiptMatches(value)).toBe(false); }
});
it("keeps the canonical human message untouched and rejects hidden turns, source navigation or extra admissions", async () => {
  const success = fixture(), state = {};
  await prepareNativeStopCanonicalBoundary(success.ctx, success.implementation, state, success.ctx.scenario.query, success.setup);
  expect(state).toEqual({ nativeStopBoundary: receipt }); expect(success.implementation.beforeCanonicalSend).toHaveBeenCalledOnce();
  for (const change of [(f: ReturnType<typeof fixture>) => { f.comments.push({ id: "hidden-human", body: "Hidden direction" }); }, (f: ReturnType<typeof fixture>) => { f.runs.push({ id: "extra-run" }); }, (f: ReturnType<typeof fixture>) => { f.comments[0]!.body = "Altered setup direction"; }, (f: ReturnType<typeof fixture>) => { f.move(); }, (f: ReturnType<typeof fixture>) => { f.ctx.scenario.query += " Hurry"; }]) {
    const f = fixture(); f.implementation.beforeCanonicalSend = async () => { change(f); return receipt; };
    await expect(prepareNativeStopCanonicalBoundary(f.ctx, f.implementation, {}, f.ctx.scenario.query, f.setup)).rejects.toThrow("changed source/query/history");
  }
  const f = fixture(); await expect(prepareNativeStopCanonicalBoundary(f.ctx, f.implementation, {}, "Alternate direction", f.setup)).rejects.toThrow("alter"); expect(f.implementation.beforeCanonicalSend).not.toHaveBeenCalled();
});
it("does no boundary work in an ordinary undeclared catalog scenario", async () => {
  const f = fixture(); await prepareNativeStopCanonicalBoundary(f.ctx, { ...f.implementation, canonicalBoundary: undefined, beforeCanonicalSend: undefined }, {}, "Exact ordinary query", f.setup);
  expect(f.ctx.input.evidence).not.toHaveBeenCalled();
});
it("preflights the finite Slack distractor callback only for its declared reply thread", async () => {
  const descriptor: ChatCatalogDescriptor = { ...metadata, scenarioId: "chat-channels.reply-in-thread", canonicalBoundary: undefined, journeyKind: "native-slack-thread", slackIngress: { kind: "native-slack-thread", maximumProviderCalls: 20, ingressTimeoutMs: 120000, setupThread: "same-agent-distractor" }, expectedRunCount: 4, minimumRunCount: 2, expectedHumanMessageCount: 1, setupHumanMessageCount: 0 };
  const row = { ...fixture().implementation, ...descriptor, beforeCanonicalSend: undefined, dispatchSlackQuery: async () => ({}), dispatchSlackOtherThread: async () => ({}) } as unknown as ChatCatalogCase;
  const load = (implementation: ChatCatalogCase, selected = descriptor) => loadChatCatalogImplementation(selected, async () => ({ cases: [implementation] }));
  await expect(load(row)).resolves.toBe(row);
  await expect(load({ ...row, dispatchSlackOtherThread: undefined })).rejects.toThrow("other-thread callback");
  const ordinary = { ...metadata, canonicalBoundary: undefined };
  await expect(load({ ...fixture().implementation, canonicalBoundary: undefined, beforeCanonicalSend: undefined, dispatchSlackOtherThread: row.dispatchSlackOtherThread }, ordinary)).rejects.toThrow("other-thread callback");
});
