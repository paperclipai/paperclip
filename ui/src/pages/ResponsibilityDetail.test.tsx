// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";
import { describeLinkError } from "@/components/responsibilities/AddExistingWorkPicker";
import { artifactsTruncationNote } from "@/components/responsibilities/ResponsibilitySkillsAndArtifacts";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  areaFundraising,
  areaPortfolio,
  boardReportingDetail,
  fundraisingDetail,
  hiringDetail,
  lpUpdatesDetail,
  RESPONSIBILITY_DETAIL_FIXTURES,
  RESPONSIBILITY_FIXTURE_GUIDE_AGENT_ID,
  RESPONSIBILITY_FIXTURE_NOW,
} from "../../storybook/fixtures/responsibilities";
import { METRIC_SET_FIXTURES, statusReportFixture } from "../../storybook/fixtures/responsibility-metrics";
import { ResponsibilityDetail } from "./ResponsibilityDetail";

const mocks = vi.hoisted(() => ({
  responsibilityId: "resp-fundraising",
  api: { get: vi.fn(), update: vi.fn(), unlink: vi.fn(), remove: vi.fn(), link: vi.fn(), statusReport: vi.fn(), requestStatusUpdate: vi.fn() },
  areas: { list: vi.fn() },
  agents: { list: vi.fn() },
  activity: { list: vi.fn() },
  auth: { getSession: vi.fn() },
  settings: { getExperimental: vi.fn() },
  issues: { update: vi.fn() },
  routines: { update: vi.fn() },
  projects: { update: vi.fn() },
  bars: { conversation: vi.fn(), start: vi.fn(), accept: vi.fn(), decline: vi.fn() },
  metrics: { metrics: vi.fn(), removeMetric: vi.fn() },
  navigate: vi.fn(),
}));
const breadcrumbs = vi.hoisted(() => vi.fn());
vi.mock("@/api/responsibilities", () => ({ responsibilitiesApi: mocks.api, responsibilityAreasApi: mocks.areas }));
vi.mock("@/api/agents", () => ({ agentsApi: mocks.agents }));
vi.mock("@/api/activity", () => ({ activityApi: mocks.activity }));
vi.mock("@/api/auth", () => ({ authApi: mocks.auth }));
vi.mock("@/api/instanceSettings", () => ({ instanceSettingsApi: mocks.settings }));
vi.mock("@/api/issues", () => ({ issuesApi: mocks.issues }));
vi.mock("@/api/routines", () => ({ routinesApi: mocks.routines }));
vi.mock("@/api/projects", () => ({ projectsApi: mocks.projects }));
vi.mock("@/api/responsibility-bars", () => ({ responsibilityBarsApi: mocks.bars }));
vi.mock("@/api/responsibility-metrics", () => ({ responsibilityMetricsApi: mocks.metrics }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-storybook" }) }));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: breadcrumbs }) }));
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
  useLocation: () => ({ pathname: "/responsibilities", search: "?view=full", hash: "", state: null, key: "default" }),
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
let client: QueryClient;
const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const section = (heading: string) =>
  [...host.querySelectorAll("section")].find((node) => node.querySelector("h2")?.textContent?.startsWith(heading))!;
const bar = () => host.querySelector<HTMLElement>("#responsibility-bar")!;
const buttonByText = (label: string, scope: ParentNode = host) =>
  [...scope.querySelectorAll("button")].find((button) => button.textContent?.trim() === label) as HTMLButtonElement | undefined;

function setInputValue(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

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

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(RESPONSIBILITY_FIXTURE_NOW);
  vi.clearAllMocks();
  // These tests cover the full layout, which the page shows only when the address names it.
  mocks.api.get.mockImplementation(async (id: string) => RESPONSIBILITY_DETAIL_FIXTURES[id]);
  mocks.api.unlink.mockResolvedValue({ id: "link-task-intro" });
  mocks.api.link.mockResolvedValue({ link: { id: "link-task-intro-2" } });
  mocks.api.update.mockImplementation(async (id: string, patch: Record<string, unknown>) => ({ ...RESPONSIBILITY_DETAIL_FIXTURES[id], ...patch }));
  mocks.areas.list.mockResolvedValue([areaFundraising, areaPortfolio]);
  mocks.agents.list.mockResolvedValue([
    { id: "agent-codex", companyId: "company-storybook", name: "CodexCoder", status: "idle" },
    { id: RESPONSIBILITY_FIXTURE_GUIDE_AGENT_ID, companyId: "company-storybook", name: "CTO", status: "idle" },
  ]);
  mocks.activity.list.mockResolvedValue([
    { action: "responsibility.metric_updated", actorType: "agent", actorId: "agent-codex", createdAt: "2026-11-12T08:00:00.500Z" },
  ]);
  mocks.auth.getSession.mockResolvedValue({ user: { id: "user-storybook" } });
  mocks.settings.getExperimental.mockResolvedValue({ enableArtifactsV1: false, managedKeys: { enableArtifactsV1: true } });
  // No agent can talk the bar through unless a test says so: the bar is edited by hand.
  mocks.bars.conversation.mockImplementation(async (responsibilityId: string) => ({
    responsibilityId, state: "none", defaultAgentId: null, conversation: null, proposal: null,
  }));
  // The metric set and the written status load beside the page; until a test says so they are not there.
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

describe("ResponsibilityDetail: setting the bar with an agent", () => {
  const openConversation = {
    issueId: "issue-bar-conversation", identifier: "PAP-42", title: "Edit the bar for Seed extension",
    status: "todo", agentId: RESPONSIBILITY_FIXTURE_GUIDE_AGENT_ID, createdAt: new Date("2026-11-13T10:00:00Z"),
  };

  it("talks the bar through with an agent first, and keeps editing by hand as the second way", async () => {
    mocks.bars.conversation.mockResolvedValue({
      responsibilityId: "resp-fundraising", state: "none", defaultAgentId: RESPONSIBILITY_FIXTURE_GUIDE_AGENT_ID, conversation: null, proposal: null,
    });
    mocks.bars.start.mockResolvedValue({
      responsibilityId: "resp-fundraising", state: "discussing", defaultAgentId: RESPONSIBILITY_FIXTURE_GUIDE_AGENT_ID,
      conversation: openConversation, proposal: null,
    });
    await render();
    expect(buttonByText("Edit by hand", bar())).toBeDefined();
    await act(async () => buttonByText("Edit the bar", bar())!.click());
    await flush();
    expect(mocks.bars.start).toHaveBeenCalledExactlyOnceWith("resp-fundraising");
    expect(mocks.navigate).toHaveBeenCalledWith("/issues/PAP-42");
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();

    await act(async () => buttonByText("Edit by hand", bar())!.click());
    expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain("Kind of measure");
  });

  it("shows that a bar is being discussed, with a way into the conversation", async () => {
    mocks.bars.conversation.mockResolvedValue({
      responsibilityId: "resp-fundraising", state: "discussing", defaultAgentId: RESPONSIBILITY_FIXTURE_GUIDE_AGENT_ID,
      conversation: openConversation, proposal: null,
    });
    await render();
    const notice = bar().querySelector('[data-testid="bar-conversation-open"]')!;
    expect(notice.textContent).toContain("You are talking the bar through with CTO.");
    expect(notice.querySelector("a")?.getAttribute("href")).toBe("/issues/PAP-42");
    expect(buttonByText("Continue the conversation", bar())).toBeDefined();
  });

  it("puts a waiting proposal on the page to accept in one tap", async () => {
    const { barProposalFixture } = await import("../../storybook/fixtures/responsibility-bars");
    mocks.bars.conversation.mockResolvedValue({
      responsibilityId: "resp-fundraising", state: "proposal_waiting", defaultAgentId: RESPONSIBILITY_FIXTURE_GUIDE_AGENT_ID,
      conversation: openConversation, proposal: barProposalFixture("range"),
    });
    mocks.bars.accept.mockResolvedValue({ interaction: barProposalFixture("range", { status: "accepted" }), responsibility: fundraisingDetail });
    await render();
    const card = bar().querySelector<HTMLElement>('[data-testid="bar-proposal"]')!;
    expect(card.textContent).toContain("We always have between 12 and 24 months of runway.");
    expect(card.querySelector('a[href="/issues/issue-bar-conversation"]')?.textContent).toBe("Open the conversation");
    await act(async () => buttonByText("Use this bar", card)!.click());
    await flush();
    expect(mocks.bars.accept).toHaveBeenCalledExactlyOnceWith("issue-bar-conversation", "bar-proposal-range");
  });

  it("offers the hand edit directly when no agent can hold the conversation", async () => {
    await render();
    expect(buttonByText("Edit by hand", bar())).toBeUndefined();
    await act(async () => buttonByText("Edit the bar", bar())!.click());
    expect(mocks.bars.start).not.toHaveBeenCalled();
    expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain("Edit the bar");
  });
});

describe("ResponsibilityDetail: the bar", () => {
  it("names it in the page and breadcrumbs, with its area and the agents working on it", async () => {
    await render();
    expect(host.querySelector("h1")?.textContent).toBe("Seed extension");
    expect(breadcrumbs).toHaveBeenLastCalledWith([
      { label: "Dashboard", href: "/responsibilities" },
      { label: "Seed extension" },
    ]);
    expect(host.querySelector('button[aria-label="Area: Fundraising. Move to another area"]')).not.toBeNull();
    const header = host.querySelector("header")!;
    expect(header.textContent).toContain("Agents on this");
    expect(header.textContent).toContain("CodexCoder");
    expect(header.textContent).toContain("1 task, 1 routine, leads 1 project");
    // No control hands the whole responsibility to an agent; a new task is offered instead.
    expect(header.textContent).not.toContain("Give to an agent");
    expect(header.textContent).toContain("New task for an agent");
  });

  it("gives a task, a routine or a project to an agent with each one's own call", async () => {
    mocks.issues.update.mockResolvedValue({});
    mocks.routines.update.mockResolvedValue({});
    mocks.projects.update.mockResolvedValue({});
    await render();
    const pick = async (label: string, agent: string) => {
      const trigger = host.querySelector<HTMLButtonElement>(`button[aria-label="Give ${label} to an agent"]`)!;
      await act(async () => trigger.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 })));
      const item = [...document.body.querySelectorAll('[role="menuitemradio"]')].find((candidate) => candidate.textContent === agent)!;
      await act(async () => item.dispatchEvent(new MouseEvent("click", { bubbles: true })));
      await flush();
    };
    await pick("Ask Dana for an intro to the lead", "CTO");
    expect(mocks.issues.update).toHaveBeenCalledExactlyOnceWith("task-intro", { assigneeAgentId: RESPONSIBILITY_FIXTURE_GUIDE_AGENT_ID, assigneeUserId: null });
    await pick("Weekly investor pipeline review", "CTO");
    expect(mocks.routines.update).toHaveBeenCalledExactlyOnceWith("routine-weekly", { assigneeAgentId: RESPONSIBILITY_FIXTURE_GUIDE_AGENT_ID });
    await pick("Lead investor pipeline", "CodexCoder");
    expect(mocks.projects.update).toHaveBeenCalledExactlyOnceWith("project-pipeline", { leadAgentId: "agent-codex" }, "company-storybook");
    // Done tasks are not offered.
    await act(async () => buttonByText("Show 1 done", section("Tasks"))!.click());
    expect(host.querySelector('button[aria-label="Give Send the October update to an agent"]')).toBeNull();
  });

  it("comes first: the sentence, the number against its target, who updated it, and the status", async () => {
    await render();
    const card = bar();
    expect(card.compareDocumentPosition(section("Across the work")) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(card.textContent).toContain("Twenty qualified investors contacted before the partner meeting in December.");
    expect(card.querySelector('[aria-label="9 of 20 investors contacted"]')?.textContent).toBe("9of 20");
    expect(card.querySelector('[role="meter"]')?.getAttribute("aria-valuenow")).toBe("45");
    expect(card.textContent).toContain("Updated yesterday by CodexCoder.");
    expect(card.textContent).toContain("Behind");
    expect(card.textContent).toContain("9 of 20 investors contacted, 45% of target");
    expect(card.textContent).not.toContain("Not updated in");
  });

  it("puts routines and skills first, then projects and tasks, then artifacts", async () => {
    await render();
    const order = [...host.querySelectorAll("section h2")].map((heading) => heading.textContent?.replace(/\s*\d+$/, ""))
      .filter((title) => ["Routines", "Skills", "Projects", "Tasks", "Artifacts"].includes(title ?? ""));
    expect(order).toEqual(["Routines", "Skills", "Projects", "Tasks", "Artifacts"]);
  });

  it("shows up to three metrics in the bar, each in its form, once the set loads", async () => {
    mocks.metrics.metrics.mockResolvedValue(METRIC_SET_FIXTURES.chosen);
    await render();
    await flush();
    const tiles = [...bar().querySelectorAll<HTMLElement>("[data-bar-metrics] [data-metric-key]")];
    expect(tiles.map((tile) => tile.dataset.metricDisplay)).toEqual(["line", "bar", "percent"]);
    expect(tiles[0]!.querySelector("[data-metric-value]")?.textContent).toBe("9of 20");
    expect(tiles[1]!.querySelectorAll("[data-bar]")).toHaveLength(8);
    expect(tiles[2]!.querySelector("[data-metric-ring]")).not.toBeNull();
    // The owner can remove a supporting metric, not the bar's own.
    expect(tiles[0]!.querySelector("button[aria-label^='Remove']")).toBeNull();
    expect(tiles[1]!.querySelector("button[aria-label^='Remove']")).not.toBeNull();
  });

  it("labels starter metrics plainly", async () => {
    mocks.metrics.metrics.mockResolvedValue(METRIC_SET_FIXTURES.starter);
    await render();
    await flush();
    expect(bar().querySelector("[data-metric-set-label]")?.textContent).toBe("Starter metrics from your work so far");
  });

  it("leads the status with the agent's written status when there is one", async () => {
    mocks.api.statusReport.mockResolvedValue(statusReportFixture());
    await render();
    await flush();
    const status = bar().querySelector<HTMLElement>("[data-bar-status]")!;
    expect(status.querySelector("[data-agent-status]")?.textContent).toContain("Written by CodexCoder · 2 days ago");
    expect(status.querySelector("[data-derived-status]")?.textContent).toContain("9 of 20 investors contacted, 45% of target");
    expect(status.querySelector("[data-ask-for-update]")?.textContent).toBe("Ask CodexCoder for an update");
  });

  it("records a new reading in one step", async () => {
    await render();
    const form = bar().querySelector<HTMLFormElement>('form[aria-label="Record a new reading"]')!;
    await act(async () => setInputValue(form.querySelector("input")!, "11"));
    await act(async () => buttonByText("Record", form)!.click());
    await flush();
    expect(mocks.api.update).toHaveBeenCalledExactlyOnceWith("resp-fundraising", { metricCurrent: 11 });
    expect(form.textContent).toContain("Recorded.");
  });

  it("edits the bar in a dialog", async () => {
    await render();
    await act(async () => buttonByText("Edit the bar", bar())!.click());
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.textContent).toContain("Edit the bar");
    await act(async () => buttonByText("Save the bar", dialog)!.click());
    await flush();
    expect(mocks.api.update).toHaveBeenCalledExactlyOnceWith("resp-fundraising", {
      standard: "Twenty qualified investors contacted before the partner meeting in December.",
      metricKind: "volume",
      metricName: "Investors contacted",
      metricTarget: 20,
      metricDirection: "at_least",
      metricUnit: null,
      metricLow: null,
      metricHigh: null,
    });
  });

  it("flags a stale number and points its signal at the bar", async () => {
    await render(lpUpdatesDetail.id);
    const card = bar();
    expect(card.textContent).toContain("36 days");
    expect(card.textContent).toContain("vs. at most 30 days");
    expect(card.textContent).toContain("Not updated in 19 days");
    expect(card.textContent).toContain("At risk");
    const stale = section("Across the work").querySelector('a[href="#responsibility-bar"]');
    expect(stale?.textContent).toContain("Days since the last LP letter was last updated 19 days ago");
  });

  it("shows the owner's override with its note, secondary to the number", async () => {
    await render(boardReportingDetail.id);
    const card = bar();
    expect(card.querySelector('[title="Set by hand"]')?.textContent).toContain("At risk");
    expect(card.textContent).toContain("Set by hand. From the number alone it is on track.");
    expect(card.textContent).toContain("The Q4 deck depends on numbers finance has not closed yet.");
    expect(buttonByText("Change or clear", card)).toBeDefined();
  });

  it("says when there is no reading yet", async () => {
    await render(hiringDetail.id);
    expect(bar().textContent).toContain("No reading yet");
    expect(bar().textContent).toContain("The agents working on this keep the number current; you can record one too.");
  });
});

describe("ResponsibilityDetail: the work, skills and artifacts", () => {
  it("lists the bubbled-up signals, each opening what it refers to", async () => {
    await render();
    const summary = section("Across the work");
    expect(summary.querySelector('a[href="/projects/project-deck"]')?.textContent).toContain("Investor update deck is 3 days past its target date");
    expect(summary.querySelector('a[href="/issues/task-blocked"]')?.textContent).toContain("Get the cap table from counsel is blocked");
    expect(summary.querySelector('a[href="/routines/routine-weekly"]')).not.toBeNull();
    expect(summary.querySelector('button[aria-label="Give Get the cap table from counsel is blocked to an agent"]')).not.toBeNull();
    expect(summary.querySelector('button[aria-label="Give Investor update deck is 3 days past its target date to an agent"]')).not.toBeNull();
  });

  it("lists projects with their target dates and links", async () => {
    await render();
    const projects = section("Projects");
    expect(projects.querySelector('a[href^="/projects/"]')?.textContent).toContain("Investor update deck");
    expect(projects.textContent).toContain("Late · Nov 10");
    expect(projects.querySelector('button[aria-label="Remove Investor update deck from this responsibility"]')).not.toBeNull();
  });

  it("calls out blocked tasks first, explains project membership, and collapses done work", async () => {
    await render();
    const tasks = section("Tasks");
    expect(tasks.textContent).toContain("1 task is blocked.");
    const titles = [...tasks.querySelectorAll("ul a[href^='/issues/']")].map((link) => link.textContent);
    expect(titles[0]).toContain("Get the cap table from counsel");
    expect(tasks.textContent).toContain("Here through Investor update deck");
    expect(tasks.querySelector('button[aria-label="Remove Get the cap table from counsel from this responsibility"]')).toBeNull();
    expect(tasks.querySelector('button[aria-label="Remove Ask Dana for an intro to the lead from this responsibility"]')).not.toBeNull();
    expect(tasks.textContent).not.toContain("Send the October update");
    await act(async () => buttonByText("Show 1 done", tasks)!.click());
    expect(tasks.textContent).toContain("Send the October update");
  });

  it("removes a link without deleting the task, and can undo it", async () => {
    await render();
    const remove = host.querySelector<HTMLButtonElement>('button[aria-label="Remove Ask Dana for an intro to the lead from this responsibility"]')!;
    await act(async () => remove.click());
    await flush();
    expect(mocks.api.unlink).toHaveBeenCalledExactlyOnceWith("resp-fundraising", "link-task-intro");
    const notice = host.querySelector('[role="status"]')!;
    expect(notice.textContent).toContain("Removed “Ask Dana for an intro to the lead” from this responsibility. It still exists");
    await act(async () => buttonByText("Undo", notice)!.click());
    await flush();
    expect(mocks.api.link).toHaveBeenCalledExactlyOnceWith("resp-fundraising", { issueId: "task-intro" });
  });

  it("lists routines", async () => {
    await render();
    expect(section("Routines").querySelector('a[href="/routines/routine-weekly"]')?.textContent).toContain("Weekly investor pipeline review");
  });

  it("lists the skills of the agents doing the work as cards, with who holds each", async () => {
    await render();
    const skills = section("Skills");
    expect(skills.querySelectorAll('[data-testid="responsibility-skills"] > li [data-slot="card"]')).toHaveLength(2);
    expect(skills.querySelector('a[href="/skills/investor-research"]')?.textContent).toContain("Investor research");
    expect(skills.querySelector('[aria-label="Held by CodexCoder, CTO"]')).not.toBeNull();
    expect(skills.querySelector('a[href="/skills/deck-builder"]')).not.toBeNull();
  });

  it("lists artifacts newest first, each opening in its task, and says the list is cut short", async () => {
    await render();
    const artifacts = section("Artifacts");
    expect(artifacts.querySelector("h2")?.textContent).toContain("63");
    const cards = [...artifacts.querySelectorAll('[data-testid="artifact-card"]')];
    expect(cards.map((card) => card.getAttribute("href"))).toEqual([
      "/issues/PAP-42#document-update",
      "/issues/PAP-43#attachment-pipeline",
      "/issues/PAP-30#document-terms",
    ]);
    expect(artifacts.querySelector('a[href="/issues/PAP-43"]')?.textContent).toContain("Ask Dana for an intro to the lead");
    expect(artifacts.textContent).toContain("Showing the newest 3 of 63.");
  });

  it("says what belongs in each empty section", async () => {
    await render(hiringDetail.id);
    expect(section("Across the work").textContent).toContain("Nothing to report yet.");
    expect(section("Projects").textContent).toContain("No projects yet. A project groups the tasks that move this number");
    expect(section("Tasks").textContent).toContain("No open tasks. Create one for an agent, or add a task you already have.");
    expect(section("Routines").textContent).toContain("A routine is work that repeats");
    expect(section("Skills").textContent).toContain("No skills yet.");
    expect(section("Artifacts").textContent).toContain("Nothing produced yet.");
    expect(host.querySelector("header")?.textContent).toContain("No agent is working on this yet.");
  });
});

describe("artifactsTruncationNote", () => {
  it("says how many there are, or that the count stopped", () => {
    expect(artifactsTruncationNote(50, 312)).toBe("Showing the newest 50 of 312.");
    expect(artifactsTruncationNote(50, 1000)).toBe("Showing the newest 50 of 1,000 or more.");
  });
});

describe("describeLinkError", () => {
  it("explains an item that is gone or out of reach", () => {
    expect(describeLinkError(new ApiError("not found", 404, { error: "Task not found" }), "task")).toBe(
      "That task is no longer available to you. It may have been deleted or made private.",
    );
  });
});
