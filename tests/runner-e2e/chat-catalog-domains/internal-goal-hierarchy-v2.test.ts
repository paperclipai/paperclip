import { afterEach, expect, it, vi } from "vitest";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
import type { InternalObservation } from "./internal-support.js";
import { observeInternal } from "./internal-support.js";
import { sendChatMessage } from "../chat-flow.js";
import { retryDefinition } from "./internal-definition.js";
import { grade_goals, goalsCases } from "./internal-goals.js";
vi.mock("../codex-subscription-fixture.js", () => ({ codexSubscriptionAgentConfig: vi.fn() }));
vi.mock("../chat-flow.js", () => ({ sendChatMessage: vi.fn() }));
vi.mock("./internal-support.js", async original => ({ ...await original<typeof import("./internal-support.js")>(), observeInternal: vi.fn() }));
vi.mock("@playwright/test", () => ({ expect: (locator: { visible?: boolean }) => ({
  toBeVisible: async () => { if (locator.visible !== true) throw new Error("Synthetic unit UI did not expose the requested saved goal"); },
}) }));
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });
const query = "Set a company goal of reaching a thousand signups, with a team goal for launching the website.";
function valid(owner: string | null = null): InternalObservation {
  const o = { scenarioId: "goals.create-goal-tree", origin: "https://fixture.test", companyId: "acorn", leadId: "ceo", state: {},
    agents: [{ id: "ceo", companyId: "acorn" }, { id: "morgan", companyId: "acorn" }],
    goals: [{ id: "growth", companyId: "acorn", title: "Reach a thousand signups", level: "company", parentId: null, ownerAgentId: "ceo" },
      { id: "website", companyId: "acorn", title: "Launch the website", level: "team", parentId: "growth", ownerAgentId: owner }],
    tasks: [], projects: [], comments: [], documents: [], revisions: [], links: [], reply: "Created the requested company goal and its website sub-goal.",
    activity: [{ id: "created-root", action: "goal.created", entityId: "growth", agentId: "ceo" },
      { id: "created-child", action: "goal.created", entityId: "website", agentId: "ceo" }],
    humanQueries: [query, query], runs: [1, 2].map(n => ({ id: `native-${n}`, companyId: "acorn", agentId: "ceo", status: "succeeded", runtimeMode: "native" })),
  } as InternalObservation;
  o.state = { firstIds: ["growth", "website"], retryQuery: query,
    hierarchyInspection: { companyId: "acorn", rootId: "growth", childId: "website", readbackMatched: true, rootVisible: true, childVisible: true } };
  o.state.firstCreation = structuredClone(o);
  return o;
}
it.each([null, "morgan"])("accepts a genuinely inspectable tree with optional same-company owner %s and no exact chat-link requirement", owner => {
  expect(grade_goals(valid(owner))).toMatchObject({ passed: true });
});
it.each(["invented", "foreign"])("rejects an unverified or foreign goal owner %s", owner => {
  const o = valid(owner); if (owner === "foreign") o.agents!.push({ id: owner, companyId: "birch" });
  expect(grade_goals(o).passed).toBe(false);
});
it.each(["wrong parent", "missing child", "foreign goal", "no saved state", "missing attribution", "invented progress", "missing UI", "wrong UI identity", "duplicate retry"])("still rejects %s", invalid => {
  const o = valid();
  if (invalid === "wrong parent") o.goals[1]!.parentId = "foreign-root";
  if (invalid === "missing child") o.goals.pop();
  if (invalid === "foreign goal") o.goals[1]!.companyId = "birch";
  if (invalid === "no saved state") o.goals = [];
  if (invalid === "missing attribution") o.activity = [];
  if (invalid === "invented progress") o.reply = "Already 100 signups.";
  if (invalid === "missing UI") delete o.state.hierarchyInspection;
  if (invalid === "wrong UI identity") (o.state.hierarchyInspection as { childId: string }).childId = "different-goal";
  if (invalid === "duplicate retry") o.goals.push({ ...o.goals[1]!, id: "duplicate" });
  expect(grade_goals(o).passed).toBe(false);
});
function retitled(root: string, child: string, reply?: string) {
  const o = valid();
  for (const target of [o, o.state.firstCreation as InternalObservation]) {
    target.goals[0]!.title = root; target.goals[1]!.title = child;
    if (reply !== undefined) target.reply = reply;
  }
  return o;
}
it.each([
  ["Reach 1,000 signups", "Launch the website"],
  ["Reach 1000 customer signups", "Ship the website"],
  ["Get 1,000 people signed up", "Go live with the new web site"],
  ["Signups: 1,000", "Launch the company site"],
])("accepts meaning-preserving goal wording %s / %s", (root, child) => {
  expect(grade_goals(retitled(root, child)).passed).toBe(true);
});
it("accepts a truthful zero-progress note on newly created goals", () => {
  expect(grade_goals(retitled("Reach 1,000 signups", "Launch the website", "Created both goals; progress is 0% complete so far.")).passed).toBe(true);
  expect(grade_goals(retitled("Reach 1,000 signups", "Launch the website", "Created both goals; each is 0.0% complete.")).passed).toBe(true);
});
it.each([
  ["Reach 100 signups", "Launch the website"],
  ["Reach 10,000 signups", "Launch the website"],
  ["Reach 1,000 signups", "Hire a designer"],
  ["Grow revenue to 1,000 dollars", "Launch the website"],
])("rejects goals whose saved subject is not the requested one: %s / %s", (root, child) => {
  expect(grade_goals(retitled(root, child)).passed).toBe(false);
});
it.each(["We are already at 250 signups.", "The website goal is 40% complete.", "The website goal is 0.5% complete.", "Signups are .5% done."])("rejects invented progress: %s", reply => {
  expect(grade_goals(retitled("Reach 1,000 signups", "Launch the website", reply)).passed).toBe(false);
});
it("does not allow a retry to repair an invalid first parent or first foreign owner", () => {
  for (const field of ["parentId", "ownerAgentId"] as const) {
    const o = valid(), first = o.state.firstCreation as InternalObservation;
    first.goals[1]![field] = "foreign";
    expect(grade_goals(o).passed).toBe(false);
  }
});
function uiFixture() {
  const o = valid(); let current = "https://fixture.test/ACORN/chats/ceo", phase = 1;
  const readbacks = structuredClone(o.goals), state: Record<string, unknown> = { retryQuery: query };
  const get = vi.fn(async (route: string) => route.endsWith("/agents") ? structuredClone(o.agents)
    : structuredClone(readbacks.find(row => `/api/goals/${row.id}` === route)));
  const goto = vi.fn(async (url: string) => { current = url; });
  const headingVisible = { root: true, child: true };
  const page = { url: () => current, goto,
    locator: (selector: string) => ({ first: () => ({ click: async () => {
      const row = selector.includes("/goals/growth") ? o.goals[0]! : o.goals[1]!;
      current = `https://fixture.test/ACORN/goals/${row.id}`;
    } }) }),
    getByRole: (_role: string, options: { name: string }) => ({ first: () => ({ visible: o.goals.some(row => row.title === options.name
      && current.endsWith(`/goals/${row.id}`) && (row.level === "company" ? headingVisible.root : headingVisible.child)) }) }),
    getByTestId: () => ({ visible: current.endsWith("/chats/ceo") }),
  };
  const ctx = { observationDeadlineAt: Date.now() + 390_000, scenario: { id: o.scenarioId, query }, issue: () => ({ conversationState: "waiting" }),
    input: { fixtures: { company: { id: "acorn", issuePrefix: "ACORN" } }, api: { baseURL: o.origin, get, patch: vi.fn() }, page, evidence: vi.fn() } } as unknown as ChatCatalogContext;
  vi.mocked(observeInternal).mockImplementation(async (_ctx, receivedState) => ({ ...structuredClone(o), state: receivedState,
    runs: o.runs.slice(0, phase), humanQueries: Array.from({ length: phase }, () => query) }));
  vi.mocked(sendChatMessage).mockImplementation(async () => { phase = 2; });
  return { o, ctx, state, get, goto, headingVisible, readbacks };
}
it("the actual retry owner observes the saved tree and normal Goals UI without manufacturing goals or coaching a second request", async () => {
  const f = uiFixture(), d = goalsCases.find(row => row.scenarioId === "goals.create-goal-tree")!;
  await d.act!(f.ctx, f.state);
  expect(sendChatMessage).toHaveBeenCalledExactlyOnceWith(f.ctx.input.page, query);
  expect(f.goto).toHaveBeenCalledWith("https://fixture.test/ACORN/goals", expect.objectContaining({ waitUntil: "domcontentloaded" }));
  expect(f.get).toHaveBeenCalledWith("/api/goals/growth", expect.anything());
  expect(f.get).toHaveBeenCalledWith("/api/goals/website", expect.anything());
  expect(f.state.firstIds).toEqual(["growth", "website"]);
  expect(f.state.hierarchyInspection).toMatchObject({ rootId: "growth", childId: "website", readbackMatched: true });
  expect(f.ctx.input.api.patch).not.toHaveBeenCalled();
  expect(d.grade(await d.observe(f.ctx, f.state)).passed).toBe(true);
});
it.each(["missing UI child", "readback wrong parent", "readback foreign owner", "expired deadline"])("actual inspection rejects %s", async invalid => {
  const f = uiFixture();
  if (invalid === "missing UI child") f.headingVisible.child = false;
  if (invalid === "readback wrong parent") f.readbacks[1]!.parentId = "foreign";
  if (invalid === "readback foreign owner") f.readbacks[1]!.ownerAgentId = "foreign";
  if (invalid === "expired deadline") Object.assign(f.ctx, { observationDeadlineAt: Date.now() - 1 });
  const { inspectGoalHierarchy } = await import("./internal-goals.js");
  await expect(inspectGoalHierarchy(f.ctx, f.state, f.o)).rejects.toThrow();
  expect(f.state.hierarchyInspection).toBeUndefined();
});

it("keeps the existing project retry factory on its default observer and original repeat request", async () => {
  const f = uiFixture(), project = { id: "launch", companyId: "acorn", name: "Launch" };
  vi.mocked(observeInternal).mockImplementation(async (_ctx, state) => ({ ...valid(), state,
    projects: [project], goals: [], runs: [{ id: "first-native", status: "succeeded" }],
  }) as never);
  const d = retryDefinition("projects.create-project", () => { throw new Error("This boundary must not invoke the final grader"); },
    initial => initial.projects.some(row => row.id === "launch" && row.companyId === "acorn"));
  await d.act!(f.ctx, f.state);
  expect(f.state.firstIds).toEqual(["launch"]);
  expect(observeInternal).toHaveBeenCalledWith(f.ctx, f.state);
  expect(sendChatMessage).toHaveBeenCalledExactlyOnceWith(f.ctx.input.page, query);
});
