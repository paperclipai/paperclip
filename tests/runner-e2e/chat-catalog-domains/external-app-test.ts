import { chatCatalogOriginalPhaseDeadline } from "../chat-catalog-contract.js";
import { createHash, randomBytes } from "node:crypto";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
import type { ToolProfileEffectiveSummary, ToolRunDecisionLookup } from "../../../packages/shared/src/types/tool-access.js";
import { definition, root, checks, externalObservation, observeExternal, verifyRenderedReply, type ExternalObservation } from "./external-support.js";
import { startNotesProvider, connectNotes, type NotesProvider } from "./external-provider.js";
import { identityWorker, waitForReply } from "./identity-support.js";
const providers = new WeakMap<ChatCatalogContext, NotesProvider>();
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const ids = (rows: Array<{ id: string }>) => rows.map(row => row.id).sort();
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const time = (value: unknown) => typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
function effectiveScope(e: ToolProfileEffectiveSummary) {
  return { agentId: e.agentId, allowed: ids(e.allowedTools), profiles: ids(e.profiles), entries: ids(e.entries), bindings: ids(e.bindings), connections: ids(e.installedConnections) };
}
function resources(o: ExternalObservation) { return { tasks: ids(o.tasks), projects: ids(o.projects), goals: ids(o.goals), secrets: ids(o.secrets) }; }
function allowedScope(value: unknown, agentId: unknown, read: unknown, write: unknown) {
  const scope = record(value); return scope.agentId === agentId && Array.isArray(scope.allowed) && scope.allowed.includes(read) && !scope.allowed.includes(write);
}
/** The product's own per-action summary of Morgan's access, as the person and the agent read it from the test-as-agent API. */
function accessSummary(value: unknown) {
  const access = record(record(value).access), tools = Array.isArray(access.tools) ? access.tools.map(record) : [];
  return { allowedCount: access.allowedCount, askFirstCount: access.askFirstCount, offCount: access.offCount,
    tools: tools.map(tool => ({ toolName: tool.toolName, risk: tool.risk, decision: tool.decision, reasonCode: tool.reasonCode })) };
}
function testDecisions(lookup: ToolRunDecisionLookup, provider: NotesProvider) {
  return lookup.decisions.map(({ invocation: v, auditEvents }) => ({ runId: lookup.runId,
    invocation: { id: v.id, companyId: v.companyId, actorType: v.actorType, actorId: v.actorId, agentId: v.agentId, issueId: v.issueId, runId: v.runId,
      connectionId: v.connectionId, catalogEntryId: v.catalogEntryId, toolName: v.toolName, status: v.status, policyDecision: v.policyDecision,
      errorCode: v.errorCode, resultHash: v.resultHash, resultSizeBytes: v.resultSizeBytes, startedAt: String(v.startedAt), completedAt: String(v.completedAt) },
    events: auditEvents.map(e => {
      const metadata = record(e.metadata), request = record(record(metadata.execution).request), requestId = request.requestId;
      return { id: e.id, companyId: e.companyId, actorType: e.actorType, actorId: e.actorId, agentId: e.agentId, issueId: e.issueId, runId: e.runId,
        connectionId: e.connectionId, catalogEntryId: e.catalogEntryId, invocationId: e.invocationId, eventType: e.eventType, outcome: e.outcome,
        decision: e.decision, resultHash: e.resultHash, source: metadata.source === "test" ? "test" : "other", endpointMatches: request.endpoint === provider.url,
        method: request.mcpMethod === "tools/call" ? "tools/call" : "other", upstreamToolName: request.upstreamToolName === "launch_read" ? "launch_read" : "other",
        toolName: e.toolName, requestIdSha256: typeof requestId === "string" && /^[A-Za-z0-9_-]{1,240}$/.test(requestId) ? hash(requestId) : null };
    }),
  }));
}
async function observeAppTest(ctx: ChatCatalogContext, state: Record<string, unknown>) {
  const o = await observeExternal(ctx, state), provider = providers.get(ctx); if (!provider) throw new Error("Actual synthetic test provider is missing");
  const scopes = await Promise.all([ctx.input.fixtures.agent.id, String(state.morganId)].map(id => ctx.input.api.get<ToolProfileEffectiveSummary>(`${root(ctx)}/tools/profiles/effective/agents/${id}`)));
  const decisions = (await Promise.all(o.runs.map(run => ctx.input.api.get<ToolRunDecisionLookup>(`${root(ctx)}/tools/runs/${run.id}/decisions`)))).flatMap(row => testDecisions(row, provider));
  const morganAccessSummary = accessSummary(await ctx.input.api.get(`/api/tool-connections/${state.connectionId}/test-agents/${state.morganId}/access`));
  const comments = await ctx.input.api.get<Array<{ id: string; authorAgentId: string | null; authorUserId: string | null; createdByRunId: string | null; createdAt: string; body: string }>>(`/api/issues/${state.sourceIssueId}/comments?order=asc`);
  Object.assign(state, { finalCeoScope: effectiveScope(scopes[0]!), finalMorganScope: effectiveScope(scopes[1]!), decisions, morganAccessSummary,
    providerCalls: provider.calls.filter(row => row.method === "tools/call").map(({ method, name, authorized, requestIdSha256, responseSha256, responseHttpStatus, toolError, receivedAt, respondedAt }) => ({ method, name, authorized, requestIdSha256, responseSha256, responseHttpStatus, toolError, receivedAt, respondedAt })),
    sourceComments: comments.map(({ id, authorAgentId, authorUserId, createdByRunId, createdAt, body }) => ({ id, authorAgentId, authorUserId, createdByRunId, createdAt, matchesOriginalQuery: body === state.originalQuery })),
    credentialDisclosed: [provider.token, encodeURIComponent(provider.token), Buffer.from(provider.token).toString("base64")].some(value => o.reply.includes(value)),
    morganRuntimeRunCount: (await ctx.input.api.get<Array<{ agentId: string }>>(`${root(ctx)}/heartbeat-runs?agentId=${state.morganId}&limit=100`)).filter(row => row.agentId === state.morganId).length });
  return o;
}
export function gradeAppTest(value: unknown) {
  const c = checks(), o = externalObservation(value), complete = !!o && [o.tasks, o.projects, o.goals, o.secrets].every(Array.isArray);
  c.add("complete-authorized-test-evidence", complete, "Real target access, native source provenance, durable test audit and independent provider result are required."); if (!o || !complete) return c.result();
  const s = o.state, scopesUnchanged = JSON.stringify(s.initialCeoScope) === JSON.stringify(s.finalCeoScope) && JSON.stringify(s.initialMorganScope) === JSON.stringify(s.finalMorganScope);
  c.add("actual-authorized-actor-and-target", s.syntheticProvider === true && s.morganId !== o.leadId && s.providerCallsBeforeQuery === 0
    && allowedScope(s.initialCeoScope, o.leadId, s.readEntryId, s.writeEntryId) && allowedScope(s.initialMorganScope, s.morganId, s.readEntryId, s.writeEntryId) && scopesUnchanged,
  "The real caller and target already have the read grant, not the write action; no pre-query test or permission widening may supply the answer.");
  const comments = Array.isArray(s.sourceComments) ? s.sourceComments.map(record) : [], humans = comments.filter(row => !row.authorAgentId), native = o.runs[0];
  const queryBound = o.runs.length === 1 && !!native && native.companyId === o.companyId && native.agentId === o.leadId && native.runtimeMode === "native" && native.status === "succeeded"
    && humans.length === 1 && typeof s.personId === "string" && humans[0]!.authorUserId === s.personId && humans[0]!.matchesOriginalQuery === true && native.contextSnapshot?.commentId === humans[0]!.id && native.contextSnapshot?.issueId === s.sourceIssueId
    && o.humanQueries.length === 1 && o.humanQueries[0] === s.originalQuery && time(native.startedAt) >= time(s.setupFinishedAt);
  c.add("one-original-native-request", !!queryBound, "One unchanged human query and its actual successful CEO native turn must own the selected source conversation.");
  const decisions = Array.isArray(s.decisions) ? s.decisions.map(record) : [], decision = decisions[0], v = record(decision?.invocation);
  // The gateway persists its normalized MCP envelope, not the raw provider
  // result. Keep this independently expected shape aligned with
  // normalizeMcpToolResult + summarizeToolValue's stable key ordering.
  const resultText = JSON.stringify({ content: s.marker, data: {
    content: [{ text: s.marker, type: "text" }], isError: false,
    spawnedLocalProcess: false, structuredContent: null, transport: "mcp_http",
  } }), expectedResultHash = hash(resultText);
  const call = (Array.isArray(s.providerCalls) ? s.providerCalls : []).map(record)[0], calls = s.providerCalls as unknown[] | undefined;
  const expectedProviderHash = hash(JSON.stringify({ content: [{ type: "text", text: s.marker }] }));
  const events = (Array.isArray(decision?.events) ? decision.events : []).map(record).filter(e => e.eventType === "call_completed");
  const event = events[0];
  const invocationBound = !!queryBound && decisions.length === 1 && decision?.runId === native!.id && typeof v.id === "string" && v.id.length > 0
    && v.companyId === o.companyId && v.actorType === "agent" && v.actorId === o.leadId && v.agentId === s.morganId && v.runId === native!.id && v.issueId === s.sourceIssueId
    && v.connectionId === s.connectionId && v.catalogEntryId === s.readEntryId && typeof v.toolName === "string" && v.status === "succeeded" && v.policyDecision === "allow" && !v.errorCode
    && v.resultHash === expectedResultHash && v.resultSizeBytes === Buffer.byteLength(resultText);
  c.add("saved-target-scoped-test", invocationBound, "The persisted successful invocation binds authorized CEO, Morgan, source task/run, exact connection/read catalog action and exact synthetic result bytes.");
  c.add("independent-provider-and-durable-audit", invocationBound && Array.isArray(calls) && calls.length === 1 && !!call && call.authorized === true && call.name === "launch_read"
    && call.responseHttpStatus === 200 && call.toolError === false && call.responseSha256 === expectedProviderHash
    && events.length === 1 && !!event && event.companyId === o.companyId && event.actorType === "agent" && event.actorId === o.leadId && event.agentId === s.morganId
    && event.issueId === s.sourceIssueId && event.runId === native!.id && event.connectionId === s.connectionId && event.catalogEntryId === s.readEntryId && event.invocationId === v.id
    && event.toolName === v.toolName && event.outcome === "success" && event.decision === "allow" && event.resultHash === expectedResultHash
    && event.source === "test" && event.endpointMatches === true && event.method === "tools/call" && event.upstreamToolName === "launch_read"
    && typeof event.requestIdSha256 === "string" && event.requestIdSha256 === call.requestIdSha256
    && time(native!.startedAt) <= time(v.startedAt) && time(v.startedAt) <= time(call.receivedAt) && time(call.receivedAt) <= time(call.respondedAt) && time(call.respondedAt) <= time(v.completedAt),
  "Exactly one authorized provider read and no other call must join the server's actual test audit by request/result identity and temporal order.");
  const reply = comments.filter(row => row.authorAgentId === o.leadId && row.createdByRunId === native?.id);
  c.add("saved-reply-after-test", reply.length === 1 && !!call && time(reply[0]!.createdAt) >= time(v.completedAt)
    && o.phaseReplies.length === 1 && o.phaseReplies[0]!.runId === native?.id && o.phaseReplies[0]!.commentId === reply[0]!.id && o.phaseReplies[0]!.body === o.reply
    && s.credentialDisclosed === false,
  "The original native turn saves its reply after the test completed, without exposing credentials. The reply's wording is not graded.");
  // The agent reads this same summary before answering; it must agree with the saved read-only scope it was set up with.
  const summary = record(s.morganAccessSummary), tools = Array.isArray(summary.tools) ? summary.tools.map(record) : [];
  const decisionOf = (name: string) => tools.filter(tool => tool.toolName === name).map(tool => tool.decision);
  c.add("access-summary-matches-saved-scope", JSON.stringify(decisionOf("launch_read")) === JSON.stringify(["allowed"])
    && JSON.stringify(decisionOf("launch_update")) === JSON.stringify(["off"]) && summary.allowedCount === 1,
  "The product's test-as-agent access summary reports Morgan's read action allowed and the write action off, matching the saved read-only scope.");
  const baselineActivity = Array.isArray(s.initialActivityIds) ? s.initialActivityIds : [];
  const forbiddenMutation = o.activity.some(e => !baselineActivity.includes(e.id) && /^(?:tool_(?:profile|policy|connection|catalog|trust)|connection_(?:grant|install|credential)|secret[._]|agent\.(?:updated|files_updated|instruction_write_attempted))/.test(e.action ?? ""));
  c.add("no-widening-unrelated-work-or-extra-runtime", JSON.stringify(resources(o)) === JSON.stringify(s.initialResources) && !forbiddenMutation && s.morganRuntimeRunCount === 0,
  "Read verification does not mutate access, credentials or agent configuration, create unrelated resources, or start Morgan's runtime.");
  return c.result();
}
export const appTestExternalCases = [definition("app-permissions.test-as-agent", async ctx => {
  const marker = `Synthetic sample page ${randomBytes(16).toString("hex")}`, provider = await startNotesProvider(marker); providers.set(ctx, provider);
  try {
    const connection = await connectNotes(ctx, provider, "read-only"), morgan = await identityWorker(ctx);
    await ctx.input.api.putSensitive(`/api/tool-connections/${connection.connectionId}/installs`, { installs: [{ targetType: "agent", targetId: morgan.id }] });
    const effective = await Promise.all([ctx.input.fixtures.agent.id, morgan.id].map(id => ctx.input.api.get<ToolProfileEffectiveSummary>(`${root(ctx)}/tools/profiles/effective/agents/${id}`)));
    if (effective.some((e, i) => !allowedScope(effectiveScope(e), [ctx.input.fixtures.agent.id, morgan.id][i], connection.read[0], connection.write[0]))) throw new Error("Setup blocker: actual CEO and Morgan scoped access must already allow only the selected read");
    await ctx.input.api.post(`${root(ctx)}/chats/${ctx.input.fixtures.agent.id}`); await ctx.refreshIssue();
    await ctx.input.api.patch(`/api/issues/${ctx.issue()!.id}`, { description: `The selected connection is Synthetic Launch Notes (${connection.connectionId}), containing the sample action Read launch page (launch_read). Morgan (${morgan.id}) is the intended test actor. Existing caller and Morgan read grants are configured; do not widen permissions or start Morgan's runtime. No sample read or test has run yet.` });
    const baseline = await observeExternal(ctx, {}), session = await ctx.input.api.get<{ user: { id: string } }>("/api/auth/get-session");
    if (!session.user?.id) throw new Error("Setup blocker: actual responsible human session is required");
    const providerCallsBeforeQuery = provider.calls.filter(row => row.method === "tools/call").length;
    if (providerCallsBeforeQuery !== 0) throw new Error("Setup blocker: no pre-query sample read may supply the requested outcome");
    return { syntheticProvider: true, connectionId: connection.connectionId, readEntryId: connection.read[0], writeEntryId: connection.write[0], morganId: morgan.id, marker,
      sourceIssueId: ctx.issue()!.id, personId: session.user.id, originalQuery: ctx.scenario.query, initialCeoScope: effectiveScope(effective[0]!), initialMorganScope: effectiveScope(effective[1]!),
      initialResources: resources(baseline), initialActivityIds: ids(baseline.activity), providerCallsBeforeQuery, setupFinishedAt: new Date().toISOString(),
      connectionPath: `/${ctx.input.fixtures.company.issuePrefix}/apps/${connection.connectionId}`, resultPath: `/${ctx.input.fixtures.company.issuePrefix}/apps/${connection.connectionId}/permissions` };
  } catch (error) { providers.delete(ctx); await provider.close(); throw error; }
}, gradeAppTest, {
  authentication: "human-session", oracleVersion: "paperclip.chat-catalog.app-test.v4",
  sourceFiles: ["chat-catalog-domains/external-app-test.ts", "chat-catalog-domains/external-provider.ts", "chat-catalog-domains/external-support.ts", "chat-catalog-domains/internal-support.ts", "chat-catalog-domains/identity-support.ts", "../../server/src/routes/tool-access.ts", "../../server/src/services/tool-gateway.ts", "../../server/src/services/tool-access/activity/service.ts", "../../server/src/services/tool-content-guards.ts", "../../server/src/services/tool-approval-execution.ts", "chat-scenarios/app-permissions.yaml"],
  async act(ctx) { await waitForReply(ctx, chatCatalogOriginalPhaseDeadline(ctx)); },
  observe: observeAppTest,
  async verifyResult(ctx, _state, value) { await verifyRenderedReply(ctx, value); },
  async cleanup(ctx, state) { try { if (typeof state.connectionId === "string") await ctx.input.api.delete(`/api/tool-connections/${state.connectionId}`, { allowNotFound: true }); } finally { const provider = providers.get(ctx); providers.delete(ctx); await provider?.close(); } },
})];
