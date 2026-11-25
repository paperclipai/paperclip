// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent, AttentionItem } from "@paperclipai/shared";
import { ApiError } from "@/api/api-error";
import { ThemeProvider } from "@/context/ThemeContext";
import { ANALYTICS_MASK_CLASS } from "@/lib/analytics/privacy";
import { queryKeys } from "@/lib/queryKeys";
import { BlockedTaskCardBody } from "./NeedsYouCardBodies";

const issues = vi.hoisted(() => ({ get: vi.fn(async (..._args: unknown[]): Promise<unknown> => ({ blocks: [] })) }));
vi.mock("@/api/issues", () => ({ issuesApi: { get: issues.get } }));
vi.mock("@/context/CompanyContext", () => {
  const company = { selectedCompanyId: "company", companies: [] };
  return { useCompany: () => company, useOptionalCompany: () => company };
});

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
  async function renderCard(detail: Record<string, unknown>, cachedIssue?: unknown) {
    const item = {
      id: "owner", sourceKind: "blocker_attention", inlineResolvable: false, whyNow: "Merge the prep branch, or say to build on it",
      subject: { id: "task-3", kind: "issue", identifier: "PAP-3", title: "Second stage", href: "/PAP/issues/PAP-3", status: "blocked", metadata: { assigneeAgentId: "agent-eng" } },
      relatedIssue: null,
      detail: { kind: "blocker", blockingIssue: null, unblockAction: "Merge the prep branch, or say to build on it", heldUpTasks: [], heldUpDirectCount: 0, heldUpTotalCount: 0, images: [], ...detail },
    } as unknown as AttentionItem;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    if (cachedIssue) client.setQueryData(queryKeys.issues.detail("task-3"), cachedIssue);
    await act(async () => root.render(
      <QueryClientProvider client={client}><ThemeProvider><MemoryRouter><BlockedTaskCardBody item={item} companyId="company" agentMap={agentMap} /></MemoryRouter></ThemeProvider></QueryClientProvider>,
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

  it("renders the ask as Markdown, so its links and lists work", async () => {
    const card = await renderCard({ unblockAction: "Pick one:\n\n- Merge [the prep branch](https://example.com/pr/1)\n- Say to build on it" });
    const ask = card.querySelector("[data-unblock-ask]");
    expect(ask?.querySelector("a")?.getAttribute("href")).toBe("https://example.com/pr/1");
    expect(Array.from(ask?.querySelectorAll("li") ?? [], (item) => item.textContent)).toEqual(["Merge the prep branch", "Say to build on it"]);
    expect(ask?.textContent).not.toContain("](");
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

  it("keeps the cached held-up list and says so when refreshing it fails", async () => {
    issues.get.mockRejectedValueOnce(new ApiError("Not found", 404, { error: "not_found" }));
    const cached = { blocks: [heldUpTask(4), { ...heldUpTask(8), status: "todo", priority: "high" }].map((task) => ({ priority: "medium", ...task })) };
    const card = await renderCard({ heldUpTasks: [heldUpTask(4), heldUpTask(8), heldUpTask(9)], heldUpDirectCount: 10, heldUpTotalCount: 10 }, cached);
    await act(async () => card.querySelector<HTMLButtonElement>("[data-unblock-held-up-more]")!.click());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const list = document.body.querySelector<HTMLElement>("[data-unblock-held-up-list]")!;
    expect(list, "held-up list").toBeTruthy();
    // The cached rows stay, and the failed refresh is shown next to them.
    expect([...list.querySelectorAll("[data-unblock-held-up-row]")].map((row) => visibleText(row))).toEqual(["PAP-8Follow-up 8", "PAP-4Follow-up 4"]);
    expect(list.querySelector('[role="alert"]')?.textContent).toMatch(/^Couldn't refresh this list, so it may be out of date\. /);
  });

  it("counts what the list loaded, even when nothing is held up any more", async () => {
    issues.get.mockResolvedValueOnce({ blocks: [{ ...heldUpTask(4), status: "done", priority: "medium" }] });
    const card = await renderCard({ heldUpTasks: [heldUpTask(4), heldUpTask(8), heldUpTask(9)], heldUpDirectCount: 10, heldUpTotalCount: 10 });
    await act(async () => card.querySelector<HTMLButtonElement>("[data-unblock-held-up-more]")!.click());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const list = document.body.querySelector<HTMLElement>("[data-unblock-held-up-list]")!;
    expect(list.querySelector("[data-unblock-held-up-heading]")?.textContent).toBe("PAP-3 holds up 0 tasks");
    expect(list.querySelectorAll("[data-unblock-held-up-row]")).toHaveLength(0);
    expect(list.textContent).toContain("None of them are open now.");
  });

  it("keeps the ask, task titles and the held-up list out of session replay", async () => {
    issues.get.mockResolvedValueOnce({ blocks: [{ ...heldUpTask(4), priority: "medium" }] });
    const card = await renderCard({ heldUpTasks: [heldUpTask(4), heldUpTask(8), heldUpTask(9)], heldUpDirectCount: 10, heldUpTotalCount: 10,
      blockingIssue: { id: "task-2", identifier: "PAP-2", title: "Prep", status: "in_progress" } });
    const maskSelector = ANALYTICS_MASK_CLASS.split(" ").map((name) => `.${name}`).join("");
    const masked = (element: Element | null) => Boolean(element?.closest(maskSelector));
    expect(masked(card.querySelector("[data-unblock-ask]")), "ask").toBe(true);
    expect(masked(card.querySelector("[data-unblock-ask-context]")), "asked-by line").toBe(true);
    expect(masked(card.querySelector("[data-unblock-waiting-on]")), "waiting-on row").toBe(true);
    await act(async () => card.querySelector<HTMLButtonElement>("[data-unblock-held-up-more]")!.click());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(masked(document.body.querySelector("[data-unblock-held-up-list]")), "held-up list").toBe(true);
  });

  it("lists hundreds of held-up tasks and sorts them once per load", async () => {
    const size = 300;
    let priorityReads = 0;
    const blocks = Array.from({ length: size }, (_, n) => {
      const entry = { ...heldUpTask(n + 10), status: n % 5 === 0 ? "done" : "todo" };
      // Only the sort reads priority; fail at once if a re-render sorts the list again.
      Object.defineProperty(entry, "priority", { get: () => { priorityReads += 1; if (priorityReads > size) throw new Error(`sorted again: ${priorityReads} priority reads`); return "medium"; } });
      return entry;
    });
    issues.get.mockResolvedValueOnce({ blocks });
    const card = await renderCard({ heldUpTasks: [heldUpTask(10), heldUpTask(11), heldUpTask(12)], heldUpDirectCount: size, heldUpTotalCount: size });
    await act(async () => card.querySelector<HTMLButtonElement>("[data-unblock-held-up-more]")!.click());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const list = document.body.querySelector<HTMLElement>("[data-unblock-held-up-list]")!;
    const open = size - size / 5;
    expect(list.querySelectorAll("[data-unblock-held-up-row]")).toHaveLength(open);
    expect(list.querySelector("[data-unblock-held-up-heading]")?.textContent).toBe(`PAP-3 holds up ${open} tasks`);
    expect(priorityReads).toBeLessThanOrEqual(size);
  });
});

