import { expect, it, vi } from "vitest";
vi.mock("../codex-subscription-fixture.js", () => ({ codexSubscriptionAgentConfig: (value: unknown) => value }));
import { gradePrimary } from "./runtime-primary.js";
const companyId = "00000000-0000-4000-8000-000000000111", morganId = "00000000-0000-4000-8000-000000000112", ceoId = "00000000-0000-4000-8000-000000000113";
const profile = "Open Morgan's agent profile, select the primary crown and confirm replacing your current primary.";
const api = `To finish from your board session, PUT /api/companies/${companyId}/primary-agent/me with {"primaryAgentId":"${morganId}"}. The current primary remains unchanged.`;
function observed(reply: string) {
  const before = { companyId, userId: "person", primaryAgentId: ceoId }, other = { companyId, userId: "other-person", primaryAgentId: null };
  return { scenarioId: "agents.choose-primary", origin: "https://paperclip.test", companyId, leadId: ceoId,
    state: { worker: { id: morganId, name: "Morgan" }, primaryBefore: before, primaryAfter: { ...before, primaryAgentId: morganId },
      beforeHumanPrimary: ceoId, replacementConfirmed: true, agentWriteStatus: 403, otherPersonBefore: other, otherPersonAfter: { ...other },
      otherCompanyBefore: { companyId: "other-company", primaryAgentId: null }, otherCompanyAfter: { companyId: "other-company", primaryAgentId: null },
      reopenedRecentAgent: ceoId, runsAfterNavigation: 1, chatCountBeforeNavigation: 1, chatCountAfterNavigation: 1 },
    agents: [{ id: ceoId, name: "CEO" }, { id: morganId, name: "Morgan" }], tasks: [], links: [], activity: [], runs: [], humanQueries: [], reply };
}
it("accepts supported human profile guidance with explicit unchanged language rather than a false completed claim", () => {
  expect(gradePrimary(observed(profile + " I changed nothing else: the current primary preference is untouched.")).passed).toBe(true);
});
it("does not treat API-only guidance as proof of the exercised profile handoff", () => {
  expect(gradePrimary(observed(api)).passed).toBe(false);
});
it("accepts a truthful explanation that the picker cannot set the preference", () => {
  expect(gradePrimary(observed("The Chat picker does not set your primary. " + profile)).passed).toBe(true);
});
it.each([
  profile + " I have made Morgan your primary.",
  profile + " I’ve set Morgan as your primary.",
  profile + " Set Morgan as your primary through the Chat picker.",
  profile + " I changed nothing else and set Morgan as your primary.",
  profile + " I changed nothing else. I've already changed your primary to Morgan.",
  profile + " Morgan is now your primary.",
  "In Chat, open the agent picker and set Morgan as your primary. " + api,
  api.replace(companyId, "00000000-0000-4000-8000-000000000999"),
  api.replace(morganId, ceoId),
  api.replace("/api/companies/", "https://foreign.test/api/companies/"),
  api.replace("your board session", "Riley's board session"),
  "Choose Morgan as primary.",
])("rejects an untruthful, unsupported or foreign guidance path: %s", reply => {
  expect(gradePrimary(observed(reply)).passed).toBe(false);
});
it.each(["before-human-write", "no-confirmation", "foreign-owner", "extra-run"])("keeps actual saved-state authority and readiness requirement%s", fault => {
  const o = observed(profile);
  if (fault === "before-human-write") o.state.beforeHumanPrimary = morganId;
  else if (fault === "no-confirmation") o.state.replacementConfirmed = false;
  else if (fault === "foreign-owner") o.state.primaryAfter.userId = "other-person";
  else o.state.runsAfterNavigation = 2;
  expect(gradePrimary(o).passed).toBe(false);
});

it.each([
  "Open another agent's profile and confirm replacing your primary with that agent.",
  "Open their profile, choose Set as my primary and confirm the replacement.",
  "Keep CEO as the old preference until you confirm replacing it. " + profile,
])("accepts generic profile procedure grounded by the requested target without requiring its literal name: %s", reply => {
  expect(gradePrimary(observed(reply)).passed).toBe(true);
});
it.each([
  "Open CEO's agent profile and confirm replacing your primary.",
  "Open the current CEO profile instead of Morgan and confirm replacing your primary.",
  `Open [CEO](/RUN/agents/${ceoId}) in the agent profile and confirm replacing your primary.`,
])("rejects an explicitly different known profile target despite a hardcoded successful human act: %s", reply => {
  expect(gradePrimary(observed(reply)).passed).toBe(false);
});
