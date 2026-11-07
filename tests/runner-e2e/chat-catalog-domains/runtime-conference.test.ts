import { it, expect } from "vitest";
import { gradeConference } from "./runtime-conference.js";
function valid() {
  return { scenarioId: "agent-chat.conference-room", companyId: "company", leadId: "ceo", reply: "Open the Conference Room for the separate board-level discussion.",
    state: { deploymentMode: "local_trusted", conferenceEnabled: true, agentChatEnabled: true, conferenceVisible: true,
      openedCompanyPrefix: "ACORN", companyPrefix: "ACORN", noBrokenRoute: true, runsBeforeOpen: 1, runsAfterOpen: 1,
      standingIssueBefore: "chat", standingIssueAfter: "chat" }, agents: [], tasks: [], links: [], activity: [], runs: [], humanQueries: [] };
}
it("accepts the real gated board surface in company context", () => expect(gradeConference(valid()).passed).toBe(true));
it("accepts natural Conference Room navigation guidance", () => { const o = valid(); o.reply = "For a separate board discussion, choose Conference Room in this company. It is a distinct discussion surface."; expect(gradeConference(o).passed).toBe(true); });
it("rejects missing conference evidence", () => expect(gradeConference(undefined).passed).toBe(false));
it("rejects wrong deployment qualification", () => {
  const o = valid(); o.state.deploymentMode = "authenticated"; expect(gradeConference(o).passed).toBe(false);
});
it("rejects navigation to another company", () => {
  const o = valid(); o.state.openedCompanyPrefix = "BIRCH"; expect(gradeConference(o).passed).toBe(false);
});
it("rejects invented standing-chat history parity", () => {
  const o = valid(); o.reply += " It uses the same Agent Chat history."; expect(gradeConference(o).passed).toBe(false);
});

it("preserves failure when the actual model only asks launch questions and supplies no board navigation or scope", () => {
  const o = valid(); o.reply = ""; expect(gradeConference(o).passed).toBe(false);
});
