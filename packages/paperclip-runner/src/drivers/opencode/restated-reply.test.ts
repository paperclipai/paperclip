import { describe, expect, it } from "vitest";
import { restatesEarlierReply } from "./restated-reply.js";

// Recorded in chat-eval cohort 4 (budgets-costs.set-budget): the answer before
// the completion call, then the same answer written again after it.
const recordedBefore =
  "I can't set this from chat — changing an agent's monthly budget is a board-only action (agent credentials get 403). There are also two matching agents, so pick the intended one in the web app and set its monthly limit to $50 on the budget tab: [Morgan budgets](/COM/agents/a1/budgets) or [Morgan Research budgets](/COM/agents/a2/budgets). Tell me which Morgan you meant and I'll track the right one.";
const recordedAfter =
  "I can't change agent budgets from chat — that's board-only, and agent credentials get 403. Two agents also match \"Morgan,\" so choose the intended one and set $50/month on its budget tab: [Morgan budgets](/COM/agents/a1/budgets) or [Morgan Research budgets](/COM/agents/a2/budgets).";

describe("restatesEarlierReply", () => {
  it("treats an identical later message as a restatement", () => {
    expect(restatesEarlierReply(recordedBefore, `${recordedBefore}\n`)).toBe(true);
  });

  it("treats the recorded reworded answer as a restatement", () => {
    expect(restatesEarlierReply(recordedBefore, recordedAfter)).toBe(true);
  });

  it("keeps an answer whose later message only refers back to it", () => {
    expect(
      restatesEarlierReply(
        "Two inbox items need you: [COM-2](/COM/issues/COM-2) is blocked and [COM-1](/COM/issues/COM-1) is waiting for review.",
        "Answered above: two inbox items need your attention.",
      ),
    ).toBe(false);
  });

  it("keeps an earlier link the later message drops", () => {
    expect(
      restatesEarlierReply(
        recordedBefore,
        recordedAfter.replace(" or [Morgan Research budgets](/COM/agents/a2/budgets)", " or Morgan Research's budget tab"),
      ),
    ).toBe(false);
  });

  it("keeps an earlier code block the later message drops", () => {
    expect(
      restatesEarlierReply(
        "Run this in your terminal:\n\n```shell\nnpx paperclipai auth login\n```\n\nThen confirm with whoami.",
        "Run the sign-in command in your terminal, then confirm with whoami before any write.",
      ),
    ).toBe(false);
  });

  it("keeps earlier prose that says something different", () => {
    expect(
      restatesEarlierReply(
        "The deploy failed because the database migration timed out after 30 seconds on the orders table.",
        "I opened a follow-up task for Morgan to split the migration and will report back once it lands.",
      ),
    ).toBe(false);
  });
});
