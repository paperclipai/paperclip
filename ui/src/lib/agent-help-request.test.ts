import { describe, expect, it } from "vitest";
import {
  DEFAULT_AGENT_HELP_PROMPT,
  buildAgentHelpRequestComment,
  canAskAgentsForIssue,
} from "./agent-help-request";

describe("agent help request helpers", () => {
  it("builds a comment with durable agent mention links and the review prompt", () => {
    expect(
      buildAgentHelpRequestComment({
        issueTitle: "Ship the help flow",
        selectedAgents: [
          { id: "agent-1", name: "Agent One" },
          { id: "agent-2", name: "Agent [Two]", icon: "code" },
        ],
        prompt: `  ${DEFAULT_AGENT_HELP_PROMPT}  `,
      }),
    ).toBe(
      "[@Agent One](agent://agent-1) [@Agent \\[Two\\]](agent://agent-2?i=code)\n\n" +
        DEFAULT_AGENT_HELP_PROMPT,
    );
  });

  it("allows help requests only for open tasks assigned to the current user", () => {
    expect(canAskAgentsForIssue({ assigneeUserId: "board-user", status: "todo" }, "board-user")).toBe(true);
    expect(canAskAgentsForIssue({ assigneeUserId: "other-user", status: "todo" }, "board-user")).toBe(false);
    expect(canAskAgentsForIssue({ assigneeUserId: "board-user", status: "done" }, "board-user")).toBe(false);
    expect(canAskAgentsForIssue({ assigneeUserId: "board-user", status: "cancelled" }, "board-user")).toBe(false);
    expect(canAskAgentsForIssue({ assigneeUserId: null, status: "todo" }, "board-user")).toBe(false);
  });
});
