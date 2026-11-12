// @vitest-environment node

import { useContext } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CoordinatorChatReferences, CoordinatorChatReferencesProvider } from "./CoordinatorChatReferences";

vi.mock("@/hooks/useAgentChatNavigation", () => ({
  useAgentChatNavigation: () => ({
    agents: { data: [{ id: "agent-1", name: "CTO", urlKey: "cto" }] },
    chats: { data: [
      { id: "default-chat", identifier: "CHA-1", conversationAgentId: "agent-1", conversationDefault: true },
      { id: "second-chat", identifier: "CHA-2", conversationAgentId: "agent-1", conversationDefault: false },
    ] },
  }),
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
});
