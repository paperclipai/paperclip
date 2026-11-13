import { describe, expect, it } from "vitest";
import { restatesEarlierReply } from "./restated-reply.js";

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

  const reportBefore = "The full launch report is ready at https://example.com/reports/launch and covers the signup funnel, the pricing page and the onboarding emails for review.";
  const reportAfter = "The launch report is ready and covers the signup funnel, the pricing page and the onboarding emails, so you can review it.";

  it("keeps an earlier bare URL the later message drops", () => {
    expect(restatesEarlierReply(reportBefore, reportAfter)).toBe(false);
  });

  it("treats a later message that keeps the bare URL as a restatement", () => {
    expect(restatesEarlierReply(reportBefore, `${reportAfter} Link: https://example.com/reports/launch.`)).toBe(true);
  });

  it("keeps an earlier autolink the later message drops", () => {
    expect(
      restatesEarlierReply(reportBefore.replace("https://example.com/reports/launch", "<https://example.com/reports/launch>"), reportAfter),
    ).toBe(false);
  });

  it("keeps an earlier reference-style link the later message drops", () => {
    expect(
      restatesEarlierReply(
        "The full launch [report][launch] is ready and covers the signup funnel, the pricing page and the onboarding emails for review.\n\n[launch]: /COM/issues/COM-7#document-report",
        reportAfter,
      ),
    ).toBe(false);
  });

  const codeAnswer = (code: string) =>
    `Run this script to check the export before you send it to the team:\n\n\`\`\`python\n${code}\n\`\`\`\n\nIt prints the row count and exits.`;

  it("keeps an earlier code block whose string contents differ only in spacing", () => {
    expect(restatesEarlierReply(codeAnswer('print("a  b")'), codeAnswer('print("a b")'))).toBe(false);
  });

  it("keeps an earlier code block whose indentation differs", () => {
    expect(
      restatesEarlierReply(
        codeAnswer("for row in rows:\n    if row:\n        print(row)"),
        codeAnswer("for row in rows:\n    if row:\n    print(row)"),
      ),
    ).toBe(false);
  });

  it("treats a later message with the same code block as a restatement", () => {
    const code = "for row in rows:\n    print(row)";
    expect(restatesEarlierReply(codeAnswer(code), codeAnswer(code).replace("Run this script", "Use this script"))).toBe(true);
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
