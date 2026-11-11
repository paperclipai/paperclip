import { describe, expect, it } from "vitest";
import { observeCheckoutActivity } from "./checkout-activity.js";

const run = { id: "run", companyId: "company", agentId: "agent", status: "succeeded",
  contextSnapshot: { issueId: "issue", paperclipWake: { checkedOutByHarness: true } } };
const receipt = { id: "receipt", companyId: "company", agentId: "agent", actorType: "agent",
  entityType: "issue", entityId: "issue", action: "issue.checked_out", runId: "run" };
const input = { companyId: "company", issueId: "issue", agentId: "agent", runs: [run], activity: [] };
describe("checkout activity observation", () => {
  it("distinguishes a runtime claim from repeated successful HTTP checkout calls", () => {
    expect(observeCheckoutActivity(input)).toMatchObject({ status: "observed", successfulCheckoutRequests: 0,
      runs: [{ checkedOutByHarness: true, successfulCheckoutRequests: 0 }] });
    expect(observeCheckoutActivity({ ...input, activity: [receipt, { ...receipt, id: "second" }] }))
      .toMatchObject({ status: "observed", successfulCheckoutRequests: 2 });
  });
  it.each([
    { runId: "another-run" }, { companyId: "foreign" }, { entityId: "other-task" },
    { agentId: "other-agent" }, { actorType: "user" }, { id: null },
  ])("does not count unattributed or foreign receipt %j as a comparable zero", mutation => {
    expect(observeCheckoutActivity({ ...input, activity: [{ ...receipt, ...mutation }] }))
      .toMatchObject({ status: "uncomparable", successfulCheckoutRequests: null });
  });
  it("refuses missing, mismatched and duplicate run/receipt identities", () => {
    for (const data of [
      { ...input, runs: [] }, { ...input, runs: [run, run] },
      { ...input, runs: [{ ...run, agentId: "other" }] },
      { ...input, runs: [{ ...run, contextSnapshot: { issueId: "other" } }] },
      { ...input, activity: [receipt, receipt] },
    ]) expect(observeCheckoutActivity(data)).toMatchObject({ status: "uncomparable", successfulCheckoutRequests: null });
  });
  it("does not infer a harness claim from status or task text", () => {
    expect(observeCheckoutActivity({ ...input, runs: [{ ...run, contextSnapshot: { issueId: "issue" } }] }))
      .toMatchObject({ runs: [{ checkedOutByHarness: false }] });
  });
});
