// @vitest-environment jsdom
import { clearLegacyChatMessageRequests } from "./chat-message-request";
import { describe, expect, it } from "vitest";
import {
  orderChatAgents,
  parseRecentAgentChats,
  recordAgentChatVisit,
} from "./recent-agent-chats";
import { commentsToTaskChatItems } from "@/components/task-chat/task-chat-adapter";
import type { IssueChatComment } from "./issue-chat-messages";

describe("agent chat navigation and session markers", () => {
  it("sorts stars alphabetically, then limits recent unstarred agents to four", () => {
    const agents = [
      "Zulu",
      "Alpha",
      "Three",
      "Four",
      "Five",
      "Six",
      "Seven",
    ].map((name, i) => ({ id: String(i), name }));
    expect(
      orderChatAgents(agents, ["0", "1"], ["0", "6", "5", "4", "3", "2"]).map(
        (agent) => agent.name,
      ),
    ).toEqual(["Alpha", "Zulu", "Seven", "Six", "Five", "Four"]);
    expect(parseRecentAgentChats('["a","a",null,1,"b"]')).toEqual(["a", "b"]);
    expect(parseRecentAgentChats("broken")).toEqual([]);
  });
  it("keeps visits personal and company scoped and moves only the visited agent", () => {
    localStorage.clear();
    recordAgentChatVisit("a", "user1", "agent1");
    recordAgentChatVisit("a", "user1", "agent2");
    recordAgentChatVisit("a", "user1", "agent1");
    recordAgentChatVisit("b", "user1", "agent3");
    recordAgentChatVisit("a", "user2", "agent4");
    expect(
      JSON.parse(localStorage.getItem("paperclip.recentAgentChats:a:user1")!),
    ).toEqual(["agent1", "agent2"]);
    expect(
      JSON.parse(localStorage.getItem("paperclip.recentAgentChats:b:user1")!),
    ).toEqual(["agent3"]);
    expect(
      JSON.parse(localStorage.getItem("paperclip.recentAgentChats:a:user2")!),
    ).toEqual(["agent4"]);
  });
  it("removes legacy plaintext retry records", () => {
    const scope = "company:user:agent";
    const key = `paperclip:agent-chat-pending:${scope}`;
    localStorage.setItem(key, JSON.stringify([{ body: "private text", id: "old" }]));
    clearLegacyChatMessageRequests(scope);
    expect(localStorage.getItem(key)).toBeNull();
  });
  it("renders a processed /new as a divider without discarding earlier messages", () => {
    const comment = {
      id: "old",
      body: "Earlier message",
      authorType: "user",
      createdAt: new Date(),
    } as IssueChatComment;
    const items = commentsToTaskChatItems([
      comment,
      {
        ...comment,
        id: "reset",
        body: "/new",
        conversationSessionGeneration: 1,
      },
      { ...comment, id: "next", body: "Fresh message" },
    ]);
    expect(items.map((item) => item.kind)).toEqual([
      "message",
      "marker",
      "message",
    ]);
    expect(items[1]).toMatchObject({
      label: "New session",
      variant: "session_start",
    });
    expect(
      commentsToTaskChatItems([{ ...comment, body: "/new" }])[0].kind,
    ).toBe("message");
  });
});
