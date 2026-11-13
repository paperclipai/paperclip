// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "@/context/ThemeContext";
import { AgentCommentary } from "./AgentCommentary";

const mocks = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn(), vote: vi.fn(), removeVote: vi.fn() }));
const access = vi.hoisted(() => ({ getCurrentBoardAccess: vi.fn() }));
vi.mock("@/api/agentCommentary", () => ({ agentCommentaryApi: mocks }));
vi.mock("@/api/access", () => ({ accessApi: access }));
vi.mock("@/api/agents", () => ({ agentsApi: { list: async () => [] } }));
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompany: { issuePrefix: "TES" } }),
  useOptionalCompany: () => null,
}));

const entry = {
  id: "20000000-0000-4000-8000-000000000001",
  agent: { id: "10000000-0000-4000-8000-000000000001", name: "Writer", icon: null },
  runId: "30000000-0000-4000-8000-000000000001",
  kind: "suggestion", preview: "Preserve context", body: "Preserve context across retries.",
  createdAt: "2026-10-19T12:00:00Z", task: null, voteCount: 2, votedByMe: false,
};

function boardAccess(membershipRole: string) {
  return {
    user: null, userId: "user-1", isInstanceAdmin: false, companyIds: ["company-1"], source: "session", keyId: null,
    memberships: [{ companyId: "company-1", membershipRole, status: "active" }],
  };
}

describe("Commentary links and pagination", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let client: QueryClient;

  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState(null, "", "/TES/activity/commentary");
    mocks.list.mockImplementation(async (_companyId, filters) => ({
      items: [entry], total: 51, limit: 50, offset: filters.offset,
    }));
    mocks.get.mockResolvedValue(entry);
    mocks.vote.mockResolvedValue({ id: entry.id, voteCount: 3, votedByMe: true });
    mocks.removeVote.mockResolvedValue({ id: entry.id, voteCount: 2, votedByMe: false });
    access.getCurrentBoardAccess.mockResolvedValue(boardAccess("operator"));
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    flushSync(() => root.unmount());
    client.clear();
    container.remove();
  });
  function render() {
    flushSync(() => root.render(
      <QueryClientProvider client={client}><ThemeProvider><BrowserRouter>
        <AgentCommentary companyId="company-1" />
      </BrowserRouter></ThemeProvider></QueryClientProvider>,
    ));
  }

  it("loads pages of 50 and preserves the page in a shareable message URL", async () => {
    render();
    await vi.waitFor(() => expect(container.querySelector('[aria-label="Read suggestion from Writer"]')).not.toBeNull());
    expect(mocks.list).toHaveBeenLastCalledWith("company-1", expect.objectContaining({ limit: 50, offset: 0 }), expect.anything());
    flushSync(() => container.querySelector<HTMLButtonElement>('[aria-label="Next page"]')!.click());
    await vi.waitFor(() => expect(mocks.list).toHaveBeenLastCalledWith("company-1", expect.objectContaining({ limit: 50, offset: 50 }), expect.anything()));
    await vi.waitFor(() => expect(container.querySelector('[aria-label="Read suggestion from Writer"]')).not.toBeNull());
    flushSync(() => container.querySelector<HTMLButtonElement>('[aria-label="Read suggestion from Writer"]')!.click());
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')?.textContent).toContain(entry.body));
    expect(new URLSearchParams(window.location.search).get("entry")).toBe(entry.id);
    expect(new URLSearchParams(window.location.search).get("offset")).toBe("50");
    flushSync(() => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((button) => button.textContent === "Close")!.click());
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
    expect(new URLSearchParams(window.location.search).has("entry")).toBe(false);
    expect(new URLSearchParams(window.location.search).get("offset")).toBe("50");
  });

  it("opens the full message directly from a copied URL", async () => {
    window.history.replaceState(null, "", `/TES/activity/commentary?kind=suggestion&entry=${entry.id}`);
    render();
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')?.textContent).toContain(entry.body));
    expect(mocks.get).toHaveBeenCalledWith("company-1", entry.id, expect.anything());
    expect(mocks.list).toHaveBeenCalledWith("company-1", expect.objectContaining({ kind: "suggestion", limit: 50 }), expect.anything());
  });

  it("upvotes a message, removes the vote and keeps the vote sort in the URL", async () => {
    render();
    const upvote = () => container.querySelector<HTMLButtonElement>('li button[aria-pressed]');
    await vi.waitFor(() => expect(upvote()?.textContent).toBe("2"));
    expect(upvote()?.getAttribute("aria-pressed")).toBe("false");
    flushSync(() => upvote()!.click());
    await vi.waitFor(() => expect(upvote()?.getAttribute("aria-pressed")).toBe("true"));
    expect(upvote()?.textContent).toBe("3");
    expect(mocks.vote).toHaveBeenCalledWith("company-1", entry.id);
    expect(window.location.search).toBe("");
    flushSync(() => upvote()!.click());
    await vi.waitFor(() => expect(upvote()?.getAttribute("aria-pressed")).toBe("false"));
    expect(upvote()?.textContent).toBe("2");
    expect(mocks.removeVote).toHaveBeenCalledWith("company-1", entry.id);

    flushSync(() => root.unmount());
    window.history.replaceState(null, "", "/TES/activity/commentary?sort=votes&kind=complaint");
    root = createRoot(container);
    render();
    await vi.waitFor(() => expect(mocks.list).toHaveBeenLastCalledWith("company-1", expect.objectContaining({ sort: "votes", kind: "complaint", offset: 0 }), expect.anything()));
    expect(container.querySelector('[aria-label="Sort messages"]')?.textContent).toContain("Most votes");
  });

  it("keeps a saved vote when an older list read finishes after it", async () => {
    render();
    const upvote = () => container.querySelector<HTMLButtonElement>('li button[aria-pressed]');
    await vi.waitFor(() => expect(upvote()?.textContent).toBe("2"));
    let finishStaleRead: (value: unknown) => void = () => {};
    mocks.list.mockImplementationOnce(() => new Promise((resolve) => { finishStaleRead = resolve; }));
    void client.invalidateQueries();
    await vi.waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2));
    flushSync(() => upvote()!.click());
    await vi.waitFor(() => expect(upvote()?.getAttribute("aria-pressed")).toBe("true"));
    finishStaleRead({ items: [entry], total: 51, limit: 50, offset: 0 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(upvote()?.getAttribute("aria-pressed")).toBe("true");
    expect(upvote()?.textContent).toBe("3");
  });

  it("marks cached most-votes pages stale after a vote in newest order", async () => {
    const votesKey = ["agent-commentary", "company-1", "list", { sort: "votes", offset: 0, limit: 50 }];
    client.setQueryData(votesKey, { items: [entry], total: 1, limit: 50, offset: 0 });
    render();
    const upvote = () => container.querySelector<HTMLButtonElement>('li button[aria-pressed]');
    await vi.waitFor(() => expect(upvote()?.textContent).toBe("2"));
    flushSync(() => upvote()!.click());
    await vi.waitFor(() => expect(client.getQueryState(votesKey)?.isInvalidated).toBe(true));
  });

  it("shows vote counts to viewers without letting them vote", async () => {
    access.getCurrentBoardAccess.mockResolvedValue(boardAccess("viewer"));
    render();
    const upvote = () => container.querySelector<HTMLButtonElement>('li button[aria-pressed]');
    await vi.waitFor(() => expect(upvote()?.disabled).toBe(true));
    expect(upvote()?.textContent).toBe("2");
    expect(upvote()?.title).toBe("Viewers can see votes but cannot vote");
  });

  it("finishes opening a message when a vote completes during its first load", async () => {
    render();
    const upvote = () => container.querySelector<HTMLButtonElement>('li button[aria-pressed]');
    await vi.waitFor(() => expect(upvote()?.textContent).toBe("2"));
    let finishVote: (value: unknown) => void = () => {};
    let finishRead: (value: unknown) => void = () => {};
    mocks.vote.mockImplementationOnce(() => new Promise((resolve) => { finishVote = resolve; }));
    mocks.get.mockImplementationOnce(() => new Promise((resolve) => { finishRead = resolve; }));
    mocks.get.mockResolvedValue({ ...entry, voteCount: 3, votedByMe: true });
    flushSync(() => upvote()!.click());
    flushSync(() => container.querySelector<HTMLButtonElement>('[aria-label="Read suggestion from Writer"]')!.click());
    await vi.waitFor(() => expect(mocks.get).toHaveBeenCalled());
    finishVote({ id: entry.id, voteCount: 3, votedByMe: true });
    await vi.waitFor(() => expect(upvote()?.getAttribute("aria-pressed")).toBe("true"));
    finishRead(entry);
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')?.textContent).toContain(entry.body));
    const dialogUpvote = document.querySelector<HTMLButtonElement>('[role="dialog"] button[aria-pressed]');
    expect(dialogUpvote?.getAttribute("aria-pressed")).toBe("true");
    expect(dialogUpvote?.textContent).toBe("3");
  });
});
