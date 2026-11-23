// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent, AttentionItem } from "@paperclipai/shared";
import { BlockedTaskCardBody } from "./NeedsYouCardBodies";

vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company", companies: [] }) }));

/** The "Unblock a task" card when the assignee asked a person for something. */
describe("human unblock card", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => { container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container); });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

  const agentMap: ReadonlyMap<string, Agent> = new Map([["agent-eng", { id: "agent-eng", name: "Engineer" } as Agent]]);
  const heldUpTask = (n: number) => ({ id: `task-${n}`, identifier: `PAP-${n}`, title: `Follow-up ${n}`, status: "blocked" });
  /** What a sighted reader sees: the text without screen-reader labels or icon tooltips. */
  const visibleText = (element: Element | null) => {
    if (!element) return null;
    const copy = element.cloneNode(true) as Element;
    copy.querySelectorAll(".sr-only, svg title").forEach((entry) => entry.remove());
    return copy.textContent;
  };
  async function renderCard(detail: Record<string, unknown>) {
    const item = {
      id: "owner", sourceKind: "blocker_attention", inlineResolvable: false, whyNow: "Merge the prep branch, or say to build on it",
      subject: { id: "task-3", kind: "issue", identifier: "PAP-3", title: "Second stage", href: "/PAP/issues/PAP-3", status: "blocked", metadata: { assigneeAgentId: "agent-eng" } },
      relatedIssue: null,
      detail: { kind: "blocker", blockingIssue: null, unblockAction: "Merge the prep branch, or say to build on it", heldUpTasks: [], heldUpDirectCount: 0, heldUpTotalCount: 0, images: [], ...detail },
    } as unknown as AttentionItem;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => root.render(
      <QueryClientProvider client={client}><MemoryRouter><BlockedTaskCardBody item={item} companyId="company" agentMap={agentMap} /></MemoryRouter></QueryClientProvider>,
    ));
    return container;
  }
  const footerActions = (card: Element) => [...card.querySelectorAll("[data-decision-footer] button, [data-decision-footer] a")].map((entry) => entry.textContent);

  it("leads with what is needed, says who asked where, names what it holds up, and replies in the task", async () => {
    const card = await renderCard({ heldUpTasks: [heldUpTask(4), heldUpTask(8)], heldUpDirectCount: 2, heldUpTotalCount: 2 });
    expect(card.querySelector("[data-unblock-ask]")?.textContent).toBe("Needed from you: Merge the prep branch, or say to build on it");
    const context = card.querySelector<HTMLElement>("[data-unblock-ask-context]")!;
    expect(visibleText(context)).toBe("Asked by Engineer in PAP-3 · holds up PAP-4 and PAP-8");
    // The app's task chip: status icon and ID, the title on hover, a link to the task.
    expect([...context.querySelectorAll("a")].map((link) => [visibleText(link), link.getAttribute("href"), link.getAttribute("title")])).toEqual([
      ["PAP-3", "/issues/PAP-3", "Second stage"],
      ["PAP-4", "/issues/PAP-4", "Follow-up 4"],
      ["PAP-8", "/issues/PAP-8", "Follow-up 8"],
    ]);
    expect(card.textContent).not.toContain("Blocked by");
    expect(footerActions(card)).toEqual(["Reply in PAP-3"]);
  });

  it("names two held-up tasks and a count when there are more, and counts the work waiting behind them", async () => {
    const card = await renderCard({ heldUpTasks: [heldUpTask(4), heldUpTask(8), heldUpTask(9)], heldUpDirectCount: 10, heldUpTotalCount: 48 });
    expect(visibleText(card.querySelector("[data-unblock-ask-context]")))
      .toBe("Asked by Engineer in PAP-3 · holds up PAP-4, PAP-8 and 8 more · 38 more waiting behind those");
    expect(card.querySelector("[data-unblock-held-up-more]")?.textContent).toBe("8 more");
  });

  it("keeps an open blocker as the thing to open", async () => {
    const card = await renderCard({ blockingIssue: { id: "task-2", identifier: "PAP-2", title: "Prep", status: "in_progress" } });
    expect(card.querySelector("[data-unblock-waiting-on]")?.textContent).toContain("Waiting on");
    expect(card.querySelector("[data-unblock-waiting-on] a")?.getAttribute("href")).toBe("/issues/PAP-2");
    expect(footerActions(card)).toEqual(["Open blocking task"]);
  });
});
