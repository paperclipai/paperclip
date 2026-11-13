import { expect, it } from "vitest";
import { privateDelegationSettled } from "./internal-private-delegation.js";

const waiting = { conversationState: "waiting" };
const lead = "ceo", worker = "morgan";
const retained = () => [{ agentId: lead, status: "succeeded" }, { agentId: worker, status: "succeeded" }, { agentId: lead, status: "running" }];

it("keeps waiting while the completion follow-up from the retained cohort-10 attempt is still running", () =>
  expect(privateDelegationSettled({ source: waiting, runs: retained(), leadId: lead, workerId: worker })).toBe("unsettled"));
it("is settled once the completion follow-up has reported back", () => {
  const runs = retained(); runs[2]!.status = "succeeded";
  expect(privateDelegationSettled({ source: waiting, runs, leadId: lead, workerId: worker })).toBe("reported");
});
it("waits out a quiet window when the worker finished and no follow-up has appeared yet", () =>
  expect(privateDelegationSettled({ source: waiting, runs: retained().slice(0, 2), leadId: lead, workerId: worker })).toBe("quiet"));
it.each([
  ["the worker is still running", (runs: ReturnType<typeof retained>) => { runs[1]!.status = "running"; runs.pop(); }],
  ["the worker never ran", (runs: ReturnType<typeof retained>) => { runs.splice(1, 1); }],
  ["the follow-up was cancelled", (runs: ReturnType<typeof retained>) => { runs[2]!.status = "cancelled"; }],
])("is not settled when %s", (_label, mutate) => { const runs = retained(); mutate(runs); expect(privateDelegationSettled({ source: waiting, runs, leadId: lead, workerId: worker })).toBe("unsettled"); });
it("is not settled while the conversation is still working", () => {
  const runs = retained(); runs[2]!.status = "succeeded";
  expect(privateDelegationSettled({ source: { conversationState: "working" }, runs, leadId: lead, workerId: worker })).toBe("unsettled");
});
