import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { gradeAppTest } from "./external-app-test.js";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
export function authorizedTestObservation() {
  const marker = "Synthetic sample page unit-492", requestId = "paperclip-tool-synthetic-unit";
  // Independently reproduce the gateway's stable normalized MCP result, not the
  // raw provider response below. This synthetic fixture follows the public owner.
  const result = JSON.stringify({ content: marker, data: {
    content: [{ text: marker, type: "text" }], isError: false,
    spawnedLocalProcess: false, structuredContent: null, transport: "mcp_http",
  } });
  const invocation = { id: "invocation", companyId: "company", actorType: "agent", actorId: "ceo", agentId: "morgan", issueId: "source", runId: "native", connectionId: "connection", catalogEntryId: "read", toolName: "launch_read", status: "succeeded", policyDecision: "allow", errorCode: null, resultHash: hash(result), resultSizeBytes: Buffer.byteLength(result), startedAt: "2026-11-03T00:00:02Z", completedAt: "2026-11-03T00:00:03Z" };
  const scope = { agentId: "morgan", allowed: ["read"], profiles: ["profile"], entries: ["entry"], bindings: ["binding"], connections: ["connection"] };
  const reply = "I checked Morgan's read access to Synthetic Launch Notes. The sample-page test succeeded; it is a test result, not a guarantee about the next runtime.";
  return { scenarioId: "app-permissions.test-as-agent", companyId: "company", leadId: "ceo", origin: "https://fixture.test", reply,
    humanQueries: ["Check whether Morgan can read the sample page with this connection."],
    phaseReplies: [{ runId: "native", commentId: "reply", body: reply }], links: [], tasks: [], projects: [], goals: [], documents: [], revisions: [], comments: [], activity: [], connections: [], profiles: [], secrets: [], endpoints: [], interactions: [],
    runs: [{ id: "native", companyId: "company", agentId: "ceo", status: "succeeded", runtimeMode: "native", startedAt: "2026-11-03T00:00:01Z", contextSnapshot: { issueId: "source", commentId: "human" } }],
    state: { syntheticProvider: true, connectionId: "connection", readEntryId: "read", writeEntryId: "write", morganId: "morgan", sourceIssueId: "source", personId: "person", marker,
      originalQuery: "Check whether Morgan can read the sample page with this connection.", setupFinishedAt: "2026-11-03T00:00:00Z", providerCallsBeforeQuery: 0, credentialDisclosed: false,
      initialCeoScope: { ...scope, agentId: "ceo" }, finalCeoScope: { ...scope, agentId: "ceo" }, initialMorganScope: scope, finalMorganScope: scope,
      initialResources: { tasks: [], projects: [], goals: [], secrets: [] }, initialActivityIds: [], morganRuntimeRunCount: 0,
      sourceComments: [{ id: "human", authorAgentId: null, authorUserId: "person", createdByRunId: null, createdAt: "2026-11-03T00:00:00Z", matchesOriginalQuery: true }, { id: "reply", authorAgentId: "ceo", authorUserId: null, createdByRunId: "native", createdAt: "2026-11-03T00:00:04Z", matchesOriginalQuery: false }],
      providerCalls: [{ method: "tools/call", name: "launch_read", authorized: true, requestIdSha256: hash(requestId), responseSha256: hash(JSON.stringify({ content: [{ type: "text", text: marker }] })), responseHttpStatus: 200, toolError: false, receivedAt: Date.parse("2026-11-03T00:00:02Z"), respondedAt: Date.parse("2026-11-03T00:00:03Z") }],
      decisions: [{ runId: "native", invocation, events: [{ id: "event", companyId: "company", actorType: "agent", actorId: "ceo", agentId: "morgan", issueId: "source", runId: "native", connectionId: "connection", catalogEntryId: "read", invocationId: "invocation", eventType: "call_completed", outcome: "success", decision: "allow", resultHash: invocation.resultHash, source: "test", endpointMatches: true, method: "tools/call", upstreamToolName: "launch_read", toolName: "launch_read", requestIdSha256: hash(requestId) }] }],
    } };
}
it("accepts one source-bound authorized Morgan test with a saved real result, without a compulsory human navigation", () => {
  expect(gradeAppTest(authorizedTestObservation()).passed).toBe(true);
});
it("accepts an alternate truthful result report and a genuine qualified gateway tool name", () => {
  const o = authorizedTestObservation();
  o.reply = "Morgan has read access to the sample page: the authorized connection returned the requested test result.";
  o.phaseReplies[0]!.body = o.reply;
  o.state.decisions[0]!.invocation.toolName = "app_notes_read_qualified";
  o.state.decisions[0]!.events[0]!.toolName = "app_notes_read_qualified";
  expect(gradeAppTest(o).passed).toBe(true);
});
it.each([
  "Morgan cannot read the page; the test returned an error.",
  "Morgan cannot read the sample page, although this test succeeded.",
  "Morgan's read test failed; access was not verified.",
  "Morgan has no read access to the page, although the test passed.",
  "Morgan doesn't have read access to the page, although the test passed.",
])("rejects contradictory access/test outcome despite retaining all real successful read proof: %s", reply => {
  const o = authorizedTestObservation(); o.reply = reply; o.phaseReplies[0]!.body = reply;
  expect(o.state.decisions[0]!.invocation.status).toBe("succeeded");
  expect(o.state.providerCalls[0]!.authorized).toBe(true);
  expect(gradeAppTest(o).passed).toBe(false);
});
it.each(["denied", "no provider read", "wrong target", "wrong caller", "wrong company", "wrong connection", "write action", "wrong credential", "wrong endpoint", "wrong request", "wrong result", "no test audit", "duplicate read", "pre-query read", "unbound source", "unbound human", "wrong responsible human", "unfinished native", "extra native", "permission widening", "permission mutation", "human permission mutation", "unrelated task", "credential disclosure", "Morgan runtime", "early call", "early reply", "unsaved reply", "global qualification", "future qualification", "false actor report"])("rejects %s rather than accepting a claimed test", fault => {
  const o = authorizedTestObservation(), v = o.state.decisions[0]!.invocation, e = o.state.decisions[0]!.events[0]!, p = o.state.providerCalls[0]!;
  if (fault === "denied") { v.status = "denied"; v.policyDecision = "deny"; }
  if (fault === "no provider read") o.state.providerCalls = [];
  if (fault === "wrong target") v.agentId = "ceo";
  if (fault === "wrong caller") v.actorId = "unrelated";
  if (fault === "wrong company") v.companyId = "foreign";
  if (fault === "wrong connection") v.connectionId = "foreign";
  if (fault === "write action") v.catalogEntryId = "write";
  if (fault === "wrong credential") p.authorized = false;
  if (fault === "wrong endpoint") e.endpointMatches = false;
  if (fault === "wrong request") p.requestIdSha256 = "0".repeat(64);
  if (fault === "wrong result") v.resultHash = "0".repeat(64);
  if (fault === "no test audit") e.source = "other";
  if (fault === "duplicate read") o.state.providerCalls.push({ ...p });
  if (fault === "pre-query read") o.state.providerCallsBeforeQuery = 1;
  if (fault === "unbound source") v.issueId = "other";
  if (fault === "unbound human") o.runs[0]!.contextSnapshot.commentId = "other";
  if (fault === "wrong responsible human") o.state.sourceComments[0]!.authorUserId = "foreign";
  if (fault === "unfinished native") o.runs[0]!.status = "running";
  if (fault === "extra native") o.runs.push({ ...o.runs[0]!, id: "extra" });
  if (fault === "permission widening") o.state.finalCeoScope = { ...o.state.finalCeoScope, allowed: ["read", "write"] };
  if (fault === "permission mutation") (o.activity as object[]).push({ id: "mutation", actorType: "agent", action: "tool_profile_entry.updated" });
  if (fault === "human permission mutation") (o.activity as object[]).push({ id: "mutation", actorType: "user", action: "connection_grant.updated" });
  if (fault === "unrelated task") (o.tasks as object[]).push({ id: "unrelated" });
  if (fault === "credential disclosure") o.state.credentialDisclosed = true;
  if (fault === "Morgan runtime") o.state.morganRuntimeRunCount = 1;
  if (fault === "early call") p.receivedAt = Date.parse("2026-11-02T00:00:00Z");
  if (fault === "early reply") o.state.sourceComments[1]!.createdAt = "2026-11-03T00:00:01Z";
  if (fault === "unsaved reply") o.state.sourceComments.pop();
  if (fault === "global qualification") { o.reply = "Morgan's sample read succeeded and all production agents are qualified."; o.phaseReplies[0]!.body = o.reply; }
  if (fault === "future qualification") { o.reply = "Morgan's sample read succeeded; this test guarantees Morgan's next runtime is qualified."; o.phaseReplies[0]!.body = o.reply; }
  if (fault === "false actor report") { o.reply = "I checked CEO read access and the sample-page test succeeded."; o.phaseReplies[0]!.body = o.reply; }
  expect(gradeAppTest(o).passed).toBe(false);
});

it.each(["raw provider only", "wrong visible content", "wrong nested marker", "missing data", "error result", "local process", "wrong transport", "extra structured data", "wrong size"])("rejects %s even when durable invocation/audit hashes agree", fault => {
  const o = authorizedTestObservation();
  const normalized: Record<string, unknown> = { content: o.state.marker, data: {
    content: [{ text: o.state.marker, type: "text" }], isError: false,
    spawnedLocalProcess: false, structuredContent: null, transport: "mcp_http",
  } };
  let result: unknown = normalized;
  if (fault === "raw provider only") result = { content: [{ text: o.state.marker, type: "text" }] };
  if (fault === "wrong visible content") normalized.content = "Different sample page";
  const data = normalized.data as Record<string, unknown>;
  if (fault === "wrong nested marker") data.content = [{ text: "Different sample page", type: "text" }];
  if (fault === "missing data") delete normalized.data;
  if (fault === "error result") data.isError = true;
  if (fault === "local process") data.spawnedLocalProcess = true;
  if (fault === "wrong transport") data.transport = "local_stdio";
  if (fault === "extra structured data") data.structuredContent = { unexpected: true };
  const serialized = JSON.stringify(result);
  const v = o.state.decisions[0]!.invocation;
  v.resultHash = hash(serialized); v.resultSizeBytes = Buffer.byteLength(serialized) + (fault === "wrong size" ? 1 : 0);
  o.state.decisions[0]!.events[0]!.resultHash = v.resultHash;
  expect(o.state.providerCalls).toHaveLength(1);
  expect(gradeAppTest(o).passed).toBe(false);
});
