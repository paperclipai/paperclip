import { describe, expect, it } from "vitest";
import { gradeSignInBoundary, signInIdentityBoundaryCases } from "./identity-sign-in.js";
function valid() { return { personId: "alex", returnedPersonId: "alex", companyId: "acorn", conversationId: "standing-chat", returnedConversationId: "standing-chat",
  beforeComposerVisible: true, expiredReadStatus: 401, expiredComposerAbsent: true, configuredSignInVisible: true,
  safeReturnPath: "/ACO/chats/morgan", intendedReturnPath: "/ACO/chats/morgan", restoredComposerVisible: true,
  nonmemberCompanyStatus: 403, nonmemberConversationStatus: 404, nonmemberBrowserBlocked: true,
  beforeCommentIds: [], afterCommentIds: [], runIds: [] }; }
describe("real sign-in boundary acceptance", () => {
  it.each([401, 404])("accepts complete real auth+same-resource+audience evidence with production denial %s", expiredReadStatus => { expect(gradeSignInBoundary({ ...valid(), expiredReadStatus }).passed).toBe(true); });
  it.each([
    { expiredReadStatus: 200 }, { expiredReadStatus: 403 }, { expiredReadStatus: 500 }, { returnedPersonId: "riley" }, { returnedConversationId: "new-conversation" },
    { safeReturnPath: "https://other.test/steal" }, { nonmemberConversationStatus: 200 }, { nonmemberBrowserBlocked: false },
    { runIds: ["accidental-run"] }, { afterCommentIds: ["sent-expired-intent"] }, { restoredComposerVisible: false },
  ])("rejects incomplete or wrong boundary proof %j", change => { expect(gradeSignInBoundary({ ...valid(), ...change }).passed).toBe(false); });
  it("fails closed on a sign-in-screen-only claim or missing evidence", () => {
    expect(gradeSignInBoundary({ configuredSignInVisible: true }).passed).toBe(false);
    expect(gradeSignInBoundary(undefined).passed).toBe(false);
  });
  it("declares the pre-chat journey independently with zero query/run admissions", () => {
    expect(signInIdentityBoundaryCases[0]).toMatchObject({ scenarioId: "access.sign-in", journeyKind: "browser-boundary", boundaryTarget: "authenticated-harness",
      authentication: "human-session", expectedRunCount: 0, expectedHumanMessageCount: 0 });
    expect(signInIdentityBoundaryCases[0]!.coverageGaps ?? []).toEqual([]);
  });
});
