// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "@paperclipai/shared";
import { recordAgentChatVisit } from "@/lib/recent-agent-chats";
import { AgentChats } from "./AgentChats";

const state = vi.hoisted(() => ({
  companyId: "company-a",
  userId: "user-a",
  agents: [] as Agent[],
  chats: [] as { conversationAgentId: string }[],
  chatsFetched: true,
  sessionError: null as Error | null,
  navigate: vi.fn(),
}));

vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));
vi.mock("@/hooks/useAgentChatNavigation", () => ({
  useAgentChatNavigation: () => ({
    companyId: state.companyId,
    userId: state.userId,
    enabled: true,
    loaded: true,
    agents: { data: state.agents, isFetched: true, isPending: false, error: null },
    chats: { data: state.chats, isFetched: state.chatsFetched, error: null },
    session: { isFetched: !state.sessionError, isPending: false, error: state.sessionError },
  }),
  useOpenAgentChat: () => vi.fn(),
}));
vi.mock("@/lib/router", () => ({
  useNavigate: () => state.navigate,
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={to}>{children}</a>,
}));
vi.mock("@/components/AgentAvatar", () => ({ AgentAvatar: () => null }));

let root: Root;
let container: HTMLDivElement;
const agent = (id: string, companyId = "company-a") => ({
  id, companyId, name: id, urlKey: `${id}-slug`, role: "engineer", status: "idle",
} as Agent);

async function render() {
  await act(async () => root.render(<AgentChats />));
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.companyId = "company-a";
  state.userId = "user-a";
  state.agents = [agent("alice"), agent("bob")];
  state.chats = [];
  state.chatsFetched = true;
  state.sessionError = null;
  state.navigate.mockReset();
  localStorage.setItem("paperclip.recentAgentChats:company-a:user-a", "[]");
  localStorage.setItem("paperclip.recentAgentChats:company-b:user-a", "[]");
  localStorage.setItem("paperclip.recentAgentChats:company-a:user-b", "[]");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("Chat landing", () => {
  it("opens the most recently visited agent and replaces the landing history entry", async () => {
    recordAgentChatVisit("company-a", "user-a", "alice");
    recordAgentChatVisit("company-a", "user-a", "bob");
    await render();
    expect(state.navigate).toHaveBeenCalledWith("/chats/bob-slug", { replace: true });
    expect(container.textContent).toContain("Opening chat");
  });

  it("skips unavailable saved agents and preserves the company and user scope", async () => {
    recordAgentChatVisit("company-a", "user-a", "alice");
    recordAgentChatVisit("company-a", "user-a", "removed");
    recordAgentChatVisit("company-b", "user-a", "other-company-agent");
    recordAgentChatVisit("company-a", "user-b", "other-user-agent");
    await render();
    expect(state.navigate).toHaveBeenCalledWith("/chats/alice-slug", { replace: true });
  });

  it("reopens historical chats for agents missing from the active roster", async () => {
    recordAgentChatVisit("company-a", "user-a", "retired-id");
    state.chats = [{ conversationAgentId: "retired-id" }];
    await render();
    expect(state.navigate).toHaveBeenCalledWith("/chats/retired-id", { replace: true });
  });

  it("waits for history before skipping a recent historical chat", async () => {
    recordAgentChatVisit("company-a", "user-a", "alice");
    recordAgentChatVisit("company-a", "user-a", "retired-id");
    state.chatsFetched = false;
    await render();
    expect(state.navigate).not.toHaveBeenCalled();
    state.chatsFetched = true;
    state.chats = [{ conversationAgentId: "retired-id" }];
    await render();
    expect(state.navigate).toHaveBeenCalledWith("/chats/retired-id", { replace: true });
  });

  it("shows the chooser when no saved chat remains available", async () => {
    recordAgentChatVisit("company-a", "user-a", "removed");
    await render();
    expect(state.navigate).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Who would you like to talk to?");
  });

  it("shows a retry state when identity fails instead of waiting for disabled history", async () => {
    recordAgentChatVisit("company-a", "user-a", "alice");
    state.sessionError = new Error("Session unavailable");
    state.chatsFetched = false;
    await render();
    expect(state.navigate).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Couldn’t load your chats");
  });
});
