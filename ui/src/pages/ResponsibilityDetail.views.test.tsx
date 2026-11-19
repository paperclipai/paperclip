// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  areaFundraising,
  homeAutomationFixture,
  proposedDealFlow,
  RESPONSIBILITY_DETAIL_FIXTURES,
  RESPONSIBILITY_FIXTURE_GUIDE_AGENT_ID,
  RESPONSIBILITY_FIXTURE_NOW,
  responsibilityDetailFixture,
} from "../../storybook/fixtures/responsibilities";
import { METRIC_SET_FIXTURES, statusReportFixture } from "../../storybook/fixtures/responsibility-metrics";
import { ResponsibilityDetail } from "./ResponsibilityDetail";

const mocks = vi.hoisted(() => ({
  responsibilityId: "resp-fundraising",
  search: "",
  api: { get: vi.fn(), update: vi.fn(), unlink: vi.fn(), remove: vi.fn(), link: vi.fn(), summary: vi.fn(), automation: vi.fn(), statusReport: vi.fn(), requestStatusUpdate: vi.fn() },
  suggestions: { accept: vi.fn(), decline: vi.fn(), repeatAsRoutine: vi.fn() },
  conversations: { start: vi.fn() },
  navigate: vi.fn(),
  areas: { list: vi.fn() },
  agents: { list: vi.fn() },
  activity: { list: vi.fn() },
  auth: { getSession: vi.fn() },
  settings: { getExperimental: vi.fn() },
  metrics: { metrics: vi.fn(), removeMetric: vi.fn() },
}));
vi.mock("@/api/responsibilities", () => ({ responsibilitiesApi: mocks.api, responsibilityAreasApi: mocks.areas }));
vi.mock("@/api/agents", () => ({ agentsApi: mocks.agents }));
vi.mock("@/api/routine-suggestions", () => ({ routineSuggestionsApi: mocks.suggestions }));
vi.mock("@/api/automation-conversations", () => ({ automationConversationsApi: mocks.conversations }));
vi.mock("@/api/activity", () => ({ activityApi: mocks.activity }));
vi.mock("@/api/auth", () => ({ authApi: mocks.auth }));
vi.mock("@/api/instanceSettings", () => ({ instanceSettingsApi: mocks.settings }));
vi.mock("@/api/responsibility-metrics", () => ({ responsibilityMetricsApi: mocks.metrics }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-storybook" }) }));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));
vi.mock("@/components/InlineEditor", () => ({
  InlineEditor: ({ value, as: Tag = "p", placeholder }: { value: string; as?: "h1" | "p"; placeholder?: string }) => (
    <Tag data-inline-editor>{value || placeholder}</Tag>
  ),
}));
vi.mock("@/lib/router", () => ({
  Link: ({ to, children, disableIssueQuicklook: _skip, ...props }: { to: string; children: ReactNode; disableIssueQuicklook?: boolean }) => (
    <a href={to} {...props}>{children}</a>
  ),
  useNavigate: () => mocks.navigate,
  useParams: () => ({ responsibilityId: mocks.responsibilityId }),
  useLocation: () => ({ pathname: "/responsibilities", search: mocks.search, hash: "", state: null, key: "default" }),
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
let client: QueryClient;
const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const view = () => host.querySelector("[data-responsibility-view]")?.getAttribute("data-responsibility-view") ?? "full";
const proposedDetail = responsibilityDetailFixture(proposedDealFlow);

async function render(id = "resp-fundraising") {
  mocks.responsibilityId = id;
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <TooltipProvider>
          <ResponsibilityDetail />
        </TooltipProvider>
      </QueryClientProvider>,
    );
  });
  await flush();
  await flush();
}

async function remount(id?: string) {
  await act(async () => root.unmount());
  root = createRoot(host);
  await render(id);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(RESPONSIBILITY_FIXTURE_NOW);
  vi.clearAllMocks();
  localStorage.clear();
  mocks.search = "";
  mocks.api.get.mockImplementation(async (id: string) => (id === proposedDetail.id ? proposedDetail : RESPONSIBILITY_DETAIL_FIXTURES[id]));
  mocks.areas.list.mockResolvedValue([areaFundraising]);
  mocks.api.automation.mockResolvedValue(homeAutomationFixture);
  mocks.api.summary.mockResolvedValue({
    text: "Two things are holding the number back: the investor update deck is late and the cap table task is blocked.",
    source: "computed",
    generatedAt: RESPONSIBILITY_FIXTURE_NOW.toISOString(),
    refreshing: false,
  });
  mocks.agents.list.mockResolvedValue([
    { id: "agent-codex", companyId: "company-storybook", name: "CodexCoder", status: "idle" },
    { id: RESPONSIBILITY_FIXTURE_GUIDE_AGENT_ID, companyId: "company-storybook", name: "CTO", status: "idle" },
  ]);
  mocks.activity.list.mockResolvedValue([]);
  mocks.auth.getSession.mockResolvedValue({ user: { id: "user-storybook" } });
  mocks.settings.getExperimental.mockResolvedValue({ enableArtifactsV1: false, managedKeys: { enableArtifactsV1: true } });
  mocks.metrics.metrics.mockRejectedValue(new Error("Not found"));
  mocks.api.statusReport.mockRejectedValue(new Error("Not found"));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  client.clear();
  vi.useRealTimers();
});

describe("ResponsibilityDetail views", () => {
  it("is One screen v2, with no switch between views", async () => {
    await render();
    expect(view()).toBe("one_screen_v2");
    expect(host.querySelector('[role="radiogroup"][aria-label="Responsibility view"]')).toBeNull();
    expect(host.querySelector("[data-responsibility-back]")).toBeNull();
  });

  it("ignores a choice an earlier build remembered, and an address naming no view", async () => {
    localStorage.setItem("paperclip:responsibilities:page-view", "scorecard");
    mocks.search = "?view=timeline";
    await render();
    expect(view()).toBe("one_screen_v2");
  });

  it("shows an earlier exploration only while the address names it", async () => {
    mocks.search = "?view=full";
    await render();
    expect(view()).toBe("full");
    expect(host.querySelector("#responsibility-bar")).not.toBeNull();
    mocks.search = "?view=scorecard";
    await remount("resp-portfolio");
    expect(view()).toBe("scorecard");
    expect(host.querySelector("#responsibility-bar")).toBeNull();
    expect(host.querySelector("h1")?.textContent).toBe("Founder support");

    // Nothing was remembered.
    mocks.search = "";
    await remount();
    expect(view()).toBe("one_screen_v2");
    expect(localStorage.getItem("paperclip:responsibilities:page-view")).toBeNull();
  });

  it("Scorecard: the number against its target, the status, and three counts with one exception each", async () => {
    mocks.search = "?view=scorecard";
    await render();
    const card = host.querySelector<HTMLElement>('[data-responsibility-view="scorecard"]')!;
    expect(card.querySelector("#responsibility-score")?.textContent).toContain("9of 20");
    expect(card.textContent).toContain("9 of 20 investors contacted, 45% of target");
    const counts = Object.fromEntries(
      [...card.querySelectorAll("[data-count]")].map((cell) => [cell.getAttribute("data-count"), cell.textContent]),
    );
    expect(counts).toEqual({
      projects: "Projects21 late",
      tasks: "Tasks41 blocked, 2 with agents",
      routines: "Routines1None failed or paused",
      skills: "Skills 2Investor research, Deck builder",
      artifacts: "Artifacts 63Newest: November investor update",
    });
    expect(card.textContent).not.toContain("Get the cap table from counsel");
    expect(card.querySelectorAll("button")).toHaveLength(0);
  });

  it("What's moving: the summary attention first, then one list of the work, attention first, each marked with its kind", async () => {
    mocks.search = "?view=moving";
    await render();
    const page = host.querySelector<HTMLElement>('[data-responsibility-view="moving"]')!;
    expect(page.querySelector('[data-signal-group="attention"]')?.textContent).toContain("Investor update deck is 3 days past its target date");
    expect(page.querySelector('[data-signal-group="moving"]')?.textContent).toContain("2 open tasks with CodexCoder");
    const rows = [...page.querySelectorAll<HTMLElement>("li[data-work-id]")];
    expect(rows.map((row) => [row.getAttribute("data-work-kind"), row.getAttribute("data-work-id"), row.hasAttribute("data-attention")])).toEqual([
      ["project", "project-deck", true],
      ["task", "task-blocked", true],
      ["project", "project-pipeline", false],
      ["task", "task-draft", false],
      ["task", "task-intro", false],
      ["routine", "routine-weekly", false],
    ]);
    expect(rows[0]!.textContent).toBe("ProjectInvestor update deckLate · Nov 10");
    expect(rows[1]!.querySelector("a")?.getAttribute("href")).toBe("/issues/PAP-41");
    expect(page.textContent).toContain("1 finished item is not listed.");
    expect(page.querySelector('[data-testid="responsibility-strip"]')?.querySelectorAll("li")).toHaveLength(4);
    expect(page.textContent).toContain("And 61 more artifacts.");
  });

  it("One screen: the bar beside short capped lists of the work, each item marked with how it bears on the number", async () => {
    mocks.search = "?view=one_screen";
    await render();
    await flush();
    const page = host.querySelector<HTMLElement>('[data-responsibility-view="one_screen"]')!;
    const bar = page.querySelector<HTMLElement>("#responsibility-bar-summary")!;
    expect(bar.textContent).toContain(RESPONSIBILITY_DETAIL_FIXTURES["resp-fundraising"]!.standard!);
    const affecting = bar.querySelector<HTMLElement>("[data-affecting-summary]")!;
    expect(affecting.querySelector("h3")?.textContent).toBe("What is affecting the number");
    expect(affecting.textContent).toContain("the cap table task is blocked");
    expect(affecting.textContent).toContain("Summarized from the numbers");

    expect(page.querySelector("[data-bearing-key]")?.textContent).toBe("Holding the number backMoving it");
    const rows = (kind: string) =>
      [...page.querySelectorAll<HTMLElement>(`[data-work-list="${kind}"] li[data-work-id]`)].map((row) => [
        row.getAttribute("data-work-id"),
        row.getAttribute("data-bearing"),
        row.querySelector("[data-bearing-reason]")?.textContent,
      ]);
    expect(rows("project")).toEqual([
      ["project-deck", "holding", "Holding the number back: 3 days late (due Nov 10)"],
      ["project-pipeline", "neutral", "Not started, due Dec 15"],
    ]);
    const tasks = page.querySelector<HTMLElement>('[data-work-list="task"]')!;
    expect(tasks.querySelector("h2")?.textContent).toBe("Tasks 4");
    expect(rows("task")).toEqual([
      ["task-blocked", "holding", "Holding the number back: Blocked"],
      ["task-draft", "moving", "Moving the number: In progress with CodexCoder"],
      ["task-intro", "neutral", "With you"],
    ]);
    expect(tasks.textContent).toContain("and 1 more");
    expect(rows("routine")).toEqual([
      ["routine-weekly", "moving", "Moving the number: Active, last run succeeded on 2026-11-10, next run 2026-11-17"],
    ]);
  });

  it("One screen: routines and skills first, then projects and tasks, then artifacts, as lists and cards", async () => {
    mocks.search = "?view=one_screen";
    await render();
    await flush();
    const column = host.querySelector<HTMLElement>("[data-work-order]")!;
    const order = [...column.querySelectorAll<HTMLElement>("[data-work-list], [data-card-list]")]
      .map((node) => node.dataset.workList ?? `${node.dataset.cardList} cards`);
    expect(order).toEqual(["routine", "skill cards", "project", "task", "artifact cards"]);
    expect(column.querySelectorAll('[data-testid="responsibility-skill-cards"] [data-slot="card"]')).toHaveLength(2);
    const artifacts = column.querySelector<HTMLElement>('[data-card-list="artifact"]')!;
    expect(artifacts.querySelector("h2")?.textContent).toBe("Artifacts 63");
    expect(artifacts.querySelectorAll("li")).toHaveLength(3);
    expect(artifacts.textContent).toContain("and 60 more artifacts");
  });

  it("One screen: the bar's metrics stacked in their forms, with the agent's written status leading", async () => {
    mocks.metrics.metrics.mockResolvedValue(METRIC_SET_FIXTURES.chosen);
    mocks.api.statusReport.mockResolvedValue(statusReportFixture());
    mocks.search = "?view=one_screen";
    await render();
    await flush();
    const bar = host.querySelector<HTMLElement>("#responsibility-bar-summary")!;
    expect([...bar.querySelectorAll<HTMLElement>("[data-metric-key]")].map((tile) => tile.dataset.metricDisplay)).toEqual(["line", "bar", "percent"]);
    expect(bar.querySelector('[data-metric-layout="stack"]')).not.toBeNull();
    const lead = bar.querySelector<HTMLElement>("[data-agent-status]")!;
    expect(lead.textContent).toContain("replies are slipping");
    expect(lead.compareDocumentPosition(bar.querySelector("[data-bar-metrics]")!) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  });

  it("One screen: without the metric set or a written status, the bar looks as before", async () => {
    mocks.search = "?view=one_screen";
    await render();
    await flush();
    const bar = host.querySelector<HTMLElement>("#responsibility-bar-summary")!;
    expect(bar.querySelector("[data-metric-key]")).toBeNull();
    expect(bar.querySelector('[role="meter"]')?.getAttribute("aria-valuenow")).toBe("45");
    expect(bar.querySelector("[data-agent-status]")).toBeNull();
    expect(bar.textContent).toContain("9 of 20 investors contacted, 45% of target");
  });

  it("One screen: says how automated it is, and offers to automate each manual task with the agent or by hand, quietly", async () => {
    mocks.suggestions.repeatAsRoutine.mockResolvedValue({
      routine: { id: "routine-new", title: "Ask Dana for an intro to the lead", assigneeAgentId: "agent-codex", projectId: null, status: "active" },
      cadenceLabel: "Every Monday at 9 AM",
      timezone: "UTC",
      responsibilityIds: ["resp-fundraising"],
      acceptedOfferId: null,
    });
    mocks.search = "?view=one_screen";
    await render();
    await flush();
    const page = host.querySelector<HTMLElement>('[data-responsibility-view="one_screen"]')!;
    expect(mocks.api.automation).toHaveBeenCalledWith("company-storybook", { ownerUserId: RESPONSIBILITY_DETAIL_FIXTURES["resp-fundraising"]!.ownerUserId });
    expect(page.querySelector("#responsibility-bar-summary [data-automation-line]")?.textContent).toBe("1 automation · 5 manual tasks · 17% automated");

    // Every manual task row gets the actions; projects and routines do not.
    const actionable = [...page.querySelectorAll<HTMLElement>("li[data-work-id]")]
      .filter((row) => row.querySelector("[data-make-routine]"))
      .map((row) => row.getAttribute("data-work-id"));
    expect(actionable).toEqual(["task-blocked", "task-intro"]);
    // The row still opens the task; the actions sit beside the link, not inside it.
    const intro = page.querySelector<HTMLElement>('li[data-work-id="task-intro"]')!;
    expect(intro.querySelector("a [data-make-routine]")).toBeNull();
    expect(intro.querySelector("a [data-automate-with-agent]")).toBeNull();
    // First the conversation with the agent, then the form.
    const talk = intro.querySelector<HTMLButtonElement>("[data-automate-with-agent]")!;
    expect(talk.getAttribute("aria-label")).toBe("Automate with CodexCoder: “Ask Dana for an intro to the lead”");
    mocks.conversations.start.mockResolvedValue({
      sourceIssueId: "task-intro", state: "discussing", defaultAgentId: "agent-codex",
      conversation: { issueId: "conversation-intro", identifier: "PAP-91", title: "Automate", status: "todo", agentId: "agent-codex", createdAt: new Date() },
      proposal: null,
    });
    await act(async () => talk.click());
    await flush();
    expect(mocks.conversations.start).toHaveBeenCalledWith("task-intro", { agentId: "agent-codex", responsibilityId: "resp-fundraising" });
    expect(mocks.navigate).toHaveBeenCalledWith("/issues/PAP-91");
    const button = intro.querySelector<HTMLButtonElement>("[data-make-routine]")!;
    expect(button.getAttribute("aria-label")).toBe("Set up “Ask Dana for an intro to the lead” by hand");

    await act(async () => button.click());
    await flush();
    const dialog = document.querySelector<HTMLElement>("[data-make-routine-dialog]")!;
    expect(dialog.querySelector<HTMLInputElement>('input[aria-label="What repeats"]')?.value).toBe("Ask Dana for an intro to the lead");
    // No agent on the task: the organization's first agent runs it.
    expect(dialog.querySelector<HTMLSelectElement>('select[aria-label="Who runs it"]')?.value).toBe("agent-codex");
    expect(dialog.querySelector("[data-routine-filing-note]")?.textContent).toContain("filed under Seed extension");
    const submit = [...dialog.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent === "Make it a routine")!;
    await act(async () => submit.click());
    await flush();
    expect(mocks.suggestions.repeatAsRoutine).toHaveBeenCalledWith("task-intro", expect.objectContaining({ assigneeAgentId: "agent-codex" }));
    expect(mocks.api.automation.mock.calls.length).toBeGreaterThan(1);
  });

  it("One screen: no automation line or row actions when the automation cannot be read", async () => {
    mocks.api.automation.mockRejectedValue(new Error("down"));
    mocks.search = "?view=one_screen";
    await render();
    await flush();
    const page = host.querySelector<HTMLElement>('[data-responsibility-view="one_screen"]')!;
    expect(page.querySelector("[data-automation-line]")).toBeNull();
    expect(page.querySelector("[data-make-routine]")).toBeNull();
    expect(page.querySelectorAll('[data-work-list="task"] li[data-work-id]')).toHaveLength(3);
  });

  it("One screen: has the full page's header actions and opens the full layout's bar editor", async () => {
    mocks.search = "?view=one_screen";
    await render();
    expect(view()).toBe("one_screen");
    const actions = host.querySelector<HTMLElement>("[data-responsibility-header-actions]")!;
    expect(actions.querySelector("button")?.textContent).toBe("New task for an agent");
    expect(actions.querySelector('button[aria-label="More actions for this responsibility"]')).not.toBeNull();
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => actions.querySelector("button")!.click());
    expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain("New task for an agent");

    await remount();
    const edit = [...host.querySelectorAll<HTMLButtonElement>("#responsibility-bar-summary button")].find((button) => button.textContent === "Edit the bar")!;
    await act(async () => edit.click());
    await act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(null))); });
    await flush();
    expect(view()).toBe("full");
    expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain("Edit the bar");
    // It is a visit: "Back" is offered while the full layout shows.
    expect(host.querySelector("[data-responsibility-back]")?.textContent).toBe("Back");
  });

  it("One screen: no paragraph when the summary cannot be read", async () => {
    mocks.api.summary.mockRejectedValue(new Error("down"));
    mocks.search = "?view=one_screen";
    await render();
    await flush();
    expect(host.querySelector("[data-affecting-summary]")).toBeNull();
    expect(host.querySelector("#responsibility-bar-summary")).not.toBeNull();
  });

  it("shows the empty work in every view", async () => {
    for (const choice of ["scorecard", "moving", "one_screen"]) {
      mocks.search = `?view=${choice}`;
      await remount("resp-hiring");
      expect(view()).toBe(choice);
      expect(host.querySelector("h1")?.textContent).toBe("Hiring");
    }
    expect(host.textContent).toContain("No open tasks.");
    expect(host.textContent).toContain("No skills yet.");
    expect(host.textContent).toContain("Nothing produced yet.");
  });

  it("does not hide that it is proposed: a notice takes the person to review it", async () => {
    mocks.search = "?view=moving";
    await render(proposedDetail.id);
    const notice = host.querySelector<HTMLElement>("[data-proposals-notice]")!;
    expect(notice.textContent).toContain("This responsibility was proposed for you and is waiting for your review.");
    await act(async () => notice.querySelector("button")!.click());
    expect(view()).toBe("full");
    expect(host.textContent).toContain("Proposed for you");
    // The review is a visit: "Back" returns to where the person was.
    await act(async () => host.querySelector<HTMLButtonElement>("[data-responsibility-back]")!.click());
    expect(view()).toBe("moving");
    expect(host.querySelector("[data-responsibility-back]")).toBeNull();
  });
});
