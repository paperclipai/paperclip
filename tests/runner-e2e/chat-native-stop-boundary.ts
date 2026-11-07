import type { ChatCatalogCase, ChatCatalogContext, ChatCatalogSetupBoundary, NativeStopBoundaryReceipt } from "./chat-catalog-contract.js";
export function validNativeStopDeclaration(value: Omit<Pick<ChatCatalogCase, "scenarioId" | "canonicalBoundary" | "authentication" | "journeyKind" | "expectedHumanMessageCount" | "setupHumanMessageCount" | "queryOutcome" | "queryBindings" | "queryAttachments">, "journeyKind"> & { journeyKind?: string }) {
  return value.canonicalBoundary === "native-stop-cleanup" && value.scenarioId === "recovery.post-stop-message" && value.authentication === "human-session"
    && (value.journeyKind ?? "agent-chat") === "agent-chat" && value.expectedHumanMessageCount === 2 && value.setupHumanMessageCount === 1
    && (value.queryOutcome ?? "persisted") === "persisted" && !value.queryBindings?.length && !value.queryAttachments?.length;
}
export function assertNativeStopCallback(implementation: ChatCatalogCase) {
  if (implementation.canonicalBoundary ? !validNativeStopDeclaration(implementation) || typeof implementation.beforeCanonicalSend !== "function" : implementation.beforeCanonicalSend !== undefined)
    throw new Error("Missing, wrong-case or undeclared native Stop canonical-boundary callback");
}
// Production native-session-executor writes this intent in its cancellation transaction,
// then only writes dispatchState=acknowledged/acknowledgedAt after actual cleanup.
// A request receipt or a cancelled status alone does not establish this interval.
export function nativeStopPendingReceiptMatches(input: { receipt: NativeStopBoundaryReceipt; run: { id?: string; companyId?: string; nativeIssueId?: string; agentId?: string; runtimeMode?: string; status?: string; resultJson?: { nativeCancellation?: Record<string, unknown> } }; companyId: string; sourceIssueId: string; assignedAgentId: string; setupRunIds: string[] }) {
  const { receipt: r, run } = input, intent = run.resultJson?.nativeCancellation;
  return !!r && Object.keys(r).every(key => ["runId", "issueId", "intentId", "intentRecordedAt"].includes(key)) && [r.runId, r.issueId, r.intentId].every(id => typeof id === "string" && /^[a-f0-9-]{36}$/i.test(id))
    && Number.isFinite(Date.parse(r.intentRecordedAt)) && input.setupRunIds.includes(r.runId) && run.id === r.runId && run.companyId === input.companyId && run.nativeIssueId === r.issueId
    && r.issueId === input.sourceIssueId && run.agentId === input.assignedAgentId && run.runtimeMode === "native" && run.status === "running" && intent?.schema === "paperclip.native-cancellation.v1" && intent.companyId === input.companyId && intent.runId === r.runId && intent.issueId === r.issueId
    && intent.intentId === r.intentId && intent.recordedAt === r.intentRecordedAt && intent.scope === "run" && intent.dispatchState === "pending" && intent.dispatched === false && intent.acknowledgedAt == null;
}
export async function prepareNativeStopCanonicalBoundary(ctx: ChatCatalogContext, implementation: ChatCatalogCase, state: Record<string, unknown>, canonicalQuery: string, setup: ChatCatalogSetupBoundary) {
  assertNativeStopCallback(implementation); if (!implementation.canonicalBoundary) return;
  if (canonicalQuery !== ctx.scenario.query || setup.humanCommentIds.length !== 1 || setup.runIds.length !== 1) throw new Error("Native Stop boundary cannot alter the canonical query or introduce setup chat turns");
  const source = ctx.issue(); if (!source) throw new Error("Native Stop boundary requires the existing actual source chat");
  const sourceURL = ctx.input.page.url(), originalQuery = ctx.scenario.query;
  const before = await ctx.input.api.get<Array<{ id: string; body: string; authorAgentId?: string }>>(`/api/issues/${source.id}/comments?order=asc`);
  const retainedHuman = before.filter(row => !row.authorAgentId);
  if (retainedHuman.length !== 1 || retainedHuman[0]?.id !== setup.humanCommentIds[0]) throw new Error("Native Stop boundary requires exactly the declared genuine setup human message");
  const receipt = await implementation.beforeCanonicalSend!(ctx, state);
  const [run, comments, runs, actualSource] = await Promise.all([
    ctx.input.api.get<Parameters<typeof nativeStopPendingReceiptMatches>[0]["run"]>(`/api/heartbeat-runs/${receipt.runId}`),
    ctx.input.api.get<Array<{ id: string; body: string; authorAgentId?: string }>>(`/api/issues/${source.id}/comments?order=asc`), ctx.allRuns(),
    ctx.input.api.get<{ id: string; companyId: string; assigneeAgentId?: string | null; conversationAgentId?: string | null }>(`/api/issues/${source.id}`),
  ]);
  const assignedAgentId = actualSource.conversationAgentId ?? actualSource.assigneeAgentId;
  if (actualSource.id !== source.id || actualSource.companyId !== ctx.input.fixtures.company.id || !assignedAgentId || !nativeStopPendingReceiptMatches({ receipt, run, companyId: ctx.input.fixtures.company.id, sourceIssueId: source.id, assignedAgentId, setupRunIds: setup.runIds }) || ctx.issue()?.id !== source.id || ctx.input.page.url() !== sourceURL
    || ctx.scenario.query !== originalQuery || canonicalQuery !== originalQuery || JSON.stringify(comments.filter(row => !row.authorAgentId)) !== JSON.stringify(retainedHuman)
    || runs.length !== setup.runIds.length || runs.some(row => !setup.runIds.includes(row.id))) throw new Error("Native Stop boundary changed source/query/history or missed the genuine pending cleanup interval");
  state.nativeStopBoundary = receipt;
  await ctx.input.evidence("chat-catalog-native-stop-boundary.json", { kind: implementation.canonicalBoundary, sourceIssueId: source.id, ...receipt, canonicalQueryUnchanged: true, retainedSetupHumanCommentId: retainedHuman[0]!.id, extraHumanMessages: 0, extraRuns: 0 });
}
