import { expect, it } from "vitest";
import { gradePostStop, sameSourcePostStopChronology } from "./runtime-post-stop.js";

const query = "Now make the website a single page instead.";
const ids = { company: "company", agent: "lead", human: "user", issue: "11111111-1111-1111-1111-111111111111", old: "22222222-2222-2222-2222-222222222222", next: "33333333-3333-3333-3333-333333333333", comment: "comment-2" };
const intentId = "native-cancellation:44444444-4444-4444-4444-444444444444";
function input(times: { sent: string; ack: string; released: string; started: string; ended?: string }) {
  const boundary = { runId: ids.old, issueId: ids.issue, intentId, intentRecordedAt: "2026-11-07T10:00:00.000Z" };
  const old = { id: ids.old, nativeIssueId: ids.issue, companyId: ids.company, agentId: ids.agent, runtimeMode: "native", status: "cancelled", finishedAt: times.ended ?? times.ack,
    resultJson: { nativeCancellation: { schema: "paperclip.native-cancellation.v1", intentId, issueId: ids.issue, companyId: ids.company, runId: ids.old, scope: "run", intentAuditId: "a1", acknowledgementAuditId: "a2",
      recordedAt: boundary.intentRecordedAt, dispatchState: "acknowledged", dispatched: true, acknowledgedAt: times.ack } } };
  const next = { id: ids.next, nativeIssueId: ids.issue, companyId: ids.company, agentId: ids.agent, runtimeMode: "native", status: "succeeded", startedAt: times.started };
  const human = { id: ids.comment, body: query, issueId: ids.issue, companyId: ids.company, authorAgentId: null, authorUserId: ids.human, createdAt: times.sent };
  return { boundary, old, next, human, query, companyId: ids.company, agentId: ids.agent, humanId: ids.human, prompt: `${ids.comment} ${query}`, wakeCommentIds: [ids.comment], heldReleasedAt: times.released } as unknown as Parameters<typeof sameSourcePostStopChronology>[0];
}

it("accepts a message saved while the old provider is still held in cleanup, even after the Stop ACK", () => {
  // The product ACKs a Stop after a bounded cleanup grace while the provider may still be closing.
  expect(sameSourcePostStopChronology(input({ ack: "2026-11-07T10:00:02.000Z", sent: "2026-11-07T10:00:02.300Z", released: "2026-11-07T10:00:03.000Z", started: "2026-11-07T10:00:04.000Z" }))).toBe(true);
  expect(sameSourcePostStopChronology(input({ sent: "2026-11-07T10:00:01.000Z", ack: "2026-11-07T10:00:02.000Z", released: "2026-11-07T10:00:03.000Z", started: "2026-11-07T10:00:04.000Z" }))).toBe(true);
});

it("rejects a message sent after cleanup was released and a successor started during cleanup", () => {
  expect(sameSourcePostStopChronology(input({ ack: "2026-11-07T10:00:02.000Z", released: "2026-11-07T10:00:03.000Z", sent: "2026-11-07T10:00:03.500Z", started: "2026-11-07T10:00:04.000Z" }))).toBe(false);
  expect(sameSourcePostStopChronology(input({ ack: "2026-11-07T10:00:02.000Z", sent: "2026-11-07T10:00:02.300Z", started: "2026-11-07T10:00:02.600Z", released: "2026-11-07T10:00:03.000Z" }))).toBe(false);
  expect(sameSourcePostStopChronology(input({ sent: "2026-11-07T09:59:59.000Z", ack: "2026-11-07T10:00:02.000Z", released: "2026-11-07T10:00:03.000Z", started: "2026-11-07T10:00:04.000Z" }))).toBe(false);
});

function observation(state: Record<string, unknown>) {
  return { reply: "", companyId: ids.company, agents: [], links: [], activity: [], leadId: ids.agent, humanQueries: [{}, {}], tasks: [], runs: [{ status: "cancelled", agentId: ids.agent }, { status: "succeeded", agentId: ids.agent }],
    state: { stopStatus: 200, messageAcceptedDuringHeldCleanup: true, noSuccessorWhileHeld: true, gateReleasedAfterCleanup: true, chronologyBound: true, providerExited: true, initialHumanRetained: true,
      singleSuccessor: true, sameCurrentAssignment: true, oldEvidenceRetained: true, actualSimplePage: true, artifactRunBound: true, canonicalReply: "Done: [website.html](/PAP/issues/PAP-1#document-website)", ...state } };
}

it("grades the saved page, not the reply wording", () => {
  const passed = (state: Record<string, unknown>) => gradePostStop(observation(state)).checks.every(check => check.passed);
  expect(passed({})).toBe(true);
  expect(passed({ canonicalReply: "Switched it over — one scrolling layout, no tabs anymore." })).toBe(true);
  expect(passed({ actualSimplePage: false })).toBe(false);
  expect(passed({ canonicalReply: "" })).toBe(false);
  expect(passed({ messageAcceptedDuringHeldCleanup: false })).toBe(false);
  expect(passed({ noSuccessorWhileHeld: false })).toBe(false);
});
