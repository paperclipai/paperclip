import { describe, expect, it } from "vitest";
import { SLACK_TOOLS } from "./slack-tools.js";

describe("Slack tool catalog definitions", () => {
  it("instructs agents reading channel history to call slack_thread for reply content", () => {
    const historyTool = SLACK_TOOLS.find((tool) => tool.name === "slack_history");
    expect(historyTool).toBeDefined();
    expect(historyTool?.description).toContain(
      "A message with replyCount > 0 has thread replies not included in this result; call slack_thread with that message's channel and ts to read them.",
    );
  });

  it("instructs agents to use slack_thread to get full reply content for threads found via other tools", () => {
    const threadTool = SLACK_TOOLS.find((tool) => tool.name === "slack_thread");
    expect(threadTool).toBeDefined();
    expect(threadTool?.description).toContain(
      "Call this to read full reply content for a thread found via slack_history or slack_message.",
    );
    expect(threadTool?.description).not.toContain("slack_search");
  });
});
