// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CompanyArtifact, Issue } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AgentArtifactsPanel, AgentTasksPanel, sortAgentTasks } from "./AgentWorkPanels";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({
  issuesList: vi.fn(),
  artifactsList: vi.fn(),
}));

vi.mock("@/api/issues", () => ({ issuesApi: { list: api.issuesList } }));
vi.mock("@/api/artifacts", () => ({ artifactsApi: { list: api.artifactsList } }));
vi.mock("@/api/projects", () => ({ projectsApi: { list: async () => [] } }));
vi.mock("@/components/IssueFiltersPopover", () => ({ IssueFiltersPopover: () => <button type="button">Filters</button> }));
vi.mock("@/lib/router", () => ({
  Link: ({ to, children, className, target, rel }: { to: string; children: ReactNode; className?: string; target?: string; rel?: string }) =>
    <a href={to} className={className} target={target} rel={rel}>{children}</a>,
}));

function task(overrides: Partial<Issue>): Issue {
  return {
    id: "task",
    identifier: "PAP-1",
    title: "Task",
    status: "todo",
    priority: "medium",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  } as Issue;
}

function artifact(overrides: Partial<CompanyArtifact>): CompanyArtifact {
  return {
    id: "artifact",
    source: "document",
    mediaKind: "document",
    title: "report.md",
    issue: { id: "issue-1", identifier: "PAP-9", title: "Issue" },
    createdByAgent: { id: "agent-1", name: "CEO" },
    updatedAt: "2026-09-30T00:00:00.000Z",
    href: "/PAP/issues/PAP-9#document-report",
    ...overrides,
  } as CompanyArtifact;
}

describe("agent work panels", () => {
  let root: Root;
  let container: HTMLDivElement;
  let queryClient: QueryClient;

  beforeEach(() => {
    api.issuesList.mockReset();
    api.artifactsList.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  afterEach(() => {
    act(() => root.unmount());
    queryClient.clear();
    container.remove();
  });

  async function render(node: ReactNode) {
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>{node}</TooltipProvider>
        </QueryClientProvider>,
      );
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }

  it("lists the agent's tasks newest first as linked cards, without the chat itself", async () => {
    api.issuesList.mockResolvedValue([
      task({ id: "old", identifier: "PAP-1", title: "Older task", updatedAt: new Date("2026-09-01T00:00:00.000Z") }),
      task({ id: "chat", identifier: "PAP-2", title: "The conversation" }),
      task({ id: "new", identifier: "PAP-3", title: "Newer task", status: "in_progress", updatedAt: new Date("2026-09-20T00:00:00.000Z") }),
    ]);
    await render(<AgentTasksPanel companyId="company-1" agentId="agent-1" excludeIssueId="chat" />);

    expect(api.issuesList).toHaveBeenCalledWith("company-1", expect.objectContaining({ participantAgentId: "agent-1" }));
    const cards = Array.from(container.querySelectorAll("a"));
    expect(cards.map((card) => card.getAttribute("href"))).toEqual(["/issues/PAP-3", "/issues/PAP-1"]);
    expect(cards.every((card) => card.getAttribute("target") === "_blank")).toBe(true);
    expect(cards[0]?.textContent).toContain("Newer task");
    expect(cards[0]?.textContent).toContain("PAP-3");
    expect(container.querySelector("time")).not.toBeNull();
    expect(container.textContent).not.toContain("The conversation");
  });

  it("sorts by status and title on request", () => {
    const tasks = [
      task({ id: "a", title: "Bravo", status: "done" }),
      task({ id: "b", title: "Alpha", status: "in_progress" }),
    ];
    expect(sortAgentTasks(tasks, "status", "asc").map((item) => item.id)).toEqual(["b", "a"]);
    expect(sortAgentTasks(tasks, "title", "asc").map((item) => item.id)).toEqual(["b", "a"]);
  });

  it("asks the server for the agent's artifacts and shows filename, date and task id", async () => {
    api.artifactsList.mockResolvedValue({
      artifacts: [artifact({ id: "mine", title: "plan.md" })],
      nextCursor: null,
    });
    await render(<AgentArtifactsPanel companyId="company-1" agentId="agent-1" />);

    expect(api.artifactsList).toHaveBeenCalledWith("company-1", expect.objectContaining({ agentId: "agent-1" }));
    const cards = Array.from(container.querySelectorAll("a"));
    expect(cards).toHaveLength(1);
    expect(cards[0]?.getAttribute("href")).toBe("/PAP/issues/PAP-9#document-report");
    expect(cards[0]?.getAttribute("target")).toBe("_blank");
    expect(cards[0]?.textContent).toContain("plan.md");
    expect(cards[0]?.textContent).toContain("PAP-9");
    expect(cards[0]?.textContent).toContain("Updated");
  });
});
