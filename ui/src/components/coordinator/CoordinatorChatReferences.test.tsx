// @vitest-environment node

import { useContext } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CoordinatorChatReferences, CoordinatorChatReferencesProvider } from "./CoordinatorChatReferences";

const fixture = vi.hoisted(() => ({
  agents: [{ id: "agent-1", name: "CTO", urlKey: "cto" }] as Array<{ id: string; name: string; urlKey: string }>,
  chats: [
    { id: "default-chat", identifier: "CHA-1", conversationAgentId: "agent-1", conversationDefault: true },
    { id: "second-chat", identifier: "CHA-2", conversationAgentId: "agent-1", conversationDefault: false },
  ] as Array<{ id: string; identifier: string | null; conversationAgentId: string; conversationDefault: boolean }>,
}));
vi.mock("@/hooks/useAgentChatNavigation", () => ({
  useAgentChatNavigation: () => ({ agents: { data: fixture.agents }, chats: { data: fixture.chats } }),
}));

function References() {
  const references = useContext(CoordinatorChatReferences);
  return <>{[...references].map(([key, reference]) => `${key}=${reference.href};`).join("")}</>;
}

describe("CoordinatorChatReferencesProvider", () => {
  it("links a secondary chat to its own transcript and the default chat to the agent route", () => {
    const html = renderToStaticMarkup(<CoordinatorChatReferencesProvider enabled><References /></CoordinatorChatReferencesProvider>);
    expect(html).toContain("default-chat=/chats/cto;");
    expect(html).toContain("cha-1=/chats/cto;");
    expect(html).toContain("second-chat=/chats/cto/second-chat;");
    expect(html).toContain("cha-2=/chats/cto/second-chat;");
  });

  it("resolves hundreds of chats against hundreds of agents with one pass over the agents", () => {
    // Each chat used to search the whole agent list; count every read of an agent id.
    let idReads = 0;
    fixture.agents = Array.from({ length: 500 }, (_, index) => {
      const id = `agent-${index}`;
      return Object.defineProperty({ name: `Agent ${index}`, urlKey: `agent-${index}` }, "id", { enumerable: true, get: () => { idReads++; return id; } }) as { id: string; name: string; urlKey: string };
    });
    fixture.chats = Array.from({ length: 500 }, (_, index) => ({ id: `chat-${index}`, identifier: null, conversationAgentId: `agent-${499 - index}`, conversationDefault: false }));
    const html = renderToStaticMarkup(<CoordinatorChatReferencesProvider enabled><References /></CoordinatorChatReferencesProvider>);
    expect(html).toContain("chat-0=/chats/agent-499/chat-0;");
    expect(html).toContain("chat-499=/chats/agent-0/chat-499;");
    expect(idReads).toBeLessThanOrEqual(2 * fixture.agents.length);
  });
});
