// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  areaFundraising,
  RESPONSIBILITY_DETAIL_FIXTURES,
  RESPONSIBILITY_FIXTURE_GUIDE_AGENT_ID,
  RESPONSIBILITY_FIXTURE_NOW,
} from "../../storybook/fixtures/responsibilities";
import { METRIC_SET_FIXTURES } from "../../storybook/fixtures/responsibility-metrics";
import {
  barConversationFixture,
  everyCaseDetail,
  longContentDetail,
  nothingUnderDetail,
  runsFixtureFor,
  sentenceOnlyDetail,
  type BarConversationFixtureState,
} from "../../storybook/fixtures/responsibility-one-screen-v2";
import { ResponsibilityDetail } from "./ResponsibilityDetail";

const mocks = vi.hoisted(() => ({
  responsibilityId: "resp-fundraising",
  api: {
    get: vi.fn(), update: vi.fn(), unlink: vi.fn(), remove: vi.fn(), link: vi.fn(), delegate: vi.fn(),
    summary: vi.fn(), automation: vi.fn(), statusReport: vi.fn(), requestStatusUpdate: vi.fn(),
  },
  areas: { list: vi.fn() },
  agents: { list: vi.fn() },
  activity: { list: vi.fn() },
  auth: { getSession: vi.fn() },
  settings: { getExperimental: vi.fn() },
  issues: { list: vi.fn(), update: vi.fn(), addComment: vi.fn() },
  routines: { list: vi.fn(), create: vi.fn(), createTrigger: vi.fn(), update: vi.fn(), run: vi.fn() },
  bars: { conversation: vi.fn(), start: vi.fn(), accept: vi.fn(), decline: vi.fn() },
  metrics: { metrics: vi.fn(), removeMetric: vi.fn(), setDisplay: vi.fn() },
  runs: { recent: vi.fn() },
  navigate: vi.fn(),
}));
vi.mock("@/api/responsibilities", () => ({ responsibilitiesApi: mocks.api, responsibilityAreasApi: mocks.areas }));
vi.mock("@/api/agents", () => ({ agentsApi: mocks.agents }));
vi.mock("@/api/activity", () => ({ activityApi: mocks.activity }));
vi.mock("@/api/auth", () => ({ authApi: mocks.auth }));
vi.mock("@/api/instanceSettings", () => ({ instanceSettingsApi: mocks.settings }));
vi.mock("@/api/issues", () => ({ issuesApi: mocks.issues }));
vi.mock("@/api/routines", () => ({ routinesApi: mocks.routines }));
vi.mock("@/api/responsibility-bars", () => ({ responsibilityBarsApi: mocks.bars }));
vi.mock("@/api/responsibility-metrics", () => ({ responsibilityMetricsApi: mocks.metrics }));
vi.mock("@/api/responsibility-runs", () => ({ responsibilityRunsApi: mocks.runs }));
// The app's own new-project form, standing in: it hands back the project it made.
vi.mock("@/components/NewProjectDialog", () => ({
  NewProjectForm: ({ onCreated, onClose }: { onCreated?: (project: { id: string }) => Promise<unknown>; onClose: () => void }) => (
    <div role="dialog" data-new-project-form="">
      <button type="button" onClick={async () => { await onCreated?.({ id: "project-new" }); onClose(); }}>Create project</button>
    </div>
  ),
}));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-storybook" }) }));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));
vi.mock("@/lib/router", () => ({
  Link: ({ to, children, disableIssueQuicklook: _skip, ...props }: { to: string; children: ReactNode; disableIssueQuicklook?: boolean }) => (
    <a href={to} {...props}>{children}</a>
  ),
  useNavigate: () => mocks.navigate,
  useParams: () => ({ responsibilityId: mocks.responsibilityId }),
  useLocation: () => ({ pathname: "/responsibilities", search: "?view=one_screen_v2", hash: "", state: null, key: "default" }),
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// The task search list measures itself; jsdom has no layout.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;
Element.prototype.scrollIntoView ??= () => {};

let root: Root;
let host: HTMLDivElement;
let client: QueryClient;
const DETAILS = {
  ...RESPONSIBILITY_DETAIL_FIXTURES,
  [sentenceOnlyDetail.id]: sentenceOnlyDetail,
  [nothingUnderDetail.id]: nothingUnderDetail,
  [everyCaseDetail.id]: everyCaseDetail,
  [longContentDetail.id]: longContentDetail,
};
const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const page = () => host.querySelector<HTMLElement>('[data-responsibility-view="one_screen_v2"]')!;
const bar = () => host.querySelector<HTMLElement>("#responsibility-bar")!;
const section = (key: string) => host.querySelector<HTMLElement>(`[data-section="${key}"]`)!;
const buttons = (scope: ParentNode, label: string) =>
  [...scope.querySelectorAll<HTMLButtonElement>("button")].filter((button) => button.textContent?.trim() === label);
const menuItems = () => [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemradio"]')];
const menuItem = (label: string) => menuItems().find((item) => item.textContent?.trim() === label)!;

async function openMenu(trigger: HTMLElement) {
  await act(async () => trigger.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 })));
}
async function choose(item: HTMLElement) {
  await act(async () => item.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  await flush();
}
async function click(element: HTMLElement) {
  await act(async () => element.click());
  await flush();
}
function setInputValue(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function conversation(state: BarConversationFixtureState) {
  mocks.bars.conversation.mockImplementation(async (id: string) => barConversationFixture(id, state));
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
  await flush();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(RESPONSIBILITY_FIXTURE_NOW);
  vi.clearAllMocks();
  localStorage.clear();
  mocks.api.get.mockImplementation(async (id: string) => DETAILS[id]);
  mocks.api.link.mockResolvedValue({ link: { id: "link-new" } });
  mocks.api.update.mockImplementation(async (id: string, patch: Record<string, unknown>) => ({ ...DETAILS[id], ...patch }));
  mocks.areas.list.mockResolvedValue([areaFundraising]);
  mocks.agents.list.mockResolvedValue([
    { id: "agent-codex", companyId: "company-storybook", name: "CodexCoder", status: "idle", urlKey: "codexcoder", createdAt: "2026-01-01T00:00:00Z" },
    { id: RESPONSIBILITY_FIXTURE_GUIDE_AGENT_ID, companyId: "company-storybook", name: "CTO", status: "idle", urlKey: "cto", createdAt: "2026-01-02T00:00:00Z" },
  ]);
  mocks.activity.list.mockResolvedValue([]);
  mocks.auth.getSession.mockResolvedValue({ user: { id: "user-storybook" } });
  mocks.settings.getExperimental.mockResolvedValue({ enableArtifactsV1: false, managedKeys: { enableArtifactsV1: true } });
  mocks.metrics.metrics.mockResolvedValue(METRIC_SET_FIXTURES.chosen);
  mocks.runs.recent.mockImplementation(async (id: string) => runsFixtureFor(id));
  conversation("none");
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

describe("One screen v2: the page", () => {
  it("leads with the sentence, its area above it, and none of the status or explanation the other layouts carry", async () => {
    await render();
    expect(page()).not.toBeNull();
    const header = page().querySelector("header")!;
    expect(header.querySelector("[data-area]")?.textContent).toBe("Fundraising");
    expect(header.querySelector("h1")?.textContent).toBe("Twenty qualified investors contacted before the partner meeting in December.");
    expect(header.querySelectorAll("button")).toHaveLength(1);
    const text = page().textContent ?? "";
    for (const absent of [
      "Behind", "At risk", "On track", "Not measured", "45%", "Written by", "From the number", "What is affecting the number",
      "Holding the number back", "Moving", "routines", "Chosen with", "Starter metrics", "Agents on this", "New task for an agent",
    ]) expect(text).not.toContain(absent);
    for (const selector of ["[data-bearing-key]", "[data-bearing]", "[data-automation-line]", "[data-affecting-summary]", "[data-bar-status]", "[data-metric-read]", "[data-metric-set-label]"]) {
      expect(page().querySelector(selector)).toBeNull();
    }
    // The reads behind those elements are not even made.
    expect(mocks.api.summary).not.toHaveBeenCalled();
    expect(mocks.api.automation).not.toHaveBeenCalled();
    expect(mocks.api.statusReport).not.toHaveBeenCalled();
    // The rare actions sit in one menu.
    await openMenu(header.querySelector<HTMLElement>('button[aria-label="More actions for this responsibility"]')!);
    expect(menuItems().map((item) => item.textContent?.trim())).toEqual(["Rename…", "Move to area", "Let go", "Delete…"]);
  });

  it("has the bar, then routines, skills, projects, tasks, recent runs and artifacts, each headed by its word alone", async () => {
    await render();
    const order = [...page().querySelectorAll<HTMLElement>("#responsibility-bar, [data-section]")].map((node) => node.dataset.section ?? "bar");
    expect(order).toEqual(["bar", "routines", "skills", "projects", "tasks", "runs", "artifacts"]);
    expect([...page().querySelectorAll("[data-section] h2")].map((heading) => heading.textContent)).toEqual([
      "Routines", "Skills", "Projects", "Tasks", "Recent runs", "Artifacts",
    ]);
    for (const key of ["routines", "skills", "projects", "tasks", "runs"]) expect(section(key).querySelector("[data-section-add]")).not.toBeNull();
    expect(section("artifacts").querySelector("[data-section-add], [data-section-add-disabled]")).toBeNull();
    // A row is what it is, one stat and who has it: a task's glyph and title, its identifier and when it last moved.
    const task = section("tasks").querySelector<HTMLElement>('[data-work-id="task-draft"] a')!;
    expect(task.getAttribute("href")).toBe("/issues/PAP-42");
    // The status glyph's words are for screen readers.
    expect(task.textContent).toBe("In ProgressDraft the November investor updatePAP-422d ago");
    expect(task.querySelector('[aria-label="CodexCoder"]')).not.toBeNull();
    expect(section("tasks").querySelector('[data-work-id="task-done"]')).toBeNull();
    expect(section("projects").querySelector('[data-work-id="project-deck"]')?.textContent).toBe("Investor update deck3 days late");
  });

  it("shows only headings, their +, and a few words when nothing is filed under it", async () => {
    mocks.metrics.metrics.mockResolvedValue(METRIC_SET_FIXTURES.one);
    await render(nothingUnderDetail.id);
    for (const key of ["routines", "skills", "projects", "tasks", "runs", "artifacts"]) {
      expect(section(key).querySelector("p")?.textContent).toBe("None yet.");
    }
    // Nothing to run and nobody to give a skill to: the + says why.
    expect(section("runs").querySelector("[data-section-add-disabled]")?.getAttribute("title")).toBe("No routines to run yet");
    expect(section("skills").querySelector("[data-section-add-disabled] button")?.hasAttribute("disabled")).toBe(true);
  });
});

describe("One screen v2: each +", () => {
  it("Tasks: a new task for an agent filed here, or an existing one", async () => {
    mocks.issues.list.mockResolvedValue([{ id: "task-other", identifier: "PAP-70", title: "Book the partner meeting" }]);
    await render();
    await openMenu(section("tasks").querySelector<HTMLElement>("[data-section-add]")!);
    expect(menuItems().map((item) => item.textContent)).toEqual(["New task", "Add existing"]);
    await choose(menuItem("New task"));
    expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain("New task for an agent");
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await flush();

    await openMenu(section("tasks").querySelector<HTMLElement>("[data-section-add]")!);
    await choose(menuItem("Add existing"));
    await flush();
    const search = document.body.querySelector<HTMLInputElement>('input[aria-label="Search tasks"]')!;
    expect(search).not.toBeNull();
    const option = await vi.waitFor(() => {
      const found = [...document.body.querySelectorAll<HTMLElement>('[cmdk-item]')].find((item) => item.textContent?.includes("Book the partner meeting"));
      if (!found) throw new Error("not yet");
      return found;
    });
    await choose(option);
    expect(mocks.api.link).toHaveBeenCalledWith("resp-fundraising", { issueId: "task-other" });
  });

  it("Routines: a new routine from what repeats, how often and who runs it, filed here", async () => {
    mocks.routines.create.mockResolvedValue({ id: "routine-new", title: "Review the pipeline" });
    mocks.routines.createTrigger.mockResolvedValue({ trigger: { id: "trigger-new" }, secretMaterial: null });
    await render();
    await openMenu(section("routines").querySelector<HTMLElement>("[data-section-add]")!);
    expect(menuItems().map((item) => item.textContent)).toEqual(["New routine", "Add existing"]);
    await choose(menuItem("New routine"));
    const dialog = document.body.querySelector<HTMLElement>("[data-make-routine-dialog]")!;
    expect(dialog.textContent).toContain("New routine");
    expect(dialog.textContent).toContain("Filed under Seed extension.");
    await act(async () => setInputValue(dialog.querySelector<HTMLInputElement>('input[aria-label="What repeats"]')!, "Review the pipeline"));
    await click(buttons(dialog, "Make the routine")[0]!);
    await flush();
    // The agent already working under it runs it by default.
    expect(mocks.routines.create).toHaveBeenCalledExactlyOnceWith("company-storybook", { title: "Review the pipeline", assigneeAgentId: "agent-codex" });
    expect(mocks.routines.createTrigger).toHaveBeenCalledWith("routine-new", expect.objectContaining({ kind: "schedule", cronExpression: "0 9 * * 1" }));
    expect(mocks.api.link).toHaveBeenCalledExactlyOnceWith("resp-fundraising", { routineId: "routine-new" });
  });

  it("Projects: the app's new-project form, with the project filed here", async () => {
    await render();
    await openMenu(section("projects").querySelector<HTMLElement>("[data-section-add]")!);
    await choose(menuItem("New project"));
    await click(buttons(document.body, "Create project")[0]!);
    expect(mocks.api.link).toHaveBeenCalledExactlyOnceWith("resp-fundraising", { projectId: "project-new" });
    expect(document.body.querySelector("[data-new-project-form]")).toBeNull();
  });

  it("Skills: the skills page of each agent working under it", async () => {
    await render();
    await openMenu(section("skills").querySelector<HTMLElement>("[data-section-add]")!);
    const links = [...document.body.querySelectorAll<HTMLAnchorElement>('[role="menuitem"]')].map((item) => [item.textContent, item.getAttribute("href")]);
    expect(links).toEqual([
      ["CodexCoder", "/agents/codexcoder/skills"],
    ]);
  });

  it("Recent runs: runs one of its routines now", async () => {
    mocks.routines.run.mockResolvedValue({ id: "routine-run-1" });
    await render();
    await openMenu(section("runs").querySelector<HTMLElement>("[data-section-add]")!);
    await choose(menuItem("Weekly investor pipeline review"));
    expect(mocks.routines.run).toHaveBeenCalledExactlyOnceWith("routine-weekly", {});
    expect(mocks.runs.recent.mock.calls.length).toBeGreaterThan(1);
  });
});

describe("One screen v2: recent runs", () => {
  it("lists who ran, on what, how it ended and when, newest first, each opening the run", async () => {
    await render();
    const rows = [...section("runs").querySelectorAll<HTMLElement>("li[data-run-id]")];
    expect(rows.map((row) => row.dataset.runId)).toEqual(["run-live", "run-routine", "run-failed", "run-older"]);
    const failed = rows[2]!.querySelector("a")!;
    expect(failed.getAttribute("href")).toBe(`/agents/${RESPONSIBILITY_FIXTURE_GUIDE_AGENT_ID}/runs/run-failed`);
    expect(failed.getAttribute("aria-label")).toBe("CTO on Get the cap table from counsel: Failed 2d ago");
    expect(rows[0]!.dataset.runStatus).toBe("running");
    expect(rows.map((row) => row.querySelector("[data-row-stat]")?.textContent)).toEqual([
      "Running, started 3m ago", "Succeeded 1d ago", "Failed 2d ago", "Succeeded 3d ago",
    ]);
    expect(mocks.runs.recent).toHaveBeenCalledWith("resp-fundraising");
  });
});

describe("One screen v2: the bar", () => {
  it("empty: one line and one button that starts the conversation; by hand only in the menu; no starters in its place", async () => {
    mocks.metrics.metrics.mockResolvedValue(METRIC_SET_FIXTURES.starter);
    mocks.bars.start.mockResolvedValue(barConversationFixture(sentenceOnlyDetail.id, "discussing"));
    await render(sentenceOnlyDetail.id);
    expect(page().querySelector("h1")?.textContent).toBe("Every investor always knows where we stand.");
    const empty = bar().querySelector<HTMLElement>("[data-bar-empty]")!;
    expect(empty.textContent).toBe("How will you know this is going well?Set it with CTO");
    expect(bar().querySelector("[data-metric-key]")).toBeNull();
    expect(mocks.metrics.metrics).not.toHaveBeenCalled();
    expect(buttons(bar(), "Set it by hand")).toHaveLength(0);
    await openMenu(bar().querySelector<HTMLElement>('button[aria-label="More for the bar"]')!);
    expect(menuItems().map((item) => item.textContent)).toEqual(["Set it by hand"]);
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await click(buttons(bar(), "Set it with CTO")[0]!);
    expect(mocks.bars.start).toHaveBeenCalledExactlyOnceWith(sentenceOnlyDetail.id);
    expect(mocks.navigate).toHaveBeenCalledWith("/issues/PAP-90");
  });

  it("empty with no agent to talk to: the button is the by-hand path and says why", async () => {
    conversation("no_agent");
    await render(sentenceOnlyDetail.id);
    expect(bar().textContent).toContain("No agent is free to talk it through.");
    expect(bar().querySelector('button[aria-label="More for the bar"]')).toBeNull();
    await click(buttons(bar(), "Set it by hand")[0]!);
    expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain("Kind of measure");
  });

  it("talking it through: a few words and the way into the conversation", async () => {
    conversation("discussing");
    await render(sentenceOnlyDetail.id);
    const line = bar().querySelector<HTMLElement>("[data-bar-talking]")!;
    expect(line.textContent).toBe("Talking it through with CTO. Open the conversation");
    expect(line.querySelector("a")?.getAttribute("href")).toBe("/issues/PAP-90");
    expect(bar().querySelector("[data-bar-empty]")).toBeNull();
  });

  it("proposed: the visualizations as they will look; a supporting one dropped is left out on accept, the bar's own always kept", async () => {
    conversation("proposal");
    mocks.bars.accept.mockImplementation(async () => ({ interaction: { ...barConversationFixture("x", "proposal").proposal!, status: "accepted" }, responsibility: sentenceOnlyDetail }));
    await render(sentenceOnlyDetail.id);
    const proposal = bar().querySelector<HTMLElement>("[data-bar-proposal]")!;
    expect(proposal.textContent).toContain("Every prospective LP hears from us at least every two weeks.");
    const tiles = [...proposal.querySelectorAll<HTMLElement>("[data-metric-key]")];
    expect(tiles.map((tile) => [tile.dataset.metricRole, tile.dataset.metricDisplay])).toEqual([["primary", "line"], ["supporting", "bar"], ["supporting", "percent"]]);
    expect(tiles[0]!.querySelector("[data-always-kept]")?.textContent).toBe("Always kept");
    expect(tiles[0]!.querySelector("[data-drop-metric]")).toBeNull();
    expect(proposal.querySelectorAll("[data-drop-metric]")).toHaveLength(2);
    // Drop one, keep it again, drop it again.
    await click(proposal.querySelector<HTMLElement>('button[aria-label="Drop “Intro calls booked per week”"]')!);
    expect(proposal.querySelector("[data-dropped]")?.textContent).toBe("Intro calls booked per weekKeep");
    await click(buttons(proposal, "Keep")[0]!);
    expect(proposal.querySelector("[data-dropped]")).toBeNull();
    await click(proposal.querySelector<HTMLElement>('button[aria-label="Drop “Intro calls booked per week”"]')!);
    await click(buttons(proposal, "Use this bar")[0]!);
    expect(mocks.bars.accept).toHaveBeenCalledExactlyOnceWith("issue-bar-conversation", "bar-proposal-with-metrics", { keepMetrics: [1] });
  });

  it("proposed: accepting with nothing dropped sends no list, so every metric applies", async () => {
    conversation("proposal");
    mocks.bars.accept.mockImplementation(async () => ({ interaction: { ...barConversationFixture("x", "proposal").proposal!, status: "accepted" }, responsibility: sentenceOnlyDetail }));
    await render(sentenceOnlyDetail.id);
    await click(buttons(bar(), "Use this bar")[0]!);
    expect(mocks.bars.accept).toHaveBeenCalledExactlyOnceWith("issue-bar-conversation", "bar-proposal-with-metrics");
  });

  it("set: titles and visuals only; one button to change it with the agent; by hand in the menu", async () => {
    await render();
    const tiles = [...bar().querySelectorAll<HTMLElement>("[data-metric-key]")];
    expect(tiles.map((tile) => tile.dataset.metricKey)).toEqual(["primary", "metric-meetings", "metric-replies"]);
    expect(bar().querySelector('[data-bar-visualizations="chosen"]')?.className).toContain("lg:grid-cols-3");
    expect(bar().querySelector("[data-metric-read], [data-metric-description], [data-metric-set-label]")).toBeNull();
    expect(buttons(bar(), "Change it with CTO")).toHaveLength(1);
    expect(buttons(bar(), "Edit by hand")).toHaveLength(0);
    await openMenu(bar().querySelector<HTMLElement>('button[aria-label="More for the bar"]')!);
    expect(menuItems().map((item) => item.textContent)).toEqual(["Edit by hand", "Record a reading"]);
    await choose(menuItem("Record a reading"));
    expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain("Record a reading");
  });

  it("Show as: only the forms the metric's data allows, switched at once with the narrow write", async () => {
    mocks.metrics.setDisplay.mockImplementation(async () => ({
      ...METRIC_SET_FIXTURES.chosen,
      metrics: METRIC_SET_FIXTURES.chosen.metrics.map((metric) => metric.key === "metric-meetings" ? { ...metric, display: "line", period: null } : metric),
    }));
    await render();
    const options = async (key: string) => {
      await openMenu(bar().querySelector<HTMLElement>(`[data-metric-key="${key}"] button[aria-label^="Options for"]`)!);
      const items = menuItems().map((item) => item.textContent);
      await choose(menuItem("Show as"));
      return { items, forms: [...document.body.querySelectorAll('[role="menuitemradio"]')].map((item) => [item.textContent, item.getAttribute("aria-checked")]) };
    };
    const primary = await options("primary");
    expect(primary.items).toEqual(["Show as"]);
    expect(primary.forms).toEqual([["Number", "false"], ["Trend", "true"], ["Per week", "false"]]);
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await flush();
    const share = await options("metric-replies");
    expect(share.items).toEqual(["Show as", "Remove"]);
    expect(share.forms.map(([label]) => label)).toEqual(["Number", "Percent", "Trend", "Per week"]);
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await flush();
    const meetings = await options("metric-meetings");
    expect(meetings.forms).toEqual([["Number", "false"], ["Trend", "false"], ["Per week", "true"]]);
    await choose(menuItem("Trend"));
    expect(mocks.metrics.setDisplay).toHaveBeenCalledExactlyOnceWith("resp-fundraising", "metric-meetings", "line");
    expect(bar().querySelector('[data-metric-key="metric-meetings"]')?.getAttribute("data-metric-display")).toBe("line");
  });

  it("Remove: a supporting one, after a short confirm", async () => {
    mocks.metrics.removeMetric.mockResolvedValue({ ...METRIC_SET_FIXTURES.chosen, metrics: METRIC_SET_FIXTURES.chosen.metrics.slice(0, 2) });
    await render();
    await openMenu(bar().querySelector<HTMLElement>('[data-metric-key="metric-replies"] button[aria-label^="Options for"]')!);
    await choose(menuItem("Remove"));
    const dialog = document.body.querySelector<HTMLElement>('[role="alertdialog"]')!;
    expect(dialog.textContent).toContain("Remove “Investor emails answered within a day”?");
    expect(dialog.textContent).toContain("Its readings are kept.");
    await click(buttons(dialog, "Remove")[0]!);
    expect(mocks.metrics.removeMetric).toHaveBeenCalledExactlyOnceWith("resp-fundraising", "metric-replies");
    expect(bar().querySelectorAll("[data-metric-key]")).toHaveLength(2);
  });

  it("a set nobody chose: what it has, without menus", async () => {
    mocks.metrics.metrics.mockResolvedValue(METRIC_SET_FIXTURES.starter);
    await render();
    expect(bar().querySelectorAll("[data-metric-key]")).toHaveLength(3);
    expect(bar().querySelector('button[aria-label^="Options for"]')).toBeNull();
  });
});

describe("One screen v2: each section is a table", () => {
  const rowsOf = (key: string) => [...section(key).querySelectorAll<HTMLElement>("[data-section-rows] > li")];
  const stats = (key: string) => Object.fromEntries(rowsOf(key).map((row) => [
    row.dataset.workId ?? row.dataset.runId ?? row.dataset.artifactId,
    row.querySelector("[data-row-stat]")?.textContent ?? null,
  ]));

  it("one card each, with a header bar of the word and its +, and no counts or column headings", async () => {
    await render(everyCaseDetail.id);
    for (const key of ["routines", "skills", "projects", "tasks", "runs", "artifacts"]) {
      const card = section(key).querySelector<HTMLElement>("[data-section-table]")!;
      expect(card).not.toBeNull();
      const header = card.querySelector<HTMLElement>("[data-section-header]")!;
      expect(header.textContent).toBe(header.querySelector("h2")!.textContent);
      expect(card.querySelector("th, [role='columnheader']")).toBeNull();
      expect(rowsOf(key).length).toBeGreaterThan(0);
    }
  });

  it("Routines: how the last run went and when, or that it is paused or has not run; who runs it", async () => {
    await render(everyCaseDetail.id);
    expect(stats("routines")).toEqual({
      "routine-board": "Not run yet",
      "routine-crm": "Failed 2d ago",
      "routine-inbox": "Running, started 3h ago",
      "routine-letter": "Paused",
      "routine-weekly": "Last successful run 8h ago",
    });
    const weekly = section("routines").querySelector<HTMLElement>('[data-work-id="routine-weekly"] a')!;
    expect(weekly.getAttribute("href")).toBe("/routines/routine-weekly");
    expect(weekly.querySelector('[data-row-who] [aria-label="CodexCoder"]')).not.toBeNull();
  });

  it("Projects: when it is due, late, or nothing without a date; its progress as a quiet meter; its lead", async () => {
    await render(everyCaseDetail.id);
    expect(stats("projects")).toEqual({ "project-room": "Due in 14 days", "project-deck": "5 days late", "project-pipeline": null });
    const meter = (id: string) => section("projects").querySelector(`[data-work-id="${id}"] [data-project-progress]`);
    expect(meter("project-room")?.getAttribute("aria-label")).toBe("4 of 10 tasks done");
    expect(meter("project-room")?.getAttribute("data-project-progress")).toBe("40");
    expect(meter("project-pipeline")).toBeNull();
    expect(section("projects").querySelector('[data-work-id="project-pipeline"] [data-row-who]')).toBeNull();
  });

  it("Tasks: open ones with their identifier and when they last moved; a quiet last row reveals the done ones", async () => {
    await render(everyCaseDetail.id);
    expect(stats("tasks")).toEqual({ "task-summary": "PAP-101d ago", "task-collab": "PAP-112d ago", "task-scan": "PAP-123d ago" });
    const reveal = section("tasks").querySelector<HTMLButtonElement>("[data-section-footer]")!;
    expect(reveal.textContent).toBe("Show 2 done");
    await click(reveal);
    expect(rowsOf("tasks").map((row) => row.dataset.workId)).toEqual(["task-summary", "task-collab", "task-scan", "task-october", "task-list"]);
    expect(reveal.textContent).toBe("Hide done");
    await click(reveal);
    expect(rowsOf("tasks")).toHaveLength(3);
  });

  it("Tasks: with nothing open, a few words and the reveal", async () => {
    mocks.api.get.mockImplementation(async () => ({ ...everyCaseDetail, tasks: everyCaseDetail.tasks.filter((task) => task.status === "done") }));
    await render(everyCaseDetail.id);
    expect(section("tasks").querySelector("[data-section-empty]")?.textContent).toBe("None open.");
    await click(section("tasks").querySelector<HTMLButtonElement>("[data-section-footer]")!);
    expect(rowsOf("tasks")).toHaveLength(2);
  });

  it("Skills: the agents here who hold it are its stat; past four, three and how many more", async () => {
    await render(everyCaseDetail.id);
    const holders = (id: string) => section("skills").querySelector<HTMLElement>(`[data-work-id="${id}"] [data-row-who]`)!;
    expect(holders("skill-investor-research").querySelectorAll('[role="img"]')).toHaveLength(2);
    expect(holders("skill-market-scan").querySelectorAll('[role="img"]')).toHaveLength(3);
    expect(holders("skill-market-scan").textContent).toBe("+2");
    expect(section("skills").querySelector("[data-row-stat]")).toBeNull();
  });

  it("Artifacts: their kind, the task they came from and when, opening the artifact", async () => {
    await render(everyCaseDetail.id);
    expect(stats("artifacts")).toEqual({
      "artifact-update": "PAP-421d ago",
      "artifact-pipeline": "PAP-433d ago",
      "artifact-memo": "PAP-301w ago",
      "artifact-terms-pdf": "PAP-125d ago",
    });
    const row = section("artifacts").querySelector<HTMLElement>('[data-artifact-id="artifact-pipeline"] a')!;
    expect(row.getAttribute("href")).toBe("/issues/PAP-43#attachment-pipeline");
    expect(row.querySelector("[data-row-title] svg")).not.toBeNull();
    expect(row.querySelector("[data-row-who]")).toBeNull();
  });

  it("long names truncate with the full text on hover; the stat keeps its column", async () => {
    await render(longContentDetail.id);
    for (const key of ["routines", "skills", "projects", "tasks", "runs", "artifacts"]) {
      const title = section(key).querySelector<HTMLElement>("[data-row-title] [title]")!;
      expect(title.className).toContain("truncate");
      expect(title.getAttribute("title")).toBe(title.textContent);
      expect(title.textContent!.length).toBeGreaterThan(80);
    }
    expect(section("routines").querySelector("[data-row-stat]")?.className).toContain("sm:whitespace-nowrap");
  });
});
