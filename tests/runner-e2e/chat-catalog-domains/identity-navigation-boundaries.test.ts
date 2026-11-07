import { describe, expect, it } from "vitest";
import { assertDistinctMissingLinkFixtures, navigationBoundaryIdentityCases } from "./identity-navigation-boundaries.js";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
import type { IdentityObservation } from "./identity-support.js";
function valid(scenarioId: string): IdentityObservation {
  const similar = { id: "similar", identifier: "ACO-2", title: "Launch draft", companyId: "acorn", status: "backlog" };
  const o: IdentityObservation = { scenarioId, origin: "http://fixture.invalid", companyId: "acorn", leadId: "ceo", company: { id: "acorn" }, companies: [], agents: [], interactions: [],
    tasks: [similar], projects: [], goals: [], comments: [], documents: [], revisions: [], links: [], runs: [], humanQueries: [], reply: "The original task was removed; the other task is a separate record.", activity: [], state: {} };
  if (scenarioId.endsWith("broken-link")) {
    Object.assign(o.state, { stale: { id: "stale" }, similar, restricted: { id: "private" }, restrictedMarker: "Private Orchid", deletedStatus: 404, afterDeletedStatus: 404,
      missingVisible: true, stalePathPreserved: true, similarNotOpened: true, similarAfter: structuredClone(similar), observerRestrictedStatus: 404, observerRestrictedHidden: true });
    o.activity.push({ id: "deleted", action: "issue.deleted", entityId: "stale", actorType: "user" });
  } else {
    Object.assign(o.state, { publication: { id: "publication", title: "New release" }, humanId: "alex", primaryVisible: true, secondaryVisible: true, samePublicationAcrossCompanies: true,
      agentDismissStatus: 403, beforeHumanPublicationId: "publication", dismissRequestStatus: 204, afterHumanPublication: null, secondaryAfterReloadHidden: true,
      observerBeforePublicationId: "publication", observerAfterPublicationId: "publication", observerStillVisible: true, invalidAuditCompanyStatus: 404 });
    o.activity.push({ id: "dismiss", action: "announcement.dismissed", entityId: "publication", actorType: "user", actorId: "alex" });
  }
  return o;
}
describe("real missing link and instance-wide personal dismissal", () => {
  for (const d of navigationBoundaryIdentityCases) {
    it(`${d.scenarioId}: valid and missing observations`, () => { const o = valid(d.scenarioId); expect(d.grade(o), JSON.stringify(d.grade(o))).toMatchObject({ passed: true }); expect(d.grade(undefined).passed).toBe(false); });
    it(`${d.scenarioId}: wrong audience or replacement`, () => { const o = valid(d.scenarioId); if (d.scenarioId.endsWith("broken-link")) o.state.similarNotOpened = false; else o.state.observerAfterPublicationId = undefined; expect(d.grade(o).passed).toBe(false); });
    it(`${d.scenarioId}: plausible prose without persisted proof`, () => { const o = valid(d.scenarioId); o.activity = []; expect(d.grade(o).passed).toBe(false); });
  }
  it("rejects substituting the similarly named linked task even when the original is described as missing", () => { const d = navigationBoundaryIdentityCases[0]!; const o = valid(d.scenarioId); o.links = ["/ACO/issues/ACO-2"]; expect(d.grade(o).passed).toBe(false); });
  it("rejects company content deletion disguised as personal dismissal", () => { const d = navigationBoundaryIdentityCases[1]!; const o = valid(d.scenarioId); o.activity.push({ id: "bad", action: "announcement.deleted" }); expect(d.grade(o).passed).toBe(false); });
});

it("actual broken-link setup exposes only the supplied URL and factual distinct-project context", async () => {
  const writes: Array<{ path: string; body?: Record<string, unknown> }> = [], deleted: string[] = []; let projectId = 0, taskId = 0;
  const source = { id: "standing-chat" }; const saved = new Map<string, Record<string, unknown>>();
  const ctx = { input: { nonce: "fixture", fixtures: { company: { id: "company", issuePrefix: "ACO" }, agent: { id: "ceo" } },
    page: { context: () => ({ browser: () => null }) }, api: { baseURL: "http://fixture.invalid",
      async post(path: string, body?: Record<string, unknown>) { writes.push({ path, body }); const row = path.endsWith("/projects") ? { id: `project-${++projectId}` } : path.endsWith("/issues") ? { ...body, id: `task-${++taskId}`, identifier: `ACO-${taskId}` } : {}; if ("id" in row) saved.set(String(row.id), row); return row; },
      async get(path: string) { return saved.get(path.split("/").at(-1)!); },
      async patch(path: string, body: Record<string, unknown>) { writes.push({ path, body }); return body; }, async delete(path: string) { deleted.push(path); } } },
    refreshIssue: async () => {}, issue: () => source } as unknown as ChatCatalogContext;
  await expect(navigationBoundaryIdentityCases[0]!.setup(ctx)).rejects.toThrow("independent real-user setup");
  expect(writes.find(x => x.path === "/api/issues/standing-chat")?.body?.description).toBe("The person supplied this old task link: http://fixture.invalid/ACO/issues/ACO-1?tab=activity");
  const tasks = writes.filter(x => x.path.endsWith("/issues")); expect(tasks[0]?.body?.projectId).not.toBe(tasks[1]?.body?.projectId);
  expect(tasks[1]?.body?.title).toBe("Launch website draft revision");
  expect(tasks[1]?.body?.description).toBe("Current draft for the Archived launch context project."); expect(deleted).toEqual(["/api/issues/task-1"]);
});

it("rejects public title-dedup alias and wrong-project readbacks before deleting the old task", () => {
  const original = { id: "first", projectId: "launch" }, separate = { id: "second", projectId: "other" };
  expect(() => assertDistinctMissingLinkFixtures(original, separate, "launch", "other")).not.toThrow();
  expect(() => assertDistinctMissingLinkFixtures(original, original, "launch", "other")).toThrow("distinct saved");
  expect(() => assertDistinctMissingLinkFixtures(original, { ...separate, projectId: "launch" }, "launch", "other")).toThrow("distinct saved");
});
