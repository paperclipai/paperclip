import { it, expect } from "vitest";
import { gradePrimary } from "./runtime-primary.js";
function valid() {
  const primaryBefore = { companyId: "company", userId: "person", primaryAgentId: "ceo" };
  const other = { companyId: "company", userId: "other-person", primaryAgentId: null as string | null };
  return { scenarioId: "agents.choose-primary", origin: "http://fixture.invalid", companyId: "company", leadId: "ceo",
    state: { worker: { id: "morgan" }, primaryBefore, primaryAfter: { ...primaryBefore, primaryAgentId: "morgan" }, beforeHumanPrimary: "ceo",
      replacementConfirmed: true, agentWriteStatus: 403, otherPersonBefore: other, otherPersonAfter: { ...other },
      otherCompanyBefore: { companyId: "other-company", primaryAgentId: null }, otherCompanyAfter: { companyId: "other-company", primaryAgentId: null },
      reopenedRecentAgent: "ceo", runsAfterNavigation: 1, chatCountBeforeNavigation: 1, chatCountAfterNavigation: 1 },
    agents: [], tasks: [], links: [], activity: [], runs: [], humanQueries: [],
    reply: "Open Morgan's profile and choose Set as my primary; confirm replacing your personal primary." };
}
it("accepts a confirmed personal preference with isolated scope", () => expect(gradePrimary(valid()).passed).toBe(true));
it("accepts natural personal-primary guidance", () => { const o = valid(); o.reply = "In Morgan's profile, select Set as my primary and confirm the replacement. This changes your personal primary preference."; expect(gradePrimary(o).passed).toBe(true); });
it("rejects missing primary evidence", () => expect(gradePrimary(undefined).passed).toBe(false));
it("rejects an agent preference write before the human control", () => {
  const o = valid(); o.state.beforeHumanPrimary = "morgan"; expect(gradePrimary(o).passed).toBe(false);
});
it("rejects a preference changed for another person", () => {
  const o = valid(); o.state.otherPersonAfter = { ...o.state.otherPersonAfter, primaryAgentId: "morgan" };
  expect(gradePrimary(o).passed).toBe(false);
});
it("rejects navigation that starts a new execution", () => {
  const o = valid(); o.state.runsAfterNavigation = 2; expect(gradePrimary(o).passed).toBe(false);
});
it("rejects false agent-authored completion language", () => {
  const o = valid(); o.reply = "I have made Morgan your primary. Open the profile to confirm.";
  expect(gradePrimary(o).passed).toBe(false);
});
