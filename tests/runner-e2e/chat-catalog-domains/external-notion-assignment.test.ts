import { describe, expect, it } from "vitest";
import { notionAssignmentExternalCases } from "./external-notion-assignment.js";
function valid() { const page = { id: "11111111-1111-4111-8111-111111111111", url: "https://www.notion.so/11111111111141118111111111111111", editedAt: "2026-10-26T12:00:00.000Z", fact: { subjectAliases: ["launch date"], valueAliases: ["November 8"] } }; return { scenarioId: "connection-setup.notion-agent-unassigned", companyId: "company", leadId: "ceo", reply: "The launch date is November 8, updated Oct 26, 2026.", phaseReplies: [{ runId: "initial", body: "Please assign the existing Notion account." }, { runId: "continued", body: "The launch date is November 8, updated Oct 26, 2026." }], runs: [{ id: "initial", status: "succeeded" }, { id: "continued", status: "succeeded" }], links: [page.url], connections: [], profiles: [], secrets: [], endpoints: [], interactions: [], activity: [{ entityId: "connection", action: "tool_app.finished", actorType: "user" }], humanQueries: [], state: { connectionId: "connection", ceoId: "ceo", sourceIssueId: "source", readEntryIds: ["read"], namedProvider: "notion", workspaceMatched: true, healthyBefore: true, morganHadReadBefore: true, ceoHadReadBefore: false, morganId: "morgan", beforeGrantReadCount: 0, initialAccessExplanation: true, initialResearchClaim: false, humanManagementVisible: true, authorizedGrant: true, operatorChannel: "public-browser-agent-selection", sameConnectionCount: true, morganRetainedRead: true, ceoHasReadAfter: true, fixturesUnchanged: true, initialRunId: "initial", pages: [page], decisions: [{ runId: "continued", decisions: [{ invocation: { runId: "continued", connectionId: "connection", agentId: "ceo", issueId: "source", catalogEntryId: "read", status: "succeeded" } }] }] } }; }
describe("named Notion assignment prerequisite and continuation", () => {
  const definition = notionAssignmentExternalCases[0]!;
  it("accepts a same-account authorized grant followed by an actual source-bound read", () => expect(definition.grade(valid()).passed).toBe(true));
  it("rejects borrowed access, duplicate connections, removed Morgan access and ungrounded continuation", () => {
    for (const mutate of [
      (o: ReturnType<typeof valid>) => { o.state.ceoHadReadBefore = true; },
      (o: ReturnType<typeof valid>) => { o.state.beforeGrantReadCount = 1; },
      (o: ReturnType<typeof valid>) => { o.state.initialResearchClaim = true; },
      (o: ReturnType<typeof valid>) => { o.state.sameConnectionCount = false; },
      (o: ReturnType<typeof valid>) => { o.state.morganRetainedRead = false; },
      (o: ReturnType<typeof valid>) => { o.state.workspaceMatched = false; },
      (o: ReturnType<typeof valid>) => { o.state.decisions[0]!.decisions[0]!.invocation.agentId = "morgan"; },
      (o: ReturnType<typeof valid>) => { o.state.decisions[0]!.decisions[0]!.invocation.issueId = "other"; },
      (o: ReturnType<typeof valid>) => { o.phaseReplies[1]!.runId = "initial"; },
      (o: ReturnType<typeof valid>) => { o.phaseReplies[1]!.body = "The page is titled Launch."; },
      (o: ReturnType<typeof valid>) => { o.phaseReplies[1]!.body = "The launch date is November 8, updated Oct 25, 2026."; },
      (o: ReturnType<typeof valid>) => { o.links[0] = "https://www.notion.so/22222222222242228222222222222222"; },
    ]) { const o = valid(); mutate(o); expect(definition.grade(o).passed).toBe(false); }
  });
  it("missing evidence cannot be replaced by a plausible reply", () => { expect(definition.grade(undefined).passed).toBe(false); expect(definition.grade({ reply: "Assigned and read." }).passed).toBe(false); });
});
