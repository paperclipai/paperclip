import { describe, expect, it } from "vitest";
import { callResponsibilityTool, RESPONSIBILITIES_TURNED_OFF_MESSAGE } from "../services/responsibility-tools.js";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const AREA = "22222222-2222-4222-8222-222222222222";
const RESPONSIBILITY = "33333333-3333-4333-8333-333333333333";
const ROUTINE = "44444444-4444-4444-8444-444444444444";
const TASK = "55555555-5555-4555-8555-555555555555";

function rollup(overrides: Record<string, unknown> = {}) {
  return {
    health: "on_track", computedHealth: "on_track", healthOverridden: false, metric: null,
    statusSentence: "12 of 20 investors contacted, 60% of target", workSummary: [{ text: "2 tasks blocked" }],
    projects: 1, routines: 2, openTasks: 3, blockedTasks: 2, agentTasks: 1, userTasks: 2, doneTasks: 4,
    nextDueAt: null, overdueProjects: [], ...overrides,
  };
}

function responsibility(overrides: Record<string, unknown> = {}) {
  return {
    id: RESPONSIBILITY, companyId: COMPANY, ownerUserId: "owner", areaId: AREA, title: "Fundraising",
    description: null, standard: "Every investor conversation has a next step", metricKind: "volume",
    metricName: "Investors contacted", metricUnit: null, metricTarget: 20, metricLow: null, metricHigh: null,
    metricCurrent: 12, metricDirection: "at_least", metricUpdatedAt: null, runByAgentId: null, status: "active",
    source: "manual", evidence: null, healthOverride: null, healthNote: null, sortOrder: 0, proposedByAgentId: null,
    confirmedAt: null, createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z",
    rollup: rollup(), ...overrides,
  };
}

/** Records each request and answers from a path table; unknown paths are a test failure. */
function fakeApi(routes: Record<string, { status?: number; body: unknown; headers?: Record<string, string> }>) {
  const calls: Array<{ url: string; auth: string | null; method?: string; body?: unknown }> = [];
  const fetcher = (async (url: string | URL, init?: RequestInit) => {
    const href = String(url);
    const method = init?.method ?? "GET";
    calls.push({
      url: href, auth: new Headers(init?.headers).get("authorization"),
      ...(method !== "GET" ? { method, body: init?.body ? JSON.parse(String(init.body)) : undefined } : {}),
    });
    const path = href.replace("http://paperclip.test/api", "");
    // A route is keyed by path, or by "METHOD path" when one path takes several methods.
    const route = routes[`${method} ${path}`] ?? routes[path];
    if (!route) throw new Error(`unexpected request ${path}`);
    return new Response(JSON.stringify(route.body), { status: route.status ?? 200, headers: { "content-type": "application/json", ...route.headers } });
  }) as typeof fetch;
  return { calls, fetcher };
}

const ISSUE = "77777777-7777-4777-8777-777777777777";
const AGENT = "88888888-0000-4000-8000-000000000000";
const base = { apiUrl: "http://paperclip.test/api", token: "agent-token", companyId: COMPANY, issueId: ISSUE, agentId: AGENT, companyPrefix: "PAP" };

describe("responsibility tools", () => {
  it("groups a person's responsibilities by area and reports uncovered work", async () => {
    const proposed = responsibility({ id: "66666666-6666-4666-8666-666666666666", title: "Hiring", status: "proposed", areaId: null, evidence: "Owner said so", proposedByAgentId: "agent-1" });
    const api = fakeApi({
      [`/companies/${COMPANY}/responsibilities?includeLetGo=false`]: { body: {
        ownerUserId: "owner",
        areas: [{ id: AREA, title: "Money", description: null, status: "active", activeResponsibilities: 1, byHealth: {} }],
        responsibilities: [responsibility()],
        proposed: [proposed],
        totals: { byHealth: { behind: 0, at_risk: 0, on_track: 1, not_measured: 0 }, openTasks: 3, agentTasks: 1, userTasks: 2, blockedTasks: 2, projects: 1, lateProjects: 0 },
        loose: {
          projectCount: 0, openTaskCount: 1, routineCount: 1, projects: [],
          tasks: [{ id: TASK, identifier: "PAP-9", title: "Loose task", status: "todo", assigneeAgentId: null, assigneeUserId: null, projectId: null, updatedAt: "2026-11-01T00:00:00.000Z" }],
          routines: [{ id: ROUTINE, title: "Weekly digest", status: "active", assigneeAgentId: "agent-1", projectId: null }],
        },
      } },
    });

    const result = await callResponsibilityTool({ ...base, name: "list_responsibilities", arguments: {} }, api.fetcher);

    // The route picks the owner (the person the run works for); the tool sends none and authenticates as the run.
    expect(api.calls).toEqual([{ url: `http://paperclip.test/api/companies/${COMPANY}/responsibilities?includeLetGo=false`, auth: "Bearer agent-token" }]);
    expect(result).toMatchObject({
      ownerUserId: "owner",
      areas: [{ id: AREA, title: "Money", responsibilities: [{
        id: RESPONSIBILITY, title: "Fundraising", health: "on_track", bar: { kind: "volume", name: "Investors contacted", target: 20, current: 12 },
        counts: { projects: 1, routines: 2, openTasks: 3, blockedTasks: 2, doneTasks: 4 }, href: `/PAP/responsibilities/${RESPONSIBILITY}`,
      }] }],
      withoutArea: [{ title: "Hiring", status: "proposed", evidence: "Owner said so" }],
      totals: { active: 1, proposed: 1, letGo: 0 },
      uncoveredWork: { routineCount: 1, openTaskCount: 1, routines: [{ id: ROUTINE, title: "Weekly digest" }], tasks: [{ identifier: "PAP-9" }] },
    });
    expect(result).not.toHaveProperty("guidance");
  });

  it("says the list is empty rather than inventing responsibilities", async () => {
    const api = fakeApi({
      [`/companies/${COMPANY}/responsibilities?includeLetGo=false&ownerUserId=someone`]: { body: {
        ownerUserId: "someone", areas: [], responsibilities: [], proposed: [],
        totals: { byHealth: {}, openTasks: 0, agentTasks: 0, userTasks: 0, blockedTasks: 0, projects: 0, lateProjects: 0 },
        loose: { projectCount: 0, openTaskCount: 0, routineCount: 0, projects: [], tasks: [], routines: [] },
      } },
    });
    const result = await callResponsibilityTool({ ...base, name: "list_responsibilities", arguments: { ownerUserId: "someone" } }, api.fetcher);
    expect(result).toMatchObject({ ownerUserId: "someone", areas: [], withoutArea: [], guidance: expect.stringContaining("no responsibilities yet") });
  });

  it("scopes totals to one area, hides archived areas unless asked, and notices hidden proposals", async () => {
    const ARCHIVED = "99999999-0000-4000-8000-000000000001";
    const overview = (overrides: Record<string, unknown> = {}) => ({
      ownerUserId: "owner",
      areas: [
        { id: AREA, title: "Money", description: null, status: "active" },
        { id: ARCHIVED, title: "Old", description: null, status: "archived" },
      ],
      responsibilities: [
        responsibility(),
        responsibility({ id: "66666666-6666-4666-8666-666666666667", title: "Legacy", areaId: ARCHIVED, rollup: rollup({ health: "behind" }) }),
      ],
      proposed: [],
      totals: { byHealth: { behind: 1, at_risk: 0, on_track: 1, not_measured: 0 }, openTasks: 9, agentTasks: 0, userTasks: 0, blockedTasks: 2, projects: 4, lateProjects: 1 },
      loose: { projectCount: 0, openTaskCount: 0, routineCount: 0, projects: [], tasks: [], routines: [] },
      ...overrides,
    });
    const api = fakeApi({ [`/companies/${COMPANY}/responsibilities?includeLetGo=false`]: { body: overview() } });
    const all = await callResponsibilityTool({ ...base, name: "list_responsibilities", arguments: {} }, api.fetcher) as Record<string, any>;
    expect(all.areas.map((area: { id: string }) => area.id)).toEqual([AREA]);
    expect(all.withoutArea.map((row: { title: string }) => row.title)).toEqual(["Legacy"]);
    expect(all.totals).toMatchObject({ scope: "person", active: 2, openTasks: 9 });

    const one = await callResponsibilityTool({ ...base, name: "list_responsibilities", arguments: { areaId: AREA } }, api.fetcher) as Record<string, any>;
    expect(one.totals).toEqual({ scope: "area", active: 1, proposed: 0, letGo: 0, activeByHealth: { behind: 0, at_risk: 0, on_track: 1, not_measured: 0 } });
    expect(one).not.toHaveProperty("uncoveredWork");

    const onlyProposals = fakeApi({ [`/companies/${COMPANY}/responsibilities?includeLetGo=false`]: {
      body: overview({ responsibilities: [], proposed: [responsibility({ status: "proposed" })] }),
    } });
    const hidden = await callResponsibilityTool({ ...base, name: "list_responsibilities", arguments: { includeProposed: false } }, onlyProposals.fetcher);
    expect(hidden).toMatchObject({ guidance: expect.stringContaining("1 proposed responsibilities, hidden") });
  });

  it("reads one responsibility with its filed items and latest status report", async () => {
    const api = fakeApi({
      [`/responsibilities/${RESPONSIBILITY}`]: { body: {
        ...responsibility(), area: { id: AREA, title: "Money", status: "active" },
        skills: [{ id: "skill-1", key: "paperclipai/research", slug: "research", name: "Research", description: null, tagline: null, iconUrl: null, color: null, agentIds: ["agent-1"] }],
        artifacts: [], artifactsTotal: 0, artifactsTruncated: false,
        projects: [],
        tasks: [{ linkId: "link-1", membership: "direct", id: TASK, identifier: "PAP-9", title: "Pitch deck", status: "todo", assigneeAgentId: null, assigneeUserId: null, projectId: null, updatedAt: "2026-11-01T00:00:00.000Z" }],
        tasksTruncated: false,
        routines: [{ linkId: "link-2", membership: "direct", id: ROUTINE, title: "Weekly digest", status: "active", assigneeAgentId: "agent-1", projectId: null, lastRun: null }],
      } },
      [`/responsibilities/${RESPONSIBILITY}/status-report`]: { body: { current: { status: "on_track", message: "Fine" }, reporterAgentId: "agent-1", updateRequested: false, history: [] } },
    });
    const result = await callResponsibilityTool({ ...base, name: "get_responsibility", arguments: { responsibilityId: RESPONSIBILITY } }, api.fetcher);
    expect(result).toMatchObject({
      id: RESPONSIBILITY, ownerUserId: "owner", area: { title: "Money" }, workSummary: ["2 tasks blocked"],
      tasks: [{ linkId: "link-1", membership: "direct", identifier: "PAP-9" }],
      routines: [{ linkId: "link-2", title: "Weekly digest" }],
      skills: [{ id: "skill-1", name: "Research", agentIds: ["agent-1"] }],
      statusReport: { current: { status: "on_track" }, reporterAgentId: "agent-1" },
    });
  });

  it("finds where a task is filed by its identifier", async () => {
    const api = fakeApi({
      "/issues/PAP-9": { body: { id: TASK, identifier: "PAP-9" } },
      [`/companies/${COMPANY}/responsibility-links/lookup?issueId=${TASK}`]: { body: { responsibilities: [
        { id: RESPONSIBILITY, title: "Fundraising", areaId: AREA, ownerUserId: "owner", via: "project" },
      ] } },
    });
    const result = await callResponsibilityTool({ ...base, name: "find_responsibilities_for", arguments: { kind: "task", id: "PAP-9" } }, api.fetcher);
    expect(result).toEqual({
      item: { kind: "task", id: TASK, identifier: "PAP-9" },
      responsibilities: [{ id: RESPONSIBILITY, title: "Fundraising", areaId: AREA, ownerUserId: "owner", via: "project", href: `/PAP/responsibilities/${RESPONSIBILITY}` }],
    });
  });

  it("reports the feature as turned off, not as an empty list", async () => {
    const api = fakeApi({
      [`/companies/${COMPANY}/responsibility-links/lookup?routineId=${ROUTINE}`]: { status: 404, body: { error: "Responsibilities are not enabled", code: "responsibilities_disabled" } },
    });
    await expect(callResponsibilityTool({ ...base, name: "find_responsibilities_for", arguments: { kind: "routine", id: ROUTINE } }, api.fetcher))
      .rejects.toMatchObject({ status: 404, message: RESPONSIBILITIES_TURNED_OFF_MESSAGE, details: { code: "responsibilities_disabled" } });
  });

  it("passes route denials through and refuses malformed input before calling the API", async () => {
    const api = fakeApi({
      [`/responsibilities/${RESPONSIBILITY}`]: { status: 403, body: { error: "Responsibilities are outside this agent's authorization boundary" } },
      [`/responsibilities/${RESPONSIBILITY}/status-report`]: { status: 403, body: { error: "denied" } },
    });
    await expect(callResponsibilityTool({ ...base, name: "get_responsibility", arguments: { responsibilityId: RESPONSIBILITY } }, api.fetcher))
      .rejects.toMatchObject({ status: 403, message: "Responsibilities are outside this agent's authorization boundary" });
    await expect(callResponsibilityTool({ ...base, name: "find_responsibilities_for", arguments: { kind: "routine", id: "weekly" } }, api.fetcher))
      .rejects.toMatchObject({ status: 422 });
    await expect(callResponsibilityTool({ ...base, name: "list_responsibilities", arguments: { owner: "x" } }, api.fetcher)).rejects.toThrow();
  });

  describe("changes", () => {
    const emptyOverview = {
      ownerUserId: "owner", areas: [], responsibilities: [responsibility()], proposed: [],
      totals: { byHealth: {}, openTasks: 0, agentTasks: 0, userTasks: 0, blockedTasks: 0, projects: 0, lateProjects: 0 },
      loose: { projectCount: 0, openTaskCount: 0, routineCount: 0, projects: [], tasks: [], routines: [] },
    };

    it("creates a responsibility under an area by title, leaving the area to the server's transaction", async () => {
      const created = responsibility({ id: "88888888-8888-4888-8888-888888888888", title: "Hiring", areaId: "99999999-9999-4999-8999-999999999999", metricName: null });
      const api = fakeApi({
        [`/companies/${COMPANY}/responsibilities?includeLetGo=false`]: { body: emptyOverview },
        [`POST /companies/${COMPANY}/responsibilities`]: { body: created, headers: { "x-paperclip-dashboard-version": "version-9" } },
      });
      const result = await callResponsibilityTool({ ...base, name: "create_responsibility", arguments: { title: "Hiring", areaTitle: "people" } }, api.fetcher);
      expect(api.calls.filter((entry) => entry.method === "POST").map((entry) => entry.body)).toEqual([
        { title: "Hiring", areaTitle: "people" },
      ]);
      expect(result).toMatchObject({ created: true, responsibility: { title: "Hiring", status: "active" }, undo: expect.stringContaining("can undo it"), dashboardVersionId: "version-9" });
    });

    it("reuses a live responsibility with the same title instead of making a copy, and files what a retry asks", async () => {
      const api = fakeApi({ [`/companies/${COMPANY}/responsibilities?includeLetGo=false`]: { body: emptyOverview } });
      const result = await callResponsibilityTool({ ...base, name: "create_responsibility", arguments: { title: "  fundraising " } }, api.fetcher);
      expect(result).toMatchObject({ created: false, responsibility: { id: RESPONSIBILITY } });
      expect(api.calls.some((entry) => entry.method === "POST")).toBe(false);

      // A retry after the filing step failed files the items into the one that was saved.
      const retry = fakeApi({
        [`/companies/${COMPANY}/responsibilities?includeLetGo=false`]: { body: emptyOverview },
        [`POST /responsibilities/${RESPONSIBILITY}/file`]: { body: { filed: [{ link: { id: "l1" }, created: true }], unfiled: [] } },
      });
      expect(await callResponsibilityTool({ ...base, name: "create_responsibility", arguments: { title: "Fundraising", fileItems: [{ kind: "routine", id: ROUTINE }] } }, retry.fetcher))
        .toMatchObject({ created: false, filedItems: 1, undo: expect.stringContaining("cannot be undone") });
    });

    it("names the area and its destination on a delete card", async () => {
      const OTHER_AREA = "99999999-0000-4000-8000-000000000000";
      const api = fakeApi({
        [`/companies/${COMPANY}/responsibility-areas?includeArchived=true`]: { body: [{ id: AREA, title: "Money", status: "active" }, { id: OTHER_AREA, title: "Finance", status: "active" }] },
        [`GET /issues/${ISSUE}/interactions`]: { body: [] },
        [`POST /issues/${ISSUE}/interactions`]: { body: { id: "card-9" } },
      });
      await callResponsibilityTool({ ...base, name: "delete_area", arguments: { areaId: AREA, moveResponsibilitiesTo: OTHER_AREA } }, api.fetcher);
      expect(api.calls.find((entry) => entry.method === "POST")?.body).toMatchObject({
        title: 'Delete the area "Money"',
        payload: { prompt: 'Delete the area "Money" permanently?', detailsMarkdown: expect.stringContaining('move to "Finance"') },
      });
    });

    it("notes when a change is outside the Dashboard history and that a bar change is not undone there", async () => {
      const api = fakeApi({ [`PATCH /responsibilities/${RESPONSIBILITY}`]: { body: responsibility({ status: "proposed" }) } });
      const result = await callResponsibilityTool({ ...base, name: "update_responsibility", arguments: {
        responsibilityId: RESPONSIBILITY, bar: { kind: "volume", name: "Calls", target: 5 },
      } }, api.fetcher);
      expect(result).toMatchObject({ undo: expect.stringContaining("cannot be undone"), barNote: expect.stringContaining("old bar") });
      expect(result).not.toHaveProperty("dashboardVersionId");
    });

    it("maps a cleared bar to empty metric inputs and moves to an area by title", async () => {
      const api = fakeApi({
        [`PATCH /responsibilities/${RESPONSIBILITY}`]: { body: responsibility({ metricName: null }) },
      });
      await callResponsibilityTool({ ...base, name: "update_responsibility", arguments: { responsibilityId: RESPONSIBILITY, bar: null, areaTitle: "MONEY" } }, api.fetcher);
      expect(api.calls.find((entry) => entry.method === "PATCH")?.body).toEqual({
        areaTitle: "MONEY", metricName: null, metricUnit: null, metricTarget: null, metricLow: null, metricHigh: null, metricDirection: null, metricCurrent: null,
      });
    });

    it("asks the person on a card before a permanent delete, and deletes once they accept", async () => {
      const detail = { ...responsibility(), area: null, skills: [], artifacts: [], artifactsTotal: 0, artifactsTruncated: false, projects: [], tasks: [], tasksTruncated: false, routines: [] };
      const key = `responsibility-delete:${RESPONSIBILITY}`;
      const card = (status: string, id = "card-1", createdByAgentId = AGENT) => ({
        id, kind: "request_confirmation", status, createdAt: "2026-11-18T00:00:00.000Z", createdByAgentId, payload: { target: { type: "custom", key } },
      });

      const first = fakeApi({
        [`/responsibilities/${RESPONSIBILITY}`]: { body: detail },
        [`GET /issues/${ISSUE}/interactions`]: { body: [] },
        [`POST /issues/${ISSUE}/interactions`]: { body: { id: "card-1" } },
      });
      expect(await callResponsibilityTool({ ...base, name: "delete_responsibility", arguments: { responsibilityId: RESPONSIBILITY } }, first.fetcher))
        .toMatchObject({ deleted: false, status: "awaiting_confirmation", confirmationId: "card-1" });
      expect(first.calls.find((entry) => entry.method === "POST")?.body).toMatchObject({
        kind: "request_confirmation", idempotencyKey: `${key}:1`, resolverPolicy: "human_only", continuationPolicy: "wake_assignee",
        payload: { acceptLabel: "Delete", target: { type: "custom", key } },
      });

      const declined = fakeApi({ [`/responsibilities/${RESPONSIBILITY}`]: { body: detail }, [`GET /issues/${ISSUE}/interactions`]: { body: [card("rejected")] } });
      expect(await callResponsibilityTool({ ...base, name: "delete_responsibility", arguments: { responsibilityId: RESPONSIBILITY } }, declined.fetcher))
        .toMatchObject({ deleted: false, status: "declined" });
      expect(declined.calls.some((entry) => entry.method)).toBe(false);

      const accepted = fakeApi({
        [`/responsibilities/${RESPONSIBILITY}`]: { body: detail },
        // Another agent's accepted card does not count: the route accepts only this agent's own.
        [`GET /issues/${ISSUE}/interactions`]: { body: [
          card("rejected", "card-0"), { ...card("accepted"), createdAt: "2026-11-18T01:00:00.000Z" },
          { ...card("accepted", "card-other", "another-agent"), createdAt: "2026-11-18T02:00:00.000Z" },
        ] },
        [`DELETE /responsibilities/${RESPONSIBILITY}?confirmationId=card-1`]: { body: responsibility() },
      });
      expect(await callResponsibilityTool({ ...base, name: "delete_responsibility", arguments: { responsibilityId: RESPONSIBILITY } }, accepted.fetcher))
        .toMatchObject({ deleted: true, responsibility: { id: RESPONSIBILITY } });
    });

    it("files work by identifier and reports a move", async () => {
      const api = fakeApi({
        "/issues/PAP-9": { body: { id: TASK, identifier: "PAP-9" } },
        [`POST /responsibilities/${RESPONSIBILITY}/file`]: { body: { filed: [{ link: { id: "l1" }, created: true }, { link: { id: "l2" }, created: false }], unfiled: [{ responsibilityId: "old" }] } },
      });
      const result = await callResponsibilityTool({ ...base, name: "file_under_responsibility", arguments: {
        responsibilityId: RESPONSIBILITY, items: [{ kind: "task", id: "PAP-9" }, { kind: "routine", id: ROUTINE }], moveFrom: "all",
      } }, api.fetcher);
      expect(api.calls.find((entry) => entry.method === "POST")?.body).toEqual({
        items: [{ kind: "task", id: TASK }, { kind: "routine", id: ROUTINE }], moveFrom: "all",
      });
      expect(result).toMatchObject({ filed: 1, alreadyFiled: 1, movedFrom: ["old"] });
    });
  });
});
