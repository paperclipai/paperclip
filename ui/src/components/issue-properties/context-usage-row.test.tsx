// @vitest-environment jsdom
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ getContextUsage: vi.fn(), compactContext: vi.fn() }));
vi.mock("@/api/issues", () => ({ issuesApi: { getContextUsage: api.getContextUsage, compactContext: api.compactContext } }));
import { ApiError } from "@/api/api-error";
import { IssueContextUsageRow } from "./context-usage-row";

async function settle() {
  for (let i = 0; i < 8; i++) { await new Promise(resolve => setTimeout(resolve, 0)); flushSync(() => {}); }
}

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
beforeEach(() => {
  vi.resetAllMocks();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => {
  flushSync(() => root.unmount());
  client.clear();
  document.body.innerHTML = "";
});

function render(assigneeAgentId: string | null = "agent-1", issueStatus = "in_progress") {
  flushSync(() => root.render(
    <QueryClientProvider client={client}>
      <IssueContextUsageRow issueId="issue-1" assigneeAgentId={assigneeAgentId} issueStatus={issueStatus} hasActiveRun={false} />
    </QueryClientProvider>,
  ));
}

const reading = {
  runId: "run-1", agentId: "agent-1", sessionId: "session-1", usedTokens: 26_672, windowTokens: 258_400,
  observedAt: new Date().toISOString(), totals: null, costUsd: null, compactions: 0,
};

describe("IssueContextUsageRow", () => {
  it("stays hidden until the session reports a context window", async () => {
    api.getContextUsage.mockResolvedValue(null);
    render(); await settle();
    expect(container.textContent).toBe("");
  });

  it("shows the reading", async () => {
    api.getContextUsage.mockResolvedValue(reading);
    render(); await settle();
    expect(container.textContent).toContain("10%");
    expect(container.textContent).toContain("of 258k");
  });

  it("shows a failed request with a retry that recovers", async () => {
    api.getContextUsage
      .mockRejectedValueOnce(new ApiError("Internal error", 500, { error: "internal" }))
      .mockResolvedValue(reading);
    render(); await settle();
    const retry = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Retry"));
    expect(retry).toBeTruthy();
    retry!.click(); await settle();
    expect(container.textContent).toContain("10%");
  });

  it("drops the previous assignee's reading after an idle reassignment", async () => {
    api.getContextUsage.mockResolvedValueOnce(reading).mockResolvedValueOnce(null);
    render("agent-1"); await settle();
    expect(container.textContent).toContain("10%");
    render("agent-2"); await settle();
    expect(api.getContextUsage).toHaveBeenCalledTimes(2);
    expect(container.textContent).toBe("");
  });

  function openCard() {
    const trigger = container.querySelector<HTMLButtonElement>("[data-testid=context-usage-meter]");
    expect(trigger).toBeTruthy();
    flushSync(() => trigger!.click());
    return document.body.querySelector<HTMLButtonElement>("[data-testid=context-usage-compact]");
  }

  it("asks the agent to compact from the hover card", async () => {
    api.getContextUsage.mockResolvedValue({ ...reading, compaction: { status: "available", reasonCode: null, reason: null } });
    api.compactContext.mockReturnValue(new Promise(() => {}));
    render(); await settle();
    const button = openCard();
    expect(button?.textContent).toContain("Compact now");
    expect(button?.disabled).toBe(false);
    flushSync(() => button!.click()); await settle();
    expect(api.compactContext).toHaveBeenCalledWith("issue-1");
    expect(document.body.querySelector("[data-testid=context-usage-compact]")?.textContent).toContain("Compacting…");
  });

  it("explains why compaction is unavailable", async () => {
    api.getContextUsage.mockResolvedValue({
      ...reading,
      compaction: { status: "unavailable", reasonCode: "agent_busy", reason: "Available when the agent finishes its current run." },
    });
    render(); await settle();
    const button = openCard();
    expect(button?.disabled).toBe(true);
    expect(document.body.textContent).toContain("Available when the agent finishes its current run.");
  });

  it("refreshes Compact now when the task status changes", async () => {
    api.getContextUsage
      .mockResolvedValueOnce({ ...reading, compaction: { status: "available", reasonCode: null, reason: null } })
      .mockResolvedValue({ ...reading, compaction: { status: "unavailable", reasonCode: "task_closed", reason: "Available while the task is open." } });
    render("agent-1", "in_progress"); await settle();
    render("agent-1", "done"); await settle();
    expect(api.getContextUsage).toHaveBeenCalledTimes(2);
    expect(openCard()?.disabled).toBe(true);
  });

  it("shows a compaction already in progress", async () => {
    api.getContextUsage.mockResolvedValue({ ...reading, compaction: { status: "pending", reasonCode: null, reason: null, runId: "run-2" } });
    render(); await settle();
    const button = openCard();
    expect(button?.disabled).toBe(true);
    expect(button?.textContent).toContain("Compacting…");
  });

  it("keeps the last reading when a refresh fails", async () => {
    api.getContextUsage.mockResolvedValueOnce(reading).mockRejectedValue(new ApiError("Internal error", 500, { error: "internal" }));
    render(); await settle();
    await client.refetchQueries(); await settle();
    expect(container.textContent).toContain("10%");
  });
});
