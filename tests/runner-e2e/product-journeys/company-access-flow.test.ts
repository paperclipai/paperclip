import { describe, expect, it, vi } from "vitest";
import { companyAccessIsolation } from "./company-access-flow.js";
import type { CompanyAccessFixture, CreatedIsolationTask, IsolationWorkspace } from "./company-access-contract.js";
import type { JourneyContext, JourneyEvidence, TargetSession } from "./types.js";
vi.mock("@playwright/test", () => ({ expect: Object.assign(
  (locator: { visible: boolean; text?: string }) => ({
    async toBeVisible() { expect(locator.visible).toBe(true); },
    async toContainText(value: string) { expect(locator.text).toContain(value); },
  }), { poll: (read: () => Promise<unknown>) => ({ async toBe(value: unknown) { expect(await read()).toBe(value); } }) },
) }));
function system(newPrimaryRun: boolean) {
  const primary: IsolationWorkspace = { stackId: "one", stackSlug: "one", companyId: "company-one", origin: "https://one.example.test", displayName: "One", issuePrefix: "ONE" };
  const secondary: IsolationWorkspace = { stackId: "two", stackSlug: "two", companyId: "company-two", origin: "https://two.example.test", displayName: "Two", issuePrefix: "TWO" };
  const workspaces = { primary, secondary }, actors = { primary: { kind: "agent" as const, id: "agent-one", companyId: primary.companyId }, secondary: { kind: "agent" as const, id: "agent-two", companyId: secondary.companyId } };
  const tasks = new Map<string, CreatedIsolationTask>(); let next = 0, current = new URL(primary.origin), menu = false, created = false;
  const task = (scope: "primary" | "secondary", title: string, description: string, agentId: string | null) => {
    const value: CreatedIsolationTask = { id: `task-${++next}`, companyId: workspaces[scope].companyId, title, description, identifier: `${workspaces[scope].issuePrefix}-${next}`,
      createdByAgentId: agentId, createdByUserId: agentId ? null : "owner", status: "backlog", assigneeAgentId: null, assigneeUserId: null };
    tasks.set(value.id, value); return structuredClone(value);
  };
  const historical = { id: "historical", companyId: primary.companyId, agentId: actors.primary.id, status: "succeeded" };
  const apis = Object.fromEntries((["primary", "secondary"] as const).map(scope => [scope, {
    origin: workspaces[scope].origin,
    async post(_route: string, body: { title: string; description: string }) { return task(scope, body.title, body.description, null); },
    async get(route: string) {
      const url = new URL(route, workspaces[scope].origin);
      if (url.pathname === "/api/companies") return [{ id: workspaces[scope].companyId }];
      if (url.pathname.endsWith("/heartbeat-runs")) return scope === "secondary" ? [] : [historical, ...(created && newPrimaryRun ? [{ ...historical, id: "new-outside-task" }] : [])];
      if (url.pathname.endsWith("/issues")) return [...tasks.values()].filter(row => row.companyId === workspaces[scope].companyId && row.title.includes(url.searchParams.get("q") ?? ""));
      if (url.pathname.endsWith("/runs")) return [];
      const row = tasks.get(url.pathname.split("/").at(-1)!);
      if (!row || row.companyId !== workspaces[scope].companyId) throw new Error("wrong_fixture_scope");
      return structuredClone(row);
    },
  }])) as unknown as { primary: JourneyContext["api"]; secondary: JourneyContext["api"] };
  const page = {
    async goto(url: string) { current = new URL(url); }, url: () => current.href, async reload() {},
    async waitForURL(accept: (url: URL) => boolean) { expect(accept(current)).toBe(true); },
    getByRole(role: string, options: { name: string }) {
      const workspace = current.origin === primary.origin ? primary : secondary;
      return { visible: role === "button" ? options.name === `Open ${workspace.displayName} organization switcher`
        : [...tasks.values()].some(row => row.companyId === workspace.companyId && row.title === options.name), async click() { menu = true; } };
    },
    locator() { return { async all() { return !menu ? [] : Object.values(workspaces).map(workspace => ({ visible: true, text: workspace.displayName,
      async isVisible() { return true; }, async getAttribute() { return `https://portal.example.test/stacks/${workspace.stackSlug}/enter`; },
      async click() { current = new URL(workspace.origin); menu = false; },
    })); } }; },
  } as unknown as JourneyContext["page"];
  const fixture: CompanyAccessFixture = {
    portalOrigin: "https://portal.example.test", primary, secondary, secondaryApi: apis.secondary, restrictedActors: actors,
    async createSecondaryTask(title, description) { return task("secondary", title, description, null); },
    async restrictedRequest(actor, scope, _method, issueId) {
      if (actor !== scope) return { status: 403, contentLeaked: false, task: null };
      const row = tasks.get(issueId)!; return { status: 200, contentLeaked: false, task: { id: row.id, companyId: row.companyId, description: row.description } };
    },
    async restrictedCreate(actor, scope, title, description) {
      if (actor !== scope) return { status: 403, contentLeaked: false, task: null };
      created = true; return { status: 201, contentLeaked: false, task: task(scope, title, description, actors[actor].id) };
    },
    async revokeCredentials() { return { revoked: true, deniedStatuses: { primary: 401, secondary: 401 } }; },
  };
  const context = { page, api: apis.primary, company: { id: primary.companyId, issuePrefix: primary.issuePrefix }, fixtures: { companyAccess: fixture } } as JourneyContext;
  const evidence = { checks: [] } as unknown as JourneyEvidence;
  const session = { async own() {} } as unknown as TargetSession;
  return { context, evidence, session };
}
describe("isolation agent work observation", () => {
  it("rejects a new primary run outside all four owned tasks", async () => {
    const f = system(true);
    await expect(companyAccessIsolation(f.context, f.session, "journey-123-abcd1234", f.evidence)).rejects.toThrow("no_agent_work");
    expect(f.evidence.checks).toContainEqual({ id: "no-agent-work", passed: false });
  });
  it("accepts unchanged historical primary runs and zero work on owned tasks", async () => {
    const f = system(false); await companyAccessIsolation(f.context, f.session, "journey-123-abcd1234", f.evidence);
    expect(f.evidence.checks).toContainEqual({ id: "no-agent-work", passed: true });
  });
});
