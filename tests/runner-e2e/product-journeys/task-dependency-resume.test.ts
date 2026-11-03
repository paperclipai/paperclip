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
  async toContainText(text: string) { expect(await locator.textContent()).toContain(text); },
}), { poll: (read: () => Promise<unknown>) => ({
  async toBe(value: unknown) { expect(await read()).toBe(value); },
  async toEqual(value: unknown) { expect(await read()).toEqual(value); },
}) }) }));
import { taskDependencyResume } from "./task-dependency-resume.js";

async function fixture(premature = false) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dependency-flow-"));
  const f = dependencyEvidenceFixture(), s = f.scope;
  const blocker = { ...f.created.blocker }, dependent = { ...f.created.dependent };
  const actions: string[] = [], owned: any[] = [], writes: unknown[] = [];
  let completed = false, assigned = false;
  const reference = () => /review reference is ([a-f0-9]{32})/.exec(blocker.description)?.[1];
  const output = () => JSON.stringify({ reference: reference(), blockerIdentifier: s.blockerIdentifier });
  const runs = () => assigned && (completed || premature) ? [structuredClone(f.finished.dependentRuns[0]!)] : [];
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
    filter() { return this; }, first() { return this; }, last() { return this; },
    locator() { return this; },
    getByRole(_role: string, options?: any) { return locator(options?.name ? String(options.name) : key); },
    async isVisible() { return true; },
    async fill(value: string) { actions.push(`fill:${key}:${value}`); },
    async click() {
      actions.push(`click:${key}`);
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
      const l = locator(options?.name ? String(options.name) : "buttons");
      l.filter = (options: any) => options?.hasText === blocker.title ? locator("blocker-choice")
        : options?.hasText === "Fixture agent" ? locator("agent-choice") : l;
      return l;
    },
    getByPlaceholder(name: string) { return locator(name); },
    async goto(url: string) { actions.push(`goto:${url}`); }, async reload() { actions.push("reload"); },
  };
  const api: any = { origin: "https://qa.example.test", async get(route: string) {
    if (route === `/api/issues/${s.blockerId}`) return structuredClone(blocker);
    if (route === `/api/issues/${s.dependentId}`) return structuredClone(dependent);
    if (route === `/api/issues/${s.blockerId}/runs`) return [];
    if (route === `/api/issues/${s.dependentId}/runs` || route.includes("/heartbeat-runs?")) return runs().map(r => ({ runId: r.id }));
    if (route === "/api/heartbeat-runs/run") return runs()[0];
    if (route.includes("/activity?")) return completed ? structuredClone(f.reopened.activity) : [];
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
  return { directory, context, session, evidence, actions, owned, writes };
}
afterEach(() => { vi.useRealTimers(); controls.create.mockReset(); });
describe("dependency browser flow orchestration", () => {
  it("measures browser actions and waits before completing the blocker; API observations never write the output", async () => {
    const f = await fixture(); vi.useFakeTimers(); vi.setSystemTime(new Date("2020-01-01T00:00:00Z"));
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
