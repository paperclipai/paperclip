import { describe, expect, it } from "vitest";
import { gradeInvitation, describesInvitationLimitation, type InvitationEvidence } from "./public-mcp-grading.js";

function good(): InvitationEvidence {
  return { kind: "invitation-cold-start", companyId: "company", fetched: true, configured: true, approved: true, configurationWrites: 1, existingPreserved: true,
    grants: [{ companyId: "company" }], turns: [{ calls: [
      { name: "request_user_approval", result: { decision: "approved" } },
      { name: "paperclip_connection", result: { structuredContent: { companyId: "company" } } },
      { name: "paperclip_create_task", result: {} },
    ] }] };
}
describe("invitation approval oracle calibration", () => {
  it("accepts honest refusal with typographic apostrophes without accepting success claims", () => {
    for (const text of ["I can’t complete the connection from this host.", "I can't connect here.", "You declined the connection.", "Use your host's manual settings."]) expect(describesInvitationLimitation(text)).toBe(true);
    for (const text of ["Connected successfully.", "I created your task.", ""]) expect(describesInvitationLimitation(text)).toBe(false);
  });
  it("requires instructions, actual approval, independently scoped grants and identity before work", () => {
    expect(gradeInvitation(good())).toBe(true);
    for (const change of [{ fetched: false }, { approved: false }, { existingPreserved: false }, { grants: [] }, { grants: [{ companyId: "foreign" }] }, { configurationWrites: 2 }, { turns: [] }]) expect(gradeInvitation({ ...good(), ...change })).toBe(false);
    expect(gradeInvitation(null)).toBe(false);
    const early = good(); early.turns[0]!.calls.reverse(); expect(gradeInvitation(early)).toBe(false);
  });
  it("requires denial to leave no authorized grant or Paperclip tool access", () => {
    const denied: InvitationEvidence = { ...good(), kind: "invitation-denied", approved: false, grants: [], turns: [{ calls: [{ name: "request_user_approval", result: { decision: "declined" } }] }] };
    expect(gradeInvitation(denied)).toBe(true);
    expect(gradeInvitation({ ...denied, grants: [{ companyId: "company" }] })).toBe(false);
    denied.turns[0]!.calls.push({ name: "paperclip_connection", result: {} }); expect(gradeInvitation(denied)).toBe(false);
  });
  it("does not count a host without setup capabilities as configured", () => {
    const unavailable: InvitationEvidence = { ...good(), kind: "invitation-unavailable-host", approved: false, configured: false, grants: [], configurationWrites: 0, turns: [{ calls: [] }] };
    expect(gradeInvitation(unavailable)).toBe(true);
    expect(gradeInvitation({ ...unavailable, configured: true })).toBe(false);
  });
  it("accepts a recorded human browser decision between turns without inventing a model call", () => {
    const evidence = good();
    evidence.turns = [{ calls: [] }, { calls: evidence.turns[0]!.calls.slice(1) }];
    evidence.humanDecisions = [{ afterTurn: 0, decision: "approved", verificationUrl: "https://paperclip.example/mcp-device?user_code=ABCD-EFGH" }];
    expect(gradeInvitation(evidence)).toBe(true);
    expect(gradeInvitation({ ...evidence, humanDecisions: [] })).toBe(false);
    expect(gradeInvitation({ ...evidence, humanDecisions: [{ ...evidence.humanDecisions[0]!, afterTurn: 1 }] })).toBe(false);
    expect(gradeInvitation({ ...evidence, grants: [] })).toBe(false);
    expect(gradeInvitation({ ...evidence, humanDecisions: [{ ...evidence.humanDecisions[0]!, decision: "declined" }] })).toBe(false);
  });
});
