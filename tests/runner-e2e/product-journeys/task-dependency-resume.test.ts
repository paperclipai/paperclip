import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JourneyContext, JourneyEvidence, TargetSession } from "./types.js";
import { dependencyEvidenceFixture } from "./task-dependency-resume-fixture.js";

const controls = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("../user-actions.js", () => ({ createTaskThroughUi: (...args: unknown[]) => controls.create(...args) }));
vi.mock("./task-document-flow.js", () => ({ openDocumentAuthoring: vi.fn(async () => {}) }));
vi.mock("@playwright/test", () => ({ expect: Object.assign((locator: any) => ({
  async toBeVisible() { expect(await locator.isVisible()).toBe(true); },
  async toBeInViewport() { expect(await locator.isVisible()).toBe(true); },
  async toContainText(text: string) { expect(await locator.textContent()).toContain(text); },
}), { poll: (read: () => Promise<unknown>) => ({
  async toBe(value: unknown) { expect(await read()).toBe(value); },
  async toEqual(value: unknown) { expect(await read()).toEqual(value); },
}) }) }));
import { taskDependencyResume } from "./task-dependency-resume.js";

interface FixtureOptions { priorRuns?: number; unrelatedActivity?: number; ownedActivity?: number; agentActivity?: number; missingActivity?: boolean; activePrior?: boolean;
  closedPanel?: "properties" | "toggle"; missingProperty?: boolean; missingStatusChoice?: boolean }
async function fixture(premature = false, options: FixtureOptions = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dependency-flow-"));
  const f = dependencyEvidenceFixture(), s = f.scope;
  const blocker = { ...f.created.blocker }, dependent = { ...f.created.dependent };
  const actions: string[] = [], owned: any[] = [], writes: unknown[] = [], reads: string[] = [];
  let completed = false, assigned = false, panelOpen = !options.closedPanel;
  const reference = () => /review reference is ([a-f0-9]{32})/.exec(blocker.description)?.[1];
  const output = () => JSON.stringify({ reference: reference(), blockerIdentifier: s.blockerIdentifier });
  const runs = () => assigned && (completed || premature) ? [structuredClone(f.finished.dependentRuns[0]!)] : [];
  const priorRuns = Array.from({ length: options.priorRuns ?? 0 }, (_, i) => ({ ...structuredClone(f.finished.agentRuns[0]!),
    id: `prior-${i}`, nativeIssueId: `prior-task-${i}`, contextSnapshot: { issueId: `prior-task-${i}` },
    startedAt: "2019-12-31T23:00:00Z", status: options.activePrior ? "running" : i % 2 ? "failed" : "succeeded" }));
  const activity = (count: number, entityId: string, agentId?: string) => Array.from({ length: count }, (_, i) => ({
    id: `${entityId}-activity-${i}`, companyId: s.companyId, entityType: "issue", entityId, agentId,
    actorType: agentId ? "agent" : "user", actorId: agentId ?? s.userId, action: "issue.observed" }));
  const taskDocument = () => ({ ...f.finished.document, body: output() });
  const revision = () => ({ ...f.finished.revision, body: output() });
  controls.create.mockImplementation(async (input: any) => {
    await input.beforeDispatch?.();
    const row = input.title.includes(" blocker ") ? blocker : dependent;
    Object.assign(row, { title: input.title, description: input.prompt });
    actions.push(`create:${row.id}`);
    return { issueId: row.id, submittedAtMs: Date.now() };
  });
  const locator = (key: string): any => ({
    key,
    filter(value: any) {
      if (key === '[data-slot="popover-content"]' && value?.has) {
        return locator(options.missingStatusChoice ? "missing-status-choice" : value.has.key);
      }
      return this;
    }, first() { return this; }, last() { return this; },
    locator() { return this; },
    getByRole(_role: string, options?: any) { return locator(options?.name ? String(options.name) : key); },
    async isVisible() {
      if (key.includes("data-property-row")) return panelOpen && !options.missingProperty;
      if (key === "Toggle side panel") return !panelOpen && options.closedPanel === "toggle";
      if (key.includes("Show properties")) return !panelOpen && options.closedPanel === "properties";
      return true;
    },
    async scrollIntoViewIfNeeded() { actions.push(`scroll:${key}`); },
    async fill(value: string) { actions.push(`fill:${key}:${value}`); },
    async click() {
      actions.push(`click:${key}`);
      if (key === "Toggle side panel" || key.includes("Show properties")) panelOpen = true;
      if (key === "missing-status-choice") throw new Error("missing_status_choice");
      if (key === "blocker-choice") dependent.blockedByIssueIds = [blocker.id];
      if (key === "Blocked") dependent.status = "blocked";
      if (key === "agent-choice") { assigned = true; dependent.assigneeAgentId = s.agentId; dependent.assigneeUserId = null; }
      if (key === "Done") {
        completed = true; blocker.status = "done"; blocker.completedAt = "2020-01-01T00:00:20.000Z";
        dependent.status = "done";
      }
    },
    async textContent() { return output(); },
  });
  const page: any = {
    locator(selector: string) { return locator(selector); },
    getByRole(_role: string, options?: any) {
      if (_role === "button" && options?.exact && ["Blocked", "Done"].includes(options.name)) return locator("missing-status-choice");
      const l = locator(options?.name ? String(options.name) : "buttons");
      l.filter = (options: any) => options?.hasText === blocker.title ? locator("blocker-choice")
        : options?.hasText === "Fixture agent" ? locator("agent-choice") : l;
      return l;
    },
    getByPlaceholder(name: string) { return locator(name); },
    getByTestId(name: string) { return locator(name); },
    async goto(url: string) { actions.push(`goto:${url}`); }, async reload() { actions.push("reload"); },
  };
  const api: any = { origin: "https://qa.example.test", async get(route: string) {
    reads.push(route);
    if (route === `/api/issues/${s.blockerId}`) return structuredClone(blocker);
    if (route === `/api/issues/${s.dependentId}`) return structuredClone(dependent);
    if (route === `/api/issues/${s.blockerId}/runs`) return [];
    if (route === `/api/issues/${s.dependentId}/runs`) return runs().map(r => ({ runId: r.id }));
    if (route.includes("/heartbeat-runs?")) return [...runs(), ...structuredClone(priorRuns)];
    if (route === "/api/heartbeat-runs/run") return runs()[0];
    if (route === `/api/issues/${s.blockerId}/activity`) return completed ? structuredClone(f.reopened.activity) : [];
    if (route === `/api/issues/${s.dependentId}/activity`) return activity(options.ownedActivity ?? 0, s.dependentId);
    if (route === `/api/companies/${s.companyId}/activity?agentId=${s.agentId}&limit=500`) {
      return options.missingActivity ? undefined : activity(options.agentActivity ?? 0, "prior-task", s.agentId);
    }
    if (route === `/api/companies/${s.companyId}/activity?limit=500`) return activity(options.unrelatedActivity ?? 0, "unrelated-task").slice(0, 500);
    if (route === `/api/issues/${s.dependentId}/documents`) return completed ? [taskDocument()] : [];
    if (route.endsWith("/documents/dependency-proof")) return taskDocument();
    if (route.endsWith("/revisions/revision")) return revision();
    throw new Error(`unexpected_read:${route}`);
  }, async post(...args: unknown[]) { writes.push(args); throw new Error("unexpected_mutation"); },
  async patch(...args: unknown[]) { writes.push(args); throw new Error("unexpected_mutation"); } };
  const context = { page, api, company: { id: s.companyId, issuePrefix: "QA" }, user: { id: s.userId }, environmentId: s.environmentId,
    capabilities: ["company", "board-user", "task-write", "agent"], agent: { id: s.agentId, name: "Fixture agent", provider: s.provider, model: s.model, runtimeMode: "native" } } as JourneyContext;
  const session = { own: vi.fn(async resource => { owned.push(resource); }) } as unknown as TargetSession;
  const evidence = { checks: [] } as unknown as JourneyEvidence;
  return { directory, context, session, evidence, actions, owned, writes, reads };
}
afterEach(() => { vi.useRealTimers(); controls.create.mockReset(); });
describe("dependency browser flow orchestration", () => {
  it.each((["provider", "model"] as const).flatMap(field => [
    [field, "missing", undefined], [field, "null", null], [field, "empty", ""], [field, "blank", " \t "],
  ] as const))("rejects a %s identity that is %s before observation or task work", async (field, _kind, value) => {
    const f = await fixture();
    Object.assign(f.context.agent!, { [field]: value });
    const get = vi.spyOn(f.context.api, "get").mockRejectedValue(new Error("preflight_read_attempted"));
    try {
      await expect(taskDependencyResume(f.context, f.session, "journey-123-abcdef01", f.evidence,
        { deadlineAt: Date.now() + 60_000, directory: f.directory })).rejects.toMatchObject({
        outcome: "unsupported", code: "dependency_execution_identity_unavailable",
      });
      expect(get).not.toHaveBeenCalled(); expect(controls.create).not.toHaveBeenCalled();
      expect(f.actions).toEqual([]); expect(f.owned).toEqual([]); expect(f.writes).toEqual([]);
      expect(f.evidence.checks).toEqual([]);
      expect(JSON.parse(await readFile(path.join(f.directory, "task-dependency-observations.json"), "utf8"))).toHaveProperty("stage", "prerequisites");
      expect(JSON.parse(await readFile(path.join(f.directory, "observation-read-failures.json"), "utf8"))).toEqual({ failures: [] });
    } finally { await rm(f.directory, { recursive: true, force: true }); }
  });
  it.each([
    ["empty history", {}],
    ["completed earlier campaign runs", { priorRuns: 3 }],
    ["more than 100 earlier campaign runs", { priorRuns: 150 }],
    ["more than 500 unrelated company events", { unrelatedActivity: 800 }],
    ["more than 500 owned task events", { ownedActivity: 600 }],
    ["prior agent events", { priorRuns: 2, agentActivity: 300 }],
  ] as const)("uses browser actions with %s and never writes output through API observations", async (_name, options) => {
    const f = await fixture(false, options); vi.useFakeTimers(); vi.setSystemTime(new Date("2020-01-01T00:00:00Z"));
    try {
      const operation = taskDependencyResume(f.context, f.session, "journey-123-abcdef01", f.evidence,
        { deadlineAt: Date.now() + 60_000, directory: f.directory });
      await vi.advanceTimersByTimeAsync(11_000); await operation;
      expect(f.evidence.checks).toHaveLength(8); expect(f.evidence.checks.every(check => check.passed)).toBe(true);
      expect(f.writes).toEqual([]);
      expect(f.actions.indexOf("click:Blocked")).toBeLessThan(f.actions.indexOf("click:agent-choice"));
      expect(f.actions.indexOf("click:agent-choice")).toBeLessThan(f.actions.indexOf("click:Done"));
      expect(f.owned).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "issue", id: "blocker", journeyId: "task-dependency-resume" }),
        expect.objectContaining({ kind: "issue", id: "dependent", journeyId: "task-dependency-resume" }),
      ]));
      const saved = JSON.parse(await readFile(path.join(f.directory, "task-dependency-observations.json"), "utf8"));
      expect(saved.stage).toBe("complete"); expect(saved.scope.prompt).not.toContain(saved.scope.reference);
      expect(saved.waiting.at(-1).observedAt - saved.waiting[0].observedAt).toBeGreaterThanOrEqual(10_000);
      expect(saved.startingAgentRuns).toHaveLength("priorRuns" in options ? options.priorRuns : 0);
      expect(saved.reopened.agentRuns).toHaveLength(saved.startingAgentRuns.length + 1);
      expect(f.reads.some(route => route.startsWith("/api/heartbeat-runs/prior-"))).toBe(false);
      expect(f.reads).toContain("/api/issues/blocker/activity"); expect(f.reads).toContain("/api/issues/dependent/activity");
      expect(f.reads).not.toContain("/api/companies/company/activity?limit=500");
    } finally { await rm(f.directory, { recursive: true, force: true }); }
  });
  it.each(["properties", "toggle"] as const)("opens a closed properties pane through its %s control before linking", async closedPanel => {
    const f = await fixture(false, { closedPanel }); vi.useFakeTimers(); vi.setSystemTime(new Date("2020-01-01T00:00:00Z"));
    try {
      const operation = taskDependencyResume(f.context, f.session, "journey-123-abcdef01", f.evidence,
        { deadlineAt: Date.now() + 60_000, directory: f.directory });
      await vi.advanceTimersByTimeAsync(11_000); await operation;
      expect(f.evidence.checks).toHaveLength(8); expect(f.evidence.checks.every(check => check.passed)).toBe(true);
      const opener = f.actions.findIndex(action => action.startsWith("click:") && (action.includes("Show properties") || action === "click:Toggle side panel"));
      expect(opener).toBeGreaterThanOrEqual(0); expect(opener).toBeLessThan(f.actions.indexOf("click:blocker-choice"));
      expect(f.actions.some(action => action.startsWith("scroll:[data-property-row]:not([inert] *):not([aria-hidden=\"true\"] *)"))).toBe(true);
      expect(f.writes).toEqual([]);
    } finally { await rm(f.directory, { recursive: true, force: true }); }
  });
  it.each([
    ["missing property", { missingProperty: true }, "link_blocker"],
    ["missing matching status glyph", { missingStatusChoice: true }, "set_dependent_blocked"],
  ] as const)("fails closed on %s before agent assignment or blocker completion", async (_name, options, stage) => {
    const f = await fixture(false, options);
    try {
      await expect(taskDependencyResume(f.context, f.session, "journey-123-abcdef01", f.evidence,
        { deadlineAt: Date.now() + 60_000, directory: f.directory })).rejects.toThrow();
      expect(f.actions).not.toContain("click:agent-choice"); expect(f.actions).not.toContain("click:Done"); expect(f.writes).toEqual([]);
      expect(JSON.parse(await readFile(path.join(f.directory, "task-dependency-observations.json"), "utf8"))).toHaveProperty("stage", stage);
    } finally { await rm(f.directory, { recursive: true, force: true }); }
  });
  it.each([
    ["truncated agent activity", { agentActivity: 500 }, "dependency_activity_coverage_unavailable"],
    ["missing agent activity", { missingActivity: true }, "dependency_activity_coverage_unavailable"],
    ["active earlier work", { priorRuns: 1, activePrior: true }, "dependency_starting_agent_not_idle"],
    ["saturated run history", { priorRuns: 1000 }, "dependency_run_coverage_unavailable"],
  ] as const)("rejects %s before completing the blocker", async (_name, options, code) => {
    const f = await fixture(false, options);
    try {
      await expect(taskDependencyResume(f.context, f.session, "journey-123-abcdef01", f.evidence,
        { deadlineAt: Date.now() + 60_000, directory: f.directory })).rejects.toThrow(code);
      expect(f.actions).not.toContain("click:Done"); expect(f.writes).toEqual([]);
    } finally { await rm(f.directory, { recursive: true, force: true }); }
  });
  it("premature work fails before the browser completes the blocker and preserves its observations", async () => {
    const f = await fixture(true);
    try {
      await expect(taskDependencyResume(f.context, f.session, "journey-123-abcdef01", f.evidence,
        { deadlineAt: Date.now() + 60_000, directory: f.directory })).rejects.toThrow("dependency_ran_before_blocker_completed");
      expect(f.actions).not.toContain("click:Done"); expect(f.writes).toEqual([]);
      expect(JSON.parse(await readFile(path.join(f.directory, "task-dependency-observations.json"), "utf8"))).toHaveProperty("stage", "observe_blocked_wait");
      expect(JSON.parse(await readFile(path.join(f.directory, "observation-read-failures.json"), "utf8"))).toEqual({ failures: [] });
    } finally { await rm(f.directory, { recursive: true, force: true }); }
  });
});
