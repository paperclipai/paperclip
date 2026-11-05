// @vitest-environment jsdom
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ getContextUsage: vi.fn() }));
vi.mock("@/api/issues", () => ({ issuesApi: { getContextUsage: api.getContextUsage } }));
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

function render(assigneeAgentId: string | null = "agent-1") {
  flushSync(() => root.render(
    <QueryClientProvider client={client}>
      <IssueContextUsageRow issueId="issue-1" assigneeAgentId={assigneeAgentId} hasActiveRun={false} />
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

  it("keeps the last reading when a refresh fails", async () => {
    api.getContextUsage.mockResolvedValueOnce(reading).mockRejectedValue(new ApiError("Internal error", 500, { error: "internal" }));
    render(); await settle();
    await client.refetchQueries(); await settle();
    expect(container.textContent).toContain("10%");
  });
});
