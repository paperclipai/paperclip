import { it, expect } from "vitest";
import { gradeReopenConversation } from "./runtime-agent-chat.js";
function valid() {
  return { scenarioId: "agent-chat.reopen-conversation", companyId: "company", leadId: "morgan", reply: "Your existing conversation.",
    state: { existingIssueId: "chat", reopenedIssueId: "chat", reopenedAgentId: "morgan", historyRetained: true,
      beforeNavigationRuns: 2, afterNavigationRuns: 2, beforeNavigationChatIds: ["chat"], afterNavigationChatIds: ["chat"],
      agentChatListStatus: 403, finalQueryReply: "You can reopen your existing conversation with Morgan through Chat.", navigationMatchesIntendedAgent: true, finalNavigationLinksCorrect: true }, agents: [], tasks: [], links: [], activity: [], runs: [], humanQueries: [] };
}
it("accepts original conversation navigation retaining genuine history", () => expect(gradeReopenConversation(valid()).passed).toBe(true));
it("rejects missing conversation evidence", () => expect(gradeReopenConversation(undefined).passed).toBe(false));
it("rejects opening a duplicate conversation", () => {
  const o = valid(); o.state.reopenedIssueId = "duplicate"; expect(gradeReopenConversation(o).passed).toBe(false);
});
it("rejects navigation that starts provider work", () => {
  const o = valid(); o.state.afterNavigationRuns = 3; expect(gradeReopenConversation(o).passed).toBe(false);
});
it("rejects a link from the setup reply instead of canonical query", () => {
  const o = valid(); o.state.finalQueryReply = "Only setup context."; expect(gradeReopenConversation(o).passed).toBe(false);
});

it("rejects a supplied link into another person's or agent's chat", () => {
  const o = valid(); o.state.finalNavigationLinksCorrect = false; expect(gradeReopenConversation(o).passed).toBe(false);
});
