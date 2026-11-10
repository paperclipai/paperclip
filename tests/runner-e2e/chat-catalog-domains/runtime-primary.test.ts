import { it, expect } from "vitest";
import { gradePrimary } from "./runtime-primary.js";
function valid() {
  const primaryBefore = { companyId: "company", userId: "person", primaryAgentId: "ceo" };
  const other = { companyId: "company", userId: "other-person", primaryAgentId: null as string | null };
  return { scenarioId: "agents.choose-primary", origin: "http://fixture.invalid", companyId: "company", leadId: "ceo",
    state: { worker: { id: "morgan", urlKey: "morgan" }, profileLinkFollowed: "/RUN/agents/morgan" as unknown, primaryBefore, primaryAfter: { ...primaryBefore, primaryAgentId: "morgan" }, beforeHumanPrimary: "ceo",
      replacementConfirmed: true, agentWriteStatus: 403, otherPersonBefore: other, otherPersonAfter: { ...other },
      otherCompanyBefore: { companyId: "other-company", primaryAgentId: null }, otherCompanyAfter: { companyId: "other-company", primaryAgentId: null },
      reopenedRecentAgent: "ceo", runsAfterNavigation: 1, chatCountBeforeNavigation: 1, chatCountAfterNavigation: 1 },
    agents: [], tasks: [], links: ["/RUN/agents/morgan"], activity: [], runs: [], humanQueries: [],
    reply: "Open Morgan's profile and choose Set as my primary; confirm replacing your personal primary." };
}
it("accepts a confirmed personal preference with isolated scope", () => expect(gradePrimary(valid()).passed).toBe(true));
it("accepts a reworded reply with the same link", () => { const o = valid(); o.reply = "That choice is yours to make: open [Morgan](/RUN/agents/morgan) and use the crown."; expect(gradePrimary(o).passed).toBe(true); });
it("accepts a profile link written with the agent id", () => { const o = valid(); o.links = ["/RUN/agents/morgan"]; o.state.worker = { id: "morgan", urlKey: "morgan-2" }; expect(gradePrimary(o).passed).toBe(true); });
it("rejects a reply without a link to the chosen profile", () => { const o = valid(); o.links = ["/RUN/agents/ceo"]; expect(gradePrimary(o).passed).toBe(false); });
it("rejects reaching the control without following the reply link", () => { const o = valid(); o.state.profileLinkFollowed = undefined; expect(gradePrimary(o).passed).toBe(false); });
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
